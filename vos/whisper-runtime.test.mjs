import assert from 'node:assert/strict';
import test from 'node:test';
import { managedWhisperContext } from './whisper-runtime.mjs';

const addon = '/opt/v-sub/extraResources/addons/addon.node';
const settings = { profile: 'l4t', runtime: 'whisper.cpp', backend: 'cpu', addon,
  parameters: { use_gpu: false, flash_attn: false, vad_threshold: 0.5 } };
test('managed backend uses the approved CPU runtime without changing semantic parameters', () => {
  const plan = { execution_settings: structuredClone(settings) };
  assert.deepEqual(managedWhisperContext(plan, 'l4t', addon), { gpuMode: 'cpu-only', coremlEligible: false });
  assert.deepEqual(plan.execution_settings, settings);
});
test('unsupported runtime, profile, addon and GPU settings fail closed', () => {
  for (const changed of [{ profile: 'thor' }, { runtime: 'other' }, { backend: 'cuda' },
    { addon: '/tmp/untrusted.node' }, { parameters: { use_gpu: true, flash_attn: false } },
    { parameters: { use_gpu: false, flash_attn: true } }]) {
    assert.throws(() => managedWhisperContext({ execution_settings: { ...settings, ...changed } }, 'l4t', addon), error => error.status === 422);
  }
  assert.throws(() => managedWhisperContext(undefined, 'l4t', addon), error => error.status === 422);
});
