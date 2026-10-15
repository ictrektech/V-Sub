import http from 'node:http';
import { discoverLocalModels } from './discovery.mjs';
import fs from 'node:fs';
import { mkdir, readFile, stat, chown, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { identity, existingFile, confined, sameOrigin } from './security.mjs';

const base = '/app/com.ictrek.v-sub';
const appRoot = path.resolve(process.env.VSUB_APP_ROOT || '.');
const dataRoot = path.resolve(process.env.VSUB_DATA_DIR || '/data');
const sessions = new Map();
const workers = new Map();
const routerURL = process.env.V_ROUTER_URL || 'http://v-router:8080';
const userinfoURL = process.env.VOS_OIDC_USERINFO_URL || 'http://host.docker.internal:8105/v1000/oauth2/userinfo';
const json = (res, code, value, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(value)); };
async function body(req, limit = 8 * 1024 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new Error('Request too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function verified(token) {
  const response = await fetch(userinfoURL, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('VOS authentication failed');
  return identity(await response.json());
}
async function session(req) {
  const cookie = /(?:^|;\s*)v_sub_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  const found = sessions.get(cookie);
  if (!found || found.expires < Date.now()) { if (cookie) sessions.delete(cookie); return null; }
  if (found.checked < Date.now() - 60000) { try { const user = await verified(found.accessToken); if (user.subject !== found.user.subject) return null; found.checked = Date.now(); } catch { sessions.delete(cookie); return null; } }
  return found;
}
async function workerFor(user) {
  if (workers.has(user.namespace)) return workers.get(user.namespace);
  const promise = (async () => {
    const root = path.join(dataRoot, 'users', user.namespace);
    await mkdir(root, { recursive: true, mode: 0o700 });
    // Different OS identities enforce isolation even when a native engine reads files directly.
    const uid = 20000 + Number.parseInt(user.namespace.slice(0, 6), 16);
    const ownerFile = path.join(dataRoot, `uid-${uid}`);
    try { await writeFile(ownerFile, user.namespace, { flag: 'wx', mode: 0o600 }); }
    catch { if ((await readFile(ownerFile, 'utf8')) !== user.namespace) throw new Error('User namespace collision'); }
    await chown(root, uid, uid); await chmod(root, 0o700);
    const endpointFile = path.join(root, 'web-endpoint.json');
    await fs.promises.rm(endpointFile, { force: true });
    const workerToken = randomBytes(32).toString('hex');
    const child = spawn(path.join(appRoot, 'node_modules/electron/dist/electron'), [appRoot, '--no-sandbox', '--disable-gpu', '--automation-background', `--automation-data-dir=${root}`], {
      uid, gid: uid, cwd: root,
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, NODE_ENV: 'production', VSUB_WEB: '1', VSUB_WORKER_TOKEN: workerToken, VSUB_USER_ROOT: root, VSUB_NAMESPACE: user.namespace, VSUB_APP_ROOT: appRoot, V_ROUTER_URL: routerURL },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const log = fs.createWriteStream(path.join(root, 'runtime.log'), { mode: 0o600 });
    child.stderr.pipe(log);
    child.on('exit', () => { workers.delete(user.namespace); log.end(); });
    for (let n = 0; n < 120; n++) {
      if (child.exitCode !== null) throw new Error('Subtitle runtime failed to start');
      try { const endpoint = JSON.parse(await readFile(endpointFile, 'utf8')); if (endpoint.pid === child.pid) return { child, root, token: workerToken, port: endpoint.port }; } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    child.kill(); throw new Error('Subtitle runtime startup timed out');
  })();
  workers.set(user.namespace, promise);
  try { return await promise; } catch (error) { workers.delete(user.namespace); throw error; }
}
async function serveFile(req, res, file, downloadable = false) {
  const info = await stat(file); if (!info.isFile()) throw new Error('Not a file');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.vtt': 'text/vtt' };
  const headers = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  if (downloadable) headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  let start = 0, end = info.size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416); res.end(); return; }
    start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    if (start > end || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1); res.writeHead(status, headers);
  if (req.method === 'HEAD' || !info.size) { res.end(); return; }
  await pipeline(fs.createReadStream(file, { start, end }), res);
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = url.pathname;
    if (pathname === base || pathname.startsWith(base + '/')) pathname = pathname.slice(base.length) || '/';
    if (pathname === '/health') { json(res, 200, { ok: true, version: process.env.APP_VERSION || 'development', workers: workers.size }); return; }
    if (pathname === '/api/v1/discovery' && req.method === 'GET') {
      const match = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
      if (!match) { json(res, 401, { error: 'VOS access token required' }); return; }
      let user;
      try { user = await verified(match[1]); } catch { json(res, 401, { error: 'Invalid VOS access token' }); return; }
      try { json(res, 200, await discoverLocalModels(user, workers.get(user.namespace))); }
      catch { json(res, 503, { error: 'Local model discovery unavailable' }); }
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) { json(res, 403, { error: 'Invalid request origin' }); return; }
    if (pathname === '/api/auth/pkce' && req.method === 'GET') { const verifier = randomBytes(32).toString('base64url'); json(res, 200, { verifier, state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), challenge: createHash('sha256').update(verifier).digest('base64url') }); return; }
    if (pathname === '/api/auth/vos-oidc' && req.method === 'POST') {
      const { access_token: accessToken } = JSON.parse(await body(req, 65536));
      if (typeof accessToken !== 'string' || !accessToken) throw new Error('Access token required');
      const user = await verified(accessToken); const cookie = randomBytes(32).toString('hex');
      sessions.set(cookie, { user, accessToken, checked: Date.now(), expires: Date.now() + 3600000 });
      json(res, 200, { authenticated: true, user: { username: user.username, namespace: user.namespace } }, { 'Set-Cookie': `v_sub_session=${cookie}; Path=${base}/; HttpOnly; SameSite=Strict; Max-Age=3600${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}` }); return;
    }
    if (pathname === '/api/auth/session') {
      const found = await session(req);
      json(res, found ? 200 : 401, { enabled: true, authenticated: !!found, clientId: 'com.ictrek.v-sub', scope: 'openid profile email', ...(found ? { user: { username: found.user.username, namespace: found.user.namespace } } : {}) }); return;
    }
    const inference = /^\/inference\/([a-f0-9]{64})(\/v1\/.*)$/.exec(pathname);
    if (inference) {
      const pending = workers.get(inference[1]);
      if (!pending) { json(res, 503, { error: 'Model runtime unavailable' }); return; }
      const worker = await pending;
      if (req.headers.authorization !== `Bearer ${worker.token}`) { json(res, 401, { error: 'Inference authentication required' }); return; }
      const proxy = http.request({ host: '127.0.0.1', port: worker.port, path: inference[2] + url.search, method: req.method, headers: { 'Content-Type': req.headers['content-type'] || 'application/json', Authorization: `Bearer ${worker.token}` } }, upstream => { res.writeHead(upstream.statusCode || 502, upstream.headers); upstream.pipe(res); });
      proxy.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'Local inference unavailable' }); else res.destroy(); });
      req.pipe(proxy); return;
    }
    if (pathname.startsWith('/api/') || pathname.startsWith('/media')) {
      const found = await session(req); if (!found) { json(res, 401, { error: 'VOS login required' }); return; }
      const worker = await workerFor(found.user);
      if (pathname === '/api/upload' && req.method === 'POST') {
        const name = path.basename(decodeURIComponent(url.searchParams.get('name') || 'media'));
        const folder = path.join(worker.root, 'uploads', randomBytes(12).toString('hex'));
        await mkdir(folder, { recursive: true }); await chown(folder, 20000 + Number.parseInt(found.user.namespace.slice(0, 6), 16), 20000 + Number.parseInt(found.user.namespace.slice(0, 6), 16));
        const dest = path.join(folder, name || 'media');
        const limit = Number(process.env.VSUB_MAX_UPLOAD_BYTES || 4 * 1024 ** 3); let received = 0;
        req.on('data', chunk => { received += chunk.length; if (received > limit) req.destroy(new Error('Upload too large')); });
        try { await pipeline(req, fs.createWriteStream(dest, { mode: 0o600 })); await chown(dest, 20000 + Number.parseInt(found.user.namespace.slice(0, 6), 16), 20000 + Number.parseInt(found.user.namespace.slice(0, 6), 16)); }
        catch (error) { await fs.promises.rm(dest, { force: true }); throw error; }
        json(res, 200, { path: dest }); return;
      }
      if (pathname === '/media') { const file = await existingFile(worker.root, url.searchParams.get('path') || ''); await serveFile(req, res, file, url.searchParams.has('download')); return; }
      const proxy = http.request({ host: '127.0.0.1', port: worker.port, path: pathname + url.search, method: req.method, headers: { 'Content-Type': req.headers['content-type'] || 'application/json', Authorization: `Bearer ${worker.token}`, 'X-VSub-Access-Token': found.accessToken } }, upstream => { res.writeHead(upstream.statusCode || 502, upstream.headers); upstream.pipe(res); });
      proxy.on('error', () => { if (!res.headersSent) json(res, 502, { error: 'Subtitle runtime unavailable' }); else res.destroy(); });
      res.on('close', () => proxy.destroy()); req.pipe(proxy); return;
    }
    if (pathname === '/') { res.writeHead(302, { Location: `${base}/zh/home/` }); res.end(); return; }
    const root = path.join(appRoot, 'app');
    const decoded = decodeURIComponent(pathname);
    let file = confined(root, path.join(root, decoded));
    if (decoded.endsWith('/')) file = path.join(file, 'index.html');
    await serveFile(req, res, await existingFile(root, file));
  } catch (error) { if (!res.headersSent) json(res, 400, { error: error.message }); else res.destroy(); }
});
await mkdir(path.join(dataRoot, 'users'), { recursive: true, mode: 0o711 });
await chmod(dataRoot, 0o711); await chmod(path.join(dataRoot, 'users'), 0o711);
server.listen(Number(process.env.PORT || 7090), '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { for (const promise of workers.values()) promise.then(worker => worker.child.kill()); server.close(); setTimeout(() => process.exit(0), 3000).unref(); });
