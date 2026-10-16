const { app, utilityProcess } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-whisper-'));
  const addon = path.join(directory, 'test-addon.cjs');
  fs.writeFileSync(addon, "exports.whisper = (params, done) => { if (process.env.VSUB_SCHEDULER_WORKER_TOKEN) return done(new Error('private token inherited')); if (!(params.signal instanceof AbortSignal)) return done(new Error('missing abort signal')); params.progress_callback(50); done(null, { transcription: [[0, 100, 'synthetic test']] }); };");
  let child;
  try {
    const env = { ...process.env };
    delete env.VSUB_SCHEDULER_WORKER_TOKEN;
    child = utilityProcess.fork(path.resolve(__dirname, '../extraResources/whisper-scheduled-worker.cjs'), [], { stdio: 'pipe', env });
    const result = await new Promise((resolve, reject) => {
      let progress = false;
      const timer = setTimeout(() => reject(new Error('worker response timed out')), 15000);
      child.on('message', message => {
        if (message.type === 'progress') { assert.equal(message.percent, 50); progress = true; }
        else if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.message)); }
        else if (message.type === 'done') { clearTimeout(timer); assert.ok(progress); resolve(message.result); }
      });
      child.on('exit', code => { clearTimeout(timer); reject(new Error('early exit ' + code)); });
      child.postMessage({ type: 'run', addon, params: { model: 'synthetic-only' } });
    });
    assert.equal(result.transcription[0][2], 'synthetic test');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('native worker exit not confirmed')), 10000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
    console.log('Scheduled Whisper real utilityProcess IPC, progress, abort signal and exit PASS (synthetic addon, not model inference)');
    app.exit(0);
  } catch (error) {
    child?.kill();
    console.error(error);
    app.exit(1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
