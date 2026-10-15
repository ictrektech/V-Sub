import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { discoverLocalModels } from './discovery.mjs';

test('discovery never creates a worker and empty snapshots contain no secrets', async()=>{
 const result=await discoverLocalModels({subject:'alice',namespace:'a'.repeat(64)},undefined);
 assert.equal(result.owner,'alice');assert.deepEqual(result.models,[]);assert.equal(result.api_key,undefined);assert.equal(result.visibility,'private');
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
