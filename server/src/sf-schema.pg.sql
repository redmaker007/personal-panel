-- 强项查找器（2.0）的 Postgres schema。
-- 与 sf-schema.sql（SQLite）一一对应，差异只在方言：
--   jsonb 取代 TEXT+JSON.parse、identity 取代 AUTOINCREMENT、
--   timestamptz 取代 TEXT 时间、ordinal 取代 rowid（用于「同一时刻取最新一份」的 tiebreak）。
-- 由 `npm run migrate` 执行；运行时不再建表。

create table if not exists sf_catalog (
  version      text primary key,
  catalog_json jsonb       not null,
  created_at   timestamptz not null default now()
);

create table if not exists sf_weight_versions (
  id              int generated always as identity primary key,
  weights_json    jsonb       not null,
  reason          text        not null,
  report_json     jsonb       not null,
  created_at      timestamptz not null default now(),
  catalog_version text        not null default 'sf2.1'
);

create table if not exists sf_settings (
  key   text primary key,
  value text not null
);

create table if not exists sf_sessions (
  id              uuid        primary key,
  token_hash      text        not null,
  client_id       uuid        not null,
  catalog_version text        not null references sf_catalog(version),
  weight_version  int         not null references sf_weight_versions(id),
  seq             integer     not null default 0,
  answers_json    jsonb       not null default '[]'::jsonb,
  result_json     jsonb,
  feedback        smallint    check (feedback between 1 and 5),
  feedback_note   text,
  status          text        not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  -- 取代 SQLite 的 rowid：completed_at 相同时用它决定谁更新
  ordinal         int generated always as identity
);

create table if not exists sf_events (
  session_id  uuid        not null references sf_sessions(id),
  seq         integer     not null,
  type        text        not null,
  question_id text,
  payload_json jsonb      not null,
  created_at  timestamptz not null default now(),
  primary key (session_id, seq)
);

create table if not exists sf_answers (
  session_id  uuid    not null references sf_sessions(id),
  question_id text    not null,
  choice      integer not null,
  leaf        text    not null,
  phase       text    not null,
  duration_ms integer not null,
  primary key (session_id, question_id)
);

-- 匿名写入限流。serverless 下内存 Map 活不过一次调用，改用表。
create table if not exists sf_rate_limit (
  bucket     text        primary key,
  hits       integer     not null default 0,
  started_at timestamptz not null default now()
);

create index if not exists sf_answers_question   on sf_answers  (question_id, choice);
create index if not exists sf_events_question    on sf_events   (question_id, type);
create index if not exists sf_sessions_client    on sf_sessions (client_id, completed_at);
create index if not exists sf_sessions_status    on sf_sessions (status);
create index if not exists sf_sessions_catalog   on sf_sessions (catalog_version, status);
