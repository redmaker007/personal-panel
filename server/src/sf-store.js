import { createHash, randomBytes } from 'node:crypto';
import { requireSql } from './sf-db.js';
import { CATALOG_VERSION, KEYS, L } from '../../assets/sf-data.mjs';
import { DEFAULT_WEIGHTS } from '../../assets/sf-engine.mjs';
import { implementations, versionImplementation } from './sf-versions.js';

/* =========================================================
   Postgres（Supabase）版本。
   与 SQLite 版的差异：全部异步、jsonb 直接返回对象、count 统一 ::int
   （postgres.js 会把 bigint 当字符串返回）、事务用 sql.begin()。
   建表与初始数据在 migrate-pg.js，运行时不再建表。
   ========================================================= */

export const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const GLOBAL_SETTINGS = new Set(['auto_enabled', 'rate_limit_salt']);
export const settingKey = (key, version = CATALOG_VERSION) => GLOBAL_SETTINGS.has(key) ? key : `${version}:${key}`;
export const getSetting = async (db, key, version = CATALOG_VERSION) =>
  (await db`select value from sf_settings where key = ${settingKey(key, version)}`)[0]?.value;
export const putSetting = (db, key, value, version = CATALOG_VERSION) => db`
  insert into sf_settings (key, value) values (${settingKey(key, version)}, ${value})
  on conflict (key) do update set value = excluded.value`;

export async function activeWeights(version = CATALOG_VERSION, db = requireSql()) {
  const id = Number(await getSetting(db, 'active_version', version));
  const [row] = await db`
    select id, weights_json from sf_weight_versions where id = ${id || 0} and catalog_version = ${version}`;
  if (!row) fail('找不到对应题库的权重，请先执行 npm run migrate', 400);
  return { version: row.id, weights: row.weights_json };
}

export async function configuration(catalogVersion = CATALOG_VERSION) {
  if (!versionImplementation(catalogVersion)) fail('题库版本不存在');
  return { catalogVersion, ...(await activeWeights(catalogVersion)) };
}

export async function createSession(body) {
  const db = requireSql();
  if (!uuid(body.id) || !uuid(body.token) || !uuid(body.clientId)) fail('会话标识无效');
  const [existing] = await db`select token_hash, seq, weight_version from sf_sessions where id = ${body.id}`;
  if (existing) {
    if (existing.token_hash !== hash(body.token)) fail('会话凭证无效', 403);
    return { seq: existing.seq, version: existing.weight_version };
  }
  if (!versionImplementation(body.catalogVersion)) fail('题库已更新，请刷新页面后开始', 409);
  if (!Number.isInteger(body.version) || body.version < 1) fail('权重版本无效');
  const [version] = await db`
    select id from sf_weight_versions where id = ${body.version} and catalog_version = ${body.catalogVersion}`;
  if (!version) fail('权重版本无效');
  await db`
    insert into sf_sessions (id, token_hash, client_id, catalog_version, weight_version)
    values (${body.id}, ${hash(body.token)}, ${body.clientId}, ${body.catalogVersion}, ${version.id})`;
  return { seq: 0, version: version.id };
}

const EVENT_FIELDS = {
  view:     ['seq', 'type', 'questionId'],
  answer:   ['seq', 'type', 'questionId', 'choice', 'durationMs'],
  back:     ['seq', 'type'],
  pause:    ['seq', 'type'],
  resume:   ['seq', 'type'],
  feedback: ['seq', 'type', 'rating', 'note'],
};

