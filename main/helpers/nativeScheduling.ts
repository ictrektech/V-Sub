import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import { readWavInfo } from './dubbing/audioPipeline';
import { scheduledCompute, schedulingRequired, SchedulingError } from '../../vos/scheduler-client.mjs';

const models = new AsyncLocalStorage<string>();
const cancellations = new Map<string, { cancelled: boolean }>();

export function cancelScheduled(id: string): void {
  const state = cancellations.get(id);
  if (state) state.cancelled = true;
}

export function scheduleCancelable(id: string, options: any): Promise<any> {
  const state = { cancelled: false };
  cancellations.set(id, state);
  return scheduledCompute({ ...options, isCancelled: () => state.cancelled }).finally(() => cancellations.delete(id));
}

export function withNativeModel<T>(model: string, run: () => T): T {
  return models.run(model, run);
}

export function scheduledAudio<T>(audioFile: string, executionSettings: object, run: () => Promise<T>, stop: () => Promise<boolean>, cancel?: () => void, inputs: Record<string, number> = {}, nativeModel?: string, requestId?: string): Promise<T> {
  if (!schedulingRequired()) return run();
  const model = nativeModel || models.getStore();
  if (!model) throw new SchedulingError(503, 'Native model identity required');
  const info = readWavInfo(audioFile);
  if (!(info.durationMs > 0)) throw new SchedulingError(422, 'Valid bounded WAV input required');
  const options = { model, executionSettings, inputs: { input_bytes: fs.statSync(audioFile).size, duration_seconds: info.durationMs / 1000, ...inputs }, run, stop, cancel };
  return requestId ? scheduleCancelable(requestId, options) : scheduledCompute(options);
}
