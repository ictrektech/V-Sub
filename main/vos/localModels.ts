import http from 'http';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { invokeHandler } from '../automation/handlers';
import { createServiceEvent } from '../automation/events';
import { getEngineAdapter } from '../helpers/engines/registry';
import { extractAudio } from '../helpers/audioProcessor';
import { parseSubtitleCues } from '../helpers/subtitleFormats';
import { getInstalledTtsModels, TTS_MODELS, getTtsModelRequest, resolveTtsVoiceSid } from '../helpers/ttsModelCatalog';
import { getSherpaTtsRuntime } from '../helpers/sherpaOnnx/ttsRuntime';
import { getClonedVoices } from '../helpers/voiceClone/voiceCloneManager';
import { previewVoice } from '../helpers/dubbing/dubbingProcessor';

type LocalModel = { id: string; kind: 'asr' | 'tts'; engine?: any; model: string; endpoints: string[]; capabilities: string[] };
let models: LocalModel[] = [];
let busy = false;
let refreshError = '';
export function localModelStatus() { return { models: models.length, error: refreshError }; }
let queue: Promise<any> = Promise.resolve();
const root = process.env.VSUB_USER_ROOT!;
const prefix = `v-sub-${(process.env.VSUB_NAMESPACE || 'desktop').slice(0, 12)}`;
function voicesFor(model: string) { const spec = TTS_MODELS[model]; return spec.cloneOnly ? getClonedVoices().filter(v => v.engine === 'zipvoice' && v.refText && v.refWavPath && fs.existsSync(v.refWavPath)).map(v => ({ id: v.id, sid: 0, labelEn: v.name })) : spec.voices; }
export async function refreshLocalModels() {
  const event = createServiceEvent();
  const info = await invokeHandler('getSystemInfo', event);
  const statuses = await invokeHandler('get-engine-status', event);
  const fields = { builtin: 'modelsInstalled', fasterWhisper: 'fasterWhisperModelsInstalled', funasr: 'funasrAsrModelsInstalled', qwen: 'qwenModelsInstalled', fireRedAsr: 'fireRedModelsInstalled', parakeet: 'parakeetModelsInstalled' };
  const next: LocalModel[] = [];
  for (const [engine, field] of Object.entries(fields)) {
    if (statuses[engine]?.state !== 'ready') continue;
    for (const value of info[field] || []) {
      const model = typeof value === 'string' ? value : value.id || value.name;
      if (model) next.push({ id: `${prefix}/${engine}/${model}`, engine, model, kind: 'asr', endpoints: ['audio/transcriptions'], capabilities: ['asr'] });
    }
  }
  for (const model of getInstalledTtsModels()) {
    if (!TTS_MODELS[model].voices.length && !getClonedVoices().some(v => v.engine === 'zipvoice' && v.refText && v.refWavPath && fs.existsSync(v.refWavPath))) continue;
    next.push({ id: `${prefix}/tts/${model}`, model, kind: 'tts', endpoints: ['audio/speech'], capabilities: ['tts'] });
  }
  models = next;
 }