export async function recordEvents(id, token, events) {
  const db = requireSql();
  if (!uuid(id) || !uuid(token)) fail('会话凭证无效', 403);
  if (!Array.isArray(events) || !events.length || events.length > 60) fail('每批事件数量必须为 1–60');

  const outcome = await db.begin(async db => {
    // 锁住这一行：并发的 lambda 不能交错读改写同一个 session。
    const [session] = await db`select * from sf_sessions where id = ${id} for update`;
    if (!session || session.token_hash !== hash(token)) fail('会话凭证无效', 403);

    const implementation = versionImplementation(session.catalog_version);
    if (!implementation) fail('本次测验的题库暂不支持续答，请保留记录', 409);
    const { evaluate, answerRecord } = implementation;

    const [weightRow] = await db`select weights_json from sf_weight_versions where id = ${session.weight_version}`;
    const weights = weightRow.weights_json;

    let answers = session.answers_json, seq = session.seq, status = session.status;
    let feedback = session.feedback, note = session.feedback_note, completed = false;

    for (const event of events) {
      if (!event || !Number.isInteger(event.seq) || event.seq < 1 || event.seq > 2000) fail('事件序号无效');
      if (!Object.hasOwn(EVENT_FIELDS, event.type) || Object.keys(event).some(k => !EVENT_FIELDS[event.type].includes(k)))
        fail('事件字段无效');

      if (event.seq <= seq) {
        const [prior] = await db`select payload_json from sf_events where session_id = ${id} and seq = ${event.seq}`;
        if (!prior || JSON.stringify(prior.payload_json.request) !== JSON.stringify(event))
          fail('事件重复但内容不一致', 409);
        continue;
      }
      if (event.seq !== seq + 1) fail('事件缺失，请按顺序重试', 409);

      const state = evaluate(answers, weights);
      let canonical = null, questionId = event.questionId ?? null;

      if (event.type === 'view' || event.type === 'answer') {
        if (!state.next || questionId !== state.next.id) fail('题目与当前进度不符', 409);
        if (event.type === 'answer') {
          if (!Number.isInteger(event.choice) || !state.next.options[event.choice] ||
              !Number.isInteger(event.durationMs) || event.durationMs < 0 || event.durationMs > 3600000)
            fail('作答数据无效');
          canonical = answerRecord(questionId, event.choice, event.durationMs);
          answers = [...answers, canonical];
          if (evaluate(answers, weights).done) { status = 'completed'; completed = true; }
          else status = 'active';
        }
      } else if (event.type === 'back') {
        if (state.done || !answers.length) fail('当前无法返回上一题');
        canonical = answers.at(-1); answers = answers.slice(0, -1);
        questionId = canonical.questionId; status = 'active';
      } else if (event.type === 'pause' || event.type === 'resume') {
        if (!state.done) status = event.type === 'pause' ? 'paused' : 'active';
      } else if (event.type === 'feedback') {
        if (!state.done || !Number.isInteger(event.rating) || event.rating < 1 || event.rating > 5 ||
            (event.note !== undefined && (typeof event.note !== 'string' || event.note.length > 1000)))
          fail('反馈内容无效');
        feedback = event.rating; note = event.note || '';
      } else fail('事件类型无效');

      await db`
        insert into sf_events (session_id, seq, type, question_id, payload_json)
        values (${id}, ${event.seq}, ${event.type}, ${questionId}, ${db.json({ request: event, canonical })})`;
      seq = event.seq;
    }

    const final = evaluate(answers, weights);
    await db`
      update sf_sessions set
        seq = ${seq},
        answers_json = ${db.json(answers)},
        result_json = ${final.done ? db.json({ ranked: final.ranked, prediction: final.prediction }) : null},
        status = ${status},
        feedback = ${feedback},
        feedback_note = ${note},
        updated_at = now(),
        completed_at = case when ${final.done} then coalesce(completed_at, now()) else completed_at end
      where id = ${id}`;

    await db`delete from sf_answers where session_id = ${id}`;
    if (answers.length) {
      await db`insert into sf_answers ${db(
        answers.map(a => ({
          session_id: id, question_id: a.questionId, choice: a.choice,
          leaf: a.leaf, phase: a.phase, duration_ms: a.durationMs,
        })),
        'session_id', 'question_id', 'choice', 'leaf', 'phase', 'duration_ms'
      )}`;
    }
    return { seq, status, completed, catalogVersion: session.catalog_version };
  });

  if (outcome.completed && outcome.catalogVersion === CATALOG_VERSION) {
    try { await calibrate(false); } catch (error) { console.error('自动分析暂未完成:', error.message); }
  }
  return { seq: outcome.seq, status: outcome.status };
}

