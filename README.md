# cloudflarepool

**A multi-tenant data lake on Cloudflare Workers + D1 + R2.**

`cloudflarepool` is the storage backend behind `data.kapibala.icu`. It turns one
free Cloudflare stack into a shared data lake that can back **multiple apps** —
WeChat mini-programs, web frontends, mobile clients — each isolated as a *tenant*,
with room to grow into paid, cross-app resource sharing later.

> Status: foundational open-source release. The first real tenant is the **家事本**
> (jiashiben) WeChat mini-program. See [`examples/gateway.md`](examples/gateway.md)
> for how the gateway (`home.inkspcl.com`) talks to it.

---

## 致谢 Cloudflare「赛博菩萨」

本项目完全构建在 Cloudflare 的免费资源之上 —— Workers、D1、R2 的免费额度，
对独立开发者与小型应用而言堪称慷慨，因此在中文社区被亲切地称为 **「赛博菩萨」**。

我们由衷感谢 Cloudflare 长期对开发者生态的投入，让一个人也能以近乎零成本把想法真正跑起来。

**但请不要把这份善意当成理所当然：**

- 免费额度是全体开发者共用的，请勿用于高频爬虫、CC 攻击、挖矿或任何其他滥用行为；
- 规模化的生产场景请自觉升级付费套餐，把免费名额留给真正需要的人；
- 本项目仅用于合规、正当的私有 / 家庭数据存储，拒绝任何违规用途。

> Salute to Cloudflare — the "cyber bodhisattva" of free edge compute. Please
> treat the free tier with respect and never abuse it.

---

## Why this exists

- **One backend, many apps.** A single D1 database holds every tenant, logically
  isolated by a `tenant_id` column. Adding a new mini-program is one row in
  `tenants`, not a new deployment.
- **Free tier friendly.** Workers (100k req/day), D1 (5M reads/day), R2
  (10 GB storage, zero egress) cover a family/small-app scale comfortably.
- **Compliance by design.** The data lake is a *pure storage* service. It never
  sees WeChat credentials. The trusted gateway authenticates users and forwards
  requests with a server-to-server `X-Sync-Key`. The lake only ever trusts the
  gateway.
- **Path-based, predictable API.** Everything lives under `/t/:tenant/...`, so a
  tenant can never read another tenant's data — the SQL always filters by
  `tenant_id`.

## Architecture

```
 WeChat mini-program
        │  (HTTPS, legal domain: home.inkspcl.com)
        ▼
 Gateway  home.inkspcl.com   ◄── does WeChat login (code2session), holds AppSecret
        │  REST  +  X-Sync-Key  +  X-User-Id  +  Bearer
        ▼
 Data lake  data.kapibala.icu  (Cloudflare Workers + D1 + R2)
        ├── /tenants            (admin, X-Sync-Key only)
        └── /t/:tenant/*        (data, tenant-scoped, per-user isolated)
```

| Layer        | Cloudflare primitive | Purpose                          |
|--------------|----------------------|----------------------------------|
| Compute      | Workers (Hono)       | REST API, auth guard             |
| Database     | D1 (SQLite)          | tenants, todos, tasks, archive   |
| Blob storage | R2                   | images / binary resources        |
| Secrets      | `INTERNAL_KEY`       | server-to-server shared secret   |

## Multi-tenancy model

- **Single database, logical isolation.** Every table carries `tenant_id`; all
  queries are scoped with `WHERE tenant_id = ?`. No cross-tenant leakage is
  possible by construction.
- **Per-user isolation inside a tenant.** The gateway passes the verified user
  identity in the `X-User-Id` header (the WeChat `openid`). Writes are owned by
  that user; reads default to `owner=me`, and `owner=all` is available to the
  gateway for family/shared aggregation.
- **Plans.** `tenants.plan` (`free` | `pro` | …) is a hook for future paid,
  cross-app resource sharing — the schema is already tenant-aware.

## API contract

All routes except `/` and `/health` require `X-Sync-Key: <INTERNAL_KEY>`.

