// Discovery is authenticated per VOS user. Never enumerate another user's worker
// or start a heavyweight runtime merely because V-Router probes the service.
export async function discoverLocalModels(user, pending) {
  const empty = { service_id: 'v-sub', name: 'V-Sub local models', owner: user.subject, visibility: 'private', protocol: 'openai', models: [] };
  if (!pending) return empty;
  const worker = await pending;
  const response = await fetch(`http://127.0.0.1:${worker.port}/v1/models`, {
    headers: { Authorization: `Bearer ${worker.token}` }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Local model discovery unavailable');
  const payload = await response.json();
  return { ...empty, base_path: `/inference/${user.namespace}/v1`, api_key: worker.token, models: payload.data || [], scheduler: {
    protocol_version: 1, app_id: 'com.ictrek.v-sub', binding_endpoint: '/api/v1/scheduler/binding',
    namespace: user.namespace, upstream_url: `http://v-sub-backend:7090/inference/${user.namespace}/v1`,
    models: (payload.data || []).map(model => ({ id: model.id, task_type: 'model.infer' })),
  } };
}

export async function discoverSchedulerModels(workers, fetcher = fetch) {
  const models = [];
  for (const [namespace, pending] of workers) {
    if (!/^[a-f0-9]{64}$/.test(namespace)) throw new Error('Invalid private worker namespace');
    const worker = await pending;
    if (!/^[a-f0-9]{32}$/.test(worker.generation || '')) throw new Error('Invalid private worker generation');
    if (!Number.isInteger(worker.port) || worker.port < 1 || worker.port > 65535) throw new Error('Invalid private worker endpoint');
    const response = await fetcher(`http://127.0.0.1:${worker.port}/v1/models`, { headers: { Authorization: `Bearer ${worker.token}` }, redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Private worker discovery unavailable');
    const text = await response.text();
    if (text.length > 1048576) throw new Error('Private worker discovery too large');
    const rows = JSON.parse(text).data;
    if (!Array.isArray(rows) || rows.length > 512) throw new Error('Invalid private model catalog');
    const prefix = `v-sub-${namespace.slice(0, 12)}/`;
    for (const row of rows) {
      if (typeof row.id !== 'string' || !row.id.startsWith(prefix) || !row.id.slice(prefix.length) || row.id.includes('..')) throw new Error('Invalid private model identity');
      models.push({ id: row.id, native_id: row.id.slice(prefix.length), namespace, generation: worker.generation, task_type: 'model.infer', upstream_url: `http://v-sub-backend:7090/inference/${namespace}/v1` });
      if (models.length > 512) throw new Error('Private model catalog exceeds binding capacity');
    }
  }
  return { protocol_version: 1, app_id: 'com.ictrek.v-sub', capabilities: ['namespace-inference-v1'], binding_endpoint: '/api/v1/scheduler/binding', models };
}
