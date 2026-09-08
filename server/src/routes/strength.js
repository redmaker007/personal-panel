import { Router } from 'express';
import * as sf from '../sf-store.js';
export const strength = Router(), strengthAdmin = Router();
const route = fn => (req,res,next) => { try { res.json(fn(req,res)); } catch(e) { if (e.status) res.status(e.status).json({error:e.message}); else next(e); } };
// Anonymous write endpoints are bounded. No raw IP or user-agent is persisted.
const limits = new Map();
strength.use((req,res,next) => {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'POST') return next();
  const now=Date.now(), key=req.ip;
  if (limits.size > 10000) for (const [k,v] of limits) if (now-v.at>60000) limits.delete(k);
  const entry=limits.get(key);
  const current=entry && now-entry.at<60000 ? entry : { at:now,n:0 };
  current.n++; limits.set(key,current);
  if (current.n>240 || limits.size>12000) return res.status(429).json({error:'提交过于频繁，稍后将自动重试'});
  next();
});
strength.get('/config',route(req=>sf.configuration(req.query.catalogVersion)));
strength.post('/sessions',route(req=>sf.createSession(req.body || {})));
strength.post('/sessions/:id/events',route(req=>sf.recordEvents(req.params.id,req.headers.authorization?.replace(/^Bearer /,''),req.body?.events)));
strengthAdmin.use((req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
strengthAdmin.get('/summary',route(req=>sf.summary(req.query.catalogVersion)));
strengthAdmin.get('/sessions',route(req=>sf.sessionPage(Math.min(100,Math.max(1,parseInt(req.query.limit)||50)),Math.max(0,parseInt(req.query.offset)||0),req.query.catalogVersion??null)));
strengthAdmin.get('/sessions/:id',route(req=>sf.sessionDetail(req.params.id)));
strengthAdmin.post('/analyze',route(()=>sf.calibrate(true)));
strengthAdmin.put('/automatic',route(req=>sf.setAutomatic(req.body?.enabled)));
strengthAdmin.post('/rollback',route(req=>sf.rollback(req.body?.version)));
