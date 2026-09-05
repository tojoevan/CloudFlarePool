# 零 SSH 部署纪律（新需求开发 CheckList）

> 设计意图：管理后台「⟳ 版本更新」按钮的初衷是 **把"发一个新特性"和"SSH 进服务器"解耦**——
> 理想闭环是「本地改 → push GitHub → 点按钮」，Agent 全程不必碰服务器。
> 本文档沉淀 2026-09-05 一次部署排障的复盘结论，作为后续所有新需求开发的部署纪律与自查清单。
> 关联：`../.workbuddy/memory/MEMORY.md` 部署硬纪律 **#18（防 root 污染四件套）**、**#19（SSH-free 部署纪律）**；
> 配套部署实操见 `09-网关能力补强-部署.md`。

## 〇、一句话原则

**发特性 = 本地改 + push + 点按钮 / 本地 CLI 部署；验证 = 只走 HTTP。SSH 只留给一次性基建与真正事故。**

---

## 一、复盘：为什么 SSH 又回来了（根因）

本次（2026-09-05）排查「版本更新按钮失败」时，Agent 反复 SSH 上服务器做 `chown`、`git pull`、查进程、改配置。
**但 SSH 回归并非"发特性"所需，而是"修水管"所需**——部署管道自身脆弱：

| 脆弱点 | 现象 | 触发 Agent SSH |
|---|---|---|
| 仓库属主为 `root`（setup 以 root clone 未 chown） | www 跑 `git pull` 写不进 `.git/objects` → `EACCES` | 上服务器 `chown www:www` |
| 网关继承 `HOME=/root`（700，www 不可进） | `wrangler` 写 `/root/.config` 被拒 `EACCES` | 上服务器查/改 HOME |
| `safe.directory` 误配给 `root` 的 `--global` | www 跑 git 触发 `dubious ownership` | 上服务器改 gitconfig |

**结论**：SSH 是"修管道"，不是"送水"。只要管道自愈，发特性就不需要 SSH。
→ 已用 **A+B+C+D 四件套**（见 #18）让管道自愈：setup 结尾 `chown www:www` + deploy.sh root 守卫 + `safe.directory` 改 `--system` + 规则注释。
→ 后续发特性应进入下方「零 SSH 闭环」，管道不再需要修理，SSH 自然消失。

---

## 二、零 SSH 闭环（标准流程）

```
┌─ 1. 本地改代码（projects/<repo> 工作区）              ── 无 SSH
├─ 2. 本地预检 preflight                                 ── 无 SSH
│      node --check *.js ｜ lint-wxss --strict ｜ regression-check
├─ 3. 提交并推送 GitHub                                  ── 无 SSH
│      git commit && git push origin/main
├─ 4. 部署（三路任选，皆零 SSH）─────────────────────────┐
│      (a) 数据湖特性  → 本地 wrangler deploy            │ 零 SSH
│      (b) 网关/SPA    → 点「版本更新」按钮（www spawn） │ 零 SSH
│      (c) Schema 变更 → 本地 wrangler d1 execute --remote│ 零 SSH
└─ 5. 验证（只走 HTTP，绝不 SSH）───────────────────────┘
       curl health ｜ curl version.json ｜ 新路由 401 vs 404 ｜ 后台 deploy 日志轮询
```

### 部署三路说明
- **(a) 数据湖特性**：`wrangler deploy`（CLI 直连 Cloudflare 边缘，**天然零 SSH**）。`GIT_HEAD` 版本标记改 `wrangler.toml` 后裸 deploy（勿用 `--var`，见 #18/部署方案第八节第 5 条）。
- **(b) 网关 / SPA 特性**：管理后台点「⟳ 版本更新」→ `POST /api/t4data/deploy` → www 进程 spawn `scripts/deploy.sh`（自包含：git pull + wrangler + 同步 SPA + 重写 version.json）。
- **(c) Schema 变更**：`wrangler d1 execute cloudflarepool --remote --file=<migrate.sql>`（CLI 直连 D1，**零 SSH**）。注意 `migrate()` 不走冷启动，DDL 必须显式 execute。

### 验证只走 HTTP（替换一切 SSH 排查）
- 版本：`curl https://home.inkspcl.com/health` 看 `gatewayGit` / `dataLakeGit`；`curl https://home.inkspcl.com/version.json` 看 `git`。
- 路由判据：新增路由返回 **401（分支生效）vs 404（未同步）**——404 即 `server.js` 改动未同步到 `WEB_ROOT` 或网关未重启（判据沿用 #3/#13）。
- 部署结果：管理后台「版本更新」面板已轮询 `deploy.sh` 日志，**失败原因直接显示在前端**，无需 SSH 看日志。

