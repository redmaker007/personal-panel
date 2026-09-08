# server/

一个 Node + Express + SQLite 服务（用 Node 22.5+ 内建的 `node:sqlite`，免原生编译），
同时承载 **2.0 强项查找器** 和 **1.0 完整面板** 两套东西。

```bash
cd server
npm install
cp .env.example .env      # 填上 ADMIN_PASSWORD（不设则关闭后台登录）
npm run dev               # 或 npm start
npm test                  # 13 个测试，用 tmpdir 隔离，不碰真库
```

默认端口 4000，可用 `.env` 里的 `PORT` 覆盖；实际端口见启动日志。

| 入口 | 说明 |
|---|---|
| `/` 或 `/v2.html` | 2.0 强项查找器（当前默认首页）|
| `/admin` | 后台数据中心（登录后）|
| `/v2-previous.html` | sf2.1 旧题库存档，可继续旧进度 |
| `/index.html` | 1.0 完整面板，已冻结 |

## 2.0（强项查找器）

- 前端：`../v2.html` + `../assets/sf-*.mjs`。浏览器与 Node 共用同一份数据／计分模块。
- 后端：`src/sf-store.js`（会话、事件、权重校准）、`src/sf-schema.sql`（`sf_*` 表）、
  `src/routes/strength.js`（公开 + 管理接口）、`admin/strength-admin.*`（数据面板）。
- 接口、存储语义、自动校准阈值、题库版本隔离，全部见
  [../docs/新版升级说明.md](../docs/新版升级说明.md)。
- 题库版本与配对设计见 [../docs/sf2.2-完整题库.md](../docs/sf2.2-完整题库.md) 与
  [../docs/题库改版说明.md](../docs/题库改版说明.md)。

## 1.0（完整面板后台，遗留）

围绕 `index.html` 的四区块结构建的，2.0 不再使用，但仍可运行：

- `npm run import`：把 `index.html` 的题库解析进数据库（不复制文字，改完题重跑即可）。
- 网页界面编辑既有题目的内容（题干、选项、维度加分、num 范围）。
- **题库体检**：不需作答资料的静态指标（维度覆盖、区块三「无最优解」稽核、
  选项单调性、硬／软件平衡…），呈现在「选项数据」页。查出 1.0 的区块三有
  **28/58 题存在 Pareto 支配选项**、5 个硬件维度没有交叉校验题。

判读方式见 [../docs/準確率方法論.md](../docs/準確率方法論.md)。

> ⚠️ `routes/audit.js` 里「区块三稽核」「obj/self/cross 覆盖」这些概念是 1.0 专属的，
> 2.0 没有区块三、也没有交叉校验区块，那部分之后要跟着重做。

## 密码

从环境变量 `ADMIN_PASSWORD` 读，放在 `server/.env`（已 gitignore，npm scripts 用
`--env-file-if-exists` 载入）。**不要把真密码写死进 `src/auth.js`。** 未设置时后台登录直接关闭。

## 改 1.0 题目的约束

答案存档与「选择压缩码」都以**绝对题号**索引。纯内容编辑安全；
**新增／删除／换顺序整题**会让既有存档整体位移，必须同步递增 `index.html` 里的
`const KEY` 与 `const CODE_VER`。
