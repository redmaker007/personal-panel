import { Router } from "express";
import { db } from "../db.js";

/**
 * 選項數據 —— 骨架。
 * 目標畫面：每題一列，列出各選項被選的人數 / 佔比；num 題給分佈。
 * 現在 submission_answers 還沒有資料，查詢寫好了但多半回 0。
 */
export const stats = Router();

// 總覽：作答數、最後一筆時間
stats.get("/summary", (req, res) => {
  const total = db.prepare("SELECT COUNT(*) n FROM submissions").get().n;
  const last = db.prepare("SELECT MAX(created_at) t FROM submissions").get().t;
  const answered = db.prepare("SELECT COUNT(*) n FROM submission_answers").get().n;
  res.json({ submissions: total, answers: answered, last_submission: last });
});

// 每題每選項的選擇次數
stats.get("/questions/:absIdx", (req, res) => {
  const absIdx = Number(req.params.absIdx);
  const rows = db
    .prepare(
      `SELECT choice_idx, COUNT(*) AS n
         FROM submission_answers
        WHERE q_abs_idx = ?
        GROUP BY choice_idx
        ORDER BY choice_idx`
    )
    .all(absIdx);
  const nums = db
    .prepare(
      `SELECT num_value FROM submission_answers
        WHERE q_abs_idx = ? AND num_value IS NOT NULL`
    )
    .all(absIdx)
    .map((r) => r.num_value);
  res.json({ q_abs_idx: absIdx, choices: rows, num_values: nums });
});

// 全部題目的選項分佈（一次拉完，前端畫表）
stats.get("/all", (req, res) => {
  const rows = db
    .prepare(
      `SELECT q_abs_idx, choice_idx, COUNT(*) AS n
         FROM submission_answers
        GROUP BY q_abs_idx, choice_idx
        ORDER BY q_abs_idx, choice_idx`
    )
    .all();
  res.json(rows);
});