export function startLocalModelRefresh() {
  const tick = async () => { if (busy) return; busy = true; try { await refreshLocalModels(); refreshError = ''; } catch (e) { refreshError = e instanceof Error ? e.message : String(e); } finally { busy = false; } };
  void tick(); setInterval(tick, 30000).unref();
}
export async function handleLocalInference(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
  const url = new URL(req.url!, 'http://localhost');
  if (!url.pathname.startsWith('/v1/')) return false;
  const json = (code: number, value: any) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (url.pathname === '/v1/models') { json(200, { object: 'list', data: models.map(m => ({ ...m, object: 'model', owned_by: 'v-sub' })) }); return true; }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 100 * 1024 * 1024) throw new Error('Audio upload too large'); chunks.push(chunk); }
  const body = Buffer.concat(chunks);
  const request = new Request('http://localhost' + req.url, { method: req.method, headers: { 'Content-Type': req.headers['content-type'] || 'application/json' }, ...(body.length ? { body } : {}) });
  const form = req.method === 'GET' ? null : (req.headers['content-type']?.includes('multipart/') ? await request.formData() : null);
  const params: any = req.method === 'GET' ? Object.fromEntries(url.searchParams) : form ? Object.fromEntries(form) : JSON.parse(body.toString());
  const model = models.find(m => m.id === params.model);
  if (!model) { json(404, { error: { message: 'Local model is not ready' } }); return true; }
  if (url.pathname === '/v1/audio/voices' && model.kind === 'tts') { const spec = TTS_MODELS[model.model]; json(200, { model: model.id, voices: voicesFor(model.model).map(v => ({ id: v.id, name: v.labelEn })), default_voice: spec.defaultVoiceId }); return true; }
  const run = async () => {
    const folder = path.join(root, 'inference', randomUUID()); fs.mkdirSync(folder, { recursive: true });
    try {
      if (url.pathname === '/v1/audio/speech' && model.kind === 'tts') {
        const spec = TTS_MODELS[model.model];
        params.voice ||= spec.defaultVoiceId || voicesFor(model.model)[0]?.id;
        if (!voicesFor(model.model).some(v => v.id === params.voice)) throw new Error('Unknown voice');
        if (typeof params.input !== 'string' || !params.input || params.input.length > 20000) throw new Error('Invalid speech input');
        const speed = Number(params.speed || 1); if (speed < 0.25 || speed > 4) throw new Error('Invalid speed');
        const format = params.response_format || 'mp3';
        if (!['wav', 'mp3', 'opus', 'aac', 'flac', 'pcm'].includes(format)) throw new Error('Unsupported audio response format');
        const file = path.join(folder, 'speech.wav');
        if (spec.cloneOnly) {
          const result = await previewVoice({ kind: 'local', modelId: model.model as any }, params.voice, params.input, { language: params.language });
          fs.copyFileSync(result.wavPath, file); fs.rmSync(result.wavPath, { force: true });
          if (speed !== 1) { const adjusted = path.join(folder, 'adjusted.wav'); await promisify(execFile)('/usr/bin/ffmpeg', ['-y', '-i', file, '-filter:a', speed < 0.5 ? `atempo=0.5,atempo=${speed * 2}` : `atempo=${speed}`, adjusted]); fs.renameSync(adjusted, file); }
        } else await getSherpaTtsRuntime().synthesize({ model: getTtsModelRequest(model.model as any), text: params.input, language: params.language, sid: resolveTtsVoiceSid(spec, params.voice), speed, outWavPath: file }).result;
        let output = file;
        const contentTypes = { wav: 'audio/wav', mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', pcm: 'application/octet-stream' };
        if (format !== 'wav') {
          output = path.join(folder, `speech.${format}`);
          await promisify(execFile)('/usr/bin/ffmpeg', ['-y', '-i', file, ...(format === 'pcm' ? ['-f', 's16le', '-acodec', 'pcm_s16le'] : []), output]);
        }
        res.writeHead(200, { 'Content-Type': contentTypes[format] }); res.end(fs.readFileSync(output)); return;
      }
      if (url.pathname === '/v1/audio/transcriptions' && model.kind === 'asr' && form) {
        const audio: any = form.get('file'); if (!audio || typeof audio.arrayBuffer !== 'function') throw new Error('Audio file required');
        const source = path.join(folder, path.basename(audio.name || 'audio.wav')); fs.writeFileSync(source, Buffer.from(await audio.arrayBuffer()));
        const wav = path.join(folder, 'decoded.wav'); const srt = path.join(folder, 'transcript.srt');
        await extractAudio(source, wav);
        const adapter = getEngineAdapter(model.engine)!;
        const text = await adapter.transcribe({ event: createServiceEvent() as any, file: { filePath: source, tempAudioFile: wav, srtFile: srt } as any, formData: { transcriptionEngine: model.engine, model: model.model, sourceLanguage: params.language || 'auto' }, hasOpenAiWhisper: false });
        const subtitle = fs.existsSync(srt) ? fs.readFileSync(srt, 'utf8') : text;
        const cues = parseSubtitleCues(subtitle, 'srt');
        const output = cues.map(c => c.text).join(' ');
        if (params.response_format === 'srt' || params.response_format === 'text' || params.response_format === 'vtt') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(params.response_format === 'srt' ? subtitle : params.response_format === 'vtt' ? 'WEBVTT\n\n' + subtitle.replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2') : output); }
        else json(200, { text: output, ...(params.response_format === 'verbose_json' ? { segments: cues.map((c, i) => ({ id: i, start: c.startMs / 1000, end: c.endMs / 1000, text: c.text })), words: [] } : {}) });
        return;
      }
      json(404, { error: { message: 'Unsupported local model endpoint' } });
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  };
  const active = queue.then(run); queue = active.catch(() => {}); await active; return true;
}
