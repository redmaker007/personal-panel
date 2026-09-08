import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { db } from './db.js';
import { CATALOG, CATALOG_VERSION, KEYS, L, QUESTION_MAP } from '../../assets/sf-data.mjs';
import { evaluate, answerRecord, DEFAULT_WEIGHTS } from '../../assets/sf-engine.mjs';
import { implementations, versionImplementation } from './sf-versions.js';

db.exec(readFileSync(new URL('./sf-schema.sql', import.meta.url), 'utf8'));
if (!db.prepare('PRAGMA table_info(sf_weight_versions)').all().some(c=>c.name==='catalog_version')) db.exec("ALTER TABLE sf_weight_versions ADD COLUMN catalog_version TEXT NOT NULL DEFAULT 'sf2.1'");
const settingKey=(key,version=CATALOG_VERSION)=>key==='auto_enabled'?key:`${version}:${key}`;
const setting=(key,version=CATALOG_VERSION)=>db.prepare('SELECT value FROM sf_settings WHERE key=?').get(settingKey(key,version))?.value;
const setSetting=(key,value,version=CATALOG_VERSION)=>db.prepare('INSERT OR REPLACE INTO sf_settings VALUES (?,?)').run(settingKey(key,version),value);
for (const [version,implementation] of Object.entries(implementations)) {
  db.prepare('INSERT OR IGNORE INTO sf_catalog(version,catalog_json) VALUES (?,?)').run(version,JSON.stringify(implementation.CATALOG));
  if(!setting('active_version',version)) {
    const oldActive=version==='sf2.1'?db.prepare("SELECT value FROM sf_settings WHERE key='active_version'").get()?.value:null;
    let row=oldActive?db.prepare('SELECT id FROM sf_weight_versions WHERE id=? AND catalog_version=?').get(Number(oldActive),version):null;
    row??=db.prepare('SELECT id FROM sf_weight_versions WHERE catalog_version=? ORDER BY id DESC LIMIT 1').get(version);
    if(!row)row={id:Number(db.prepare('INSERT INTO sf_weight_versions(weights_json,reason,report_json,catalog_version) VALUES (?,?,?,?)').run(JSON.stringify(DEFAULT_WEIGHTS),'初始权重 · '+version,'{}',version).lastInsertRowid)};
    setSetting('active_version',String(row.id),version);
    if(version==='sf2.1')for(const key of ['last_pair_counts','last_analysis']){const prior=db.prepare('SELECT value FROM sf_settings WHERE key=?').get(key);if(prior)setSetting(key,prior.value,version);}
  }
}
db.prepare('INSERT OR IGNORE INTO sf_settings VALUES (?,?)').run('auto_enabled', 'true');
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function activeWeights(version=CATALOG_VERSION) {
  const row = db.prepare('SELECT * FROM sf_weight_versions WHERE id=? AND catalog_version=?').get(Number(setting('active_version',version)),version);
  if(!row)fail('找不到对应题库的权重',400);
  return { version: row.id, weights: JSON.parse(row.weights_json) };
}
export function configuration(catalogVersion=CATALOG_VERSION) {
  if(!versionImplementation(catalogVersion))fail('题库版本不存在');
  return {catalogVersion,...activeWeights(catalogVersion)};
}
export function createSession(body) {
  if (!uuid(body.id) || !uuid(body.token) || !uuid(body.clientId)) fail('会话标识无效');
  const existing = db.prepare('SELECT * FROM sf_sessions WHERE id=?').get(body.id);
  if (existing) {
    if (existing.token_hash !== hash(body.token)) fail('会话凭证无效', 403);
    return { seq: existing.seq, version: existing.weight_version };
  }
  if (!versionImplementation(body.catalogVersion)) fail('题库已更新，请刷新页面后开始', 409);
  if (!Number.isInteger(body.version) || body.version < 1) fail('权重版本无效');
  const version = db.prepare('SELECT id FROM sf_weight_versions WHERE id=? AND catalog_version=?').get(body.version,body.catalogVersion);
  if (!version) fail('权重版本无效');
  db.prepare('INSERT INTO sf_sessions(id,token_hash,client_id,catalog_version,weight_version) VALUES (?,?,?,?,?)').run(body.id, hash(body.token), body.clientId, body.catalogVersion, version.id);
  return { seq: 0, version: version.id };
}
function getSession(id, token) {
  const s = uuid(id) && db.prepare('SELECT * FROM sf_sessions WHERE id=?').get(id);
  if (!s || !uuid(token) || s.token_hash !== hash(token)) fail('会话凭证无效', 403);
  return s;
}
export function recordEvents(id, token, events) {
  const session = getSession(id, token);
  const implementation=versionImplementation(session.catalog_version);
  if(!implementation)fail('本次测验的题库暂不支持续答，请保留记录',409);
  const {evaluate,answerRecord}=implementation;
  if (!Array.isArray(events) || !events.length || events.length > 60) fail('每批事件数量必须为 1–60');
  const weights = JSON.parse(db.prepare('SELECT weights_json FROM sf_weight_versions WHERE id=?').get(session.weight_version).weights_json);
  let answers = JSON.parse(session.answers_json), seq = session.seq, status = session.status, feedback = session.feedback, note = session.feedback_note;
  const insert = db.prepare('INSERT INTO sf_events(session_id,seq,type,question_id,payload_json) VALUES (?,?,?,?,?)');
  let completed = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const event of events) {
      if (!event || !Number.isInteger(event.seq) || event.seq < 1 || event.seq > 2000) fail('事件序号无效');
      const fields = { view:['seq','type','questionId'], answer:['seq','type','questionId','choice','durationMs'], back:['seq','type'], pause:['seq','type'], resume:['seq','type'], feedback:['seq','type','rating','note'] };
      if (!Object.hasOwn(fields,event.type) || Object.keys(event).some(key=>!fields[event.type].includes(key))) fail('事件字段无效');
      if (event.seq <= seq) {
        const prior = db.prepare('SELECT payload_json FROM sf_events WHERE session_id=? AND seq=?').get(id, event.seq);
        if (!prior || JSON.stringify(JSON.parse(prior.payload_json).request) !== JSON.stringify(event)) fail('事件重复但内容不一致', 409);
        continue;
      }
      if (event.seq !== seq + 1) fail('事件缺失，请按顺序重试', 409);
      const state = evaluate(answers, weights);
      let canonical = null, questionId = event.questionId ?? null;
      if (event.type === 'view' || event.type === 'answer') {
        if (!state.next || questionId !== state.next.id) fail('题目与当前进度不符', 409);
        if (event.type === 'answer') {
          if (!Number.isInteger(event.choice) || !state.next.options[event.choice] || !Number.isInteger(event.durationMs) || event.durationMs < 0 || event.durationMs > 3600000) fail('作答数据无效');
          canonical = answerRecord(questionId, event.choice, event.durationMs);
          answers.push(canonical);
          if (evaluate(answers, weights).done) { status = 'completed'; completed = true; }
          else status = 'active';
        }
      } else if (event.type === 'back') {
        if (state.done || !answers.length) fail('当前无法返回上一题');
        canonical = answers.pop(); questionId = canonical.questionId; status = 'active';
      } else if (event.type === 'pause' || event.type === 'resume') {
        if (!state.done) status = event.type === 'pause' ? 'paused' : 'active';
      } else if (event.type === 'feedback') {
        if (!state.done || !Number.isInteger(event.rating) || event.rating < 1 || event.rating > 5 || (event.note !== undefined && (typeof event.note !== 'string' || event.note.length > 1000))) fail('反馈内容无效');
        feedback = event.rating; note = event.note || '';
      } else fail('事件类型无效');
      insert.run(id, event.seq, event.type, questionId, JSON.stringify({ request: event, canonical }));
      seq = event.seq;
    }
    const final = evaluate(answers, weights);
    db.prepare(`UPDATE sf_sessions SET seq=?,answers_json=?,result_json=?,status=?,feedback=?,feedback_note=?,updated_at=datetime('now'),completed_at=CASE WHEN ? THEN COALESCE(completed_at,datetime('now')) ELSE completed_at END WHERE id=?`)
      .run(seq, JSON.stringify(answers), final.done ? JSON.stringify({ ranked: final.ranked, prediction: final.prediction }) : null, status, feedback, note, final.done ? 1 : 0, id);
    db.prepare('DELETE FROM sf_answers WHERE session_id=?').run(id);
    const add = db.prepare('INSERT INTO sf_answers VALUES (?,?,?,?,?,?)');
    for (const a of answers) add.run(id, a.questionId, a.choice, a.leaf, a.phase, a.durationMs);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  if (completed && session.catalog_version===CATALOG_VERSION) { try { calibrate(false); } catch (error) { console.error('自动分析暂未完成:', error.message); } }
  return { seq, status };
}

