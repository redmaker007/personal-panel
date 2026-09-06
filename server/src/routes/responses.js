import { Router } from "express";
import { db } from "../db.js";

/**
 * 作答回收 —— 骨架。
 * 之後前端在結果頁把「壓縮碼 + 摘要」POST 到這裡（取代 / 併行現在的 Google 表單）。
 * 逐題 answers 可以由壓縮碼在伺服器端還原後寫入 submission_answers。
 */
export const responses = Router();

responses.post("/", (req, res) => {
  const b = req.body || {};
  if (!b.code) return res.status(400).json({ error: "missing code" });

  const info = db
    .prepare(
      `INSERT INTO submissions
         (code, code_ver, q_count, user_agent, block_reached, hw_avg, sw_avg, confidence, self_rating)
       VALUES (@code, @code_ver, @q_count, @user_agent, @block_reached, @hw_avg, @sw_avg, @confidence, @self_rating)`
    )
    .run({
      code: b.code,
      code_ver: b.code_ver ?? null,
      q_count: b.q_count ?? null,
      user_agent: req.headers["user-agent"] || null,
      block_reached: b.block_reached ?? null,
      hw_avg: b.hw_avg ?? null,
      sw_avg: b.sw_avg ?? null,
      confidence: b.confidence ?? null,
      self_rating: b.self_rating ?? null,
    });

  // TODO: 由 code 還原逐題 answers 寫入 submission_answers
  res.status(201).json({ id: info.lastInsertRowid });
});