/* ---------------- 自动调权 ---------------- */

function correlation(pairs) {
  const n = pairs.length, mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let xx = 0, yy = 0, xy = 0;
  for (const [x, y] of pairs) { xx += (x - mx) ** 2; yy += (y - my) ** 2; xy += (x - mx) * (y - my); }
  return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : null;
}

export async function analyzeWeights(catalogVersion = CATALOG_VERSION, db = requireSql()) {
  // 同一变量的两道行为题（B/C）配成一对。每个匿名浏览器只取该题库最近一份完成记录，
  // 不使用预测和结果反馈当标签。
  const rows = await db`
    select a.leaf, a.choice as x, b.choice as y,
           a.duration_ms as dx, b.duration_ms as dy, s.answers_json
      from sf_sessions s
      join sf_answers a on a.session_id = s.id and a.phase = 'B'
      join sf_answers b on b.session_id = s.id and b.leaf = a.leaf and b.phase = 'C'
     where s.status = 'completed' and s.catalog_version = ${catalogVersion}
       and a.choice between 0 and 4 and b.choice between 0 and 4
       and not exists (
         select 1 from sf_sessions newer
          where newer.client_id = s.client_id and newer.status = 'completed'
            and newer.catalog_version = s.catalog_version
            and (newer.completed_at > s.completed_at
              or (newer.completed_at = s.completed_at and newer.ordinal > s.ordinal)))`;

  const previous = JSON.parse((await getSetting(db, 'last_pair_counts', catalogVersion)) || '{}');
  const { weights } = await activeWeights(catalogVersion, db);

  return KEYS.map(key => {
    const all = rows.filter(r => r.leaf === key);
    const usable = all.filter(r => {
      const answered = r.answers_json.filter(a => (a.phase === 'B' || a.phase === 'C') && !a.skipped);
      return r.dx >= 750 && r.dy >= 750 && new Set(answered.map(a => a.choice)).size >= 2;
    });
    const n = usable.length, r = n > 1 ? correlation(usable.map(u => [u.x, u.y])) : null;
    const ready = n >= 40 && n - (previous[key] || 0) >= 20 && r !== null;
    const target = r === null ? weights[key]
      : Math.max(.85, Math.min(1.15, 1 + .15 * Math.max(-1, Math.min(1, (r - .4) / .6)) * n / (n + 100)));
    const proposed = ready
      ? Math.round(Math.max(.85, Math.min(1.15, weights[key] + Math.max(-.025, Math.min(.025, target - weights[key])))) * 10000) / 10000
      : weights[key];
    return {
      key, name: L[key].n, pairs: n, excluded: all.length - n, correlation: r,
      current: weights[key], proposed, ready,
      reason: n < 40 ? `有效配对 ${n}/40`
        : r === null ? '答案无变异，暂不调权'
        : n - (previous[key] || 0) < 20 ? '等待 20 个新增配对'
        : '达到校准条件',
    };
  });
}

export async function calibrate(manual = false) {
  const db = requireSql();
  const report = await analyzeWeights(CATALOG_VERSION, db);
  await putSetting(db, 'last_analysis', JSON.stringify({ at: new Date().toISOString(), report }));
  if ((await getSetting(db, 'auto_enabled')) !== 'true') return { applied: false, reason: '自动调权已暂停', report };
  const changed = report.filter(r => r.ready && r.current !== r.proposed);
  if (!changed.length) return { applied: false, reason: '暂无满足条件的权重调整', report };

  const current = await activeWeights(CATALOG_VERSION, db);
  const weights = { ...current.weights };
  const counts = JSON.parse((await getSetting(db, 'last_pair_counts')) || '{}');
  for (const r of changed) { weights[r.key] = r.proposed; counts[r.key] = r.pairs; }

  const version = await db.begin(async db => {
    const [row] = await db`
      insert into sf_weight_versions (weights_json, reason, report_json, catalog_version)
      values (${db.json(weights)}, ${manual ? '管理员触发分析' : '完成答题后自动校准'}, ${db.json(report)}, ${CATALOG_VERSION})
      returning id`;
    await putSetting(db, 'active_version', String(row.id));
    await putSetting(db, 'last_pair_counts', JSON.stringify(counts));
    return row.id;
  });
  return { applied: true, version, report };
}