function correlation(pairs) {
  const n = pairs.length, mx = pairs.reduce((s,p) => s+p[0],0)/n, my = pairs.reduce((s,p) => s+p[1],0)/n;
  let xx=0, yy=0, xy=0;
  for (const [x,y] of pairs) { xx+=(x-mx)**2; yy+=(y-my)**2; xy+=(x-mx)*(y-my); }
  return xx > 0 && yy > 0 ? xy/Math.sqrt(xx*yy) : null;
}
export function analyzeWeights(catalogVersion=CATALOG_VERSION) {
  // The two different behavioral questions for the SAME variable form a pair.
  // One latest completed session per anonymous browser, no prediction/result labels.
  const rows = db.prepare(`SELECT a.leaf,a.choice x,b.choice y,a.duration_ms dx,b.duration_ms dy,s.answers_json
    FROM sf_sessions s JOIN sf_answers a ON a.session_id=s.id AND a.phase='B'
    JOIN sf_answers b ON b.session_id=s.id AND b.leaf=a.leaf AND b.phase='C'
    WHERE s.status='completed' AND s.catalog_version=? AND a.choice BETWEEN 0 AND 4 AND b.choice BETWEEN 0 AND 4
    AND NOT EXISTS (SELECT 1 FROM sf_sessions newer WHERE newer.client_id=s.client_id AND newer.status='completed' AND newer.catalog_version=s.catalog_version
      AND (newer.completed_at>s.completed_at OR (newer.completed_at=s.completed_at AND newer.rowid>s.rowid)))`).all(catalogVersion);
  const previous = JSON.parse(setting('last_pair_counts',catalogVersion) || '{}');
  const { weights } = activeWeights(catalogVersion);
  return KEYS.map(key => {
    const all = rows.filter(r => r.leaf === key);
    const usable = all.filter(r => {
      const a = JSON.parse(r.answers_json).filter(a => (a.phase === 'B' || a.phase === 'C') && !a.skipped);
      return r.dx >= 750 && r.dy >= 750 && new Set(a.map(a => a.choice)).size >= 2;
    });
    const n = usable.length, r = n > 1 ? correlation(usable.map(r => [r.x,r.y])) : null;
    const ready = n >= 40 && n - (previous[key] || 0) >= 20 && r !== null;
    const target = r === null ? weights[key] : Math.max(.85, Math.min(1.15, 1 + .15 * Math.max(-1, Math.min(1, (r-.4)/.6)) * n/(n+100)));
    const proposed = ready ? Math.round(Math.max(.85, Math.min(1.15, weights[key] + Math.max(-.025, Math.min(.025, target-weights[key]))))*10000)/10000 : weights[key];
    return { key, name: L[key].n, pairs: n, excluded: all.length-n, correlation: r, current: weights[key], proposed, ready,
      reason: n < 40 ? `有效配对 ${n}/40` : r === null ? '答案无变异，暂不调权' : n-(previous[key]||0)<20 ? '等待 20 个新增配对' : '达到校准条件' };
  });
}
export function calibrate(manual = false) {
  const report = analyzeWeights();
  setSetting('last_analysis', JSON.stringify({ at: new Date().toISOString(), report }));
  if (setting('auto_enabled') !== 'true') return { applied: false, reason: '自动调权已暂停', report };
  const changed = report.filter(r => r.ready && r.current !== r.proposed);
  if (!changed.length) return { applied: false, reason: '暂无满足条件的权重调整', report };
  const weights = { ...activeWeights().weights };
  const counts = JSON.parse(setting('last_pair_counts') || '{}');
  for (const r of changed) { weights[r.key] = r.proposed; counts[r.key] = r.pairs; }
  db.exec('BEGIN IMMEDIATE');
  try {
    const v = db.prepare('INSERT INTO sf_weight_versions(weights_json,reason,report_json,catalog_version) VALUES (?,?,?,?)').run(JSON.stringify(weights), manual ? '管理员触发分析' : '完成答题后自动校准', JSON.stringify(report),CATALOG_VERSION);
    setSetting('active_version', String(v.lastInsertRowid));
    setSetting('last_pair_counts', JSON.stringify(counts));
    db.exec('COMMIT');
    return { applied: true, version: Number(v.lastInsertRowid), report };
  } catch(e) { db.exec('ROLLBACK'); throw e; }
}
export function setAutomatic(enabled) {
  if (typeof enabled !== 'boolean') fail('开关值无效');
  db.prepare('INSERT OR REPLACE INTO sf_settings VALUES (?,?)').run('auto_enabled', String(enabled));
  return { enabled };
}
export function rollback(version) {
  const row = Number.isInteger(version) && db.prepare('SELECT * FROM sf_weight_versions WHERE id=? AND catalog_version=?').get(version,CATALOG_VERSION);
  if (!row) fail('找不到该权重版本');
  db.exec('BEGIN IMMEDIATE');
  try {
    const v = db.prepare('INSERT INTO sf_weight_versions(weights_json,reason,report_json,catalog_version) VALUES (?,?,?,?)').run(row.weights_json, `回滚至 v${version}（自动调权已暂停）`, JSON.stringify({ rollbackFrom: activeWeights().version, target: version }),CATALOG_VERSION);
    setSetting('active_version', String(v.lastInsertRowid));
    setAutomatic(false);
    db.exec('COMMIT');
    return { version: Number(v.lastInsertRowid), enabled: false };
  } catch(e) { db.exec('ROLLBACK'); throw e; }
}
export function summary(catalogVersion=CATALOG_VERSION) {
  const implementation=versionImplementation(catalogVersion);if(!implementation)fail('题库版本不存在');
  const sessions = db.prepare('SELECT COUNT(*) total, SUM(status=\'completed\') completed, SUM(status=\'paused\') paused, AVG(feedback) feedback FROM sf_sessions WHERE catalog_version=?').get(catalogVersion);
  const count = db.prepare('SELECT COUNT(*) n FROM sf_answers a JOIN sf_sessions s ON s.id=a.session_id WHERE s.catalog_version=?').get(catalogVersion).n;
  const counts = db.prepare('SELECT a.question_id,a.choice,COUNT(*) n,AVG(a.duration_ms) duration FROM sf_answers a JOIN sf_sessions s ON s.id=a.session_id WHERE s.catalog_version=? GROUP BY a.question_id,a.choice').all(catalogVersion);
  const exposure = db.prepare("SELECT e.question_id,COUNT(DISTINCT e.session_id) n FROM sf_events e JOIN sf_sessions s ON s.id=e.session_id WHERE e.type='view' AND s.catalog_version=? GROUP BY e.question_id").all(catalogVersion);
  const revisions = db.prepare("SELECT e.question_id,COUNT(*) n FROM sf_events e JOIN sf_sessions s ON s.id=e.session_id WHERE e.type='back' AND s.catalog_version=? GROUP BY e.question_id").all(catalogVersion);
  return { catalogVersion,currentCatalogVersion:CATALOG_VERSION,catalogVersions:Object.keys(implementations).reverse(),sessions: { ...sessions, completed: sessions.completed || 0, paused: sessions.paused || 0 }, answers: count, ...activeWeights(catalogVersion), autoEnabled: setting('auto_enabled') === 'true',
    lastAnalysis: JSON.parse(setting('last_analysis',catalogVersion) || 'null'), analysis: analyzeWeights(catalogVersion),
    questions: implementation.CATALOG.map(q => {
      const choices = q.options.map((o,i) => ({ ...o, choice: i, count: counts.find(r => r.question_id===q.id && r.choice===i)?.n || 0 }));
      const answered = choices.reduce((s,o) => s+o.count,0), shown = exposure.find(r=>r.question_id===q.id)?.n || 0;
      const duration = counts.filter(r=>r.question_id===q.id).reduce((s,r)=>s+r.n*r.duration,0);
      return { ...q, choices, answered, skipped:choices.filter(o=>o.scored===false).reduce((n,o)=>n+o.count,0), shown, neverShown: Math.max(0,sessions.total-shown), unanswered: Math.max(0,shown-answered), revisions: revisions.find(r=>r.question_id===q.id)?.n || 0, averageMs: answered ? duration/answered : null };
    }),
    versions: db.prepare('SELECT id, reason, created_at,catalog_version FROM sf_weight_versions WHERE catalog_version=? ORDER BY id DESC LIMIT 100').all(catalogVersion)
  };
}
export function sessionPage(limit=50, offset=0, catalogVersion=null) {
  if(catalogVersion!==null&&!versionImplementation(catalogVersion))fail('题库版本不存在');
  return db.prepare('SELECT id,seq,status,weight_version,catalog_version,feedback,created_at,updated_at,completed_at,answers_json,result_json,feedback_note FROM sf_sessions WHERE (? IS NULL OR catalog_version=?) ORDER BY rowid DESC LIMIT ? OFFSET ?').all(catalogVersion,catalogVersion,limit,offset).map(s=>({ ...s, answers: JSON.parse(s.answers_json), result: JSON.parse(s.result_json), answers_json: undefined, result_json: undefined }));
}
export function sessionDetail(id) {
  const s = db.prepare('SELECT id,status,weight_version,catalog_version,feedback,feedback_note,created_at,completed_at,answers_json,result_json FROM sf_sessions WHERE id=?').get(id);
  if (!s) fail('找不到记录',404);
  return { ...s, answers: JSON.parse(s.answers_json), result: JSON.parse(s.result_json), answers_json: undefined, result_json: undefined,
    events: db.prepare('SELECT seq,type,question_id,payload_json,created_at FROM sf_events WHERE session_id=? ORDER BY seq').all(id).map(e=>({ ...e, payload: JSON.parse(e.payload_json), payload_json: undefined })) };
}
