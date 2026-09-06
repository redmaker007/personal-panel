-- 個人屬性面板 後台資料庫 schema
-- 目前只是骨架：表結構先立好，題庫的實際搬遷與作答回收之後再接。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 題目。block 為 b1..b4，order_idx 為區塊內的絕對順序（與前端 ALLQ 對齊）。
CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  block       TEXT    NOT NULL CHECK (block IN ('b1','b2','b3','b4')),
  order_idx   INTEGER NOT NULL,          -- 區塊內序號（0-based）
  abs_idx     INTEGER,                   -- 絕對題號（跨區塊，對齊前端 ALLQ / 壓縮碼）
  type        TEXT    NOT NULL DEFAULT 'choice' CHECK (type IN ('choice','num')),
  stem_zh     TEXT    NOT NULL DEFAULT '',
  stem_en     TEXT    NOT NULL DEFAULT '',
  -- num 題專用
  num_key     TEXT,
  unit_zh     TEXT,
  unit_en     TEXT,
  num_min     REAL,
  num_max     REAL,
  placeholder TEXT,
  shuffled    INTEGER NOT NULL DEFAULT 0,   -- 區塊 3 打亂型
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (block, order_idx),
  UNIQUE (abs_idx)
);

-- 選項。score_json 存 {維度key: 分數} 的 JSON，對應前端 o[].s。
CREATE TABLE IF NOT EXISTS options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  order_idx   INTEGER NOT NULL,
  label_zh    TEXT    NOT NULL DEFAULT '',
  label_en    TEXT    NOT NULL DEFAULT '',
  score_json  TEXT    NOT NULL DEFAULT '{}',
  UNIQUE (question_id, order_idx)
);

-- 維度字典。key 對應 options.score_json 裡的維度代號。
-- 由 import 從 index.html 的 DIM / EN.dim 灌入；soma 三軸（_ecto/_endo/_meso）另補。
CREATE TABLE IF NOT EXISTS dimensions (
  key      TEXT PRIMARY KEY,
  name_zh  TEXT NOT NULL DEFAULT '',
  name_en  TEXT NOT NULL DEFAULT '',
  domain   TEXT,                        -- hw / sw / soma
  grp      TEXT,                        -- 主屬性分組代號
  example  TEXT
);

-- 具體場景（前端 SCENES，93 項）。weights_json 存 {維度key: 1..3}。
-- 用來評估硬件／軟件的場景平衡（見 overview guide.txt 第五節）。
CREATE TABLE IF NOT EXISTS scenes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_idx    INTEGER NOT NULL,
  name         TEXT    NOT NULL DEFAULT '',
  weights_json TEXT    NOT NULL DEFAULT '{}',
  UNIQUE (order_idx)
);

-- 一次完整作答。code 為前端的「選擇壓縮碼」，answers 之後可由它還原。
CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT,
  code_ver     INTEGER,
  q_count      INTEGER,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  user_agent   TEXT,
  block_reached INTEGER,
  hw_avg       REAL,
  sw_avg       REAL,
  confidence   REAL,
  self_rating  INTEGER
);

-- 攤平後的逐題作答，方便做「每題每選項多少人選」的統計。
CREATE TABLE IF NOT EXISTS submission_answers (
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  q_abs_idx     INTEGER NOT NULL,   -- 絕對題號（跨區塊）
  choice_idx    INTEGER,            -- 選第幾個選項；num 題為 NULL
  num_value     REAL,               -- num 題填的數值
  PRIMARY KEY (submission_id, q_abs_idx)
);

CREATE INDEX IF NOT EXISTS idx_answers_q ON submission_answers (q_abs_idx, choice_idx);
CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions (created_at);

-- schema 版本，之後 migrate 用
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT INTO meta (key, value) VALUES ('schema_version', '4')
  ON CONFLICT (key) DO NOTHING;
