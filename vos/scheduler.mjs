import fs from 'node:fs/promises';
import { ApplicationLifecycle } from './scheduler-lifecycle.mjs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const appId = 'com.ictrek.v-sub';
const schedulerUrl = 'http://v-scheduler:8080/scheduler/api/v1';
const trustedScheduler = url => [schedulerUrl, 'http://v-router:8080/scheduler/api/v1', 'http://v-scheduler-gateway:8080/scheduler/api/v1'].includes(url);
const equal = (left, right) => {
  const actual = Buffer.from(left || ''), expected = Buffer.from(right || '');
  return actual.length === expected.length && actual.length >= 32 && timingSafeEqual(actual, expected);
};
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const canonical = value => JSON.stringify(ordered(value));

export class SchedulerError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class SchedulerBroker {
  constructor({ dataRoot, workerForNamespace, fetcher = fetch }) {
    this.file = path.join(dataRoot, 'scheduler.local.json');
    this.workerForNamespace = workerForNamespace;
    this.fetcher = fetcher;
    this.executions = new Map();
    this.bindingQueue = Promise.resolve();
    this.bindingBusy = false;
    this.pendingAcquisitions = 0;
    this.lifecycle = new ApplicationLifecycle({ configuration: () => this.configuration(),
      controller: (...args) => this.controller(...args), file: path.join(dataRoot, 'scheduler.lifecycle.json'),
      executionFor: permit => [...this.executions.values()].find(execution => execution.permit === permit) });
    if (process.env.VSUB_SCHEDULER_REQUIRED === 'true') this.lifecycle.start();
  }

