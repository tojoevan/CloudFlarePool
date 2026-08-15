# 平台 API 与鉴权规范（草案 v0.2 · 多应用平台底座）

> 状态：草案 ｜ 适用范围：整合项目全部客户端（小程序 / Web / App / MCP / Skill / 管理后台）｜ 数据湖定位：app-agnostic 多应用平台底座
> 平台核心：数据湖（Cloudflare Worker + D1 + R2，域 `data.kapibala.icu`）
> 边缘：网关（`home.inkspcl.com`，境内备案，仅小程序必需）

## 1. 设计目标
- **一个后端，多个门面**：所有客户端平等消费同一套版本化、带作用域（scope）的 REST API。
- **客户端无关**：新增 Web / App / MCP / Skill 不应改动数据模型，只需申请对应令牌。
- **合规与延迟分离**：面向国内终端用户的流量走境内网关；服务间 / 海外集成走数据湖直连。
- **多应用平台底座**：数据湖是 app-agnostic 通用底座，家事本只是第一个 `app`；新应用靠"声明 schema"接入，而非改数据湖代码。
- **最小权限**：默认最小 scope；admin 严格隔离。

## 2. 客户端与认证矩阵
| 客户端 | 身份来源 | 令牌类型 | 必经网关 | 说明 |
|---|---|---|---|---|
| 小程序 | 微信 openid | T1 用户令牌 | 是（合规+备案） | 网关做 code2session |
| Web (SPA) | 账号/密码·OAuth | T2 用户令牌 | 可选（境内加速） | 直连或经网关 |
| App (原生) | 账号/密码·OAuth | T2 用户令牌 | 可选 | 同上 |
| MCP Server | API Key | T3 服务令牌 | 否 | 延迟不敏感，直连数据湖 |
| Skill（专家） | 复用 MCP | T3 服务令牌 | 否 | 零额外后端 |
| 管理后台 | 管理员账号 | T4 管理令牌 | 是（境内运营） | Web 客户端 |

## 3. 令牌体系
四类令牌，统一为**可验证的 JWT**（无状态，数据湖可直接验签，无需查库）：
- **公共 claims**：`sub`(主体ID) / `aid`(app_id) / `tid`(tenant_id) / `typ`(wx|user|service|admin) / `scp`(scope数组) / `exp` / `iss`(签发方) / `aud`(数据湖)
- **T1 WX 用户令牌**：网关 code2session 后签发，代表一个微信用户；短期 + refresh。
- **T2 用户令牌**：Auth 服务为 Web/App 签发，非 WX 身份；与 T1 同级（user scope）。
- **T3 服务令牌（API Key）**：长生命周期，发给集成方（MCP/Skill）；显式 `scp` + 可选 `tenant_bound`；可轮转、可吊销。
- **T4 管理令牌**：admin 登录签发；含 `admin` scope，跨用户读写。
- **内部通道**：网关→数据湖仍用 `X-Sync-Key`（服务器间），不暴露给客户端。

> 关键变化：数据湖从「只信 X-Sync-Key」升级为「验证 `Authorization: Bearer <JWT>`（验签+exp+scope+tenant）」；`X-Sync-Key` 仅保留给网关内部调用，以兼容小程序现状。

## 4. Scope 分级
资源族：`todo` `task` `archive` `family` `img` `user` `tenant`
动作：`read` `write`（含增改删）`admin`

| 级别 | 授予 | 边界 |
|---|---|---|
| 用户级 (user) | `read:*` + `write:todo,task,archive,family,img` | 限定自身 `tid` 与 `sub` |
| 服务级 (service) | 显式子集，如 `read:todo,archive` 或 `read:*,write:todo` | 须 `tenant_bound` 或用户委派 |
| 管理级 (admin) | `admin:tenant` `admin:user` `read:*` `write:*` | 跨用户，限定 `tid` |
| 内部 (internal) | 网关→湖服务间 | 仅 `X-Sync-Key` |

## 5. 抽象层级与 App / Tenant 模型
**抽象层级（自底向上）：**
```
平台核心（app 无关）   认证 / 两维隔离(app_id+tenant_id) / 通用数据+对象存储 / 配额
  └─ 应用层 app        如 jiashiben；声明自身数据模型、登录方式、配额
       └─ 租户 tenant  一个家庭 / 一个组织（同一家庭在不同 app = 不同 tenant）
            └─ 用户 user
```
- **数据湖是 app-agnostic 通用底座**，家事本只是第一个 `app`；第二、第三个应用接入不应改动数据湖 Worker 代码，只需声明 schema。
- **两级隔离**：所有表带 `app_id` + `tenant_id`（单库共用、逻辑隔离）；R2 前缀 `app_id/tenant_id/`。
- **一个家庭 = 一个 tenant**；小程序 / Web / App 登录同一账号体系后映射到同一 tenant，数据共享（跨端共享在 tenant 维度，而非 app 维度）。
- `apps` 表：应用注册（app_id / name / owner / 启用的登录方式 / 配额 / status）。
- `tenants` 表：`app_id` + `plan` / 配额 / `status`。
- 用户归属：`users`（或 `family_members`）绑 `app_id` + `tenant_id` + `openid`/`email` + provider。
- 家庭共享：`family_groups` + `shared`/`family_id` 字段控制可见性（沿用现有机制）。

