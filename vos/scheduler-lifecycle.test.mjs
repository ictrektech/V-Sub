import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApplicationLifecycle } from './scheduler-lifecycle.mjs';

async function fixture(context) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vsub-lifecycle-'));
  context.after(()=>fs.rm(root,{recursive:true,force:true}));
  const config={app_id:'application',url:'http://scheduler',token:'private-service-token',lifecycle_protocol_version:1,models:{model:'approved'},gateway_executors:{model:'gateway'}};
  const execution={config,permit:'permit',id:'native-execution',proof:'private-execution-proof',failed:false};
  const state={commands:[],acks:[],registrations:[],outstanding:[{permit_id:'permit'}]};
  const options={file:path.join(root,'journal.json'),configuration:async()=>config,executionFor:()=>execution,controller:async(_config,method,endpoint,body)=>{
    if(endpoint==='/integrations'&&method==='GET')return {items:[]};
    if(endpoint==='/integrations'){state.registrations.push(body);return {revision:1};}
    if(endpoint==='/integrations/heartbeat')return {stop_requests:state.commands,executions:state.outstanding,complete_execution_snapshot:true};
    state.acks.push(body);return {state:'released'};
  }};
  return {...state,state,options,config,execution,client:new ApplicationLifecycle(options)};
}

test('registers only approved executors and never declares its own budget',async context=>{
  const {client,state}=await fixture(context);await client.tick();await client.tick();
  assert.equal(state.registrations.length,1);assert.deepEqual(state.registrations[0].executors,['approved','gateway']);assert.equal(state.registrations[0].resources,undefined);
});
test('stop marks worker lease invalid but only native completion releases the permit',async context=>{
  const {client,state,execution}=await fixture(context);await client.attach(execution);await client.claimed(execution);
  state.commands=[{permit_id:'permit',execution_id:execution.id,nonce:'challenge'}];
  await client.tick();assert.equal(execution.failed,true);assert.equal(state.acks.length,0);
  await client.finished(execution,false);await client.tick();assert.equal(state.acks.length,0);
  await client.finished(execution,true);await client.tick();assert.equal(state.acks[0].native_exit_barrier,true);assert.equal(state.acks[0].model_unloaded,true);assert.equal(state.acks[0].execution_token,execution.proof);
});
test('confirmed receipt survives restart and uses private journal permissions',async context=>{
  const {client,state,execution,options}=await fixture(context);await client.attach(execution);await client.claimed(execution);await client.finished(execution,true);
  state.commands=[{permit_id:'permit',execution_id:execution.id,nonce:'challenge'}];
  const restored=new ApplicationLifecycle(options);await restored.tick();assert.equal(state.acks.length,1);assert.equal((await fs.stat(options.file)).mode&0o777,0o600);
});
test('unknown execution after restart and mismatched command cannot free resources',async context=>{
  const {client,state,execution,options}=await fixture(context);await client.attach(execution);await client.claimed(execution);
  state.commands=[{permit_id:'permit',execution_id:'someone-else',nonce:'challenge'}];await client.tick();assert.equal(execution.failed,false);
  state.commands[0].execution_id=execution.id;await new ApplicationLifecycle(options).tick();assert.equal(state.acks.length,0);
});
test('claim response loss is reconciled only after native exit',async context=>{
  const {client,state,execution}=await fixture(context);await client.attach(execution);state.commands=[{permit_id:'permit',execution_id:execution.id,nonce:'challenge'}];await client.tick();assert.equal(state.acks.length,0);
  await client.finished(execution,true);await client.tick();assert.equal(state.acks[0].execution_id,execution.id);
});
