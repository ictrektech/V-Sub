import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registeredWhisperWeight } from '../../main/vos/registeredWhisper';
import { assert, test, finish } from './testkit';

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vsub-registered-whisper-'));
  const previous = process.env.MODEL_HUB_EXPORTS_PATH;
  process.env.MODEL_HUB_EXPORTS_PATH = path.join(directory, 'export');
  const reference = path.join(process.env.MODEL_HUB_EXPORTS_PATH, 'ms/vivibit/v-sub-whisper-tiny-q5_1/current/ggml-tiny-q5_1.bin');
  const privateFile = path.join(directory, 'private/ggml-tiny-q5_1.bin');
  fs.mkdirSync(path.dirname(reference), { recursive: true });
  fs.mkdirSync(path.dirname(privateFile), { recursive: true });
  fs.writeFileSync(reference, 'registered-weight');
  try {
    await test('用户符号链接只在真实目标等于注册共享权重时归一', () => {
      fs.symlinkSync(reference, privateFile);
      const result = registeredWhisperWeight(privateFile);
      assert.equal(result.reference, reference);
      assert.equal(result.actualPath, fs.realpathSync(reference));
    });
    await test('同名同内容但不同文件不能套用共享权重校准', () => {
      fs.unlinkSync(privateFile);
      fs.copyFileSync(reference, privateFile);
      assert.throws(() => registeredWhisperWeight(privateFile), /not the registered shared weight/);
    });
    await test('指向另一用户同名文件的链接不能套用共享权重校准', () => {
      fs.renameSync(privateFile, privateFile + '.other');
      fs.symlinkSync(privateFile + '.other', privateFile);
      assert.throws(() => registeredWhisperWeight(privateFile), /not the registered shared weight/);
    });
    await test('不完整注册权重与未知模型拒绝归一', () => {
      fs.writeFileSync(reference, '');
      assert.throws(() => registeredWhisperWeight(privateFile), /incomplete/);
      assert.throws(() => registeredWhisperWeight(path.join(directory, 'unknown.bin')), /required/);
    });
  } finally {
    if (previous === undefined) delete process.env.MODEL_HUB_EXPORTS_PATH;
    else process.env.MODEL_HUB_EXPORTS_PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  finish('registered Whisper weights');
}
void main();
