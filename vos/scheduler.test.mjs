import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SchedulerBroker } from './scheduler.mjs';

async function fixture(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vsub-scheduler-'));
  const namespace = 'a'.repeat(64), other = 'b'.repeat(64);
  const model = 'v-sub-' + namespace.slice(0, 12) + '/builtin/tiny';
  const workerToken = 'worker-private-'.repeat(4), otherToken = 'other-worker-'.repeat(4);
  const calls = [];
  const settings = { profile: 'l4t', runtime: { threads: 4, provider: 'cpu' } };
  const upstream = `http://v-sub-backend:7090/inference/${namespace}/v1`;
  const worker = { port: 19001, token: 'inference-token', schedulerToken: workerToken, generation: 'c'.repeat(32) };
  const config = { protocol_version: 1, binding_revision: 2, app_id: 'com.ictrek.v-sub', url: 'http://v-router:8080/scheduler/api/v1', token: 'scheduler-service-'.repeat(4), models: { [model]: 'app.model' }, gateway_executors: { [model]: 'gateway.model' }, namespaces: { [model]: namespace }, model_generations: { [model]: worker.generation }, upstreams: { [model]: upstream }, model_limits: { [model]: { input_bytes: 1024, duration_seconds: 60 } }, model_execution_settings: { [model]: settings } };
  const broker = new SchedulerBroker({ dataRoot: directory,
    workerForNamespace: async value => value === namespace ? worker : value === other ? { port: 19002, schedulerToken: otherToken } : null,
    fetcher: async (url, options = {}) => {
      if (url.startsWith('http://127.0.0.1:19001/')) return Response.json({ data: [{ id: model }] });
      const endpoint = new URL(url).pathname.replace('/scheduler/api/v1', '');
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ endpoint, body, key: options.headers?.['Idempotency-Key'] });
      let data = {};
      if (endpoint === '/executors') data = [{ id: 'app.model', app_id: config.app_id, task_type: 'model.infer', contract_version: '1', upstream_urls: [upstream] }];
      if (endpoint === '/permits') data = { permit_id: 'permit' };
      if (endpoint.endsWith('/verify')) data = { state: 'active', lease_seconds: 30 };
      return Response.json({ code: 'OK', data });
    },
  });
  context.after(async () => { for (const execution of broker.executions.values()) clearInterval(execution.timer); await fs.rm(directory, { recursive: true, force: true }); });
  await broker.bind(config);
  calls.length = 0;
  return { broker, config, calls, worker, namespace, other, workerToken, otherToken, model, settings, body: { model, execution_settings: settings, inputs: { input_bytes: 100, duration_seconds: 1 } } };
}

test('private broker never returns Scheduler credentials and releases only after stop evidence', async context => {
  const state = await fixture(context);
  const receipt = await state.broker.acquire(state.namespace, state.workerToken, state.body);
  assert.deepEqual(Object.keys(receipt), ['execution_id']);
  assert.ok(!JSON.stringify(receipt).includes(state.config.token));
  assert.equal(state.calls.filter(call => call.endpoint === '/permits').length, 1);
  assert.equal(state.calls.find(call => call.endpoint.endsWith('/verify')).body.claim, true);
  await state.broker.command(state.namespace, state.workerToken, 'release', { ...receipt, stopped: true });
  assert.equal(state.calls.at(-1).body.stopped, true);
});

test('inference token cannot authenticate private broker', async context => {
  const state = await fixture(context);
  await assert.rejects(state.broker.acquire(state.namespace, 'inference-token', state.body), error => error.status === 401);
  assert.equal(state.calls.length, 0);
});

test('full namespace isolates execution receipts', async context => {
  const state = await fixture(context);
  const receipt = await state.broker.acquire(state.namespace, state.workerToken, state.body);
  await assert.rejects(state.broker.command(state.other, state.otherToken, 'release', { ...receipt, stopped: true }), error => error.status === 404);
  assert.equal(state.broker.executions.size, 1);
});

test('inherited gateway permit is claimed without a second reservation', async context => {
  const state = await fixture(context);
  const receipt = await state.broker.acquire(state.namespace, state.workerToken, { ...state.body, gateway: { permit_id: 'gateway-permit', executor_id: 'gateway.model', execution_token: 'proof-'.repeat(8) } });
  await state.broker.command(state.namespace, state.workerToken, 'release', { ...receipt, stopped: true });
  assert.equal(state.calls.filter(call => call.endpoint === '/permits').length, 0);
  assert.equal(state.calls.filter(call => call.endpoint.endsWith('/release')).length, 0);
  assert.equal(state.calls[0].body.executor_id, 'gateway.model');
});

test('nested runtime changes, oversized or missing inputs fail before admission', async context => {
  const state = await fixture(context);
  for (const body of [{ ...state.body, execution_settings: { ...state.settings, runtime: { threads: 8, provider: 'cpu' } } }, { ...state.body, inputs: { input_bytes: 2048, duration_seconds: 1 } }, { ...state.body, inputs: {} }]) {
    await assert.rejects(state.broker.acquire(state.namespace, state.workerToken, body), error => error.status === 422);
  }
  assert.equal(state.calls.length, 0);
});

test('binding preserves private permissions, idempotency and monotonic revisions', async context => {
  const state = await fixture(context);
  assert.equal((await fs.stat(state.broker.file)).mode & 0o777, 0o600);
  await state.broker.bind(state.config);
  await assert.rejects(state.broker.bind({ ...state.config, binding_revision: 1 }), error => error.status === 409);
  const result = await Promise.allSettled([state.broker.bind({ ...state.config, binding_revision: 4 }), state.broker.bind({ ...state.config, binding_revision: 3 })]);
  assert.equal(result[0].status, 'fulfilled');
  assert.equal(result[1].status, 'rejected');
  assert.equal((await state.broker.configuration()).binding_revision, 4);
});

test('worker exit is unknown stop and does not silently free its reservation', async context => {
  const state = await fixture(context);
  await state.broker.acquire(state.namespace, state.workerToken, state.body);
  await state.broker.workerExited(state.namespace);
  assert.equal(state.calls.at(-1).body.stopped, false);
  assert.equal(state.broker.executions.size, 1);
});

test('worker restart rejects old generation until a matching new binding arrives', async context => {
  const state = await fixture(context);
  state.worker.generation = 'd'.repeat(32);
  await assert.rejects(state.broker.acquire(state.namespace, state.workerToken, state.body), error => error.status === 503);
  await assert.rejects(state.broker.bind({ ...state.config, binding_revision: 3 }), error => error.status === 503);
  assert.equal(state.calls.filter(call => call.endpoint === '/permits').length, 0);
  await state.broker.bind({ ...state.config, binding_revision: 3, model_generations: { [state.model]: state.worker.generation } });
  const receipt = await state.broker.acquire(state.namespace, state.workerToken, state.body);
  await state.broker.command(state.namespace, state.workerToken, 'release', { ...receipt, stopped: true });
});
