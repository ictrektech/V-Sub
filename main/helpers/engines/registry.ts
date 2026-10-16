import { builtinEngineAdapter } from './builtinEngine';
import { fasterWhisperEngineAdapter } from './fasterWhisperEngine';
import { funasrEngineAdapter } from './funasrEngine';
import { qwenEngineAdapter } from './qwenEngine';
import { fireRedEngineAdapter } from './fireRedEngine';
import { parakeetEngineAdapter } from './parakeetEngine';
import { localCliEngineAdapter } from './localCliEngine';
import { cloudAsrEngineAdapter } from './cloudAsrEngine';
import type { TranscriptionEngine } from '../../../types/engine';
import type { TranscriptionEngineAdapter } from './types';
import { withNativeModel } from '../nativeScheduling';
import { schedulingRequired, SchedulingError } from '../../../vos/scheduler-client.mjs';

const adapters: TranscriptionEngineAdapter[] = [
  builtinEngineAdapter,
  fasterWhisperEngineAdapter,
  funasrEngineAdapter,
  qwenEngineAdapter,
  fireRedEngineAdapter,
  parakeetEngineAdapter,
  localCliEngineAdapter,
  cloudAsrEngineAdapter,
];

export function getEngineAdapter(
  id: TranscriptionEngine,
): TranscriptionEngineAdapter | undefined {
  const adapter = adapters.find((a) => a.id === id);
  if (!adapter || !schedulingRequired() || id === 'cloud') return adapter;
  return {
    ...adapter,
    prewarm: undefined,
    transcribe: (context) => {
      if (id === 'localCli') throw new SchedulingError(503, 'Custom commands have no calibrated executor');
      const model = context.formData.model;
      if (typeof model !== 'string' || !model) throw new SchedulingError(422, 'Explicit local model required');
      return withNativeModel(`${id}/${model}`, () => adapter.transcribe(context));
    },
  };
}

/**
 * 逐任务引擎解析：任务 formData 携带的 `transcriptionEngine` 优先（且必须是已知引擎），
 * 缺省回退 builtin。引擎已逐任务化，不再读全局设置。
 */
export function resolveEngineIdForTask(formData?: {
  transcriptionEngine?: TranscriptionEngine;
}): TranscriptionEngine {
  const fromTask = formData?.transcriptionEngine;
  if (fromTask && getEngineAdapter(fromTask)) return fromTask;
  return 'builtin';
}

export function getEngineAdapterForTask(formData?: {
  transcriptionEngine?: TranscriptionEngine;
}): TranscriptionEngineAdapter {
  return (
    getEngineAdapter(resolveEngineIdForTask(formData)) ?? builtinEngineAdapter
  );
}

export function listEngineAdapters(): TranscriptionEngineAdapter[] {
  return adapters.map(adapter => getEngineAdapter(adapter.id)!);
}
