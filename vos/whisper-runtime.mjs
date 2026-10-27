import { SchedulingError } from './scheduler-client.mjs';

// In managed VOS execution the calibrated binding owns backend selection. Desktop
// acceleration preferences stay saved, but must never select an unbudgeted addon.
/** @returns {{gpuMode: "cpu-only", coremlEligible: false}} */
export function managedWhisperContext(plan, profile, addon) {
  const settings = plan?.execution_settings;
  if (settings?.profile !== profile || settings?.runtime !== 'whisper.cpp' ||
      settings?.backend !== 'cpu' || settings?.addon !== addon ||
      settings?.parameters?.use_gpu !== false || settings?.parameters?.flash_attn !== false) {
    throw new SchedulingError(422, 'No supported calibrated Whisper runtime is bound');
  }
  return { gpuMode: 'cpu-only', coremlEligible: false };
}