export async function setAutomatic(enabled) {
  if (typeof enabled !== 'boolean') fail('开关值无效');
  await putSetting(requireSql(), 'auto_enabled', String(enabled));
  return { enabled };
}

export async function rollback(version) {
  const db = requireSql();
  if (!Number.isInteger(version)) fail('找不到该权重版本');
  const [row] = await db`
    select weights_json from sf_weight_versions where id = ${version} and catalog_version = ${CATALOG_VERSION}`;
  if (!row) fail('找不到该权重版本');
  const from = (await activeWeights(CATALOG_VERSION, db)).version;

  const created = await db.begin(async db => {
    const [next] = await db`
      insert into sf_weight_versions (weights_json, reason, report_json, catalog_version)
      values (${db.json(row.weights_json)}, ${`回滚至 v${version}（自动调权已暂停）`},
              ${db.json({ rollbackFrom: from, target: version })}, ${CATALOG_VERSION})
      returning id`;
    await putSetting(db, 'active_version', String(next.id));
    await putSetting(db, 'auto_enabled', 'false');
    return next.id;
  });
  return { version: created, enabled: false };
}

/* ---------------- 后台读取 ---------------- */

export async function summary(catalogVersion = CATALOG_VERSION) {
  const db = requireSql();
  const implementation = versionImplementation(catalogVersion);
  if (!implementation) fail('题库版本不存在');

  const [sessions] = await db`
    select count(*)::int as total,
           count(*) filter (where status = 'completed')::int as completed,
           count(*) filter (where status = 'paused')::int as paused,
           avg(feedback)::float8 as feedback
      from sf_sessions where catalog_version = ${catalogVersion}`;
  const [{ n: answers }] = await db`
    select count(*)::int as n from sf_answers a
      join sf_sessions s on s.id = a.session_id where s.catalog_version = ${catalogVersion}`;
  const counts = await db`
    select a.question_id, a.choice, count(*)::int as n, avg(a.duration_ms)::float8 as duration
      from sf_answers a join sf_sessions s on s.id = a.session_id
     where s.catalog_version = ${catalogVersion} group by a.question_id, a.choice`;
  const exposure = await db`
    select e.question_id, count(distinct e.session_id)::int as n
      from sf_events e join sf_sessions s on s.id = e.session_id
     where e.type = 'view' and s.catalog_version = ${catalogVersion} group by e.question_id`;
  const revisions = await db`
    select e.question_id, count(*)::int as n
      from sf_events e join sf_sessions s on s.id = e.session_id
     where e.type = 'back' and s.catalog_version = ${catalogVersion} group by e.question_id`;
  const versions = await db`
    select id, reason, created_at, catalog_version from sf_weight_versions
     where catalog_version = ${catalogVersion} order by id desc limit 100`;

  return {
    catalogVersion,
    currentCatalogVersion: CATALOG_VERSION,
    catalogVersions: Object.keys(implementations).reverse(),
    sessions: { ...sessions, completed: sessions.completed || 0, paused: sessions.paused || 0 },
    answers,
    ...(await activeWeights(catalogVersion, db)),
    autoEnabled: (await getSetting(db, 'auto_enabled')) === 'true',
    lastAnalysis: JSON.parse((await getSetting(db, 'last_analysis', catalogVersion)) || 'null'),
    analysis: await analyzeWeights(catalogVersion, db),
    questions: implementation.CATALOG.map(q => {
      const choices = q.options.map((o, i) => ({
        ...o, choice: i, count: counts.find(r => r.question_id === q.id && r.choice === i)?.n || 0,
      }));
      const answered = choices.reduce((s, o) => s + o.count, 0);
      const shown = exposure.find(r => r.question_id === q.id)?.n || 0;
      const duration = counts.filter(r => r.question_id === q.id).reduce((s, r) => s + r.n * r.duration, 0);
      return {
        ...q, choices, answered,
        skipped: choices.filter(o => o.scored === false).reduce((n, o) => n + o.count, 0),
        shown,
        neverShown: Math.max(0, sessions.total - shown),
        unanswered: Math.max(0, shown - answered),
        revisions: revisions.find(r => r.question_id === q.id)?.n || 0,
        averageMs: answered ? duration / answered : null,
      };
    }),
    versions,
  };
}