### Admin — tenants (X-Sync-Key only)
| Method | Path            | Body                          | Notes                |
|--------|-----------------|-------------------------------|----------------------|
| POST   | `/tenants`      | `{tenant_id, appid?, name?}`  | create / update      |
| GET    | `/tenants/:id`  | —                             | read metadata        |

### Data — `/t/:tenant/*`
The gateway must send `X-User-Id: <openid>` on every request.

| Method | Path                          | Notes                                              |
|--------|-------------------------------|----------------------------------------------------|
| POST   | `/t/:tenant/todos`            | create todo (body: id,title,meta,tag,dot,shared,family_id) |
| GET    | `/t/:tenant/todos?owner=me\|all\|<openid>` | list                         |
| GET    | `/t/:tenant/todos/:id`        | read one                                          |
| PUT    | `/t/:tenant/todos/:id`        | update (owner only)                               |
| DELETE | `/t/:tenant/todos/:id`        | delete (owner only)                               |
| GET    | `/t/:tenant/tasks`            | get per-user tasks document                       |
| PUT    | `/t/:tenant/tasks`            | save tasks document (`{sections:[...]}`)          |
| GET    | `/t/:tenant/archive?owner=…`  | list archive items                                |
| POST   | `/t/:tenant/archive`          | add archive item                                  |
| PUT    | `/t/:tenant/archive/:id`      | update (owner only)                               |
| DELETE | `/t/:tenant/archive/:id`      | delete (owner only)                               |
| GET    | `/t/:tenant/family/shared`    | aggregated view of all `shared=1` todos + archive |
| POST   | `/t/:tenant/img`              | upload image (multipart `file` **or** JSON `{data:base64, contentType}`) → `{key,url}` |
| GET    | `/t/:tenant/img/:key`         | fetch the image bytes                             |

## Local development

```bash
npm install
npm run dev            # wrangler dev (needs a Cloudflare account for live D1/R2)
```

To create the tables locally:

```bash
npm run db:migrate:local
```

…or hit the dev-only bootstrap (with `ALLOW_SETUP=1`):

```bash
curl -X POST localhost:8787/__setup -H "X-Sync-Key: dev-only-change-me"
```

> `ALLOW_SETUP` must be **unset** in production; there it is created once with
> `npm run db:migrate:remote`.

## Testing

A self-contained smoke test runs the real Worker against in-memory D1 + R2 via
[Miniflare](https://miniflare.dev) — no Cloudflare account required:

```bash
npm test
```

It covers: X-Sync-Key guard (403), tenant + todo CRUD with per-user isolation,
archive + family/shared aggregation, tasks document, image upload/fetch, and
unknown-tenant 404.

## Deploy

```bash
# 1. Create resources (copy the DB id into wrangler.toml)
wrangler d1 create cloudflarepool
wrangler r2 bucket create cloudflarepool

# 2. Secrets (never commit INTERNAL_KEY)
wrangler secret put INTERNAL_KEY

# 3. Schema + ship
npm run db:migrate:remote
npm run deploy
```

Point `data.kapibala.icu` (or your own domain) at the Worker as a custom domain.

## Gateway integration

The gateway is a normal Node.js service that:
1. Performs WeChat login (`code2session`) and issues its own user token.
2. Translates the mini-program's calls into the `/t/:tenant/*` contract above.
3. Injects `X-Sync-Key` (shared secret) + `X-User-Id` (verified openid) + the
   user `Bearer` token.

Full walkthrough: [`examples/gateway.md`](examples/gateway.md).

## References & inspiration

- [Cloudflare — Build a Comments API (D1 + Hono)](https://developers.cloudflare.com/d1/tutorials/build-a-comments-api/)
- [notionworker — multi-tenant D1 + R2 + OAuth platform](https://github.com/faeton/notionworker)
- [hono-restful — Hono + D1 RESTful boilerplate](https://github.com/kaelen2026/hono-restful)
- [Multi-tenant patterns on Cloudflare (per-tenant DO vs single DB + tenant_id)](https://blog.rajpoot.dev/posts/typescript/cloudflare-workers-d1-durable-objects-2026)

## License

[MIT](LICENSE)
