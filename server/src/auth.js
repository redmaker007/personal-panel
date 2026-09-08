import { randomBytes } from "node:crypto";

/**
 * 極簡單人後台驗證：一組密碼，登入成功後發一個記憶體內的 session token，放 httpOnly cookie。
 * 之後要正經一點再換 express-session / 使用者表。
 *
 * 密碼從環境變數 ADMIN_PASSWORD 讀。放在 server/.env（已 gitignore）即可，
 * npm scripts 會用 --env-file-if-exists 載入。不要把真的密碼寫死在這裡。
 */
const PASSWORD = process.env.ADMIN_PASSWORD;
const COOKIE = "pp_admin";
const sessions = new Set();

function parseCookies(header = "") {
  return Object.fromEntries(
    header.split(";").map((c) => {
      const i = c.indexOf("=");
      return i < 0 ? [c.trim(), ""] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    })
  );
}

export function login(password) {
  if (!PASSWORD || typeof password !== 'string' || password !== PASSWORD) return null;
  const token = randomBytes(24).toString("hex");
  sessions.add(token);
  return token;
}

export function logout(token) {
  sessions.delete(token);
}

export function cookieName() {
  return COOKIE;
}

/** 保護 API：未登入回 401。 */
export function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie).pp_admin;
  if (token && sessions.has(token)) {
    req.adminToken = token;
    return next();
  }
  res.status(401).json({ error: "unauthorized" });
}

/** 保護頁面：未登入導去 /admin/login.html。 */
export function requirePage(req, res, next) {
  const token = parseCookies(req.headers.cookie).pp_admin;
  if (token && sessions.has(token)) return next();
  res.redirect("/admin/login.html");
}
