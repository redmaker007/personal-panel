import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH || join(__dirname, "..", "data", "panel.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

// Node 內建 SQLite（v22.5+）。免原生編譯。
export const db = new DatabaseSync(DB_PATH);

/** 建表（冪等）。改 schema 就在 schema.sql 加 CREATE / 這裡加 migrate 步驟。 */
export function migrate() {
  const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
  db.exec(sql);

  // 舊 DB 補欄位（CREATE TABLE IF NOT EXISTS 不會改既有表）
  const cols = db.prepare("PRAGMA table_info(questions)").all().map((c) => c.name);
  if (!cols.includes("abs_idx")) {
    db.exec("ALTER TABLE questions ADD COLUMN abs_idx INTEGER");
  }
  db.exec("UPDATE meta SET value = '6' WHERE key = 'schema_version'");
}

export function schemaVersion() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  return row ? Number(row.value) : 0;
}

// Route modules prepare statements during import, so migrate before importing them.
migrate();
