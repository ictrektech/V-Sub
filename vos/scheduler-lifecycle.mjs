// Root broker 内的生命周期循环；凭据和原生回执不进入用户 worker 或浏览器。
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

export class ApplicationLifecycle {
  constructor({ configuration, controller, executionFor, file }) {
    Object.assign(this, { configuration, controller, executionFor, file });
    this.receipts = new Map(); this.revision = null; this.key = ''; this.pending = null;
    this.timer = null; this.polling = false; this.loaded = false;
  }
  async load() {
    if (!this.loading) this.loading = this.readJournal().catch(error => { this.loading = null; throw error; });
    await this.loading;
  }
  async save() {
    this.writes = (this.writes || Promise.resolve()).catch(() => {}).then(() => this.writeJournal());
    await this.writes;
  }
  async readJournal() {
    if (this.loaded) return;
    try {
      const info = await fs.lstat(this.file);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size > 4194304) throw new Error('Private lifecycle journal required');
      this.receipts = new Map(Object.entries(JSON.parse(await fs.readFile(this.file, 'utf8'))));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.loaded = true;
  }
  async writeJournal() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + randomBytes(8).toString('hex') + '.tmp';
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(Object.fromEntries(this.receipts))); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, this.file);
  }
  async ensure(config) {
    if (config.lifecycle_protocol_version !== 1) return;
    if (this.pending) await this.pending;
    const ids = [...new Set([...Object.values(config.models || {}), ...Object.values(config.gateway_executors || {})])].sort();
    const key = createHash('sha256').update(JSON.stringify([config.url, config.token, ids])).digest('hex');
    if (this.key === key && this.revision !== null) return;
    this.pending = (async () => {
      const current = await this.controller(config, 'GET', '/integrations');
      const revision = current.items.find(item => item.app_id === config.app_id)?.revision || 0;
      const result = await this.controller(config, 'POST', '/integrations', { protocol_version: 1, revision, executors: ids, stop_protocol: 'permit-native-exit-v1' });
      this.key = key; this.revision = result.revision;
    })();
    try { await this.pending; } finally { this.pending = null; }
  }
  start() {
    if (this.timer) return;
    const poll = async () => {
      if (this.polling) return;
      this.polling = true;
      try { await this.tick(); }
      catch { this.key = ''; this.revision = null; }
      finally { this.polling = false; }
    };
    this.timer = setInterval(poll, 2000); this.timer.unref(); void poll();
  }
  async attach(execution) {
    if (execution.config.lifecycle_protocol_version !== 1) return;
    await this.load();
    this.receipts.set(execution.permit, { execution_id: null, expected_id: execution.id, execution_token: execution.proof, stopped: false });
    await this.save();
  }
  async claimed(execution) {
    if (execution.config.lifecycle_protocol_version !== 1) return;
    const receipt = this.receipts.get(execution.permit);
    if (!receipt) throw new Error('Missing private execution journal');
    receipt.execution_id = execution.id; await this.save();
  }
  async finished(execution, stopped) {
    if (execution.config.lifecycle_protocol_version !== 1) return;
    const receipt = this.receipts.get(execution.permit);
    if (receipt) { receipt.stopped = stopped === true; await this.save(); }
  }
  async released(permit) { this.receipts.delete(permit); await this.save(); }
  async tick() {
    const config = await this.configuration();
    if (config.lifecycle_protocol_version !== 1) return;
    await this.load(); await this.ensure(config);
    const reply = await this.controller(config, 'POST', '/integrations/heartbeat', { revision: this.revision });
    for (const command of reply.stop_requests || []) {
      const receipt = this.receipts.get(command.permit_id);
      if (!receipt) continue;
      if (receipt.stopped && receipt.execution_id === null && receipt.expected_id === command.execution_id) receipt.execution_id = command.execution_id;
      if (receipt.execution_id !== command.execution_id) continue;
      const execution = this.executionFor(command.permit_id);
      if (execution) execution.failed = true;
      if (receipt.stopped !== true) continue;
      await this.controller(config, 'POST', `/permits/${command.permit_id}/stopped`, { nonce: command.nonce,
        execution_id: receipt.execution_id, execution_token: receipt.execution_token,
        native_exit_barrier: true, model_unloaded: true, evidence: 'private worker confirmed native process exit and unloaded weights' });
      await this.released(command.permit_id);
    }
    if (reply.complete_execution_snapshot === true) {
      const outstanding = new Set((reply.executions || []).map(item => item.permit_id));
      for (const [permit, receipt] of this.receipts) if (receipt.stopped && !outstanding.has(permit)) this.receipts.delete(permit);
      await this.save();
    }
  }
  close() { clearInterval(this.timer); this.timer = null; }
}
