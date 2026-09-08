import express from 'express';
import { strength } from './routes/strength.js';

/**
 * 2.0 强项查找器的**公开** API。
 * 本地 server/src/index.js 和 Vercel 的 api/index.js 共用这一份，避免两处漂移。
 * 这里只有匿名写入端点，没有后台、没有登录——后台只在本地跑。
 */
export function publicApi() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '128kb' }));
  app.use('/api/strength', strength);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error(err.message);
    res.status(err.status || 500).json({
      error: err.status === 400 ? '请求格式无效' : '服务暂时不可用，请稍后重试',
    });
  });
  return app;
}
