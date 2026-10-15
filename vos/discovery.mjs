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
  return { ...empty, base_path: `/inference/${user.namespace}/v1`, api_key: worker.token, models: payload.data || [] };
}