## 6. 端点契约
- **版本化**：URL 前缀 `/v1/`（破坏性变更 → `/v2/`）。
- **认证头**：客户端 `Authorization: Bearer <token>`；网关内部 `X-Sync-Key` + `X-User-Id` + `X-Tenant-Id`。
- **资源路由**（在现有 `/t/:tenant/...` 上升级，客户端 URL 保持 tenant 维度；`app` 由 JWT 的 `aid` + tenant 反查得到，数据湖强制匹配）：
  - `GET/POST   /v1/t/:tenant/todos`
  - `GET/PATCH/DELETE /v1/t/:tenant/todos/:id`
  - `tasks` / `archive` / `family` / `shared` / `img` 同构
  - `GET /v1/t/:tenant/me` 当前用户
  - `GET /v1/t/:tenant/stats`（admin / 概览）
  - **类型化应用模块**：`todos/tasks/archive/...` 这类资源不由数据湖硬编码，而由 app 在 `apps` 表声明的一组 **collection（带字段 schema）** 决定；数据湖提供类型感知的通用 CRUD + 查询。家事本注册 `todo/task/archive_item/family_group/family_member` 等模型。
  - **平台 / 应用管理端点**（显式 app 维度）：
    - `GET/POST /v1/a/:app`（应用信息 / 注册）
    - `GET /v1/a/:app/tenants`（该 app 下租户列表，admin）
    - `GET /v1/apps`（平台级跨应用，超级 admin）
- **响应信封**：成功 `200 { data }`；错误 `4xx/5xx { error, message }`。
- **分页**：`?cursor=&limit=`（默认 20，最大 100）。
- **错误码**：401 未认证 / 403 无权限 / 404 不存在 / 422 参数错 / 429 限流。

## 7. 数据湖鉴权中间件（伪码）
```
app.use('*', guard)
guard:
  if headers['X-Sync-Key'] === INTERNAL_KEY:        # 网关内部调用
      ctx.user = { typ:'internal', uid: headers['X-User-Id'], tid: headers['X-Tenant-Id'] }
      return
  token = bearer(headers['Authorization'])
  if !token: 401
  p = verifyJWT(token)                               # 验签 + exp + iss + aud
  if !p: 401
  if !hasScope(p.scp, route.requiredScope): 403
  if p.aid !== resolveApp(params.tenant): 403       # 应用隔离（tenant 反查其 app_id）
  if p.tid !== params.tenant: 403                   # 租户隔离
  ctx.user = p
```
> 替换现有纯 `X-Sync-Key` 守卫；保留 `X-Sync-Key` 作为 internal 通道以兼容小程序现状。

## 8. 网关职责
- 小程序：`code2session` → 签 T1（含 `aid`）→ 以 `X-Sync-Key` 转发到湖（internal 通道）。
- 未来：Web/App 账号登录端点 → 签 T2；`POST /api/admin/login` → 签 T4。
- **配置从单 tenant 升为 app 感知**：原 `TENANT_ID=jiashiben` → `APP_ID=jiashiben`；tenant 解析改为按请求（来自 JWT），而非静态配置。
- 持有：WX AppSecret、**JWT 签名密钥（与数据湖共享，仅 env，绝不进代码）**、admin 凭据。

## 9. MCP / Skill 接入
- MCP Server：独立服务（或 Worker），持 T3 服务令牌（`tenant_bound`），调数据湖 REST，暴露工具 `list_todos` / `add_task` / `search_archive` …
- 工具↔scope 映射：读工具需 `read:*`；写工具需 `write:*`。
- Skill（WorkBuddy 专家）：配置型专家，复用 MCP 的 T3 令牌，零额外后端。
- 令牌轮转 / 吊销：`api_keys` 表管理。

## 10. 管理后台
- 第一等客户端：带 T4 的 Web SPA；UI 托管网关（境内、快、合规）。
- **两级管理**：
  - 平台级（超级 admin）：`GET /v1/apps` 跨应用查看、应用注册 / 开通、全局配额。
  - 应用级（app admin）：`GET /v1/a/:app/tenants` 管理该 app 下租户、用户、数据浏览（只读或受控编辑）。
- 不直连 D1，走平台 API（admin scope）。

## 11. 安全与合规
- 全令牌 HTTPS；JWT 短期 + 刷新；service token 可轮转。
- `X-Sync-Key` 仅服务器间，不下发客户端。
- 数据湖域未备案 → 仅服务间 / 集成 / 海外客户端；国内终端用户走网关。
- 最小权限；admin 严格隔离。

## 12. 演进与下一步
> 详见 `docs/PLATFORM_TODO.md`（待讨论 / 待实施跟踪）。
- [x] 选定 JWT 算法（**EdDSA/Ed25519**）与签名密钥分发（见 `JWT_KEY_SCHEME.md`）
- [x] 确立抽象层级：平台核心 → 应用(app) → 租户(tenant) → 用户(user)，数据湖 app-agnostic
- [x] 核心通用度决策：**(a) 类型化应用模块**（app 声明 schema，数据湖给类型化 CRUD）
- [ ] 数据湖加 JWT 验证中间件（替换纯 X-Sync-Key），并支持 `app_id`+`tenant_id` 两维隔离
- [ ] 新增 `apps` 表 + app 注册 / 开通流程；家事本作为首个 app 迁移
- [ ] 端点加 `/v1/a/:app/...` 平台 / 应用管理维度
- [ ] 网关：`TENANT_ID` → `APP_ID`，tenant 按请求解析
- [ ] 网关加账号登录 + admin 登录端点
- [ ] 建 `api_keys` 表 + 轮转 / 吊销（T3）
- [ ] 起草 MCP Server 骨架（含 T3 令牌获取）
- [ ] 管理后台 UI 草图（平台级 + 应用级，基于平台 API）
