const { parentPort } = process;
const abort = new AbortController();
parentPort.on('message', ({ data }) => {
  if (data.type === 'cancel') { abort.abort(); return; }
  if (data.type !== 'run') return;
  try {
    const addon = require(data.addon);
    addon.whisper({ ...data.params, signal: abort.signal, progress_callback: percent => parentPort.postMessage({ type: 'progress', percent }) }, (error, result) => {
      parentPort.postMessage(error ? { type: 'error', message: String(error.message || error) } : { type: 'done', result });
    });
  } catch (error) { parentPort.postMessage({ type: 'error', message: String(error.message || error) }); }
});
