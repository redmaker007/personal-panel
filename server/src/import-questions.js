/**
 * 把 index.html 的題庫（B1–B4 + EN.q）匯入 SQLite。
 *
 *   node src/import-questions.js
 *
 * 做法：抽出 index.html 裡純資料的 <script> 區塊，在沙箱中求值，
 * 拿到 BLOCKS / B1..B4 / EN.q / DIM / EN.dim / SCENES，
 * 攤平寫進 questions / options / dimensions / scenes。
 * 可重複執行 —— 每次會先清空這四張表再重灌。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { db, migrate } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = process.env.INDEX_HTML || join(__dirname, "..", "..", "index.html");

/* ---------- 1. 從 index.html 取出題庫資料 ---------- */
function extractData() {
  const html = readFileSync(INDEX_HTML, "utf8");
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

  // 只留下定義題庫 / 維度 / 場景 / 英文字串的區塊（皆為純資料，無 DOM 依賴）
  const needed = scripts.filter((s) =>
    /const (BLOCKS|B1|B2|B3|B4|DIM|SCENES) =|const EN = \{\}|EN\.(q(\.b[1-4])?|dim) =/.test(s)
  );
  if (needed.length < 7) {
    throw new Error(`index.html 結構可能變了：只找到 ${needed.length} 個資料區塊`);
  }

  const src =
    needed.join("\n;\n") +
    `\n;({
      BLOCKS, B1, B2, B3, B4,
      DIM: (typeof DIM !== 'undefined' ? DIM : {}),
      SCENES: (typeof SCENES !== 'undefined' ? SCENES : []),
      ENq: (typeof EN !== 'undefined' ? EN.q : {}),
      ENdim: (typeof EN !== 'undefined' ? EN.dim : {}),
    });`;

  return vm.runInNewContext(src, Object.create(null), { filename: "index.html:scripts" });
}

/* ---------- 維度字典 ---------- */
const SOMA = [
  ["_ecto", "外胚型軸", "Ectomorph axis"],
  ["_meso", "中胚型軸", "Mesomorph axis"],
  ["_endo", "內胚型軸", "Endomorph axis"],
];

function flattenDims({ DIM, ENdim }) {
  const rows = Object.entries(DIM || {}).map(([key, d]) => ({
    key,
    name_zh: d.n || "",
    name_en: (ENdim && ENdim[key] && ENdim[key].n) || "",
    domain: d.d || null,
    grp: d.g || null,
    example: d.ex || null,
  }));
  for (const [key, zh, en] of SOMA) {
    rows.push({ key, name_zh: zh, name_en: en, domain: "soma", grp: null, example: null });
  }
  return rows;
}

/* ---------- 場景 ---------- */
function flattenScenes({ SCENES }) {
  return (SCENES || []).map((sc, i) => ({
    order_idx: i,
    name: sc.n || "",
    weights_json: JSON.stringify(sc.w || {}),
  }));
}

/* ---------- 2. 攤平成逐題 / 逐選項 ---------- */
function flatten({ BLOCKS, B1, B2, B3, B4, ENq }) {
  const byKey = { b1: B1, b2: B2, b3: B3, b4: B4 };
  const rows = [];
  let abs = 0;

  for (const { k } of BLOCKS) {
    const arr = byKey[k];
    const en = (ENq && ENq[k]) || [];
    arr.forEach((q, i) => {
      const enQ = en[i] || {};
      const isNum = q.type === "num";
      rows.push({
        block: k,
        order_idx: i,
        abs_idx: abs,
        type: isNum ? "num" : "choice",
        stem_zh: q.t || "",
        stem_en: enQ.t || "",
        num_key: isNum ? q.key ?? null : null,
        unit_zh: isNum ? q.unit ?? null : null,
        unit_en: isNum ? enQ.u ?? null : null,
        num_min: isNum ? q.min ?? null : null,
        num_max: isNum ? q.max ?? null : null,
        placeholder: isNum ? q.ph ?? null : null,
        shuffled: k === "b3" ? 1 : 0,
        options: (q.o || []).map((opt, j) => ({
          order_idx: j,
          label_zh: typeof opt === "string" ? opt : opt.t || "",
          label_en: (enQ.o && enQ.o[j]) || "",
          score_json: JSON.stringify((opt && opt.s) || {}),
        })),
      });
      abs += 1;
    });
  }
  return rows;
}

/* ---------- 3. 寫入 ---------- */
function importRows(rows, dims, scenes) {
  const insQ = db.prepare(`
    INSERT INTO questions
      (block, order_idx, abs_idx, type, stem_zh, stem_en,
       num_key, unit_zh, unit_en, num_min, num_max, placeholder, shuffled)
    VALUES
      (@block, @order_idx, @abs_idx, @type, @stem_zh, @stem_en,
       @num_key, @unit_zh, @unit_en, @num_min, @num_max, @placeholder, @shuffled)
  `);
  const insO = db.prepare(`
    INSERT INTO options (question_id, order_idx, label_zh, label_en, score_json)
    VALUES (@question_id, @order_idx, @label_zh, @label_en, @score_json)
  `);

  const insD = db.prepare(`
    INSERT INTO dimensions (key, name_zh, name_en, domain, grp, example)
    VALUES (@key, @name_zh, @name_en, @domain, @grp, @example)
  `);

  const insS = db.prepare(`
    INSERT INTO scenes (order_idx, name, weights_json)
    VALUES (@order_idx, @name, @weights_json)
  `);

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM options; DELETE FROM questions; DELETE FROM dimensions; DELETE FROM scenes;");
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('questions','options','scenes')");
    let nOpt = 0;
    for (const r of rows) {
      const { options, ...qFields } = r;
      const { lastInsertRowid: qid } = insQ.run(qFields);
      for (const o of options) {
        insO.run({ ...o, question_id: Number(qid) });
        nOpt += 1;
      }
    }
    for (const d of dims) insD.run(d);
    for (const s of scenes) insS.run(s);
    db.exec("COMMIT");
    return nOpt;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/* ---------- main ---------- */
migrate();
const data = extractData();
const rows = flatten(data);
const dims = flattenDims(data);
const scenes = flattenScenes(data);
const nOpt = importRows(rows, dims, scenes);

const byBlock = rows.reduce((m, r) => ((m[r.block] = (m[r.block] || 0) + 1), m), {});
console.log(`匯入完成：${rows.length} 題、${nOpt} 選項、${dims.length} 維度、${scenes.length} 場景`);
console.log("  分區：", byBlock);
console.log(`  來源：${INDEX_HTML}`);
