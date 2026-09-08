# 新版强项查找器

新版答题页与后台已接通：/v2.html 和 /admin。请设置 .env 中的 ADMIN_PASSWORD 后运行 npm run dev。新版使用独立 sf_* 表并保留旧数据，npm test 可运行验证。详情见 ../docs/新版升级说明.md。

以下章节描述旧版 index.html 的接口，不代表新版能力。

# 個人屬性面板 — 後台

Node + Express + SQLite（用 Node 22.5+ 內建的 `node:sqlite`，免原生編譯）。
能看題庫、改既有題目的內容；作答回收與選項數據還是骨架。

## 跑起來

```bash
cd server
npm install
cp .env.example .env   # 填上 ADMIN_PASSWORD
npm run import         # 把 index.html 的題庫灌進 DB（可重複執行）
npm run dev            # 或 npm start
```

- 後台：http://localhost:4000/admin
- 測驗站：http://localhost:4000/ （直接吃專案根目錄的 `index.html`）

密碼從環境變數 `ADMIN_PASSWORD` 讀，放在 `server/.env`（已 gitignore，npm scripts 會用
`--env-file-if-exists` 載入）。未设置密码时关闭后台登录——**別把真密碼寫死進 `src/auth.js`**。

## 結構

```
server/
  src/
    index.js               Express 進入點，掛 API + 後台 + 靜態站
    db.js                   node:sqlite 連線 + migrate
    schema.sql              資料表定義
    auth.js                 單人密碼登入（記憶體 session）
    import-questions.js     從 index.html 匯入題庫 + 維度字典
    routes/
      questions.js          題目讀取 + PUT 編輯（POST/DELETE 為 501）
      dimensions.js         維度字典（唯讀）
      audit.js              題庫體檢：不需作答資料的靜態指標
      stats.js              選項統計查詢（查詢寫好，資料還沒有）
      responses.js          作答回收（寫 submissions，逐題還原待做）
  admin/                    後台前端（純靜態，無框架）
  data/panel.db             SQLite（gitignore）
```

## 資料表

| 表 | 用途 |
|---|---|
| `questions` / `options` | 題庫。`options.score_json` 對應前端 `o[].s` 的多維加分。`questions.abs_idx` 是跨區塊絕對題號（0–130），對齊前端 `ALLQ` 與壓縮碼 |
| `dimensions` | 維度字典（key → 中英名、hw/sw/soma），給編輯器的下拉選單用 |
| `scenes` | 具體場景（前端 `SCENES`，93 項），`weights_json` = `{維度key: 1..3}`。用於硬/軟件平衡體檢 |
| `submissions` | 一次完整作答的摘要 + 壓縮碼 |
| `submission_answers` | 攤平的逐題作答，供「每題每選項多少人選」統計 |
| `meta` | schema 版本（目前 3）|

## 題庫匯入

`npm run import`（`src/import-questions.js`）：抽出 `index.html` 裡純資料的
`<script>` 區塊，沙箱求值拿到 `B1`–`B4` / `EN.q` / `DIM` / `EN.dim` / `SCENES`，
攤平寫進 `questions` / `options` / `dimensions` / `scenes`。
每次執行會先清空這四張表再重灌，所以 index.html 改完題目重跑即可。
結果：131 題（b1:24 / b2:27 / b3:58 / b4:22）、645 選項、43 維度、93 場景。

## 題目編輯

`PUT /api/questions/:id` — 只改**既有題目的內容**：

- 題幹（中／英）
- 選項文字（中／英）、選項的維度加分（`{維度key: 1–5}`）、加減選項（2–8 個）、換選項順序
- num 題的 min / max / 單位 / 提示文字
- b3 的打亂旗標

伺服器端驗證：題幹不可空、維度 key 必須存在於 `dimensions`、分數為 1–5 整數、
num 範圍 min < max。後台頁面在 `/admin/questions.html?id=<id>`。

**還不會影響線上測驗** —— 前端目前仍讀 `index.html` 寫死的題庫，
編輯只寫進 DB。把 DB 的修改回寫 `index.html`（或讓前端改讀 API）是下一步。

不做：新增／刪除／換序**整題**。那會位移絕對題號，必須連動前端的
`KEY` / `CODE_VER`，所以 `POST` / `DELETE` 維持 501。

## 題庫體檢 / 準確率

`GET /api/audit/*`（需登入）—— 不需作答資料的靜態指標，呈現在「選項數據」頁上半部：

| 端點 | 內容 |
|---|---|
| `/audit/summary` | 各類旗標總數 |
| `/audit/coverage` | 每維度被幾道題涵蓋（分 obj/self/cross），標出覆蓋不足 / 只有自評 / 無交叉校驗 |
| `/audit/b3` | 區塊三「無最優解」稽核：Pareto 支配選項、退化成排序題、最強選項位置分佈 |
| `/audit/monotonic` | 區塊一/二/四選項總分不遞增的題 |
| `/audit/spread` | 選項總分範圍過小 / 某維度在每個選項給同值的題 |
| `/audit/balance` | 硬/軟件題量與 93 個場景的平衡 |

判讀方式與改進優先序見 `docs/準確率方法論.md`。

## 待辦（之後）

1. ~~匯入腳本~~ ✅
2. ~~題目編輯（改內容）~~ ✅
3. ~~靜態題庫體檢（準確率方法論階段一）~~ ✅
4. 編輯結果回寫 `index.html`：把 DB 的 `questions` / `options` 重新產生 `B1`–`B4` /
   `EN.q` 區塊，或讓前端改成 fetch 題庫。
5. 前端結果頁 POST `/api/responses`（完整壓縮碼 + 摘要），伺服器端由壓縮碼還原逐題答案
   → 開啟需作答資料的題目分析（見 `docs/準確率方法論.md` 階段二、三）。
6. 選項數據頁下半部：選項實際被選比例、題—總分相關、自評—錨點落差、num 題分佈。
7. 驗證換成正經方案（express-session 或 JWT），部署再上 HTTPS。


