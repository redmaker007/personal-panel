import { Router } from 'express';
import * as sf from '../sf-store.js';

export const strength = Router(), strengthAdmin = Router();

// 全部改成异步：Postgres 驱动没有同步 API。
const route = fn => async (req, res, next) => {
  try { res.json(await fn(req, res)); }
  catch (e) { if (e.status) res.status(e.status).json({ error: e.message }); else next(e); }
};

// 匿名写入端点限流。serverless 下内存计数活不过一次调用，改用数据库表。
// 不保存原始 IP：只存它的哈希前缀当桶名。
const bucketOf = req => 'ip:' + sf.rateBucket(req.ip || '');

strength.use(async (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return next();
  try {
    if (!(await sf.hitRateLimit(bucketOf(req)))) {
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
