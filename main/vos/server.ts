import { syncHubModels, detachHubModel } from './modelhub';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomUUID, timingSafeEqual } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import { app, dialog, shell } from 'electron';
import { invokeHandler, sendHandler } from '../automation/handlers';
import { automationEvents, createServiceEvent } from '../automation/events';
import { refreshRouter, routerStatus } from './router';
import { startLocalModelRefresh, handleLocalInference, localModelStatus } from './localModels';

const contexts = new AsyncLocalStorage<{ saved: string[] }>();
const clients = new Set<http.ServerResponse>();
const closeTimers = new Map<string, ReturnType<typeof setTimeout>>();
const browserEvents = new Map<string, ReturnType<typeof createServiceEvent>>();
const browserEvent = (id: string) => { if (!browserEvents.has(id)) browserEvents.set(id, createServiceEvent()); return browserEvents.get(id)!; };
const closeBrowser = (id: string) => { browserEvents.get(id)?.sender.emit('destroyed'); browserEvents.delete(id); };
const dialogs = new Map<string, (paths: string[]) => void>();
const root = process.env.VSUB_USER_ROOT!;
const events = (channel: string, ...args: any[]) => {
  const wire = `data: ${JSON.stringify({ channel, args }, (_k, value) => value instanceof Uint8Array ? { __bytes: Array.from(value) } : value)}\n\n`;
  for (const client of clients) client.write(wire);
};
const confined = (file: string) => { const target = path.resolve(file); if (target !== root && !target.startsWith(root + path.sep)) throw new Error('File outside user workspace'); return target; };
async function openDialog(options: any) {
  if (options?.properties?.includes('openDirectory')) { const directory = path.join(root, 'exports'); fs.mkdirSync(directory, { recursive: true }); return { canceled: false, filePaths: [directory] }; }
  if (!clients.size) return { canceled: true, filePaths: [] };
  const id = randomUUID();
  const paths = await new Promise<string[]>(resolve => {
    const timer = setTimeout(() => { dialogs.delete(id); resolve([]); }, 120000);
    dialogs.set(id, paths => { clearTimeout(timer); dialogs.delete(id); resolve(paths.map(confined)); });
    events('vos:dialog', { id, filters: options?.filters, multiple: options?.properties?.includes('multiSelections') });
  });
  return { canceled: !paths.length, filePaths: paths };
}
export function installWebDialogs() {
  (dialog as any).showOpenDialog = (...args: any[]) => openDialog(args[args.length - 1]);
  (dialog as any).showSaveDialog = async (...args: any[]) => {
    const options = args[args.length - 1];
    const exports = path.join(root, 'exports', randomUUID()); fs.mkdirSync(exports, { recursive: true });
    const filePath = path.join(exports, path.basename(options?.defaultPath || 'export'));
    contexts.getStore()?.saved.push(filePath);
    return { canceled: false, filePath };
  };
  (dialog as any).showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  (dialog as any).showErrorBox = (_title: string, message: string) => events('vos:error', message);
  (shell as any).openExternal = async (url: string) => { if (/^https?:\/\//.test(url)) events('vos:open-url', url); };
  (shell as any).openPath = async (file: string) => { const target = confined(file); if (fs.statSync(target).isFile()) events('vos:download', target); else events('vos:files', target); return ''; };
  (shell as any).showItemInFolder = (file: string) => events('vos:download', confined(file));
}
async function readBody(req: http.IncomingMessage) { const chunks: Buffer[] = []; let size = 0; for await (const c of req) { size += c.length; if (size > 8 * 1024 * 1024) throw new Error('Request too large'); chunks.push(c); } return JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
export async function startWebServer() {
  const token = process.env.VSUB_WORKER_TOKEN!;
  automationEvents.on('event', events);
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, value: any) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value, (_k, v) => v instanceof Uint8Array ? { __bytes: Array.from(v) } : v)); };
    const actual = Buffer.from(req.headers.authorization || ''), expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { reply(401, { error: 'Worker authentication required' }); return; }
    try {
      if (await handleLocalInference(req, res)) return;
      const pathname = new URL(req.url!, 'http://localhost').pathname;
      if (pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const clientId = new URL(req.url!, 'http://localhost').searchParams.get('clientId') || '';
        clearTimeout(closeTimers.get(clientId)); closeTimers.delete(clientId);
        browserEvent(clientId);
        res.write(': ready\n\n'); clients.add(res); const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        res.on('close', () => { clearInterval(timer); clients.delete(res); closeTimers.set(clientId, setTimeout(() => { closeBrowser(clientId); closeTimers.delete(clientId); }, 15000)); }); return;
      }
      if (pathname === '/api/close' && req.method === 'POST') { const value = await readBody(req); closeBrowser(value.clientId); reply(200, { ok: true }); return; }
      if (pathname === '/api/dialog' && req.method === 'POST') { const value = await readBody(req); const done = dialogs.get(value.id); if (!done) throw new Error('Dialog expired'); done(value.paths || []); reply(200, { ok: true }); return; }
      await refreshRouter(String(req.headers['x-vsub-access-token'] || ''));
      if (pathname === '/api/router') { await refreshRouter(undefined, true); reply(200, routerStatus()); return; }
      if (pathname !== '/api/ipc' || req.method !== 'POST') { reply(404, { error: 'Unknown endpoint' }); return; }
      const { channel, args = [], mode = 'invoke', clientId = '' } = await readBody(req);
      if (typeof channel !== 'string' || !Array.isArray(args)) throw new Error('Invalid IPC request');
      if (channel === 'sync-title-bar-overlay' || channel === 'window-chrome:getState') { reply(200, { result: null }); return; }
      // Browser operations reuse the exact desktop handlers. OS UID and data roots isolate native IO.
      if (channel === 'vos:router-status') { reply(200, { result: { ...routerStatus(), local: localModelStatus() } }); return; }
      if (channel === 'vos:runtime-status') { reply(200, { result: { profile: process.env.VSUB_PROFILE || 'cpu', sherpaProvider: process.env.VSUB_SHERPA_PROVIDER || 'cpu', sherpaVersion: process.env.VSUB_SHERPA_VERSION || '1.13.2' } }); return; }
      const deletion: Record<string, string> = { deleteModel: 'ggml', deleteCt2Model: 'ct2', deleteFunasrModel: 'funasr', deleteQwenModel: 'qwen', deleteFireRedModel: 'firered', deleteParakeetModel: 'parakeet', deleteTtsModel: 'tts', deleteSpeakerDiarizationModel: 'diarization' };
      if (deletion[channel]) detachHubModel(deletion[channel], channel === 'deleteSpeakerDiarizationModel' ? 'default' : String(args[0]).toLowerCase());
      await syncHubModels().catch(() => {});
      const event = browserEvent(clientId); const context = { saved: [] as string[] };
      const result = await contexts.run(context, async () => mode === 'send' ? sendHandler(channel, event, ...args) : invokeHandler(channel, event, ...args));
      reply(200, { result: result ?? null, downloads: context.saved.filter(file => fs.existsSync(file)) });
    } catch (error) { reply(400, { error: error instanceof Error ? error.message : 'Operation failed' }); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  fs.writeFileSync(path.join(root, 'web-endpoint.json'), JSON.stringify({ port, pid: process.pid }), { mode: 0o600 });
  await syncHubModels().catch(() => {});
  const hubTimer = setInterval(() => { void syncHubModels().catch(() => {}); }, 15000);
  hubTimer.unref();
  startLocalModelRefresh();
  app.once('will-quit', () => server.close());
}
