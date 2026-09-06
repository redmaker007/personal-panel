import { Router } from "express";
import { db } from "../db.js";

/**
 * 題目讀取 + 編輯。
 *
 * 能做：改既有題目的內容 —— 題幹（中／英）、選項文字、選項的維度加分、
 *       num 題的範圍與單位、b3 的打亂旗標。
 * 不做：新增／刪除／換順序整題。那會位移絕對題號，必須連動前端的
 *       KEY / CODE_VER，且目前前端還是讀 index.html 寫死的題庫，
 *       DB 的編輯尚未回寫。POST / DELETE 因此維持 501。
 */
export const questions = Router();

const qById = db.prepare("SELECT * FROM questions WHERE id = ?");
const optsByQ = db.prepare("SELECT * FROM options WHERE question_id = ? ORDER BY order_idx");

function withOptions(q) {
  return { ...q, options: optsByQ.all(q.id) };
}

function dimKeySet() {
  return new Set(db.prepare("SELECT key FROM dimensions").all().map((r) => r.key));
}

/* ---------- 讀 ---------- */
questions.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM questions ORDER BY abs_idx").all();
  res.json(rows.map(withOptions));
});

questions.get("/:id", (req, res) => {
  const q = qById.get(req.params.id);
  if (!q) return res.status(404).json({ error: "not found" });
  res.json(withOptions(q));
});

/* ---------- 改 ---------- */
questions.put("/:id", (req, res) => {
  const q = qById.get(req.params.id);
  if (!q) return res.status(404).json({ error: "not found" });

  const b = req.body || {};
  const errors = [];

  const stem_zh = typeof b.stem_zh === "string" ? b.stem_zh.trim() : q.stem_zh;
  const stem_en = typeof b.stem_en === "string" ? b.stem_en.trim() : q.stem_en;
  if (!stem_zh) errors.push("stem_zh 不可為空");

  let patch = { stem_zh, stem_en };
  let newOptions = null;

  if (q.type === "num") {
    const num_min = b.num_min ?? q.num_min;
    const num_max = b.num_max ?? q.num_max;
    if (num_min != null && typeof num_min !== "number") errors.push("num_min 必須是數字");
    if (num_max != null && typeof num_max !== "number") errors.push("num_max 必須是數字");
    if (typeof num_min === "number" && typeof num_max === "number" && num_min >= num_max)
      errors.push("num_min 必須小於 num_max");
    patch = {
      ...patch,
      num_min,
      num_max,
      unit_zh: b.unit_zh ?? q.unit_zh,
      unit_en: b.unit_en ?? q.unit_en,
      placeholder: b.placeholder ?? q.placeholder,
    };
  } else {
    patch = { ...patch, shuffled: b.shuffled != null ? (b.shuffled ? 1 : 0) : q.shuffled };

    if (b.options != null) {
      if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 8) {
        errors.push("options 需為 2–8 個");
      } else {
        const keys = dimKeySet();
        newOptions = b.options.map((o, i) => {
          const label_zh = typeof o.label_zh === "string" ? o.label_zh.trim() : "";
          const label_en = typeof o.label_en === "string" ? o.label_en.trim() : "";
          if (!label_zh) errors.push(`選項 ${i + 1}：label_zh 不可為空`);

          const score = o.score && typeof o.score === "object" ? o.score : {};
          const clean = {};
          for (const [k, v] of Object.entries(score)) {
            if (!keys.has(k)) { errors.push(`選項 ${i + 1}：未知維度「${k}」`); continue; }
            const n = Number(v);
            if (!Number.isInteger(n) || n < 1 || n > 5) {
              errors.push(`選項 ${i + 1}：維度「${k}」分數需為 1–5 的整數`);
              continue;
            }
            clean[k] = n;
          }
          return { order_idx: i, label_zh, label_en, score_json: JSON.stringify(clean) };
        });
      }
    }
  }

  if (errors.length) return res.status(400).json({ error: "validation failed", details: errors });

  const cols = Object.keys(patch);
  const setSql = cols.map((c) => `${c} = @${c}`).join(", ");

  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE questions SET ${setSql}, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...patch, id: q.id });

    if (newOptions) {
      db.prepare("DELETE FROM options WHERE question_id = ?").run(q.id);
      const ins = db.prepare(
        `INSERT INTO options (question_id, order_idx, label_zh, label_en, score_json)
         VALUES (@question_id, @order_idx, @label_zh, @label_en, @score_json)`
      );
      for (const o of newOptions) ins.run({ ...o, question_id: q.id });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    return res.status(500).json({ error: "write failed", detail: String(e) });
  }

  res.json(withOptions(qById.get(q.id)));
});

/* ---------- 尚未開放 ---------- */
questions.post("/", (req, res) => {
  res.status(501).json({
    error: "not implemented",
    note: "新增整題會位移絕對題號，需連動前端 KEY / CODE_VER，且 DB 尚未回寫 index.html",
  });
});

questions.delete("/:id", (req, res) => {
  res.status(501).json({
    error: "not implemented",
    note: "刪整題會位移絕對題號，需連動前端 KEY / CODE_VER",
  });
});
