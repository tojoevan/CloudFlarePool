// Multi-tenant data lake schema (D1 / SQLite).
// Single database, logical isolation via `app_id` + `tenant_id` on every row.
// Abstraction level: platform core (app-agnostic) -> app -> tenant -> user.
// This module is also used by the dev `/__setup` endpoint and `schema.sql`.

// The first app. Used as the default when an existing tenant has no explicit app_id.
export const DEFAULT_APP_ID = 'jiashiben';

export const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tenants (
    tenant_id  TEXT PRIMARY KEY,          -- e.g. "weijiashi"
    appid      TEXT UNIQUE,              -- WeChat AppID; gateway maps AppID -> tenant
    app_id     TEXT DEFAULT 'jiashiben', -- app this tenant belongs to (1 tenant = 1 app)
    name       TEXT,
    plan       TEXT DEFAULT 'free',      -- free | pro | ... (paid resource sharing later)
    quota      INTEGER DEFAULT 10000,    -- per-tenant row/storage quota hint
    created_at INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS apps (
    app_id       TEXT PRIMARY KEY,        -- e.g. "jiashiben"
    name         TEXT,
    owner        TEXT,                    -- owning tenant_id or account
    auth_methods TEXT DEFAULT 'wechat',   -- comma-separated: wechat,password,oauth
    plan         TEXT DEFAULT 'free',
    quota        INTEGER DEFAULT 10000,
    status       TEXT DEFAULT 'active',   -- active | disabled
    created_at   INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS collections (
    id           TEXT,
    app_id       TEXT,                    -- app the collection belongs to
    tenant_id    TEXT,
    collection   TEXT,                    -- logical collection name within the app
    owner_openid TEXT,                    -- end user identity (from gateway X-User-Id)
    doc          TEXT,                    -- JSON blob
    updated_at   INTEGER,
    PRIMARY KEY (app_id, tenant_id, collection, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(app_id, tenant_id, owner_openid)`,
  `CREATE INDEX IF NOT EXISTS idx_collections_lookup ON collections(app_id, tenant_id, collection)`,

  `CREATE TABLE IF NOT EXISTS collections_meta (
    app_id      TEXT,
    collection  TEXT,
    schema_json TEXT,                     -- declared schema for a typed module
    created_at  INTEGER,
    PRIMARY KEY (app_id, collection)
  )`,

  `CREATE TABLE IF NOT EXISTS todos (
    id           TEXT,
    tenant_id    TEXT,
    owner_openid TEXT,                    -- end user identity (from gateway X-User-Id)
    title        TEXT,
    meta         TEXT,                    -- JSON blob
    tag          TEXT,
    dot          TEXT,                    -- personal | family marker
    shared       INTEGER DEFAULT 0,       -- 1 => visible in family/shared
    family_id    TEXT,
    updated_at   INTEGER,
    PRIMARY KEY (tenant_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos(tenant_id, owner_openid)`,
  `CREATE INDEX IF NOT EXISTS idx_todos_shared ON todos(tenant_id, shared)`,

  `CREATE TABLE IF NOT EXISTS tasks_doc (
    tenant_id    TEXT,
    owner_openid TEXT,
    sections     TEXT,                    -- JSON: the per-user tasks document
    updated_at   INTEGER,
    PRIMARY KEY (tenant_id, owner_openid)
  )`,

  `CREATE TABLE IF NOT EXISTS archive_items (
    id           TEXT,
    tenant_id    TEXT,
    owner_openid TEXT,
    type         TEXT,                    -- todo | note | ...
    payload      TEXT,                    -- JSON blob
    shared       INTEGER DEFAULT 0,
    family_id    TEXT,
    created_at   INTEGER,
    updated_at   INTEGER,
    PRIMARY KEY (tenant_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_archive_owner ON archive_items(tenant_id, owner_openid)`,
  `CREATE INDEX IF NOT EXISTS idx_archive_shared ON archive_items(tenant_id, shared)`,

  // ===== Phase 2 (B2) account & service-key tables =====
  // NOTE (implementation correction vs 02-设计 §18.3): passwords and api_key
  // secrets use PBKDF2 / SHA-256 — NOT bcrypt. Cloudflare Workers (WebCrypto)
  // has no bcrypt, and bcrypt is also unavailable natively in Node's crypto.
  // PBKDF2-SHA256 is supported on both runtimes with zero dependencies.
  `CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    app_id       TEXT,
    tenant_id    TEXT,
    email        TEXT UNIQUE,
    pwd_hash     TEXT,                     -- PBKDF2-SHA256: "salt$iterations$hashHex"
    provider     TEXT DEFAULT 'native',   -- native | oauth
    status       TEXT DEFAULT 'active',    -- active | disabled
    created_at   INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS account_oauth (
    id           TEXT PRIMARY KEY,
    user_id      TEXT,
    provider     TEXT,                     -- github | wechat-open
    external_id  TEXT,
    created_at   INTEGER
  )`,

  // T3 service keys (MCP / Skill / server-to-server). Symmetric HMAC-SHA256:
  //   secret_hash = SHA-256(raw_secret) hex, used directly as the HMAC verify key.
  // §18.3 described "bcrypt(raw)" but bcrypt is irreversible and cannot verify
  // a signature — this is the deliberate correction.
  `CREATE TABLE IF NOT EXISTS api_keys (
    id            TEXT PRIMARY KEY,        -- service_id
    app_id        TEXT,
    tenant_id     TEXT,                    -- NULL when tenant_bound = 0
    secret_hash   TEXT,                    -- SHA-256(raw_secret) hex (HMAC verify key)
    scope         TEXT,                    -- JSON array, e.g. ["data:read","data:write"]
    tenant_bound  INTEGER DEFAULT 0,      -- 1 => p.tid must equal tenant_id
    status        TEXT DEFAULT 'active',  -- active | revoked
    current_kid   TEXT,
    prev_kid      TEXT,                   -- rotation grace period (7d)
    prev_secret   TEXT,                   -- SHA-256(prev raw_secret); NULL after grace
    created_at    INTEGER,
    revoked_at    INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS admin_accounts (
    id           TEXT PRIMARY KEY,
    app_id       TEXT,                     -- NULL = platform scope
    tenant_id    TEXT,                     -- NULL = platform / app scope
    email        TEXT UNIQUE,
    pwd_hash     TEXT,                     -- PBKDF2-SHA256
    role         TEXT DEFAULT 'tenant',    -- platform | app | tenant
    status       TEXT DEFAULT 'active',
    recovery_hash TEXT,                    -- SHA-256(recovery_code); NULL = 未设置
    created_at   INTEGER
  )`,

  // ===== Phase 3 (B3): admin audit log =====
  // 管理员（T4）变更操作的留痕：改密 / 启停用户 / 签发吊销密钥 / 编辑删除数据。
  // tenant_id = 操作归属租户（platform 角色无租户时为 NULL）；detail 为 JSON。
  `CREATE TABLE IF NOT EXISTS admin_audit_log (
    id         TEXT PRIMARY KEY,
    app_id     TEXT,
    tenant_id  TEXT,
    admin_id   TEXT,                       -- T4 token sub (admin_accounts.id)
    action     TEXT,                       -- password.change | user.status | key.issue | key.revoke | row.update | row.delete
    target     TEXT,                       -- 操作对象：user:<id> / key:<id> / <table>:<id>
    detail     TEXT,                       -- JSON（scope / status / 变更字段等）
    ip         TEXT,
    created_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_tenant ON admin_audit_log(tenant_id, created_at)`,

  // ===== Multi-family model (微家事 家庭功能) =====
  // 一人可属多个家庭（上限 MAX_FAMILIES_PER_USER，应用层强制）；邀请码 7 天有效、一次性使用。
  `CREATE TABLE IF NOT EXISTS families (
    family_id    TEXT PRIMARY KEY,
    tenant_id    TEXT NOT NULL,
    name         TEXT,
    owner_openid TEXT NOT NULL,
    created_at   INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_families_tenant ON families(tenant_id)`,

  `CREATE TABLE IF NOT EXISTS family_members (
    family_id   TEXT NOT NULL,
    openid      TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member',  -- owner | member
    nickname    TEXT,
    invited_by  TEXT,
    joined_at   INTEGER,
    PRIMARY KEY (family_id, openid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fam_members_openid ON family_members(openid)`,
  `CREATE INDEX IF NOT EXISTS idx_fam_members_family ON family_members(family_id)`,

  `CREATE TABLE IF NOT EXISTS family_invites (
    code           TEXT PRIMARY KEY,
    family_id      TEXT NOT NULL,
    inviter_openid TEXT NOT NULL,
    created_at     INTEGER,
    expires_at     INTEGER,
    used_at        INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fam_invites_family ON family_invites(family_id)`,

  // ===== Rate limiting (fixed-window counter, D1-backed) =====
  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket_key   TEXT,
    window_start INTEGER,                 -- epoch seconds of the window start
    count        INTEGER,
    PRIMARY KEY (bucket_key, window_start)
  )`,
];

// Run all CREATE statements. Called from the dev `/__setup` endpoint
// (ALLOW_SETUP=1) or by `wrangler d1 execute --file=schema.sql` in production.
export async function migrate(db) {
  for (const sql of CREATE_STATEMENTS) {
    await db.prepare(sql).run();
  }
  // Existing remote `tenants` tables predate the app_id column (the first app was
  // hard-wired as "jiashiben"). Add the column idempotently and backfill NULLs so
  // the two-dimensional (app_id + tenant_id) isolation works on live data.
  await ensureTenantAppId(db);
  // 已上线的 admin_accounts 表可能缺少 recovery_hash（恢复码）列，幂等补齐。
  await ensureAdminRecoveryHash(db);
}

// Idempotent: add `recovery_hash` to an already-existing `admin_accounts` table
// if missing (used by the self-service password recovery flow).
async function ensureAdminRecoveryHash(db) {
  const cols = await db.prepare('PRAGMA table_info(admin_accounts)').all();
  const has = (cols.results || []).some((c) => c.name === 'recovery_hash');
  if (!has) {
    await db.prepare('ALTER TABLE admin_accounts ADD COLUMN recovery_hash TEXT').run();
  }
}

// Idempotent: add `app_id` to an already-existing `tenants` table if missing,
// then backfill any row that has no explicit app_id with DEFAULT_APP_ID.
async function ensureTenantAppId(db) {
  const cols = await db.prepare('PRAGMA table_info(tenants)').all();
  const hasAppId = (cols.results || []).some((c) => c.name === 'app_id');
  if (!hasAppId) {
    await db
      .prepare("ALTER TABLE tenants ADD COLUMN app_id TEXT DEFAULT 'jiashiben'")
      .run();
  }
  await db
    .prepare("UPDATE tenants SET app_id = ? WHERE app_id IS NULL OR app_id = ''")
    .bind(DEFAULT_APP_ID)
    .run();
}
