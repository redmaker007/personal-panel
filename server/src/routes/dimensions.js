import { Router } from "express";
import { db } from "../db.js";

/** 維度字典（唯讀）—— 給題目編輯器的維度下拉選單用。 */
export const dimensions = Router();

dimensions.get("/", (req, res) => {
  const rows = db
    .prepare("SELECT key, name_zh, name_en, domain, grp, example FROM dimensions ORDER BY domain, key")
    .all();
  res.json(rows);
});
