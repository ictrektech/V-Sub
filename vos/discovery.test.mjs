import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { discoverLocalModels, discoverSchedulerModels } from './discovery.mjs';

test('discovery never creates a worker and empty snapshots contain no secrets', async()=>{
 const result=await discoverLocalModels({subject:'alice',namespace:'a'.repeat(64)},undefined);
 assert.equal(result.owner,'alice');assert.deepEqual(result.models,[]);assert.equal(result.api_key,undefined);assert.equal(result.visibility,'private');
});

test('trusted Scheduler discovery only enumerates existing workers and strips private credentials', async () => {
  const namespace = 'a'.repeat(64);
  const id = 'v-sub-' + namespace.slice(0, 12) + '/builtin/tiny-q5_1';
  const result = await discoverSchedulerModels(new Map([[namespace, Promise.resolve({ port: 19001, token: 'inference-secret', schedulerToken: 'broker-secret', username: 'private-user' })]]), async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:19001/v1/models');
    assert.equal(options.headers.Authorization, 'Bearer inference-secret');
    return new Response(JSON.stringify({ data: [{ id, token: 'never-copy', owner: 'private-user' }] }));
  });
  assert.deepEqual(result.models, [{ id, native_id: 'builtin/tiny-q5_1', namespace, task_type: 'model.infer', upstream_url: `http://v-sub-backend:7090/inference/${namespace}/v1` }]);
  assert.ok(!/secret|private-user|never-copy/.test(JSON.stringify(result)));
  assert.deepEqual((await discoverSchedulerModels(new Map(), () => assert.fail('empty discovery must not start a worker'))).models, []);
});

test('trusted Scheduler discovery rejects short namespaces and cross-namespace model identities', async () => {
  await assert.rejects(discoverSchedulerModels(new Map([['a'.repeat(12), {}]])), /namespace/);
  await assert.rejects(discoverSchedulerModels(new Map([['a'.repeat(64), { port: 19001, token: 'secret' }]]), async () => new Response(JSON.stringify({ data: [{ id: 'v-sub-bbbbbbbbbbbb/builtin/tiny-q5_1' }] }))), /identity/);
});
test('discovery reads only the authenticated user worker and retains model capabilities',async()=>{
 const server=http.createServer((req,res)=>{
  assert.equal(req.url,'/v1/models');assert.equal(req.headers.authorization,'Bearer worker-secret');
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'local/asr',kind:'asr',endpoints:['audio/transcriptions'],capabilities:['asr']}]}));
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try {
  const result=await discoverLocalModels({subject:'alice',namespace:'a'.repeat(64)},Promise.resolve({port:server.address().port,token:'worker-secret'}));
  assert.equal(result.owner,'alice');assert.equal(result.base_path,`/inference/${'a'.repeat(64)}/v1`);assert.equal(result.api_key,'worker-secret');assert.deepEqual(result.models[0].endpoints,['audio/transcriptions']);
 } finally {server.closeAllConnections();server.close();}
});
