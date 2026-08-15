# 微家事 MCP Server（T3 服务令牌消费侧）

一个**零依赖**的 MCP（Model Context Protocol）服务器，以 `stdio` 传输运行，
让任意 MCP 客户端（Claude Desktop、WorkBuddy 等）通过 **T3 服务令牌** 直接
访问「微家事」数据湖（`data.kapibala.icu`）。

> 定位：MCP Server 是 Phase 3 的一个「客户端」，与小程序 / Web SPA / 管理后台
> 平等消费同一套平台 API。它直连数据湖（不经网关），符合设计文档 §12（未备案
> 域仅服务间 / 集成 / 海外客户端，延迟不敏感）。

## 工具 ↔ Scope 映射

| 工具 | 方法 / 端点 | 所需 scope | 说明 |
|---|---|---|---|
| `list_todos` | `GET /t/<tenant>/todos` | `data:read` | 列出待办；`ownerAll` 控制家庭视图 |
| `add_task` | `POST /t/<tenant>/todos` | `data:write` | 新增待办；`owner` 指定家庭成员 openid |
| `search_archive` | `GET /t/<tenant>/archive` | `data:read` | 归档库关键词检索 |

> 当前数据湖侧**未强制 scope 校验**（MVP 范围，设计 §8 的 scope 门禁留待 scope
> 命名统一后补）。T3 令牌的 `scope` 字段仍为约束意图，MCP server 严格按上表声明。
> 租户隔离（`tenant_bound`）已由数据湖 `dualGuard` 强制。

## 配置

```bash
cp .env.example .env          # 然后填入真实 T3 凭据
node server.js                # 启动 stdio MCP server
```

`.env` 字段见 `.env.example`。`WEIJIASHI_API_KEY_SECRET` 即签发时一次性返回的
`raw_secret`（base64url 32 字节）。

## 签发 T3 服务令牌

T3 key 在 `api_keys` 表，由运维签发（不开放自助）。两种等价方式：

1. **admin 端点**（推荐）：持 T4 admin JWT 调
   `POST /v1/a/jiashiben/keys` → 返回 `{ id, raw_secret, kid, scope, tenant_bound }`。
2. **运维脚本**：直连 D1 插入记录（`secret_hash = SHA-256(raw_secret)` 的 hex）。

签发示例（tenant_bound = weijiashi，scope = data:read + data:write）：

```sql
INSERT INTO api_keys (id, app_id, tenant_id, secret_hash, scope, tenant_bound,
                      status, current_kid, prev_kid, prev_secret, created_at)
VALUES ('svc_xxx', 'jiashiben', 'weijiashi', '<sha256hex>',
        '["data:read","data:write"]', 1, 'active', 'svc_xxx.v1', NULL, NULL, <ts>);
```

## 接入 MCP 客户端

### WorkBuddy

在 `~/.workbuddy/mcp.json`（或对应连接器配置）加入：

```json
{
  "mcpServers": {
    "weijiashi": {
      "command": "node",
      "args": ["/abs/path/to/cloudflarepool/mcp/server.js"],
      "env": {
        "WEIJIASHI_API_KEY_ID": "svc_xxx",
        "WEIJIASHI_API_KEY_SECRET": "<raw_secret>",
        "WEIJIASHI_API_KEY_KID": "svc_xxx.v1",
        "WEIJIASHI_TENANT_ID": "weijiashi",
        "WEIJIASHI_APP_ID": "jiashiben"
      }
    }
  }
}
```

随后在 WorkBuddy 中创建一个**使用该 MCP 的配置型专家（Skill）**即可，零额外后端。

### Claude Desktop

`claude_desktop_config.json` 的 `mcpServers` 段同上结构。

## 安全

- `raw_secret` 仅签发时返回一次，数据湖只存 `secret_hash`，不可逆。
- T3 令牌为对称 HMAC：**`raw_secret` 泄露 = 该 key 可被伪造**，须与私钥同级保护。
- 轮转：`POST /v1/a/jiashiben/keys/<id>/rotate`；吊销：`.../revoke`。
- 本 server 仅读 `.env` / 环境变量，不落盘任何密钥。
