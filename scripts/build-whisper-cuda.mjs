#!/usr/bin/env node
/**
 * 为 ARM GPU 平台编译带 CUDA 的 whisper.cpp addon。
 *
 * 上游 buxuku/whisper.cpp 只发布 x64 的 CUDA 预编译包，arm64 主机无法加载，
 * 因此这里用与上游 CI 相同的上游 tag、补丁和 CMake 选项自行编译。产物提交到
 * ictrektech/v-sub-addons（Git LFS），再由 docker/whisper-cuda/manifest.json
 * 指出版本与 sha256，镜像构建时按 manifest 下载。
 *
 * 升级上游或补丁后，在对应 base 镜像里重跑本脚本，把产物提交到 v-sub-addons
 * 并更新 manifest：
 *   node scripts/build-whisper-cuda.mjs --architectures=110 --out=thor.node
 *   thor: 110 · arm-cuda: 90;100;120 · l4t: 87（Jetson 统一内存需加 --no-vmm）
 *   --architectures 为空时产出空文件（amd-cuda 不内置该插件）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UPSTREAM_TAG = 'v1.9.5';
const UPSTREAM_REPO = 'ggml-org/whisper.cpp';
const PATCH_COMMIT = '9c38c27391111bdf4e80355e14a3460ef13152d2';
const PATCH_REPO = 'buxuku/whisper.cpp';
const PATCHES = [
  '0001-addon.node-cancel-via-AbortSignal.patch',
  '0002-addon.node-emit-tokens-and-vad-segments.patch',
];
const MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/', ''];
const MIN_ARCHIVE_BYTES = 1024 * 1024;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const match = argv[i].match(/^--([^=]+)=(.*)$/);
    if (match) {
      args[match[1]] = match[2];
    } else if (argv[i].startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[argv[i].slice(2)] = true;
      } else {
        args[argv[i].slice(2)] = next;
        i += 1;
      }
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const architectures = (args.architectures ?? '').trim();
const noVmm = !!args['no-vmm'];
const out = path.resolve(args.out ?? '/build/addon.cuda.node');
const work = path.resolve(args.work ?? '/tmp/whisper-cuda-src');
const nodeAddonApi = path.resolve(
  args['node-addon-api'] ?? process.env.NODE_ADDON_API_DIR ?? '/build/node-addon/node_modules/node-addon-api',
);
const nodeInclude = path.resolve(args['node-include'] ?? process.env.NODE_INCLUDE_DIR ?? '/usr/local/include/node');

if (!architectures) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, '');
  console.log(`[whisper-cuda] No CUDA architectures requested; wrote empty ${out}`);
  process.exit(0);
}

function run(command, commandArgs, options = {}) {
  console.log(`[whisper-cuda] $ ${command} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  }
}

async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer);
  return buffer;
}

async function downloadFromMirrors(pathname, destination, validate) {
  let lastError;
  for (const mirror of MIRRORS) {
    const url = `${mirror}${pathname}`;
    try {
      const buffer = await download(url, destination);
      if (!validate(buffer)) throw new Error(`unexpected content from ${url}`);
      console.log(`[whisper-cuda] fetched ${url}`);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[whisper-cuda] ${url} failed: ${error.message}`);
    }
  }
  throw lastError;
}

function isGzip(buffer) {
  return buffer.length > MIN_ARCHIVE_BYTES && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function isPatch(buffer) {
  return buffer.length > 1000 && buffer.includes('--- ') && buffer.includes('+++ ');
}

function findAddon(dir) {
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'addon.node' || entry.name === 'addon.node.node')) {
      return path.join(entry.parentPath ?? entry.path, entry.name);
    }
  }
  return null;
}

function hasCString(buffer, value) {
  const needle = Buffer.from(`${value}\0`);
  let offset = buffer.indexOf(needle);
  while (offset !== -1) {
    const before = offset === 0 ? 0 : buffer[offset - 1];
    const isIdentifier = (before >= 0x30 && before <= 0x39) || (before >= 0x41 && before <= 0x5a)
      || (before >= 0x61 && before <= 0x7a) || before === 0x5f;
    if (!isIdentifier) return true;
    offset = buffer.indexOf(needle, offset + 1);
  }
  return false;
}

function verify(addonPath, cudaArchitectures) {
  const buffer = fs.readFileSync(addonPath);
  const missing = ['token_timestamps', 'vadSegments'].filter((key) => !hasCString(buffer, key));
  if (missing.length > 0) {
    throw new Error(`${addonPath} lacks ${missing.join(', ')}: patch 0002 was not compiled in`);
  }
  const dynamic = spawnSync('readelf', ['-d', addonPath], { encoding: 'utf8' });
  const header = spawnSync('readelf', ['-h', addonPath], { encoding: 'utf8' });
  if (dynamic.status === 0) {
    const needed = [...dynamic.stdout.matchAll(/Shared library: \[(.+?)\]/g)].map((m) => m[1]);
    console.log(`[whisper-cuda] ELF ${header.stdout.match(/Machine:\s+(.+)/)?.[1]?.trim() ?? '?'}`);
    console.log(`[whisper-cuda] NEEDED ${needed.join(' ')}`);
    if (!needed.some((name) => /libcudart|libcublas|libcuda\.so/.test(name))) {
      throw new Error(`${addonPath} does not link against the CUDA runtime`);
    }
  }
  console.log(`[whisper-cuda] built ${addonPath} (${buffer.length} bytes, CUDA architectures ${cudaArchitectures})`);
}

async function main() {
  if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const archive = path.join(work, 'whisper.tar.gz');
  await downloadFromMirrors(
    `https://github.com/${UPSTREAM_REPO}/archive/refs/tags/${UPSTREAM_TAG}.tar.gz`,
    archive,
    isGzip,
  );
  run('tar', ['-xzf', archive, '--strip-components=1', '-C', work]);
  fs.rmSync(archive);

  for (const name of PATCHES) {
    const patchPath = path.join(work, name);
    await downloadFromMirrors(
      `https://raw.githubusercontent.com/${PATCH_REPO}/${PATCH_COMMIT}/.github/upstream/patches/${name}`,
      patchPath,
      isPatch,
    );
    run('patch', ['-p1', '--forward', '-i', patchPath], { cwd: work });
    fs.rmSync(patchPath);
  }

  if (!fs.existsSync(path.join(nodeInclude, 'node_api.h'))) {
    throw new Error(`Node headers not found in ${nodeInclude}`);
  }
  const addonDir = path.join(work, 'examples', 'addon.node');
  const modulesDir = path.join(addonDir, 'node_modules');
  fs.mkdirSync(modulesDir, { recursive: true });
  fs.cpSync(nodeAddonApi, path.join(modulesDir, 'node-addon-api'), { recursive: true, dereference: true });

  const jobs = String(Math.max(1, Math.min(os.cpus().length, 8)));
  run('cmake', [
    '-S', '.',
    '-B', 'build',
    '-DCMAKE_JS_VERSION=7.1.1',
    '-DWHISPER_STATIC=ON',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DGGML_NATIVE=OFF',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
    `-DCMAKE_JS_INC=${nodeInclude}`,
    '-DGGML_CUDA=ON',
    `-DCMAKE_CUDA_ARCHITECTURES=${architectures}`,
    ...(noVmm ? ['-DGGML_CUDA_NO_VMM=ON'] : []),
  ], { cwd: work });
  run('cmake', ['--build', 'build', '--target', 'addon.node', '-j', jobs], { cwd: work });

  const built = findAddon(path.join(work, 'build'));
  if (!built) throw new Error('addon.node was not produced');
  verify(built, architectures);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(built, out);
}

main().catch((error) => {
  console.error(`[whisper-cuda] ${error.stack ?? error}`);
  process.exit(1);
});