---

## 三、新需求开发 CheckList（每次发版前逐项勾）

### A. 代码与提交
- [ ] 改动在 `projects/` 本地仓库完成，未直接改服务器文件
- [ ] 本地 preflight 通过（`node --check` / `lint-wxss --strict` / `regression-check`）
- [ ] 已 `commit` + `push origin/main`

### B. 部署路径选择（按改动落点选一路）
- [ ] **只动数据湖** → 本地 `wrangler deploy`（零 SSH）
- [ ] **动网关 server.js / lib / SPA** → 点「版本更新」按钮，或 Agent 自助 `bash scripts/agent-deploy.sh`（零 SSH，需先 `agent-token-store.sh` 存令牌）
- [ ] **动 D1 schema** → 本地 `wrangler d1 execute --remote --file=<migrate.sql>`（零 SSH）
- [ ] ⚠️ 若改了 `server.js`：确认 `DEPLOY_RESTART_CMD`（如 `pm2 restart home-inkspcl`）已在网关 `.env` 配好，否则按钮只同步代码、不重启进程——仍需在宝塔手动重启

### C. 验证（仅 HTTP，不 SSH）
- [ ] `curl health` / `version.json` 显示新 commit
- [ ] 新路由返回 401（非 404）
- [ ] 管理后台「版本更新」日志显示 success、无 EACCES/permission 报错

### D. 纪律红线（任何人/任何脚本）
- [ ] **未以 root 在 `/opt/cloudflarepool` 跑 git 或 deploy.sh`**（deploy.sh 顶部守卫会直接拒，见 #18/B）
- [ ] 仓库与部署私钥始终 `www:www` 属主（setup 已固化，勿手改属主）
- [ ] 宝塔的进程启停动作由 joevan 在面板实施，Agent 只通知、不代执行（见 #17 宝塔纪律）

---

## 四、长期架构纪律（让 SSH 彻底远离）

1. **新业务逻辑尽量进数据湖（serverless）**：本地 CLI 部署天然零 SSH、免备案、全球边缘；VPS 网关只留**薄代理 + admin + deploy 触发**，保持**稳定少改**。
2. **部署可观测性走 HTTP**：日志轮询 + health/version 端点，验证不靠 SSH。
3. **每个特性签「部署契约」**：无新增手动服务端步骤；`server.js` 改动接 `DEPLOY_RESTART_CMD`；schema 走 d1 CLI。
4. **deploy 脚本自愈 + 预检报错清晰**：已做 HOME 重定向 / 属主对齐 / root 守卫；可再加「属主预检」——环境异常时打印可执行提示（用户在宝塔/setup 修，不劳 Agent SSH）。
5. **VPS 当牲口不当宠物**：漂移就重跑 `setup-server.sh` 重建，而非 Agent SSH 手术。

### 残留的、合法 SSH（明确排除出日常）
- 一次性基建 `setup-server.sh`（必须 root，写 `/opt`、`/www`、全局装 wrangler）
- 真正的基建事故（磁盘满 / 进程卡死超出宝塔守护）

---

## 五、失败自愈矩阵（万一按钮报错，先看这里）

| 报错关键词 | 含义 | 正确处置（零 SSH 优先） |
|---|---|---|
| `EACCES ... .git/objects` | 仓库属主非 www | 用户在宝塔/setup 重建属主；勿 Agent SSH 修 |
| `EACCES ... /root/.config/.wrangler` | HOME 指向 root | 已靠 `deploy.sh` 重定向 HOME 修复；若复发，按钮日志会指明 |
| `dubious ownership` | git safe.directory 未覆盖 www | 已靠 `setup-server.sh` 的 `--system` 修复 |
| `insufficient permission` | 同上两类之一 | 同上，看具体路径 |
| `CLOUDFLARE_API_TOKEN not set` | 网关 .env 未配 token | 在宝塔改 `WEB_ROOT/.env` 配 `CLOUDFLARE_API_TOKEN`（属文件编辑，非进程管理）；或 joevan 处理 |
| 新路由 404 | `server.js` 未同步/未重启 | 确认改动已 push；宝塔重启网关（或配 `DEPLOY_RESTART_CMD`） |

> 所有以上"修复"现都已固化进脚本（A+B+C+D），正常情况不会再出现；若复现，说明有人在 `/opt/cloudflarepool` 以 root 跑了 git（违 `#18` 红线），应回到 setup 重建属主，而非 Agent 逐次 SSH 打补丁。

---

## 六、Agent 自助部署通道（零 SSH 进阶）

