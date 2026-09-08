// 一次性建表 + 灌入题库快照与初始权重。
//   npm run migrate
// serverless 运行时不再做这些（冷启动每次跑一遍太浪费）。
import { readFileSync } from 'node:fs';
import { sql, configured } from './sf-db.js';
import { DEFAULT_WEIGHTS } from '../../assets/sf-engine.mjs';
import { implementations } from './sf-versions.js';

if (!configured) {
  console.error('未配置 DATABASE_URL。把 Supabase 的 Transaction pooler 连接串写进 server/.env 再试。');
  process.exit(1);
}

const schema = readFileSync(new URL('./sf-schema.pg.sql', import.meta.url), 'utf8');
await sql.unsafe(schema);
console.log('✓ 建表完成');

for (const [version, implementation] of Object.entries(implementations)) {
  await sql`
    insert into sf_catalog (version, catalog_json) values (${version}, ${sql.json(implementation.CATALOG)})
    on conflict (version) do nothing`;

  const key = `${version}:active_version`;
  const [existing] = await sql`select value from sf_settings where key = ${key}`;
  let activeId = existing && Number(existing.value);
  if (activeId) {
    const [row] = await sql`select id from sf_weight_versions where id = ${activeId} and catalog_version = ${version}`;
    if (!row) activeId = null;
  }
  if (!activeId) {
    const [latest] = await sql`
      select id from sf_weight_versions where catalog_version = ${version} order by id desc limit 1`;
    if (latest) activeId = latest.id;
    else {
      const [created] = await sql`
        insert into sf_weight_versions (weights_json, reason, report_json, catalog_version)
        values (${sql.json(DEFAULT_WEIGHTS)}, ${'初始权重 · ' + version}, ${sql.json({})}, ${version})
        returning id`;
      activeId = created.id;
    }
    await sql`
      insert into sf_settings (key, value) values (${key}, ${String(activeId)})
      on conflict (key) do update set value = excluded.value`;
  }
  console.log(`✓ ${version}：题库 ${implementation.CATALOG.length} 题，权重版本 v${activeId}`);
}

await sql`insert into sf_settings (key, value) values ('auto_enabled', 'true') on conflict (key) do nothing`;
console.log('✓ 自动调权开关就绪');

await sql.end();
console.log('迁移完成。');
