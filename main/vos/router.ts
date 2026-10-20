import { modelCapabilities } from '../../vos/security.mjs';
import type { AsrProvider } from '../../types/asrProvider';
import type { TtsProvider } from '../../types/ttsProvider';

let accessToken = '';
let refreshed = 0;
let asr: AsrProvider[] = [];
let tts: TtsProvider[] = [];
let error = '';
export const routerBase = (process.env.V_ROUTER_URL || 'http://v-scheduler:8080').replace(/\/$/, '');
export const managed = (provider: { id?: string }) => provider.id?.startsWith('v-router:');
export function routerHeaders() { return { Authorization: `Bearer ${accessToken}` }; }
export function routerProviderHeaders(provider: { id?: string; apiUrl?: string; vosManaged?: boolean }) {
  if (!provider.vosManaged || !managed(provider) || provider.apiUrl !== `${routerBase}/v1`) throw new Error('Invalid V-Router provider');
  return routerHeaders();
}
export function getRouterAsr() { return asr; }
export function getRouterTts() { return tts; }
export function routerStatus() { return { connected: !error && !!refreshed, error, asr: asr.length, tts: tts.length }; }
export async function refreshRouter(token?: string, force = false) {
  if (token && token !== accessToken) { accessToken = token; refreshed = 0; }
  if (!accessToken || (!force && refreshed > Date.now() - 30000)) return;
  refreshed = Date.now();
  try {
    const response = await fetch(`${routerBase}/api/v1/models`, { headers: routerHeaders(), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`V-Router HTTP ${response.status}`);
    const data = await response.json();
    const rows: any[] = data.models || data.data?.models || data.data || [];
    if (!Array.isArray(rows)) throw new Error('Invalid V-Router model list');
    const nextAsr: AsrProvider[] = [], nextTts: TtsProvider[] = [];
    await Promise.all(rows.map(async row => {
      const model = row.qualified || row.id;
      // Our original local models already appear in the native engine selector.
      if (!model || model.includes('v-sub-')) return;
      const undeclared = (!row.kind || row.kind === 'unknown') && !(row.capabilities || []).length && !(row.endpoints || []).length;
      const common = { vosUndeclared: undeclared, id: `v-router:${model}`, name: `V-Router · ${model}${undeclared ? ' (?)' : ''}`, type: 'openaiCompatible', apiUrl: `${routerBase}/v1`, apiKey: 'vos-session', vosManaged: true, requestTimeoutSec: 300, concurrency: 2 };
      if (modelCapabilities(row).asr) nextAsr.push({ ...common, models: model });
      if (modelCapabilities(row).tts) {
        let voices: string[] = []; let voiceLabels: Record<string, string> = {};
        const voiceResponse = undeclared ? null : await fetch(`${routerBase}/v1/audio/voices?model=${encodeURIComponent(model)}`, { headers: routerHeaders(), signal: AbortSignal.timeout(8000) }).catch(() => null);
        if (voiceResponse?.ok) {
          const result = await voiceResponse.json();
          const items = result.voices || result.data || [];
          voices = items.map((v: any) => typeof v === 'string' ? v : v.id).filter(Boolean);
          voiceLabels = Object.fromEntries(items.filter((v: any) => v.id).map((v: any) => [v.id, v.name || v.id]));
        } else if (!model.startsWith('v-voice/')) {
          // Standard OpenAI TTS endpoints need not implement a voice enumeration API.
          voices = row.voices || ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
        }
        if (voices.length) nextTts.push({ ...common, model, voices: voices.join(', '), voiceLabels });
      }
    }));
    asr = nextAsr; tts = nextTts; error = '';
  } catch (e) { error = e instanceof Error ? e.message : String(e); asr = []; tts = []; }
}