  async configuration() {
    try {
      const info = await fs.lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 262144) throw new Error();
      const config = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (config.app_id !== appId || !trustedScheduler(config.url) || typeof config.token !== 'string' || config.token.length < 32) throw new Error();
      return config;
    } catch { throw new SchedulerError(503, 'V-Scheduler binding required'); }
  }

  async controller(config, method, endpoint, body, key, operator = '') {
    let response;
    try {
      response = await this.fetcher(config.url + endpoint, {
        method, redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}`, ...(key ? { 'Idempotency-Key': key } : {}), ...(operator ? { 'X-VScheduler-Admin-Authorization': operator } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 429) throw new SchedulerError(429, 'Compute resources busy');
      if (!response.ok) throw new Error();
      const value = await response.json();
      if (value.code !== 'OK') throw new Error();
      return value.data;
    } catch (error) {
      if (error instanceof SchedulerError) throw error;
      throw new SchedulerError(503, 'V-Scheduler unavailable');
    }
  }

  async worker(namespace, token) {
    if (!/^[a-f0-9]{64}$/.test(namespace || '')) throw new SchedulerError(403, 'Invalid worker namespace');
    const worker = await this.workerForNamespace(namespace);
    if (!worker || !equal(token, worker.schedulerToken)) throw new SchedulerError(401, 'Private worker identity required');
    return worker;
  }

  async model(config, namespace, model) {
    const upstream = `http://v-sub-backend:7090/inference/${namespace}/v1`;
    if (!model?.startsWith(`v-sub-${namespace.slice(0, 12)}/`) || config.namespaces?.[model] !== namespace || config.upstreams?.[model] !== upstream || !config.models?.[model]) {
      throw new SchedulerError(503, 'Private model is not approved');
    }
    const worker = await this.workerForNamespace(namespace);
    if (!worker) throw new SchedulerError(503, 'Private worker unavailable');
    const generation = config.model_generations?.[model];
    if (!/^[a-f0-9]{32}$/.test(generation || '') || generation !== worker.generation) throw new SchedulerError(503, 'Worker generation needs a new Scheduler binding');
    const response = await this.fetcher(`http://127.0.0.1:${worker.port}/v1/models`, { headers: { Authorization: `Bearer ${worker.token}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok || !(await response.json()).data?.some(row => row.id === model)) throw new SchedulerError(503, 'Private model is not ready');
    return upstream;
  }

  bind(config) {
    const request = this.bindingQueue.then(() => this.applyBinding(config));
    this.bindingQueue = request.catch(() => {});
    return request;
  }

  async applyBinding(config) {
    if (config?.protocol_version !== 1 || !Number.isSafeInteger(config.binding_revision) || config.binding_revision < 1 || config.app_id !== appId || !trustedScheduler(config.url) || typeof config.token !== 'string' || config.token.length < 32 || config.token.length > 4096 || /\s/.test(config.token)) {
      throw new SchedulerError(422, 'Invalid Scheduler binding');
    }
    const models = Object.entries(config.models || {});
    if (!models.length || models.length > 512 || !config.model_limits || !config.model_execution_settings) throw new SchedulerError(422, 'Model calibration required');
    const executors = await this.controller(config, 'GET', '/executors');
    for (const [model, executor] of models) {
      const namespace = config.namespaces?.[model];
      if (!/^[a-f0-9]{64}$/.test(namespace || '')) throw new SchedulerError(422, 'Full namespace required');
      if (!/^[a-f0-9]{32}$/.test(config.model_generations?.[model] || '')) throw new SchedulerError(422, 'Worker generation required');
      const upstream = await this.model(config, namespace, model);
      if (!executors.some(row => row.id === executor && row.app_id === appId && row.task_type === 'model.infer' && row.contract_version === '1' && row.upstream_urls?.includes(upstream))) throw new SchedulerError(422, 'Executor is not approved for this private model');
      if (!config.model_limits[model] || !config.model_execution_settings[model]) throw new SchedulerError(422, 'Model calibration required');
    }
    const exists = await fs.lstat(this.file).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
    const previous = exists ? await this.configuration() : null;
    if (previous && previous.binding_revision >= config.binding_revision) {
      if (previous.binding_revision === config.binding_revision && canonical(previous) === canonical(config)) return;
      throw new SchedulerError(409, 'Binding revision conflict');
    }
    this.bindingBusy = true;
    try {
      if (this.executions.size || this.pendingAcquisitions) throw new SchedulerError(409, 'Binding waits for active execution');
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = this.file + '.' + randomBytes(8).toString('hex') + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.file);
    } finally { this.bindingBusy = false; }
  }

  async acquire(namespace, token, body) {
    await this.worker(namespace, token);
    if (this.bindingBusy) throw new SchedulerError(503, 'Binding update in progress');
    this.pendingAcquisitions += 1;
    try { return await this.acquirePermit(namespace, body); }
    finally { this.pendingAcquisitions -= 1; }
  }

  async acquirePermit(namespace, body) {
    const config = await this.configuration();
    await this.lifecycle.ensure(config);
    const upstream = await this.model(config, namespace, body.model);
    if (canonical(body.execution_settings) !== canonical(config.model_execution_settings[body.model])) throw new SchedulerError(422, 'Runtime settings are not calibrated');
    if (canonical(Object.keys(body.inputs || {}).sort()) !== canonical(Object.keys(config.model_limits?.[body.model] || {}).sort())) throw new SchedulerError(422, 'Complete calibrated input metrics required');
    for (const [field, value] of Object.entries(body.inputs || {})) {
      const maximum = config.model_limits?.[body.model]?.[field];
      if (typeof maximum !== 'number' || !Number.isFinite(maximum) || maximum < 0) throw new SchedulerError(503, 'Calibrated input limit required');
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) throw new SchedulerError(422, 'Input exceeds calibrated limit');
    }
    const id = randomBytes(24).toString('hex');
    const execution = { id, namespace, model: body.model, upstream, config, executor: config.models[body.model], proof: randomBytes(32).toString('hex'), owned: true, failed: false };
    const inherited = body.gateway || {};
    if (inherited.permit_id || inherited.execution_token || inherited.executor_id) {
      if (!inherited.permit_id || typeof inherited.execution_token !== 'string' || inherited.execution_token.length < 32 || inherited.executor_id !== config.gateway_executors?.[body.model]) throw new SchedulerError(503, 'Invalid gateway admission proof');
      Object.assign(execution, { permit: inherited.permit_id, proof: inherited.execution_token, executor: inherited.executor_id, owned: false });
    } else {
      const permit = await this.controller(config, 'POST', '/permits', { executor_id: execution.executor, model_id: body.model, upstream_url: upstream, execution_token: execution.proof, ...(body.scheduling ? { scheduling: body.scheduling } : {}) }, id, body.scheduling?.force_admission ? body.operator_authorization || '' : '');
      execution.permit = permit.permit_id;
    }
    if (!execution.permit) throw new SchedulerError(503, 'Missing admission receipt');
    await this.lifecycle.attach(execution);
    try { await this.verify(execution, true); await this.lifecycle.claimed(execution); }
    catch (error) {
      await this.lifecycle.finished(execution, true);
      if (execution.owned) await this.controller(config, 'POST', `/permits/${execution.permit}/release`, { stopped: true, evidence: 'worker_not_started' }).then(() => this.lifecycle.released(execution.permit)).catch(() => {});
      throw error;
    }
    this.executions.set(id, execution);
    execution.timer = setInterval(async () => {
      if (execution.renewing || execution.failed) return;
      execution.renewing = true;
      try {
        if (execution.owned) await this.controller(config, 'POST', `/permits/${execution.permit}/renew`, {});
        await this.verify(execution);
      } catch { execution.failed = true; clearInterval(execution.timer); }
      finally { execution.renewing = false; }
    }, 5000);
    execution.timer.unref();
    return { execution_id: id };
  }

  async verify(execution, claim = false) {
    const value = await this.controller(execution.config, 'POST', `/permits/${execution.permit}/verify`, { executor_id: execution.executor, model_id: execution.model, upstream_url: execution.upstream, execution_token: execution.proof, execution_id: execution.id, claim });
    if (value.state !== 'active' || value.lease_seconds < 1) throw new SchedulerError(503, 'Compute lease expired');
  }

  async command(namespace, token, operation, body) {
    if (operation === 'acquire') return this.acquire(namespace, token, body);
    await this.worker(namespace, token);
    const execution = this.executions.get(body.execution_id);
    if (!execution || execution.namespace !== namespace) throw new SchedulerError(404, 'Execution not found');
    if (operation === 'verify') {
      if (execution.failed) throw new SchedulerError(503, 'Compute lease lost');
      await this.verify(execution);
      return { active: true };
    }
    if (operation !== 'release') throw new SchedulerError(404, 'Operation not found');
    clearInterval(execution.timer);
    await this.lifecycle.finished(execution, body.stopped === true);
    if (execution.owned) {
      try {
        await this.controller(execution.config, 'POST', `/permits/${execution.permit}/release`, { stopped: body.stopped === true, evidence: body.stopped === true ? 'private_worker_confirmed_native_runtime_exit' : 'private_worker_stop_not_confirmed' });
        if (body.stopped === true && execution.config.lifecycle_protocol_version === 1) await this.lifecycle.released(execution.permit);
      } catch (error) { if (execution.config.lifecycle_protocol_version !== 1) throw error; }
    }
    this.executions.delete(execution.id);
    return { acknowledged: true, stopped: body.stopped === true };
  }

  async workerExited(namespace) {
    for (const execution of this.executions.values()) {
      if (execution.namespace !== namespace) continue;
      clearInterval(execution.timer);
      execution.failed = true;
      if (execution.owned) await this.controller(execution.config, 'POST', `/permits/${execution.permit}/release`, { stopped: false, evidence: 'worker_exited_without_native_exit_confirmation' }).catch(() => {});
    }
  }
}
