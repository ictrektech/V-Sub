import fs from 'node:fs';
import path from 'node:path';
import catalog from '../../catalog/modelhub.json';

export function registeredWhisperWeight(actualFile: string): { reference: string; actualPath: string } {
  const id = path.basename(actualFile).replace(/^ggml-/, '').replace(/\.bin$/, '');
  const model = catalog.find(item => item.group === 'ggml' && item.id === id);
  if (!model || model.required.length !== 1) throw new Error('Registered shared Whisper weight required');
  const root = process.env.MODEL_HUB_EXPORTS_PATH || path.join(process.env.MODEL_HUB_SHARED_MODELS_PATH || '/modelhub', 'export');
  const directory = path.join(root, 'ms', model.repo, 'current');
  const sizes = ('sizes' in model ? model.sizes : {}) as Record<string, number>;
  const mapping = ('mapping' in model ? model.mapping : {}) as Record<string, string>;
  for (const required of model.required) {
    const stat = fs.statSync(path.join(directory, mapping?.[required] || required));
    if (!stat.isFile() || stat.size <= 0 || (sizes?.[required] && stat.size !== sizes[required])) throw new Error('Registered shared Whisper weight is incomplete');
  }
  const reference = path.join(directory, mapping?.[model.required[0]] || model.required[0]);
  const actualPath = fs.realpathSync(actualFile);
  if (actualPath !== fs.realpathSync(reference)) throw new Error('Whisper file is not the registered shared weight');
  return { reference, actualPath };
}
