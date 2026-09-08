CREATE TABLE IF NOT EXISTS sf_catalog (
  version TEXT PRIMARY KEY, catalog_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sf_weight_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, weights_json TEXT NOT NULL, reason TEXT NOT NULL,
  report_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  catalog_version TEXT NOT NULL DEFAULT 'sf2.1'
);
CREATE TABLE IF NOT EXISTS sf_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sf_sessions (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, client_id TEXT NOT NULL,
  catalog_version TEXT NOT NULL REFERENCES sf_catalog(version), weight_version INTEGER NOT NULL REFERENCES sf_weight_versions(id),
  seq INTEGER NOT NULL DEFAULT 0, answers_json TEXT NOT NULL DEFAULT '[]', result_json TEXT,
  feedback INTEGER CHECK (feedback BETWEEN 1 AND 5), feedback_note TEXT,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT
);
CREATE TABLE IF NOT EXISTS sf_events (
  session_id TEXT NOT NULL REFERENCES sf_sessions(id), seq INTEGER NOT NULL, type TEXT NOT NULL,
  question_id TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(session_id, seq)
);
CREATE TABLE IF NOT EXISTS sf_answers (
  session_id TEXT NOT NULL REFERENCES sf_sessions(id), question_id TEXT NOT NULL,
  choice INTEGER NOT NULL, leaf TEXT NOT NULL, phase TEXT NOT NULL, duration_ms INTEGER NOT NULL,
  PRIMARY KEY(session_id, question_id)
);
CREATE INDEX IF NOT EXISTS sf_answers_question ON sf_answers(question_id, choice);
CREATE INDEX IF NOT EXISTS sf_events_question ON sf_events(question_id, type);
CREATE INDEX IF NOT EXISTS sf_sessions_client ON sf_sessions(client_id, completed_at);
CREATE INDEX IF NOT EXISTS sf_sessions_status ON sf_sessions(status);
