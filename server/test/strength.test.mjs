import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn,execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { evaluate, answerRecord, DEFAULT_WEIGHTS } from '../../assets/sf-engine.mjs';
import { CATALOG, CATALOG_VERSION, KEYS, QA, L } from '../../assets/sf-data.mjs';
import * as previousData from '../../assets/sf-data-v21.mjs';
import * as previousEngine from '../../assets/sf-engine-v21.mjs';

// 依赖数据库的测试需要一个**可丢弃**的 Postgres。
// 绝不回退到 DATABASE_URL——那是生产库，测试会往里写脏数据。
// 用法：TEST_DATABASE_URL=postgresql://... npm test
const TEST_DB = process.env.TEST_DATABASE_URL;
const needsDb = { skip: TEST_DB ? false : '未设置 TEST_DATABASE_URL，跳过依赖数据库的测试' };
const temp = mkdtempSync(join(tmpdir(), 'sf-deluxe-test-'));
let store = null, sql = null;
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  store = await import('../src/sf-store.js');
  ({ sql } = await import('../src/sf-db.js'));
  const schema = readFileSync(new URL('../src/sf-schema.pg.sql', import.meta.url), 'utf8');
  await sql.unsafe('drop schema if exists public cascade; create schema public;');
  await sql.unsafe(schema);
  const { DEFAULT_WEIGHTS } = await import('../../assets/sf-engine.mjs');
  const { implementations } = await import('../src/sf-versions.js');
  for (const [version, impl] of Object.entries(implementations)) {
    await sql`insert into sf_catalog (version, catalog_json) values (${version}, ${sql.json(impl.CATALOG)})
              on conflict (version) do nothing`;
    const [row] = await sql`insert into sf_weight_versions (weights_json, reason, report_json, catalog_version)
      values (${sql.json(DEFAULT_WEIGHTS)}, ${'初始权重 · ' + version}, ${sql.json({})}, ${version}) returning id`;
    await sql`insert into sf_settings (key, value) values (${version + ':active_version'}, ${String(row.id)})
              on conflict (key) do update set value = excluded.value`;
  }
  await sql`insert into sf_settings (key, value) values ('auto_enabled','true') on conflict (key) do nothing`;
}
after(async () => { if (sql) await sql.end(); rmSync(temp, { recursive: true, force: true }); });
function session(clientId=randomUUID()) {
  const config=store.configuration(),s={id:randomUUID(),token:randomUUID(),clientId,catalogVersion:CATALOG_VERSION,version:config.version,weights:config.weights,answers:[],seq:0};
  store.createSession(s);return s;
}
function event(s,type,payload={}) {const e={seq:++s.seq,type,...payload};store.recordEvents(s.id,s.token,[e]);return e;}
function finish(s,level=4,duration=2000) {
  const events=[];
  while(true) {
    const state=evaluate(s.answers,s.weights);if(state.done)break;
    const q=state.next;
    const choice=q.phase==='A'?Math.max(0,q.options.findIndex(o=>o.leaf==='mem')):q.phase==='D'?KEYS.indexOf('mem'):q.leaf==='mem'?level:0;
    events.push({seq:++s.seq,type:'view',questionId:q.id},{seq:++s.seq,type:'answer',questionId:q.id,choice,durationMs:duration});
    s.answers.push(answerRecord(q.id,choice,duration));
  }
  for(let i=0;i<events.length;i+=60)store.recordEvents(s.id,s.token,events.slice(i,i+60));
  return s;
}
test('all 76 questions preserve the fixed tree and balanced, separated, connected pair coverage',()=>{
  assert.equal(CATALOG.length,76);assert.equal(QA.length,25);assert.equal(KEYS.length,25);
  const seen=new Map(KEYS.map(k=>[k,[]])),edges=new Map(KEYS.map(k=>[k,new Set()]));
  for(const k of KEYS)for(const field of ['n','root','br'])assert.equal(L[k][field],previousData.L[k][field]);
  QA.forEach((q,i)=>{
    assert.equal(q.o.length,2);const [a,b]=q.o.map(o=>o[0]);assert.notEqual(a,b);assert.notEqual(L[a].root,L[b].root);
    q.o.forEach(([key],side)=>seen.get(key).push({i,side}));edges.get(a).add(b);edges.get(b).add(a);
    assert.ok(!/最不擅长|最吃力|不想接|哪件最难/.test(q.q));
  });
  for(const [key,occurrences] of seen){assert.equal(occurrences.length,2);assert.notEqual(occurrences[0].side,occurrences[1].side);assert.ok(Math.abs(occurrences[0].i-occurrences[1].i)>=7);assert.equal(edges.get(key).size,2);}
  const connected=new Set(),visit=k=>{if(connected.has(k))return;connected.add(k);for(const next of edges.get(k))visit(next);};visit(KEYS[0]);assert.equal(connected.size,25);
  for(const q of CATALOG.filter(q=>q.phase==='B'||q.phase==='C')){
    assert.notEqual(q.stem,previousData.QUESTION_MAP[q.id].stem);assert.equal(q.options.length,6);assert.equal(q.options[5].scored,false);
  }
});
test('randomized paths always verify every survivor and reproduce all previous questions',()=>{
  for(let run=1;run<=100;run++) {
    let seed=run,answers=[];
    const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
    while(true) {
      const state=evaluate(answers);if(state.done){
        const screening=evaluate(answers.slice(0,QA.length));
        const excluded=new Set(KEYS.filter(k=>screening.state[k].out));
        for(const k of KEYS.filter(k=>!excluded.has(k)))assert.ok(answers.some(a=>a.phase==='B'&&a.leaf===k),k);
        assert.ok(state.ranked.every(r=>r.targeted>0));break;
      }
      const q=state.next;answers.push(answerRecord(q.id,rand()%q.options.length,2000));
      assert.ok(answers.length<=56);
      // Returning across a stage boundary reproduces the exact previous question.
      assert.equal(evaluate(answers.slice(0,-1)).next.id,q.id);
    }
  }
});
test('binary comparisons penalize the unselected leaf only; repeated one-side choices cannot eliminate everyone',()=>{
  const first=answerRecord('A.0',0,2000),state=evaluate([first]);
  assert.notEqual(first.leaf,first.affectedLeaf);assert.equal(state.state[first.leaf].score,10);assert.equal(state.state[first.affectedLeaf].score,6.5);assert.equal(first.delta,-3.5);
  assert.throws(()=>answerRecord('A.0',2));
  for(const side of [0,1]){
    const answers=QA.map((q,i)=>answerRecord('A.'+i,side));const after=evaluate(answers);
    assert.equal(after.bTotal,25);assert.ok(KEYS.every(k=>after.state[k].score===6.5));
  }
  const target=QA[0].o[0][0];const answers=QA.map((q,i)=>answerRecord('A.'+i,Math.max(0,q.o.findIndex(([k])=>k!==target))));
  assert.equal(evaluate(answers).state[target].score,3);assert.equal(evaluate(answers).state[target].out,true);
});
test('unscored experience is neither a low score nor training evidence; no-experience completion has no invented winner',()=>{
  const answers=QA.map((q,i)=>answerRecord('A.'+i,0));
  while(!evaluate(answers).done){const q=evaluate(answers).next;answers.push(answerRecord(q.id,q.phase==='D'?0:5));}
  const state=evaluate(answers);assert.equal(state.ranked.length,0);assert.ok(KEYS.every(k=>state.state[k].score===6.5));
  assert.equal(answers.filter(a=>a.skipped).length,25);
  assert.ok(answers.filter(a=>a.skipped).every(a=>a.delta===0&&a.affectedLeaf===null));
});
test('retries are idempotent, revisions retain event history, rejected batches roll back atomically',needsDb,()=>{
  const s=session();assert.equal(store.createSession(s).seq,0);
  const view=event(s,'view',{questionId:'A.0'});
  store.recordEvents(s.id,s.token,[view]);
  const answer=event(s,'answer',{questionId:'A.0',choice:0,durationMs:1200});
  store.recordEvents(s.id,s.token,[answer]);
  assert.equal(store.sessionDetail(s.id).answers.length,1);
  event(s,'back');event(s,'view',{questionId:'A.0'});event(s,'answer',{questionId:'A.0',choice:1,durationMs:2000});
  const detail=store.sessionDetail(s.id);assert.equal(detail.answers[0].choice,1);assert.equal(detail.events.length,5);
  const before=detail.events.length;
  assert.throws(()=>store.recordEvents(s.id,s.token,[{seq:6,type:'view',questionId:'A.1'},{seq:7,type:'answer',questionId:'A.1',choice:99,durationMs:2000}]));
  assert.equal(store.sessionDetail(s.id).events.length,before);
  assert.throws(()=>store.recordEvents(s.id,randomUUID(),[{seq:6,type:'pause'}]));
  assert.throws(()=>store.recordEvents(s.id,s.token,[{seq:1,type:'pause'}]));
  assert.throws(()=>store.recordEvents(s.id,s.token,[{seq:7,type:'pause'}]));
  assert.throws(()=>store.recordEvents(s.id,s.token,[{seq:6,type:'feedback',rating:4}]));
  const summary=store.summary(),q=summary.questions.find(q=>q.id==='A.0');
  assert.equal(q.shown,1);assert.equal(q.answered,1);assert.equal(q.revisions,1);
  assert.equal(summary.questions.find(q=>q.id==='predict').neverShown,1);
});
test('calibration waits for real sample thresholds, rejects rapid answers and repeat browsers, pins old sessions, and supports rollback',needsDb,()=>{
  const old=session(),original=store.activeWeights();
  for(let i=0;i<39;i++) finish(session(),3+i%2);
  assert.equal(store.activeWeights().version,original.version);
  assert.equal(store.analyzeWeights().find(r=>r.key==='mem').pairs,39);
  finish(session(),4,0);
  assert.equal(store.activeWeights().version,original.version);
  const fortieth=finish(session(),4);
  const calibrated=store.activeWeights();
  assert.ok(calibrated.version>original.version);
  assert.ok(Math.abs(calibrated.weights.mem-original.weights.mem)<=.02500001);
  assert.equal(store.sessionDetail(old.id).weight_version,original.version);
  assert.equal(store.analyzeWeights().find(r=>r.key==='mem').pairs,40);
  finish(session(fortieth.clientId),3);
  assert.equal(store.analyzeWeights().find(r=>r.key==='mem').pairs,40);
  assert.equal(store.calibrate(true).applied,false);
  const rolled=store.rollback(original.version);
  assert.equal(rolled.enabled,false);assert.deepEqual(store.activeWeights().weights,DEFAULT_WEIGHTS);
  assert.equal(store.summary().autoEnabled,false);
  event(fortieth,'feedback',{rating:4,note:'题意清楚'});
  assert.equal(store.sessionDetail(fortieth.id).feedback,4);
  assert.throws(()=>event(fortieth,'back'));
});
test('historical sessions retain their original rules; statistics, rollback and weights never cross catalog versions',needsDb,()=>{
  const before=store.summary(),oldWeights=store.activeWeights('sf2.1');
  const s={id:randomUUID(),token:randomUUID(),clientId:randomUUID(),catalogVersion:'sf2.1',version:oldWeights.version};
  store.createSession(s);const answers=[],events=[];let seq=0;
  while(!previousEngine.evaluate(answers,oldWeights.weights).done){
    const q=previousEngine.evaluate(answers,oldWeights.weights).next,choice=q.phase==='D'?0:4;
    events.push({seq:++seq,type:'view',questionId:q.id},{seq:++seq,type:'answer',questionId:q.id,choice,durationMs:2000});
    answers.push(previousEngine.answerRecord(q.id,choice,2000));
  }
  for(let i=0;i<events.length;i+=60)store.recordEvents(s.id,s.token,events.slice(i,i+60));
  const oldSummary=store.summary('sf2.1');assert.equal(oldSummary.questions.length,61);assert.equal(oldSummary.sessions.total,1);
  assert.equal(store.summary().sessions.total,before.sessions.total);assert.equal(store.summary().answers,before.answers);
  assert.equal(store.sessionDetail(s.id).answers[0].delta,-7);assert.equal(store.sessionDetail(s.id).answers[0].stem,previousData.CATALOG[0].stem);
  assert.equal(store.sessionPage(100,0,'sf2.1').length,1);
  assert.throws(()=>store.createSession({...s,id:randomUUID(),catalogVersion:CATALOG_VERSION}));
  assert.throws(()=>store.rollback(oldWeights.version));
});
test('existing SQLite weight rows migrate in place while the new catalog starts at neutral weights',needsDb,()=>{
  const filename=join(temp,'migration.db'),oldDb=new DatabaseSync(filename);
  oldDb.exec(`CREATE TABLE sf_catalog(version TEXT PRIMARY KEY,catalog_json TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE sf_weight_versions(id INTEGER PRIMARY KEY AUTOINCREMENT,weights_json TEXT NOT NULL,reason TEXT NOT NULL,report_json TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE sf_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  oldDb.prepare('INSERT INTO sf_catalog(version,catalog_json) VALUES (?,?)').run('sf2.1',JSON.stringify(previousData.CATALOG));
  oldDb.prepare('INSERT INTO sf_weight_versions(weights_json,reason,report_json) VALUES (?,?,?)').run(JSON.stringify({...DEFAULT_WEIGHTS,str:1.12}),'已校准历史权重','{}');
  oldDb.prepare('INSERT INTO sf_settings VALUES (?,?)').run('active_version','1');
  oldDb.prepare('INSERT INTO sf_settings VALUES (?,?)').run('last_pair_counts','{"str":80}');oldDb.close();
  const source=`import {activeWeights,summary} from './src/sf-store.js'; import {db} from './src/db.js'; console.log(JSON.stringify({old:activeWeights('sf2.1'),current:activeWeights(),counts:db.prepare("SELECT value FROM sf_settings WHERE key='sf2.1:last_pair_counts'").get(),currentCounts:db.prepare("SELECT value FROM sf_settings WHERE key='sf2.2:last_pair_counts'").get()??null,catalogs:summary().catalogVersions}));db.close();`;
  const output=execFileSync(process.execPath,['--input-type=module','-e',source],{cwd:new URL('..',import.meta.url),env:{...process.env,DB_PATH:filename},encoding:'utf8'});
  const migrated=JSON.parse(output);assert.equal(migrated.old.version,1);assert.equal(migrated.old.weights.str,1.12);assert.deepEqual(migrated.current.weights,DEFAULT_WEIGHTS);assert.deepEqual(JSON.parse(migrated.counts.value),{str:80});assert.equal(migrated.currentCounts,null);assert.deepEqual(migrated.catalogs,['sf2.2','sf2.1']);
});
test('HTTP endpoints protect analytics and sensitive paths; full browser event protocol persists across server restart',needsDb,async()=>{
  const password=randomUUID();
  let child,base;
  async function start(){
    child=spawn(process.execPath,['src/index.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',DB_PATH:join(temp,'http.db'),ADMIN_PASSWORD:password},stdio:['ignore','pipe','pipe']});
    let output='';
    base=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Server startup timeout')),10000);
      child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/localhost:(\d+)\/admin/);if(match){clearTimeout(timer);resolve('http://localhost:'+match[1]);}});
      child.on('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code));});
    });
  }
  const call=(path,body,token)=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
  try{
    await start();assert.equal((await call('/v2.html')).status,200);
    for(const path of ['/server/data/panel.db','/server/src/auth.js','/.git/config','/server/.env'])assert.equal((await call(path)).status,404);
    assert.equal((await call('/api/strength-admin/summary')).status,401);
    assert.equal((await call('/api/login',{password:'changeme'})).status,401);
    const login=await call('/api/login',{password});assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const cfg=await (await call('/api/strength/config')).json();
    const s={id:randomUUID(),token:randomUUID(),clientId:randomUUID(),catalogVersion:CATALOG_VERSION,version:cfg.version};
    assert.equal((await call('/api/strength/sessions',s)).status,200);
    const ev={events:[{seq:1,type:'view',questionId:'A.0'},{seq:2,type:'answer',questionId:'A.0',choice:1,durationMs:2000}]};
    for(let i=0;i<2;i++)assert.equal((await call('/api/strength/sessions/'+s.id+'/events',ev,s.token)).status,200);
    const res=await fetch(base+'/api/strength-admin/summary',{headers:{cookie}});assert.equal(res.status,200);assert.equal((await res.json()).answers,1);
    const exited=once(child,'exit');child.kill();await exited;await start();
    const retried=await call('/api/strength/sessions',s);assert.equal((await retried.json()).seq,2);
  }finally{if(child?.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}}
});
