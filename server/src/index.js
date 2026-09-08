import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate, schemaVersion } from "./db.js";
import { login, logout, cookieName, requireAuth, requirePage } from "./auth.js";
import { questions } from "./routes/questions.js";
import { dimensions } from "./routes/dimensions.js";
import { audit } from "./routes/audit.js";
import { stats } from "./routes/stats.js";
import { responses } from "./routes/responses.js";
import { strength, strengthAdmin } from './routes/strength.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");        // 專案根目錄（放 index.html 的地方）
const ADMIN_DIR = join(__dirname, "..", "admin");
const PORT = process.env.PORT || 4000;

migrate();

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'128kb'}));

/* ---------- 驗證 ---------- */
app.post("/api/login", (req, res) => {
  const token = login((req.body || {}).password);
  if (!token) return res.status(401).json({ error: "wrong password" });
  res.setHeader(
    "Set-Cookie",
    `${cookieName()}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`
  );
  res.json({ ok: true });
});

app.post("/api/logout", requireAuth, (req, res) => {
  logout(req.adminToken);
  res.setHeader("Set-Cookie", `${cookieName()}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

/* ---------- API ---------- */
app.get("/api/health", (req, res) => res.json({ ok: true, schema: schemaVersion() }));
app.use("/api/responses", responses);                 // 前端回收：不需登入
app.use("/api/questions", requireAuth, questions);     // 後台：需登入
app.use("/api/dimensions", requireAuth, dimensions);
app.use("/api/audit", requireAuth, audit);
app.use("/api/stats", requireAuth, stats);
app.use('/api/strength', strength);
app.use('/api/strength-admin', requireAuth, strengthAdmin);

/* ---------- 後台頁面 ---------- */
// login.html 與 css/js 資產不擋；其餘 .html 需登入。API 本身另有 requireAuth 把關。
app.use(
  "/admin",
  (req, res, next) => {
    if (req.path === "/login.html" || /\.(css|js|map|ico|png|svg)$/.test(req.path)) return next();
    return requirePage(req, res, next);
  },
  express.static(ADMIN_DIR, { index: "index.html", extensions: ["html"] })
);
app.get("/admin", requirePage, (req, res) => res.sendFile(join(ADMIN_DIR, "index.html")));

/* ---------- 前端測驗站（原本的靜態站） ---------- */
app.get('/', (req,res) => res.sendFile(join(ROOT,'v2.html')));
app.get(['/v2.html','/v2'], (req,res) => res.sendFile(join(ROOT,'v2.html')));
app.get('/v2-previous.html', (req,res) => res.sendFile(join(ROOT,'v2-previous.html')));
app.get('/index.html', (req,res) => res.sendFile(join(ROOT,'index.html')));
app.use('/assets', express.static(join(ROOT,'assets')));
// Only publish front-end assets; never expose source, .env or the SQLite database.
app.use((err,req,res,next) => {
  if (res.headersSent) return next(err);
  console.error(err.message);
  res.status(err.status || 500).json({error: err.status === 400 ? '请求格式无效' : '服务暂时不可用，请稍后重试'});
});

const listener = app.listen(PORT, () => {
  const boundPort = listener.address().port;
  console.log(`個人屬性面板 後台  →  http://localhost:${boundPort}/admin`);
  console.log(`測驗站            →  http://localhost:${boundPort}/`);
});
