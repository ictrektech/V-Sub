import path from 'path';
import { spawnAppUtilityHost } from './crash/appUtilityHost';
import type { UtilityHost } from './crash/utilityHost';
import { getExtraResourcesPath } from './utils';
import { scheduledAudio } from './nativeScheduling';

export function scheduledWhisper(addon: string, backend: string, params: Record<string, any>): Promise<any> {
  let child: UtilityHost | undefined;
  const { signal, progress_callback, fname_inp, prompt, ...settings } = params;
  const env = { ...process.env };
  delete env.VSUB_SCHEDULER_WORKER_TOKEN;
  const cancel = () => child?.postMessage({ type: 'cancel' });
  return scheduledAudio(String(fname_inp), { profile: process.env.VSUB_PROFILE, runtime: 'whisper.cpp', addon, backend, parameters: settings }, async () => {
    if (signal?.aborted) throw new Error('Transcription cancelled');
    child = spawnAppUtilityHost({ workerFile: path.join(getExtraResourcesPath(), 'whisper-scheduled-worker.cjs'), serviceName: 'v-sub-scheduled-whisper', logLabel: 'scheduled whisper', env });
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await new Promise((resolve, reject) => {
        child!.onMessage(message => {
          if (message.type === 'progress') progress_callback?.(message.percent);
          else if (message.type === 'done') resolve(message.result);
          else if (message.type === 'error') reject(new Error(message.message));
        });
        child!.onExit(() => reject(new Error('Whisper process exited')));
        child!.postMessage({ type: 'run', addon, params: { ...settings, fname_inp, prompt } });
      });
    } finally { signal?.removeEventListener('abort', cancel); }
  }, async () => child ? child.stopConfirmed() : true, cancel, { prompt_characters: String(prompt || '').length }, `builtin/${path.basename(String(params.model)).replace(/^ggml-/, '').replace(/\.bin$/, '')}`);
}
