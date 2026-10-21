import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('aggregate discovery requires Scheduler application identity and never starts workers', async () => {
  const identity = http.createServer((request, response) => {
    const token = request.headers.authorization;
    response.setHeader('Content-Type', 'application/json');
    if (token?.startsWith('Bearer legacy-')) {
      if (request.url === '/v1000/user/check') {
        response.end(JSON.stringify({ code: token === 'Bearer legacy-expired' ? 10001 : 0, data: { id: 'context-user', username: token === 'Bearer legacy-admin' ? 'admin' : 'com.ictrek.v-scheduler', role_code: 'system_admin', enable: token === 'Bearer legacy-disabled' ? 0 : 1, delete: 0 } }));
      } else {
        response.statusCode = 401; response.end(JSON.stringify({ error: 'invalid_token' }));
      }
      return;
    }
    response.end(JSON.stringify({ sub: token === 'Bearer trusted' || token === 'Bearer disabled' ? 'com.ictrek.v-scheduler' : 'admin', enable: token === 'Bearer disabled' ? 0 : 1 }));
  });
  identity.listen(0, '127.0.0.1'); await once(identity, 'listening');
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vsub-trusted-discovery-'));
  const child = spawn(process.execPath, [new URL('./gateway.mjs', import.meta.url).pathname], { env: { ...process.env, PORT: String(port), VSUB_DATA_DIR: directory, VOS_OIDC_USERINFO_URL: `http://127.0.0.1:${identity.address().port}/userinfo` }, stdio: 'ignore' });
  const origin = `http://127.0.0.1:${port}`;
  try {
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { if ((await fetch(origin + '/health')).ok) { started = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.ok(started, 'isolated gateway did not start');
    for (const token of ['', 'admin', 'disabled']) {
      const response = await fetch(origin + '/api/v1/scheduler/discovery', { headers: { Authorization: 'Bearer ' + token } });
      assert.equal(response.status, 403);
    }
    for (const token of ['legacy-admin', 'legacy-disabled', 'legacy-expired']) {
      assert.equal((await fetch(origin + '/api/v1/scheduler/discovery', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
    }
    assert.equal((await fetch(origin + '/api/v1/scheduler/discovery', { headers: { Authorization: 'Bearer legacy-scheduler' } })).status, 200);
    const response = await fetch(origin + '/api/v1/scheduler/discovery', { headers: { Authorization: 'Bearer trusted' } });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual(value.models, []);
    assert.deepEqual(value.capabilities, ['namespace-inference-v1', 'canonical-v-scheduler-v1']);
    assert.equal((await (await fetch(origin + '/health')).json()).workers, 0);
    assert.equal((await fetch(origin + '/api/v1/scheduler/discovery', { method: 'POST', headers: { Authorization: 'Bearer trusted' } })).status, 405);
  } finally {
    const exited = once(child, 'exit'); child.kill(); await exited;
    identity.closeAllConnections(); identity.close();
    await rm(directory, { recursive: true, force: true });
  }
});
