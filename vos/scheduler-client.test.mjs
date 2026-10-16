import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduledCompute, withSchedulerHeaders } from './scheduler-client.mjs';

function fixture(context) {
  const previous = { ...process.env };
  Object.assign(process.env, { VSUB_WEB: '1', VSUB_SCHEDULER_REQUIRED: 'true', VSUB_NAMESPACE: 'a'.repeat(64), VSUB_SCHEDULER_WORKER_TOKEN: 'private-worker-'.repeat(4) });
  context.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous); });
  const calls = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    const operation = new URL(url).pathname.split('/').at(-1);
    const body = JSON.parse(options.body);
    calls.push({ operation, body, authorization: options.headers.Authorization });
    return Response.json(operation === 'acquire' ? { execution_id: 'receipt' } : { active: true, acknowledged: true });
  });
  return { calls, options: { model: 'builtin/tiny', executionSettings: { threads: 4 }, inputs: { input_bytes: 100 }, run: async () => 'result', stop: async () => true } };
}

test('desktop path preserves existing execution without broker', async context => {
  const state = fixture(context);
  delete process.env.VSUB_WEB;
  assert.equal(await scheduledCompute({ ...state.options, stop: () => assert.fail('desktop disposal changed') }), 'result');
  assert.equal(state.calls.length, 0);
});

test('cancelled queued work never requests a permit or starts a native process', async context => {
  const state = fixture(context);
  await assert.rejects(scheduledCompute({ ...state.options, isCancelled: () => true, run: () => assert.fail('cancelled native work started') }), error => error.status === 409);
  assert.equal(state.calls.length, 0);
});

test('private worker receives only receipt and unloads before stop confirmation', async context => {
  const state = fixture(context);
  const order = [];
  const result = await scheduledCompute({ ...state.options, run: async () => { order.push('run'); return 'output'; }, stop: async () => { order.push('stop'); return true; } });
  assert.equal(result, 'output');
  assert.deepEqual(order, ['run', 'stop']);
  assert.deepEqual(state.calls.map(call => call.operation), ['acquire', 'release']);
  assert.equal(state.calls[0].body.model, 'v-sub-aaaaaaaaaaaa/builtin/tiny');
  assert.equal(state.calls[1].body.stopped, true);
  assert.equal(state.calls[0].authorization, 'Bearer ' + process.env.VSUB_SCHEDULER_WORKER_TOKEN);
  assert.ok(!JSON.stringify(state.calls[0].body).includes(process.env.VSUB_SCHEDULER_WORKER_TOKEN));
});

test('unconfirmed native exit retains unknown stop', async context => {
  const state = fixture(context);
  await assert.rejects(scheduledCompute({ ...state.options, stop: async () => false }), error => error.status === 503);
  assert.equal(state.calls.at(-1).body.stopped, false);
});

test('gateway proof is carried only inside private broker request', async context => {
  const state = fixture(context);
  await withSchedulerHeaders({ 'x-vscheduler-permit-id': 'permit', 'x-vscheduler-execution-token': 'proof', 'x-vscheduler-executor-id': 'executor' }, () => scheduledCompute(state.options));
  assert.deepEqual(state.calls[0].body.gateway, { permit_id: 'permit', execution_token: 'proof', executor_id: 'executor' });
});

test('native calls serialize and cannot nest an unapproved second model', async context => {
  const state = fixture(context);
  await assert.rejects(scheduledCompute({ ...state.options, run: () => scheduledCompute({ ...state.options, model: 'tts/other' }) }), error => error.status === 503);
  assert.equal(state.calls.filter(call => call.operation === 'acquire').length, 1);
  assert.equal(state.calls.at(-1).body.stopped, true);
});
