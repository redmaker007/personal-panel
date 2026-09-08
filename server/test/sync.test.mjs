import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainOutbox } from '../../assets/sf-sync.mjs';
const vault = () => ({clientId:'browser',sessions:[{id:'session',token:'secret',catalogVersion:'sf2.1',version:1,seq:2,ack:0,created:false,events:[{seq:1,type:'view'},{seq:2,type:'answer'}]}]});
test('offline sessions survive reload and uncertain responses retry identical events without loss',async()=>{
  const v=vault();let serialized=JSON.stringify(v),committed=0;
  const persist=()=>serialized=JSON.stringify(v);
  await assert.rejects(drainOutbox(v,async()=>{throw new Error('offline');},persist));
  assert.equal(v.sessions[0].events.length,2);
  await assert.rejects(drainOutbox(v,async(path,body)=>{
    if(path==='/sessions')return {seq:0};
    committed=body.events.at(-1).seq;throw new Error('response lost');
  },persist));
  const restored=JSON.parse(serialized);
  assert.equal(restored.sessions[0].events.length,2);assert.equal(committed,2);
  const requests=[];
  await drainOutbox(restored,async(path,body)=>{requests.push(body.events);return {seq:committed};},()=>{});
  assert.deepEqual(requests[0],[{seq:1,type:'view'},{seq:2,type:'answer'}]);
  assert.equal(restored.sessions[0].events.length,0);
});
test('events added while sending and unsent older sessions drain without being dropped',async()=>{
  const v=vault();v.sessions.push({...v.sessions[0],id:'next-session',events:[{seq:1,type:'view'}],seq:1});
  let added=false;const seen=[];
  await drainOutbox(v,async(path,body)=>{
    if(path==='/sessions')return {seq:0};
    seen.push([path,body.events.map(e=>e.seq)]);
    if(!added){added=true;v.sessions[0].events.push({seq:++v.sessions[0].seq,type:'pause'});}
    return {seq:body.events.at(-1).seq};
  },()=>{});
  assert.deepEqual(seen.map(r=>r[1]),[[1,2],[3],[1]]);
  assert.ok(v.sessions.every(s=>s.events.length===0));
});
test('invalid receipts and tab conflicts preserve the outbox',async()=>{
  const v=vault();v.sessions[0].created=true;
  await assert.rejects(drainOutbox(v,async()=>({seq:1}),()=>{}));
  assert.equal(v.sessions[0].events.length,2);
  let cancelled=false;
  await drainOutbox(v,async()=>{cancelled=true;return {seq:2};},()=>{throw new Error('must not persist');},()=>cancelled);
  assert.equal(v.sessions[0].events.length,2);
});
