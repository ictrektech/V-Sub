import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scheduledAudio, withNativeModel, scheduleCancelable, cancelScheduled } from '../../main/helpers/nativeScheduling';
import { assert, test, finish } from './testkit';

async function main() {
  Object.assign(process.env, { VSUB_WEB: '1', VSUB_SCHEDULER_REQUIRED: 'true', VSUB_NAMESPACE: 'a'.repeat(64), VSUB_SCHEDULER_WORKER_TOKEN: 'private'.repeat(8) });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'v-sub-scheduler-'));
  const file = path.join(directory, 'input.wav');
  const wav = Buffer.alloc(44 + 32000);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40);
  fs.writeFileSync(file, wav);
  const requests: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const operation = String(url).split('/').at(-1);
    requests.push({ operation, body: JSON.parse(String(options.body)) });
    return Response.json(operation === 'acquire' ? { execution_id: 'receipt' } : { acknowledged: true });
  };
  try {
    await test('实际 WAV 头和字节数进入准入请求，停止后才释放', async () => {
      requests.length = 0;
      const order: string[] = [];
      const result = await withNativeModel('qwen/model', () => scheduledAudio(file, { threads: 2 }, async () => { order.push('run'); return 'text'; }, async () => { order.push('exit'); return true; }));
      assert.equal(result, 'text');
      assert.deepEqual(order, ['run', 'exit']);
      assert.equal(requests[0].body.inputs.duration_seconds, 1);
      assert.equal(requests[0].body.inputs.input_bytes, wav.length);
      assert.equal(requests.at(-1).body.stopped, true);
    });
    await test('缺少模型身份不启动原生计算', () => {
      assert.throws(() => scheduledAudio(file, {}, async () => assert.fail('started'), async () => true));
    });
    await test('辅助模型使用自己的预算，不借用 ASR 身份', async () => {
      requests.length = 0;
      await withNativeModel('qwen/model', () => scheduledAudio(file, {}, async () => true, async () => true, undefined, {}, 'vad/silero'));
      assert.equal(requests[0].body.model, 'v-sub-aaaaaaaaaaaa/vad/silero');
    });
    await test('取消排队任务不会启动模型或申请许可', async () => {
      requests.length = 0;
      const result = scheduleCancelable('queued', { model: 'qwen/model', executionSettings: {}, inputs: {}, run: async () => assert.fail('started'), stop: async () => true });
      cancelScheduled('queued');
      await assert.rejects(result, (error: any) => error.status === 409);
      assert.equal(requests.length, 0);
    });
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  finish('native scheduling');
}
main();
