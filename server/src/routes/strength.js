import { Router } from 'express';
import * as sf from '../sf-store.js';

export const strength = Router(), strengthAdmin = Router();

// 全部改成异步：Postgres 驱动没有同步 API。
const route = fn => async (req, res, next) => {
  try { res.json(await fn(req, res)); }
  catch (e) { if (e.status) res.status(e.status).json({ error: e.message }); else next(e); }
};

// 匿名写入端点限流。serverless 下内存计数活不过一次调用，改用数据库表。
// 原始地址只用来算加盐哈希（在 sf-store 里），不入库。
//
// Vercel 上 req.ip 拿到的是代理层地址，对所有访客都一样——不取真实地址的话
// 全站会共用一个限流桶。x-vercel-forwarded-for 由 Vercel 自己写入，客户端伪造不了。
const clientAddress = req =>
  req.headers['x-vercel-forwarded-for'] ||
  req.headers['x-real-ip'] ||
  req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
  req.ip || '';

strength.use(async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return next();
  try {
    if (!(await sf.hitRateLimit(clientAddress(req)))) {
      return res.status(429).json({ error: '提交过于频繁，稍后将自动重试' });
    }
  } catch (e) {
    // 未配置数据库时不在这里报错，交给下面的路由回 503
    if (e.status !== 503) return next(e);
  }
  next();
});

strength.get('/config', route(req => sf.configuration(req.query.catalogVersion)));
strength.post('/sessions', route(req => sf.createSession(req.body || {})));
strength.post('/sessions/:id/events', route(req => sf.recordEvents(
  req.params.id,
  req.headers.authorization?.replace(/^Bearer /, ''),
  req.body?.events,
)));

strengthAdmin.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
strengthAdmin.get('/summary', route(req => sf.summary(req.query.catalogVersion)));
strengthAdmin.get('/sessions', route(req => sf.sessionPage(
  Math.min(100, Math.max(1, parseInt(req.query.limit) || 50)),
  Math.max(0, parseInt(req.query.offset) || 0),
  req.query.catalogVersion ?? null,
)));
strengthAdmin.get('/sessions/:id', route(req => sf.sessionDetail(req.params.id)));
strengthAdmin.post('/analyze', route(() => sf.calibrate(true)));
strengthAdmin.put('/automatic', route(req => sf.setAutomatic(req.body?.enabled)));
strengthAdmin.post('/rollback', route(req => sf.rollback(req.body?.version)));
