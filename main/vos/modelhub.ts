import fs from 'fs';
import path from 'path';
import { app, type BrowserWindow } from 'electron';
import catalog from '../../catalog/modelhub.json';

type Model = typeof catalog[number];
const hubUrl = process.env.MODEL_HUB_API_URL || 'http://v-scheduler-model-hub:6005';
const hubRoot = process.env.MODEL_HUB_SHARED_MODELS_PATH || '/modelhub';
const exportRoot = process.env.MODEL_HUB_EXPORTS_PATH || path.join(hubRoot, 'export');
let lastSync = 0;
let active: { group: string; controller: AbortController; task?: string } | undefined;
let syncFlight: Promise<void> | undefined;
export const usesModelHub = () => process.env.VSUB_WEB === '1';
const repoId = (value: string) => value.replace(/^ms:\/\//, '');
const key = (m: Model) => `${m.group}:${m.id}`;
const disabledFile = () => path.join(app.getPath('userData'), 'modelhub-disabled.json');
function disabled(): string[] { try { return JSON.parse(fs.readFileSync(disabledFile(), 'utf8')); } catch { return []; } }
function enable(m: Model, enabled: boolean) {
  const values = new Set(disabled());
  enabled ? values.delete(key(m)) : values.add(key(m));
  fs.writeFileSync(disabledFile(), JSON.stringify([...values]));
}
function find(group: string, id: string): Model {
  const model = catalog.find(m => m.group === group && m.id === id);
  if (!model) throw new Error(`Unknown Model Hub model: ${group}:${id}`);
  return model;
}
function source(m: Model) { return path.join(exportRoot, 'ms', m.repo, 'current'); }
function mapping(m: Model): Record<string, string> { return 'mapping' in m && m.mapping ? m.mapping as Record<string, string> : {}; }
export function hubFilesReady(m: Model): boolean {
  return m.required.every(file => { try { const stat = fs.statSync(path.join(source(m), mapping(m)[file] || file)); return stat.isFile() && stat.size > 0 && (!('sizes' in m) || !m.sizes || !(m.sizes as Record<string, number>)[file] || stat.size === (m.sizes as Record<string, number>)[file]); } catch (error: any) { if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error('Model Hub weights are not readable by the isolated user. Update V-Sub to use the read-only export mount; downloading again will not fix permissions.'); return false; } });
}
function destination(m: Model): string {
  switch (m.group) {
    case 'ggml': return path.join(require('../helpers/whisper').getPath('modelsPath'), m.required[0]);
    case 'ct2': return path.join(require('../helpers/modelCatalog').getCt2ModelCacheDir(m.id), 'snapshots', 'modelhub');
    case 'funasr': return path.join(require('../helpers/funasrModelCatalog').getFunasrModelsRoot(), m.id);
    case 'qwen': return path.join(require('../helpers/qwenModelCatalog').getQwenModelsRoot(), m.id);
    case 'firered': return path.join(require('../helpers/fireRedModelCatalog').getFireRedModelsRoot(), m.id);
    case 'parakeet': return path.join(require('../helpers/parakeetModelCatalog').getParakeetModelsRoot(), m.id);
    case 'tts': return path.join(require('../helpers/ttsModelCatalog').getTtsModelsRoot(), m.id);
    case 'diarization': return require('../helpers/speakerDiarization/modelCatalog').getSpeakerDiarizationModelDir();
    default: throw new Error('Unsupported model layout');
  }
}
function link(target: string, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink()) {
      if (fs.readlinkSync(dest) === target) return;
      fs.unlinkSync(dest);
    } else if (stat.isDirectory() && !fs.readdirSync(dest).length) fs.rmdirSync(dest);
    else fs.renameSync(dest, `${dest}.legacy-model-${Date.now()}`);
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  fs.symlinkSync(target, dest);
}
function attach(m: Model, replaceLegacy = false) {
  if (!hubFilesReady(m) || disabled().includes(key(m))) return;
  const dest = destination(m);
  try { const stat = fs.lstatSync(dest); if (!replaceLegacy && !stat.isSymbolicLink() && (!stat.isDirectory() || fs.readdirSync(dest).length)) return; } catch {}
  let target = source(m);
  if (m.layout === 'ggml') target = path.join(target, m.required[0]);
  if (Object.keys(mapping(m)).length) {
    const view = path.join(app.getPath('userData'), '.modelhub', m.group, m.id);
    for (const [local, remote] of Object.entries(mapping(m))) link(path.join(target, remote), path.join(view, local));
    target = view;
  }
  link(target, destination(m));
}
async function request(route: string, options: RequestInit = {}) {
  const response = await fetch(`${hubUrl}/api/v1${route}`, { ...options, signal: options.signal || AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Model Hub HTTP ${response.status}`);
  return response.json();
}
export async function syncHubModels(force = false): Promise<void> {
  if (!usesModelHub() || (!force && Date.now() - lastSync < 5000)) return;
  if (syncFlight) return syncFlight;
  syncFlight = (async () => {
    const rows = await request('/models?status=all');
    for (const m of catalog) if (rows.some((r: any) => repoId(r.model_id) === m.repo && r.status === 'ready')) attach(m);
    lastSync = Date.now();
  })().finally(() => { syncFlight = undefined; });
  return syncFlight;
}
export function detachHubModel(group: string, id: string) { if (usesModelHub()) enable(find(group, id), false); }
export function cancelHubDownload(group?: string) {
  if (active && (!group || active.group === group)) {
    active.controller.abort();
    if (active.task) void request(`/tasks/${active.task}/cancel`, { method: 'POST' }).catch(() => {});
  }
}
export async function downloadHubModel(group: string, id: string, window: BrowserWindow | null): Promise<boolean> {
  const m = find(group, id);
  if (active) throw new Error('anotherDownloadInProgress');
  enable(m, true);
  const run = { group, controller: new AbortController(), task: undefined as string | undefined }; active = run;
  const progressKey = group === 'ggml' ? id : `${group}:${id}`;
  const notify = (ratio: number, status: string, task: any = {}) => {
    window?.webContents.send('downloadProgress', progressKey, ratio);
    window?.webContents.send('modelDownloadDetail', progressKey, { status, progress: ratio * 100, downloaded: 0, total: 0, speed: task.speed || 0, eta: task.eta || 0, error: task.error_msg });
  };
  try {
    // A shared task can finish for another Qwen size; re-check the requested files
    // before creating the next selective pull. Never call the desktop downloader.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (hubFilesReady(m)) { attach(m, true); notify(1, 'completed'); return true; }
      const rows = await request('/models?status=all');
      const ready = rows.some((r: any) => repoId(r.model_id) === m.repo && r.status === 'ready');
      let files = 'files' in m ? m.files as string[] : undefined;
      if (ready && !files) throw new Error('Model Hub has completed this model, but its files are unavailable in the shared export mount. Check the mount; the model will not be downloaded again.');
      if (files && ready) {
        try { fs.readdirSync(source(m)); } catch { throw new Error('Model Hub has completed this model, but its export directory is unavailable. Check the mount; the model will not be downloaded again.'); }
        // Keep already published views when adding a selective subset to a repo.
        for (const sibling of catalog.filter(s => s.repo === m.repo && hubFilesReady(s))) if ('files' in sibling) files = [...new Set([...files, ...sibling.files as string[]])];
      }
      const response = await fetch(`${hubUrl}/api/v1/models/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'ms', model_id: m.repo, name: `V-Sub · ${m.id}`, files, force: ready }), signal: AbortSignal.timeout(15000) });
      let taskId: string;
      const joined = response.status === 409;
      if (response.status === 409) {
        const tasks = await request('/tasks');
        const task = tasks.find((t: any) => repoId(t.model_id) === m.repo && ['PENDING', 'DOWNLOADING', 'VERIFYING'].includes(t.phase));
        if (!task) throw new Error('Model Hub rejected model pull');
        taskId = task.task_id;
      } else {
        if (!response.ok) throw new Error(`Model Hub pull HTTP ${response.status}`);
        taskId = (await response.json()).task_id; run.task = taskId;
      }
      if (run.controller.signal.aborted) {
        if (run.task) await request(`/tasks/${run.task}/cancel`, { method: 'POST' });
        throw new Error('Download cancelled');
      }
      const deadline = Date.now() + 2 * 60 * 60 * 1000;
      while (Date.now() < deadline) {
        if (run.controller.signal.aborted) throw new Error('Download cancelled');
        const task = await request(`/tasks/detail/${taskId}`);
        notify(Math.min(task.progress || 0, 0.99), task.phase === 'VERIFYING' ? 'extracting' : 'downloading', task);
        if (task.phase === 'FAILED') throw new Error(task.error_msg || 'Model Hub download failed');
        if (task.phase === 'READY') break;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new Error('Download cancelled')); };
          const timer = setTimeout(() => { run.controller.signal.removeEventListener('abort', abort); resolve(); }, 1000);
          run.controller.signal.addEventListener('abort', abort, { once: true });
        });
      }
      if (Date.now() >= deadline) throw new Error('Model Hub download timed out');
      run.task = undefined;
      // Only a joined selective pull may have completed a different subset.
      // A completed full pull must never trigger another forced download.
      if (!hubFilesReady(m) && (!joined || !files)) throw new Error('Model Hub completed the download, but the model is unavailable in the shared export mount. The model will not be downloaded again.');
    }
    throw new Error('Model Hub model files are incomplete or shared mount is unavailable');
  } catch (error) { notify(0, 'error', { error_msg: String(error) }); throw error; }
  finally { if (active === run) active = undefined; }
}
