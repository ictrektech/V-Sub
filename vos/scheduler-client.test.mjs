import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduledCompute, scheduledRuntime, withSchedulerHeaders } from './scheduler-client.mjs';

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

test('native calls cannot nest an unapproved second model', async context => {
  const state = fixture(context);
  await assert.rejects(scheduledCompute({ ...state.options, run: () => scheduledCompute({ ...state.options, model: 'tts/other' }) }), error => error.status === 503);
  assert.equal(state.calls.filter(call => call.operation === 'acquire').length, 1);
  assert.equal(state.calls.at(-1).body.stopped, true);
});


test('task scheduling options are carried to broker and invalid values never execute', async context => {
  const state = fixture(context);
  await withSchedulerHeaders({ 'x-vscheduler-priority': 'high', 'x-vscheduler-preemptible': 'true', 'x-vscheduler-allow-preemption': 'true' }, () => scheduledCompute(state.options));
  assert.deepEqual(state.calls[0].body.scheduling, { priority: 'high', preemptible: true, allow_preemption: true });
  state.calls.length = 0;
  await assert.rejects(withSchedulerHeaders({ 'x-vscheduler-preemptible': '1' }, () => scheduledCompute(state.options)), error => error.status === 422);
  assert.equal(state.calls.length, 0);
});


test('root proxy carries only scheduling intent, never copies caller credentials', async () => {
  const { forwardedSchedulingHeaders } = await import('./scheduling-options.mjs');
  assert.deepEqual(forwardedSchedulingHeaders({ authorization: 'Bearer synthetic', 'x-vscheduler-priority': 'high', 'x-vscheduler-allow-preemption': 'true' }), { 'x-vscheduler-priority': 'high', 'x-vscheduler-allow-preemption': 'true' });
  assert.throws(() => forwardedSchedulingHeaders({ 'x-vscheduler-force-admission': '1' }), error => error.status === 422);
});


test('concurrent requests reach central admission before the active native call finishes', async context => {
  const state = fixture(context);
  let finishFirst, admitSecond;
  const firstGate = new Promise(resolve => { finishFirst = resolve; });
  const secondGate = new Promise(resolve => { admitSecond = resolve; });
  let admissions = 0;
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    const operation = new URL(url).pathname.split('/').at(-1);
    if (operation === 'acquire') {
      admissions++;
      if (admissions === 2) await secondGate;
      return Response.json({ execution_id: 'receipt-' + admissions });
    }
    return Response.json({ acknowledged: true });
  });
  let secondRan = false;
  const first = scheduledCompute({ ...state.options, run: () => firstGate });
  const second = withSchedulerHeaders({ 'x-vscheduler-priority': 'high' }, () => scheduledCompute({ ...state.options, run: async () => { secondRan = true; } }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admissions, 2);
  assert.equal(secondRan, false);
  finishFirst('first');
  await first;
  admitSecond();
  await second;
  assert.equal(secondRan, true);
});

test('queue wait is bounded, defaults to thirty seconds and crosses the root proxy', async context => {
  const state = fixture(context);
  const { forwardedSchedulingHeaders } = await import('./scheduling-options.mjs');
  await scheduledCompute(state.options);
  assert.equal(state.calls[0].body.wait_seconds, 30);
  assert.equal(state.calls[0].body.scheduling.priority, 'interactive');
  state.calls.length = 0;
  await withSchedulerHeaders({ 'x-vscheduler-queue-wait-seconds': '0' }, () => scheduledCompute(state.options));
  assert.equal(state.calls[0].body.wait_seconds, 0);
  for (const value of ['-1', '301', '1.2', 'bad']) {
    await assert.rejects(withSchedulerHeaders({ 'x-vscheduler-queue-wait-seconds': value }, () => scheduledCompute(state.options)), error => error.status === 422);
  }
  assert.deepEqual(forwardedSchedulingHeaders({ 'x-vscheduler-queue-wait-seconds': '7' }), { 'x-vscheduler-queue-wait-seconds': '7' });
});


test('runtime planning qualifies the model and never acquires or releases a permit', async context => {
  const state = fixture(context);
  await scheduledRuntime('builtin/tiny');
  assert.deepEqual(state.calls.map(call => call.operation), ['plan']);
  assert.equal(state.calls[0].body.model, 'v-sub-aaaaaaaaaaaa/builtin/tiny');
});