把「(b) 网关 / SPA 部署」从"人工点按钮"升级为"Agent 经 API 自助触发"——本质仍是同一个 `deploy.sh`，只是触发方从浏览器换成 Agent 的 HTTP 调用。详见 `gateway/server.js` 的 `/api/agent/*` 与 `scripts/agent-*.sh`。

### 端点
| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/agent/token/request` | **公开（无需鉴权）** | Agent 提交 `{purpose, ttl_hours?}` 申请临时令牌，返回 `{requestId, status:pending}` |
| GET | `/api/agent/token/request/:id` | **公开** | Agent 轮询取用：pending → approved（返回 token+expiresAt）/ rejected / revoked |
| POST | `/api/agent/deploy` | Agent 临时令牌（Bearer） | 触发部署，返回 `{taskId,status}`（202） |
| GET | `/api/agent/deploy/status/:id` | Agent 临时令牌（Bearer） | 轮询结构化状态 + 完整日志（500 行，支撑问题定位） |
| GET | `/api/t4data/agent-token/requests` | T4 管理员 JWT | 列出申请（pending 优先）+ 当前是否有活跃令牌 |
| POST | `/api/t4data/agent-token/approve` | T4 管理员 JWT | 审批：生成并激活令牌 + 持久化 `.env` + 返回（**管理后台「部署授权」面板调用**） |
| POST | `/api/t4data/agent-token/reject` | T4 管理员 JWT | 拒绝某申请 |
| POST | `/api/t4data/agent-token/revoke` | T4 管理员 JWT | **吊销当前活跃令牌（收回权限）**，Agent 后续部署即 401 |

### 申请 → 审批 → 取用 → 吊销 模型（最小授权）
- **Agent 先申请**：`POST /api/agent/token/request {purpose:"部署说明：修复 xx 路由"}` → 网关生成不透明 `requestId`（仅申请方持有），记录 pending。
- **运维前台审批**：管理后台「部署授权」tab 看到用途备注 → 点「批准」（可改时长，默认 8h）→ 网关生成 `agt_<48hex>` 令牌并激活；点「拒绝」则拒绝。
- **Agent 轮询取用**：`GET /api/agent/token/request/:id` 直到 `approved` 取回 token（自动缓存本地 `~/.workbuddy`）。
- **运维随时收回**：面板「吊销当前令牌」→ 活跃令牌清空 → Agent 正在进行/后续的部署立即 401；Agent 会自动重新申请、由运维再次审批。
- 令牌为**单活跃态**，存 `AGENT_DEPLOY_TOKEN` / `_EXPIRES_AT`（审批时写入并持久化 `.env`，重启仍有效，直到被吊销）。校验含**常量时间比较** + **有效期**。限频同按钮：每 5 分钟 1 次。

### Agent 本地落地（令牌不进仓库）
- `scripts/agent-deploy.sh "部署说明：…"`：**自包含**——缺失/过期本地缓存则自动申请+轮询审批+缓存，再用令牌触发部署→轮询日志→输出；遇 401（被吊销）自动清空缓存、重新申请一次。全程零 SSH。
- `scripts/agent-token-store.sh`（**可选·手动兜底**）：仅当你在「部署授权」面板手动复制了令牌时，用它本地存档。正常流程由 `agent-deploy.sh` 自动申请自缓存，无需本脚本。
- ⚠️ 令牌**绝不写进仓库 / 提交**；本地缓存处于 `~/.workbuddy`，不在任何 git 仓库内。

### Agent 部署契约（必读）
1. Agent 编辑 → `git push`（API 只从 GitHub 拉，强制先 push）。
2. `bash scripts/agent-deploy.sh "用途说明"` → 自动申请/审批轮询 → 触发 → 轮询 `/status/:id` 到 `success` / `failed`。
3. 验证只走 HTTP（health / version.json / 新路由 401 vs 404）。
4. 失败**绝不盲目重试**，直接向 joevan 汇报日志与退出码。
5. 若日志含 `gateway runtime updated`：本次改了 `server.js`，**进程未重启故新代码未生效**，须由 joevan 在宝塔重启网关（或配 `DEPLOY_RESTART_CMD`）。
6. 令牌由 joevan 审批发放、可随时吊销；Agent 不持有长期凭据，权限窗口 = 审批时刻到吊销/过期。

---

*文档状态：v3（2026-09-05 第六节重构为「申请→审批→取用→吊销」模型：静态令牌改为按需申请、运维前台审批、可随时收回权限；含管理后台「部署授权」面板与自包含 agent-deploy.sh）。后续新需求若发现新的 SSH 触发点，回填「失败自愈矩阵」并核对 CheckList。*
