# cloudflarepool-gateway

`cloudflarepool` 数据湖的**参考网关**。它部署在你的**已备案服务器**上（例如 `home.inkspcl.com`），负责两件数据湖本身不能、也不应暴露的事情：

1. **微信登录**：用小程序 `wx.login()` 拿到的 `code` 调微信 `code2session` 换 `openid`，并签发网关会话令牌。AppSecret 只存在于服务端。
2. **安全反代**：把小程序的 `/api/data/*` 请求转发到数据湖 `data.kapibala.icu`，并在转发时注入 `X-Sync-Key`（数据湖内部密钥）和 `X-User-Id`（用户 openid）。**前端永远拿不到这两个值，也看不到 tenant_id。**

> 为什么需要这一层？`data.kapibala.icu` 跑在 Cloudflare 全球节点（免备案），而微信要求小程序的请求域名必须 HTTPS + 已 ICP 备案。网关架在备案域名 `home.inkspcl.com` 上，正好补齐这道合规缺口，同时把机密挡在客户端之外。

零运行时依赖（仅用 Node 内置 `http` / `https` / `crypto`），**不需要 `npm install`**，直接 `node server.js` 即可，方便挂在宝塔 nginx 反代后面。

---

## 目录结构

```
gateway/
├── server.js            # 入口：路由 + 登录 + 流式反代
├── lib/
│   ├── auth.js          # HMAC 会话令牌签发/校验
│   └── dotenv.js        # 极简 .env 加载（可选）
├── public/index.html    # 备案域名的隐私说明页（GET /）
├── test/gateway.test.mjs# 本地验证（mock 数据湖 + mock 微信）
├── package.json
├── .env.example
└── README.md
```

## 配置

复制 `.env.example` 为 `.env` 并填入：

| 变量 | 说明 |
| --- | --- |
| `DATA_LAKE_BASE` | 数据湖地址，生产填 `https://data.kapibala.icu` |
| `INTERNAL_KEY` | **必须与数据湖 `wrangler secret put INTERNAL_KEY` 的值完全一致** |
| `WX_APPID` / `WX_APPSECRET` | 微家事小程序的 AppID / AppSecret（仅服务端） |
| `WX_CODE2SESSION_URL` | 微信登录接口，默认即可 |
| `PORT` | 网关监听端口（宝塔反代指向它） |
| `SESSION_SECRET` | 会话令牌签名密钥，请改成随机长串 |
| `TENANT_ID` | 本网关服务的租户，对应数据湖 `tenants.tenant_id`（微家事用 `weijiashi`） |
| `SESSION_TTL` | 会话有效期（秒），默认 2592000（30 天） |

> 生产环境也可不依赖 `.env`，由宝塔 / 系统直接注入这些环境变量。

## 本地验证

```bash
node --test test/gateway.test.mjs
```

会用 mock 数据湖 + mock 微信跑通：登录发令牌 → `/api/data` 注入正确头与租户路径 → 缺/错令牌返回 401。

## 部署到宝塔（home.inkspcl.com）

1. **上传** 整个 `gateway/` 到服务器（如 `/www/wwwroot/home.inkspcl.com/`）。
2. **确认 Node.js ≥ 18**：宝塔「软件商店 → Node.js 版本管理器」可装。本网关零依赖，无需 `npm install`。
3. **写入配置**：在目录下建 `.env`（照 `.env.example`），把 `WX_APPSECRET`、`INTERNAL_KEY`、`SESSION_SECRET` 填成真实值。
4. **启动进程**（二选一）：
   - 宝塔「Node 项目」管理里新建项目，启动命令 `node server.js`，端口填 `PORT`；或
   - 用 PM2：`pm2 start server.js --name gateway`。
5. **nginx 反代**：在宝塔站点 `home.inkspcl.com` 的「反向代理」里，目标 URL 填 `http://127.0.0.1:<PORT>/`，发送域名 `$host`。这样外部 `https://home.inkspcl.com/api/*` 就落到网关。
6. **HTTPS + 备案**：`home.inkspcl.com` 已是备案域名，宝塔申请 Let's Encrypt 证书即可。

## 微信小程序侧配置

- 小程序后台「开发管理 → 开发设置 → 服务器域名 → request 合法域名」加入：
  `https://home.inkspcl.com`
  （图片走网关上传/下载，所以 `uploadFile` / `downloadFile` 合法域名也加它；网关会把请求反代到数据湖 R2。）
- 前端流程：
  1. `wx.login()` → 拿 `code` → `POST https://home.inkspcl.com/api/login {code}` → 得到 `token`
  2. 之后所有数据请求 `wx.request` 到 `https://home.inkspcl.com/api/data/...`，Header 带 `Authorization: Bearer <token>`
  3. 网关自动转成数据湖的 `/t/weijiashi/...` 并注入密钥与用户身份

## 安全须知

- `WX_APPSECRET`、`INTERNAL_KEY`、`SESSION_SECRET` **绝不可进前端代码或公开仓库**（本仓库 `.gitignore` 已忽略 `.env`）。
- 网关对外只暴露 `/api/login` 与 `/api/data/*`，其余路径（含 `/`）只返回静态说明页。
- 任意数据请求都必须带有效会话令牌，否则 401。

---

致谢 Cloudflare「赛博菩萨」提供的免费 Workers / D1 / R2 资源；请理性使用，勿滥用免费额度。
