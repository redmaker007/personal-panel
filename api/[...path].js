// Vercel serverless 入口：只暴露 2.0 的公开 API。
// 后台（/admin、/api/strength-admin）只在本地跑，不部署。
import { publicApi } from '../server/src/strength-app.js';
export default publicApi();
