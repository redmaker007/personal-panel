import { L, KEYS, CATALOG, QUESTION_MAP } from './sf-data-v21.mjs';

export const DEFAULT_WEIGHTS = Object.fromEntries(KEYS.map(k => [k, 1]));
export const DELTAS = [-7, -5, -3, -1, 1];
const roots = [...new Set(KEYS.map(k => L[k].root))];
const order = Array.from({ length: 8 }, (_, i) => roots.map(root => KEYS.filter(k => L[k].root === root)[i])).flat().filter(Boolean);

// Replay is the single source of truth for both the browser and server.
// Pruning keeps its original scale; reliability weights adjust evidence ranking.
export function evaluate(answers = [], weights = DEFAULT_WEIGHTS) {
  const state = Object.fromEntries(KEYS.map(k => [k, { score: 10, count: 0, targeted: 0, sum: 0, out: false }]));
  let next = null, depth = null, prediction = null, phase = 'A';
  let ai = 0, bi = 0, ci = 0;
  const rankValue = k => state[k].targeted ? 7 + (3 + state[k].sum / state[k].targeted) * (weights[k] ?? 1) : 3;
  function advance() {
    if (ai < 10) { phase = 'A'; return QUESTION_MAP['A.' + ai]; }
    while (bi < order.length && state[order[bi]].out) bi++;
    if (bi < order.length) { phase = 'B'; return QUESTION_MAP[order[bi] + '.0']; }
    if (!depth) depth = KEYS.filter(k => !state[k].out && state[k].targeted === 1).sort((a,b) => rankValue(b) - rankValue(a)).slice(0, 5);
    if (ci < depth.length) { phase = 'C'; return QUESTION_MAP[depth[ci] + '.1']; }
    phase = 'D';
    return prediction === null ? QUESTION_MAP.predict : null;
  }
  next = advance();
  for (const answer of answers) {
    if (!next || answer.questionId !== next.id || !Number.isInteger(answer.choice) || !next.options[answer.choice]) throw new Error('作答顺序或选项无效，请恢复已保存的进度。');
    const option = next.options[answer.choice];
    if (phase === 'D') prediction = option.leaf;
    else {
      const s = state[option.leaf];
      const delta = phase === 'A' ? -7 : DELTAS[answer.choice];
      s.score += delta; s.count++;
      if (phase !== 'A') { s.targeted++; s.sum += delta; }
      s.out = s.score <= 3;
      if (phase === 'A') ai++; else if (phase === 'B') bi++; else ci++;
    }
    next = advance();
  }
  const ranked = KEYS.filter(k => state[k].targeted > 0).map(k => ({ key: k, value: rankValue(k), ...state[k] })).sort((a,b) => b.value - a.value || b.targeted - a.targeted || b.score - a.score);
  const remaining = phase === 'A' ? (10-ai) + order.filter(k => !state[k].out).length + 6 : phase === 'B' ? order.slice(bi).filter(k => !state[k].out).length + 6 : phase === 'C' ? depth.length-ci+1 : next ? 1 : 0;
  return { next, phase, state, ranked, prediction, done: !next, answered: answers.length, estimatedTotal: answers.length + remaining, catalogCount: CATALOG.length };
}

export function answerRecord(questionId, choice, durationMs = 0) {
  const q = QUESTION_MAP[questionId], o = q?.options[choice];
  if (!o) throw new Error('无效选项');
  return { questionId, choice, durationMs, phase: q.phase, leaf: o.leaf, stem: q.stem, option: o.text, delta: q.phase === 'D' ? 0 : q.phase === 'A' ? -7 : DELTAS[choice] };
}

