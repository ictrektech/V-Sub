import { schedulingOptions, queueWaitSeconds } from './scheduling-options.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

const headersContext = new AsyncLocalStorage();
const executionContext = new AsyncLocalStorage();

export function schedulingRequired() {
  return process.env.VSUB_WEB === '1' && process.env.VSUB_SCHEDULER_REQUIRED === 'true';
}

export function hasScheduledExecution() {
  return Boolean(executionContext.getStore());
}

export function withSchedulerHeaders(headers, work) {
  return headersContext.run(headers, work);
}

export class SchedulingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function broker(operation, body) {
  const namespace = process.env.VSUB_NAMESPACE || '';
  const token = process.env.VSUB_SCHEDULER_WORKER_TOKEN || '';
  if (!/^[a-f0-9]{64}$/.test(namespace) || token.length < 32) throw new SchedulingError(503, 'Private Scheduler worker identity required');
  let response;
  try {
    response = await fetch(`http://127.0.0.1:7090/internal/scheduler/${namespace}/${operation}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(operation === 'acquire' ? ((body.wait_seconds ?? 30) + 8) * 1000 : 8000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { throw new SchedulingError(503, 'Private Scheduler broker unavailable'); }
  let value;
  try { value = await response.json(); }
  catch { throw new SchedulingError(503, 'Invalid private Scheduler response'); }
  if (!response.ok) throw new SchedulingError(response.status, value.error || 'Scheduler admission rejected');
  return value;
}

async function execute(options) {
  if (options.isCancelled?.()) throw new SchedulingError(409, 'Queued computation cancelled');
  const namespace = process.env.VSUB_NAMESPACE || '';
  const model = `v-sub-${namespace.slice(0, 12)}/${options.model}`;
  const headers = headersContext.getStore() || {};
  const gateway = { permit_id: headers['x-vscheduler-permit-id'] || '', execution_token: headers['x-vscheduler-execution-token'] || '', executor_id: headers['x-vscheduler-executor-id'] || '' };
  const scheduling = { priority: 'interactive', ...schedulingOptions(headers) };
  const waitSeconds = queueWaitSeconds(headers);
  const receipt = await broker('acquire', { wait_seconds: waitSeconds, model, execution_settings: options.executionSettings, inputs: options.inputs, gateway, ...(Object.keys(scheduling).length ? { scheduling } : {}), ...(scheduling.force_admission ? { operator_authorization: headers.authorization || '' } : {}) });
  let failed = false, checking = false;
  const timer = setInterval(async () => {
    if (checking || failed) return;
    checking = true;
    try { await broker('verify', receipt); }
    catch {
      failed = true;
      clearInterval(timer);
      try { await options.cancel?.(); } catch {}
    } finally { checking = false; }
  }, 5000);
  timer.unref();
  try {
    if (options.isCancelled?.()) throw new SchedulingError(409, 'Queued computation cancelled');
    const result = await executionContext.run({ model }, options.run);
    if (failed) throw new SchedulingError(503, 'Compute lease lost');
    return result;
  } finally {
    clearInterval(timer);
    let stopped = false;
    try { stopped = await options.stop() === true; }
    finally { await broker('release', { ...receipt, stopped }).catch(() => {}); }
    if (!stopped) throw new SchedulingError(503, 'Native runtime stop was not confirmed');
  }
}

export function scheduledCompute(options) {
  if (!schedulingRequired()) return options.run();
  if (typeof options.run !== 'function' || typeof options.stop !== 'function' || typeof options.model !== 'string' || !options.model) throw new SchedulingError(503, 'Controlled native execution contract required');
  if (executionContext.getStore()) throw new SchedulingError(503, 'Nested local model computation requires an approved joint budget');
  return execute(options);
}

// A metadata-only lookup: the broker authenticates this worker and its current
// binding generation; it returns no controller credentials and acquires no permit.
export function scheduledRuntime(model) {
  const namespace = process.env.VSUB_NAMESPACE || '';
  return broker('plan', { model: `v-sub-${namespace.slice(0, 12)}/${model}` });
}
