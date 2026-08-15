# JWT 算法与密钥分发方案

> 配套文档：`docs/PLATFORM_API_AUTH_SPEC.md`（平台 API 与鉴权规范）
> 本文覆盖规范「下一步」第 1 项：**JWT 算法选型 + 签名密钥在网关与数据湖间的安全分发**。

---

## 1. 算法选型

| 方案 | 类型 | 密钥 | 数据湖侧持有 | 多签发方 | 结论 |
|---|---|---|---|---|---|
| HS256 | 对称 | 单一共享密钥 | 私钥（能伪造令牌） | 难（共享同一密钥） | MVP 最快，信任边界差 |
| ES256 (ECDSA P-256) | 非对称 | 公私钥对 | 仅公钥 | 易（每签发方一对） | 可用，密钥较大 |
| **EdDSA (Ed25519)** | 非对称 | 公私钥对 | 仅公钥 | 易 | **推荐** |

**推荐 Ed25519（EdDSA），理由：**

- **数据湖只持公钥** → 即便数据湖被攻破，攻击者也无法伪造令牌（私钥只在网关/签发方）。这是与 HS256 最本质的差距。
- **天然多签发方**：网关签 T1/T4，未来鉴权服务签 T2，`api_keys` 签发 T3；各持私钥，数据湖用 JWT header 的 `kid` 选对应公钥验证。
- **边缘友好**：Cloudflare Workers（WebCrypto）与 Node 22（`crypto.webcrypto`）均原生支持 Ed25519；密钥短、验签快。
- **为 Web/App/MCP/Skill 通盘预留**：非对称模型下新增客户端类型 = 新增一对密钥，不动验证侧逻辑。

> 若想先用最小成本跑通 MVP，可临时用 HS256（单一 `JWT_SECRET`），但中间件须做成**算法无关**，便于后续无损切换到 EdDSA。

---

## 2. 密钥角色与信任边界

```
签发方 (持私钥)                  验证方 (持公钥)
┌────────────────┐             ┌──────────────────────┐
│ 网关             │  signs      │ 数据湖 Worker          │
│  T1 微信用户     │ ──────────► │ 验证 Bearer JWT        │
│  T4 管理        │  verify     │ 强制 tenant / scope    │
├────────────────┤             └──────────────────────┘
│ 未来鉴权服务      │ signs T2 (账号/OAuth)
├────────────────┤
│ api_keys 签发    │ signs T3 (服务令牌, MCP/Skill)
└────────────────┘
```

- JWT header 带 `kid`（key ID）；数据湖维护 `kid → 公钥` 映射，按 kid 选钥验证。
- 网关同时需验证自己签发的 T1/T4（刷新 / introspection 场景），故也持对应公钥（或复用私钥验签）。

---

## 3. 与现有 X-Sync-Key 的边界（不混用）

| 层级 | 令牌 | 用途 | 持有方 |
|---|---|---|---|
| 客户端 ↔ 服务端 | **JWT (Bearer)** | 小程序/Web/App/MCP 持此调用 `/v1/...` | 各客户端 |
| 服务端 ↔ 服务端 | **X-Sync-Key** | 网关 → 数据湖内部反代（`/api/data/*`、运维） | 仅网关与数据湖 |

- 二者**必须物理分离**：X-Sync-Key 是内部服务密钥，JWT 签名密钥是客户端令牌密钥。混用会扩大爆破半径。
- 当前数据湖纯靠 X-Sync-Key 守卫 → 升级为「验证 Bearer JWT + 内部保留 X-Sync-Key 用于服务端调用」。

---

## 4. 密钥分发（安全要点）

**原则：私钥永不进仓库、永不打日志、仅经 secret 机制注入。**

| 组件 | 环境变量 | 内容 | 注入方式 |
|---|---|---|---|
| 网关 | `JWT_PRIVATE_KEY` | Ed25519 私钥 PEM | `.env`（gitignore）/ 进程 env |
| 网关 | `JWT_PUBLIC_KEYS` | `{kid: publicPem}` JSON | 同上（验其他签发方用） |
| 数据湖 | `JWT_PUBLIC_KEYS` | `{kid: publicPem}` JSON | `wrangler secret put` |

**一次性生成：**

```bash
openssl ed25519 -genkey -noout -out jwt_private.pem
openssl ed25519 -pubout  -in jwt_private.pem -out jwt_public.pem
```

**分发步骤：**

1. 网关：把 `jwt_private.pem` 内容写入 `.env` 的 `JWT_PRIVATE_KEY`（PEM 换行用 `\n` 或单引号包裹）。
2. 数据湖：把 `{ "gw01": "<jwt_public.pem 内容>" }` 写入 `JWT_PUBLIC_KEYS`，执行
   ```bash
   wrangler secret put JWT_PUBLIC_KEYS
   ```
3. 多签发方时，各自生成密钥对，公钥汇总进同一 `JWT_PUBLIC_KEYS` JSON（不同 `kid`）。

**轮换：** JWT 带 `kid` + `iat`；轮换时先并行生效新 `kid`，旧 `kid` 保留一个宽限期（如 7 天）后再下线。

---

## 5. Token 结构（claims）

```jsonc
// header
{ "alg": "EdDSA", "typ": "JWT", "kid": "gw01" }

// payload
{
  "iss": "gateway",        // 签发方
  "sub": "oXYZ...",        // 用户 openid / 服务 id
  "tid": "jiashiben",      // tenant_id（一个家庭 = 一个 tenant）
  "scope": ["user:read", "user:write"], // 作用域
  "aud": "cloudflarepool", // 受众 = 数据湖
  "exp": 1756000000,
  "iat": 1755996400,
  "jti": "uuid"            // 防重放
}
```

各类型示例：

- **T1 微信用户**：`iss=gateway, sub=<openid>, scope=[user:read, user:write]`
- **T2 账号用户**（未来）：`iss=authsvc, sub=<account_id>, scope=[user:read, user:write]`
- **T3 服务令牌（MCP/Skill）**：`iss=authsvc, sub=<service_id>, scope=[svc:read]`（只读子集）
- **T4 管理**：`iss=gateway, sub=<admin_id>, scope=[admin:*]`

---

## 6. 数据湖验证中间件（step 2 预览）

请求进入 `/v1/t/:tenant/...`：

1. 取 `Authorization: Bearer <jwt>`，解析 header `kid`。
2. 用 `JWT_PUBLIC_KEYS[kid]` 验签（Ed25519）。
3. 校验 `exp` / `aud=cloudflarepool` / `iss` 白名单。
4. **强制 `tid === :tenant`**（租户隔离在服务端校验，不只靠路径）。
5. 按 `scope` 鉴权端点（`POST` 需 `*:write`；MCP 的 `svc:read` 拒写）。
6. 通过后把 `sub` / `tid` / `scope` 注入上下文；原有 `X-Sync-Key` 守卫保留给 `/api/data/*` 内部调用。

---

## 7. 安全清单

- [ ] 私钥仅存 env / secret，不入仓库、不打日志
- [ ] 数据湖只持公钥
- [ ] JWT 与 X-Sync-Key 物理分离
- [ ] 所有令牌带 `exp` + `aud` + `kid`
- [ ] 租户隔离服务端强制校验
- [ ] 预留轮换机制（并行 kid + 宽限期）
