import { Router } from "express";
import { db } from "../db.js";

/**
 * 題庫體檢 —— 一組**不需作答資料**的靜態指標。
 * 全部是對 questions / options / dimensions / scenes 的純查詢。
 *
 * 鏡像前端 score()（index.html）的兩條規則：
 *   - 區塊歸桶：b1 → obj、b4 → cross、其餘 → self
 *   - 計算選項總分時略過 "_" 開頭的維度鍵（體型傾向三軸）
 */
export const audit = Router();

const bucketOf = (block) => (block === "b1" ? "obj" : block === "b4" ? "cross" : "self");
const abilityTotal = (score) =>
  Object.entries(score).reduce((n, [k, v]) => (k[0] === "_" ? n : n + v), 0);

// 該題所有選項觸及的「能力」維度（排除體型傾向三軸）。
// 只餵 soma 軸的判定題（增重、手腕圍、肩腰比…）在此為空集，鑑別力類的檢查會跳過。
const abilityDims = (q) => {
  const s = new Set();
  for (const o of q.options) for (const k of Object.keys(o.score)) if (k[0] !== "_") s.add(k);
  return s;
};

function loadQuestions() {
  const qs = db
    .prepare("SELECT id, block, order_idx, abs_idx, type, stem_zh, shuffled FROM questions ORDER BY abs_idx")
    .all();
  const opts = db
    .prepare("SELECT question_id, order_idx, label_zh, score_json FROM options ORDER BY question_id, order_idx")
    .all();
  const byQ = new Map();
  for (const o of opts) {
    if (!byQ.has(o.question_id)) byQ.set(o.question_id, []);
    byQ.get(o.question_id).push({
      idx: o.order_idx,
      label_zh: o.label_zh,
      score: JSON.parse(o.score_json || "{}"),
    });
  }
  for (const q of qs) q.options = byQ.get(q.id) || [];
  return qs;
}

function dimDomainMap() {
  const m = {};
  for (const d of db.prepare("SELECT key, domain FROM dimensions").all()) m[d.key] = d.domain;
  return m;
}

/* ---------------- 維度覆蓋 ---------------- */
function coverage() {
  const dims = db.prepare("SELECT key, name_zh, domain, grp FROM dimensions ORDER BY domain, key").all();
  const qs = loadQuestions();
  const acc = {}; // key -> {obj:Set<abs_idx>, self:Set, cross:Set}

  for (const q of qs) {
    if (q.type === "num") continue;
    const b = bucketOf(q.block);
    const keys = new Set();
    for (const o of q.options) for (const k of Object.keys(o.score)) keys.add(k);
    for (const k of keys) {
      (acc[k] ??= { obj: new Set(), self: new Set(), cross: new Set() })[b].add(q.abs_idx);
    }
  }

  return dims.map((d) => {
    const a = acc[d.key] || { obj: new Set(), self: new Set(), cross: new Set() };
    const n_obj = a.obj.size, n_self = a.self.size, n_cross = a.cross.size;
    const n_total = n_obj + n_self + n_cross;
    const questions = [...new Set([...a.obj, ...a.self, ...a.cross])].sort((x, y) => x - y);
    const flags = [];
    if (d.domain !== "soma") {
      if (n_total <= 1) flags.push("single_item");
      else if (n_total < 3) flags.push("under_covered");
      if (n_obj === 0 && n_cross === 0) flags.push("self_only");
      else if (n_cross === 0) flags.push("no_crosscheck");
    }
    return { key: d.key, name_zh: d.name_zh, domain: d.domain, grp: d.grp,
             n_total, n_obj, n_self, n_cross, questions, flags };
  });
}

/* ---------------- 區塊三：無最優解稽核 ---------------- */
function dominates(a, b, keys) {
  // a 在每個維度上都 >= b，且至少一個 >
  let strict = false;
  for (const k of keys) {
    const va = a.score[k] || 0, vb = b.score[k] || 0;
    if (va < vb) return false;
    if (va > vb) strict = true;
  }
  return strict;
}

function b3Audit() {
  const qs = loadQuestions().filter((q) => q.block === "b3" && q.type === "choice");
  const positionHist = [0, 0, 0, 0, 0];
  let tieCount = 0;

  const items = qs.map((q) => {
    const keys = abilityDims(q);
    // 所有選項觸及的維度集合是否完全一致 —— Type A「純排序題」的標記
    const perOptDims = q.options.map((o) => Object.keys(o.score).filter((k) => k[0] !== "_").sort().join(","));
    const all_same_dims = perOptDims.every((s) => s === perOptDims[0] && s !== "");
    const opts = q.options.map((o) => ({
      idx: o.idx,
      total: abilityTotal(o.score),
      by_dim: Object.fromEntries(Object.entries(o.score).filter(([k]) => k[0] !== "_")),
    }));

    // Pareto 支配：某選項在所有維度上都不輸其他每一個選項
    let dominant_idx = null;
    for (const cand of q.options) {
      const others = q.options.filter((o) => o !== cand);
      if (others.every((o) => dominates(cand, o, keys))) { dominant_idx = cand.idx; break; }
    }

    const maxTotal = Math.max(...opts.map((o) => o.total));
    const maxPositions = opts.filter((o) => o.total === maxTotal).map((o) => o.idx);
    if (maxPositions.length === 1) positionHist[maxPositions[0]] += 1;
    else tieCount += 1;

    const flags = [];
    if (dominant_idx !== null) flags.push("dominant_option");
    if (all_same_dims && dominant_idx !== null) flags.push("pure_ranking");

    return {
      id: q.id, abs_idx: q.abs_idx, stem_zh: q.stem_zh,
      options: opts, dominant_idx, all_same_dims, max_positions: maxPositions, flags,
    };
  });

  return {
    count: items.length,
    position_histogram: positionHist, // 最強選項落在 A..E 的題數
    tie_count: tieCount,
    items: items.sort((a, b) => b.flags.length - a.flags.length || a.abs_idx - b.abs_idx),
  };
}

