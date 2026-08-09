# 部署手册 · Deploy `data.kapibala.icu`

把 `cloudflarepool` 这个多租户数据湖部署到 Cloudflare（Workers + D1 + R2），
对外提供 `https://data.kapibala.icu` 的 REST 数据服务。

> 合规提示：`data.kapibala.icu` 跑在 Cloudflare **免费/全球**节点（非中国大陆服务器），
> 因此**不需要 ICP 备案**。备案只约束解析到中国大陆服务器的域名
> （本架构里是 `home.inkspcl.com` / `inkspcl.com`，留在国内服务器）。
> 三层解耦正是为了让数据湖免备案、又能被合规的网关安全调用。

---

## 0. 前置条件

1. **域名已在 Cloudflare 托管**
   `kapibala.icu` 必须已在 Cloudflare 添加为 zone，且 NS 已指向 Cloudflare。
   `data.kapibala.icu` 只是它的一个子域，部署时由 Wrangler 自动建 CNAME 到 Worker。
   若还没加，先去 Cloudflare 控制台 Add a Site，按提示改 NS。

2. **本地环境**
   - Node ≥ 18（本项目 `package.json` 已设）
   - 已 `npm install`（含 `wrangler` / `esbuild` / `miniflare`）

3. **Cloudflare 账号**：免费版即可。Workers / D1 / R2 的免费额度对本项目绰绰有余。

---

## 1. 登录 Cloudflare

方式 A（交互式，推荐本机执行）：

```bash
cd cloudflarepool
npx wrangler login        # 浏览器授权，token 缓存在 ~/.config/.wrangler/
```

方式 B（非交互 / 交给 AI 代跑）：在 Cloudflare 控制台
*My Profile → API Tokens → Create Token*，选 **Edit Cloudflare Workers** 模板
（需含 `Account > Workers Scripts`、`D1`、`R2` 权限），生成后设置环境变量：

```bash
export CLOUDFLARE_API_TOKEN="<你的 token>"
```

---

## 2. 创建 D1 数据库，回填 ID

```bash
npx wrangler d1 create cloudflarepool
```

输出里有一行 `database_id = "...."`，把它填进 `wrangler.toml` 的：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cloudflarepool"
database_id = "这里替换成上面返回的 id"
```

---

## 3. 创建 R2 存储桶

```bash
npx wrangler r2 bucket create cloudflarepool
```

桶名与 `wrangler.toml` 里的 `bucket_name = "cloudflarepool"` 对应，无需再改配置。

---

## 4. 设置内部密钥 INTERNAL_KEY

网关（`home.inkspcl.com`）调用数据湖时要用 `X-Sync-Key` 头鉴权。
生产环境用 secret 注入（会覆盖 `wrangler.toml` 里的 dev 占位符）：

```bash
npx wrangler secret put INTERNAL_KEY
# 提示输入时，粘贴一段足够随机的字符串，例如：
#   openssl rand -hex 32
```

> 记好这个值——后面配置网关（块 B）时要用同一段字符串。
> `ALLOW_SETUP` 不要设置（保持未定义），生产环境 `/__setup` 自动禁用。

---

## 5. 建表（远程 D1）

```bash
npx wrangler d1 execute cloudflarepool --remote --file=schema.sql
```

---

## 6. 部署

```bash
npx wrangler deploy
```

首次部署会：打包 `src/index.js` → 发布 Worker → 为 `data.kapibala.icu`
创建 custom domain（自动 CNAME + TLS）。看到 `Deployed` 即成功。

查看实时日志：`npx wrangler tail`

---

## 7. 验证（用你刚设的 INTERNAL_KEY）

```bash
KEY="<第 4 步设的 INTERNAL_KEY>"

# 健康检查（无需密钥）
curl https://data.kapibala.icu/

# 无密钥应被拒（403）
curl -i https://data.kapibala.icu/t/weijiashi/todos

# 建租户（网关用 appid 映射 tenant，这里先建 weijiashi）
curl -X POST https://data.kapibala.icu/tenants \
  -H "X-Sync-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"weijiashi","appid":"wx<微家事AppID>","name":"微家事","plan":"free"}'

# 写入一条 todo（X-User-Id 为用户级隔离标识）
curl -X POST https://data.kapibala.icu/t/weijiashi/todos \
  -H "X-Sync-Key: $KEY" -H "X-User-Id: u_demo" \
  -H "Content-Type: application/json" \
  -d '{"id":"t1","title":"测试待办","dot":"personal","meta":{}}'

# 读取（应返回刚写的）
curl https://data.kapibala.icu/t/weijiashi/todos \
  -H "X-Sync-Key: $KEY" -H "X-User-Id: u_demo"
```

全部返回预期 JSON、无 403/404 即上线成功。

---

## 8. 生产注意事项

- **密钥不进仓库**：`INTERNAL_KEY` 已用 `wrangler secret put` 注入；`wrangler.toml` 里
  的 `INTERNAL_KEY = "dev-only-change-me"` 只是本地 dev 占位，部署后会被 secret 覆盖。
- **关闭 setup**：不要给生产设 `ALLOW_SETUP` 变量。
- **备份 D1**：`npx wrangler d1 export cloudflarepool --remote --output backup.sqlite`
- **配额**：免费版 Workers 10 万次/天、D1 500 万行读/天、R2 10GB 存储。
  单库多租户很省；规模化再考虑付费升级（参见 README 致谢 Cloudflare「赛博菩萨」一节：请勿滥用）。
- **更新**：改完代码直接 `npx wrangler deploy` 重新发布即可。

---

## 9. 下一步（回到微家事）

数据湖上线后，按既定计划推进：

- **块 B**：`home.inkspcl.com` 真实 Node.js 网关（微信 code2session 登录 +
  转发 REST 到本数据湖，注入 `X-Sync-Key` + 租户 + `Bearer`）
- **块 C**：微家事 `cloudflare.js` 适配器对齐 `/t/:tenant/*` 契约