export async function sessionPage(limit = 50, offset = 0, catalogVersion = null) {
  const db = requireSql();
  if (catalogVersion !== null && !versionImplementation(catalogVersion)) fail('题库版本不存在');
  const rows = await db`
    select id, seq, status, weight_version, catalog_version, feedback,
           created_at, updated_at, completed_at, answers_json, result_json, feedback_note
      from sf_sessions
     where (${catalogVersion}::text is null or catalog_version = ${catalogVersion})
     order by ordinal desc limit ${limit} offset ${offset}`;
  return rows.map(({ answers_json, result_json, ...s }) => ({ ...s, answers: answers_json, result: result_json }));
}

export async function sessionDetail(id) {
  const db = requireSql();
  if (!uuid(id)) fail('找不到记录', 404);
  const [s] = await db`
    select id, status, weight_version, catalog_version, feedback, feedback_note,
           created_at, completed_at, answers_json, result_json
      from sf_sessions where id = ${id}`;
  if (!s) fail('找不到记录', 404);
  const events = await db`
    select seq, type, question_id, payload_json, created_at
      from sf_events where session_id = ${id} order by seq`;
  const { answers_json, result_json, ...rest } = s;
  return {
    ...rest, answers: answers_json, result: result_json,
    events: events.map(({ payload_json, ...e }) => ({ ...e, payload: payload_json })),
  };
}

/* ---------------- 限流（serverless 下内存 Map 不可用） ---------------- */

// 只保存地址的**加盐**哈希，不落原始 IP。
// 不加盐是不够的：IPv4 全空间只有 2^32，拿到库的人可以穷举反查出地址。
// 盐优先取环境变量 RATE_LIMIT_SALT；没有就生成一个存进 sf_settings。
let saltCache = null;
async function rateSalt(db) {
  if (saltCache) return saltCache;
  if (process.env.RATE_LIMIT_SALT) return (saltCache = process.env.RATE_LIMIT_SALT);
  const existing = await getSetting(db, 'rate_limit_salt');
  if (existing) return (saltCache = existing);
  const generated = randomBytes(32).toString('hex');
  await db`insert into sf_settings (key, value) values ('rate_limit_salt', ${generated})
           on conflict (key) do nothing`;
  return (saltCache = (await getSetting(db, 'rate_limit_salt')) || generated);
}

export async function hitRateLimit(address, limit = 240, windowSeconds = 60) {
  const db = requireSql();
  const salt = await rateSalt(db);
  const bucket = 'ip:' + createHash('sha256').update(salt + '|' + String(address)).digest('hex').slice(0, 32);
  const [row] = await db`
    insert into sf_rate_limit (bucket, hits, started_at) values (${bucket}, 1, now())
    on conflict (bucket) do update set
      hits = case when sf_rate_limit.started_at < now() - ${windowSeconds} * interval '1 second'
                  then 1 else sf_rate_limit.hits + 1 end,
      started_at = case when sf_rate_limit.started_at < now() - ${windowSeconds} * interval '1 second'
                  then now() else sf_rate_limit.started_at end
    returning hits`;
  return row.hits <= limit;
}