/* ---------------- 區塊一/二/四：選項單調性 ---------------- */
function monotonic() {
  const qs = loadQuestions().filter((q) => q.type === "choice" && q.block !== "b3");
  return qs
    .filter((q) => abilityDims(q).size > 0) // 跳過只餵體型傾向軸的判定題
    .map((q) => {
      const totals = q.options.map((o) => abilityTotal(o.score));
      let non_monotonic = false;
      for (let i = 1; i < totals.length; i++) if (totals[i] < totals[i - 1]) non_monotonic = true;
      return { id: q.id, abs_idx: q.abs_idx, block: q.block, stem_zh: q.stem_zh, totals, non_monotonic };
    })
    .filter((q) => q.non_monotonic);
}

/* ---------------- 鑑別力（靜態）：選項分數分佈 ---------------- */
function spread() {
  const qs = loadQuestions().filter((q) => q.type === "choice" && abilityDims(q).size > 0);
  const flat = [];
  for (const q of qs) {
    const totals = q.options.map((o) => abilityTotal(o.score));
    const total_range = Math.max(...totals) - Math.min(...totals);

    // 某維度在 >=2 個選項出現、但值全一樣
    const perDim = {};
    for (const o of q.options)
      for (const [k, v] of Object.entries(o.score))
        if (k[0] !== "_") (perDim[k] ??= []).push(v);
    const flat_dims = Object.entries(perDim)
      .filter(([, vs]) => vs.length >= 2 && vs.every((v) => v === vs[0]))
      .map(([k]) => k);

    if (total_range <= 1 || flat_dims.length) {
      flat.push({ id: q.id, abs_idx: q.abs_idx, block: q.block, stem_zh: q.stem_zh, total_range, flat_dims });
    }
  }
  return flat.sort((a, b) => a.total_range - b.total_range || a.abs_idx - b.abs_idx);
}

/* ---------------- 硬件／軟件平衡 ---------------- */
function balance() {
  const dom = dimDomainMap();
  const qs = loadQuestions().filter((q) => q.type === "choice");

  const qHw = new Set(), qSw = new Set();
  for (const q of qs) {
    for (const o of q.options)
      for (const k of Object.keys(o.score)) {
        if (dom[k] === "hw") qHw.add(q.abs_idx);
        else if (dom[k] === "sw") qSw.add(q.abs_idx);
      }
  }

  const scenes = db.prepare("SELECT name, weights_json FROM scenes ORDER BY order_idx").all()
    .map((s) => ({ name: s.name, w: JSON.parse(s.weights_json || "{}") }));

  let sceneHw = 0, sceneSw = 0, sceneMixed = 0, sceneAnyHw = 0;
  const hwSceneCov = {};
  for (const sc of scenes) {
    let hw = 0, sw = 0, hasHw = false;
    for (const [k, w] of Object.entries(sc.w)) {
      if (dom[k] === "hw") { hw += w; hasHw = true; hwSceneCov[k] = (hwSceneCov[k] || 0) + 1; }
      else if (dom[k] === "sw") sw += w;
    }
    if (hasHw) sceneAnyHw += 1;
    if (hw > sw) sceneHw += 1;
    else if (sw > hw) sceneSw += 1;
    else sceneMixed += 1;
  }

  const hwDims = db.prepare("SELECT key, name_zh FROM dimensions WHERE domain = 'hw' ORDER BY key").all();
  const hw_dim_scene_coverage = hwDims.map((d) => ({
    key: d.key, name_zh: d.name_zh, n_scenes: hwSceneCov[d.key] || 0,
  }));

  return {
    questions: { hw: qHw.size, sw: qSw.size, total: qs.length },
    scenes: {
      total: scenes.length,
      hw_dominant: sceneHw, sw_dominant: sceneSw, mixed: sceneMixed,
      any_hw: sceneAnyHw, any_hw_pct: Math.round((sceneAnyHw / scenes.length) * 100),
    },
    hw_dim_scene_coverage,
  };
}

/* ---------------- 路由 ---------------- */
audit.get("/coverage", (req, res) => res.json(coverage()));
audit.get("/b3", (req, res) => res.json(b3Audit()));
audit.get("/monotonic", (req, res) => res.json(monotonic()));
audit.get("/spread", (req, res) => res.json(spread()));
audit.get("/balance", (req, res) => res.json(balance()));

audit.get("/summary", (req, res) => {
  const cov = coverage();
  const b3 = b3Audit();
  res.json({
    dims_single_item: cov.filter((d) => d.flags.includes("single_item")).length,
    dims_under_covered: cov.filter((d) => d.flags.includes("under_covered")).length,
    dims_self_only: cov.filter((d) => d.flags.includes("self_only")).length,
    dims_no_crosscheck: cov.filter((d) => d.flags.includes("no_crosscheck")).length,
    b3_dominant_options: b3.items.filter((i) => i.dominant_idx !== null).length,
    b3_position_histogram: b3.position_histogram,
    non_monotonic: monotonic().length,
    low_discrimination: spread().length,
  });
});
