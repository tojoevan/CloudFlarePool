-- cloudflarepool — multi-tenant data lake schema (D1 / SQLite)
-- Apply once:  wrangler d1 execute cloudflarepool --remote --file=schema.sql
-- Local:       wrangler d1 execute cloudflarepool --local  --file=schema.sql

CREATE TABLE IF NOT EXISTS tenants (
  tenant_id  TEXT PRIMARY KEY,
  appid      TEXT UNIQUE,
  app_id     TEXT DEFAULT 'weijiashi',
  name       TEXT,
  plan       TEXT DEFAULT 'free',
  quota      INTEGER DEFAULT 10000,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS apps (
  app_id       TEXT PRIMARY KEY,
  name         TEXT,
  owner        TEXT,
  auth_methods TEXT DEFAULT 'wechat',
  plan         TEXT DEFAULT 'free',
  quota        INTEGER DEFAULT 10000,
  status       TEXT DEFAULT 'active',
  created_at   INTEGER
);

CREATE TABLE IF NOT EXISTS collections (
  id           TEXT,
  app_id       TEXT,
  tenant_id    TEXT,
  collection   TEXT,
  owner_openid TEXT,
  doc          TEXT,
  updated_at   INTEGER,
  PRIMARY KEY (app_id, tenant_id, collection, id)
);
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(app_id, tenant_id, owner_openid);
CREATE INDEX IF NOT EXISTS idx_collections_lookup ON collections(app_id, tenant_id, collection);

CREATE TABLE IF NOT EXISTS collections_meta (
  app_id      TEXT,
  collection  TEXT,
  schema_json TEXT,
  created_at  INTEGER,
  PRIMARY KEY (app_id, collection)
);

CREATE TABLE IF NOT EXISTS todos (
  id           TEXT,
  tenant_id    TEXT,
  owner_openid TEXT,
  title        TEXT,
  meta         TEXT,
  tag          TEXT,
  dot          TEXT,
  shared       INTEGER DEFAULT 0,
  family_id    TEXT,
  updated_at   INTEGER,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_todos_owner ON todos(tenant_id, owner_openid);
CREATE INDEX IF NOT EXISTS idx_todos_shared ON todos(tenant_id, shared);

CREATE TABLE IF NOT EXISTS tasks_doc (
  tenant_id    TEXT,
  owner_openid TEXT,
  sections     TEXT,
  updated_at   INTEGER,
  PRIMARY KEY (tenant_id, owner_openid)
);

CREATE TABLE IF NOT EXISTS archive_items (
  id           TEXT,
  tenant_id    TEXT,
  owner_openid TEXT,
  type         TEXT,
  payload      TEXT,
  shared       INTEGER DEFAULT 0,
  family_id    TEXT,
  created_at   INTEGER,
  updated_at   INTEGER,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_archive_owner ON archive_items(tenant_id, owner_openid);
CREATE INDEX IF NOT EXISTS idx_archive_shared ON archive_items(tenant_id, shared);

-- ===== Phase 3 (B3): admin audit log =====
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id         TEXT PRIMARY KEY,
  app_id     TEXT,
  tenant_id  TEXT,
  admin_id   TEXT,
  action     TEXT,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON admin_audit_log(tenant_id, created_at);

-- ===== Rate limiting (fixed-window counter, D1-backed) =====
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key   TEXT,
  window_start INTEGER,
  count        INTEGER,
  PRIMARY KEY (bucket_key, window_start)
);

-- ===== 家庭（多家庭模型，每人最多 3 个）=====
-- 家庭主表：每个家庭一条记录，owner_openid 为创建者。
CREATE TABLE IF NOT EXISTS families (
  family_id   TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  name        TEXT,
  owner_openid TEXT NOT NULL,
  created_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_families_tenant ON families(tenant_id);

-- 家庭成员：一个 openid 在同一家庭只能一条（PK 防重复加入）；
-- 跨家庭允许多条，靠应用层「每人 ≤3」约束（D1 无跨行触发器）。
CREATE TABLE IF NOT EXISTS family_members (
  family_id   TEXT NOT NULL,
  openid      TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member', -- 'owner' | 'member'
  nickname    TEXT,
  invited_by  TEXT,
  joined_at   INTEGER,
  PRIMARY KEY (family_id, openid)
);
CREATE INDEX IF NOT EXISTS idx_fam_members_openid ON family_members(openid);
CREATE INDEX IF NOT EXISTS idx_fam_members_family ON family_members(family_id);

-- 邀请凭证：随机不可猜 token + 有效期 + 一次性使用标记。
-- 接受时置 used_at 防重放；过期/已用均不可接受。
CREATE TABLE IF NOT EXISTS family_invites (
  code          TEXT PRIMARY KEY,
  family_id     TEXT NOT NULL,
  inviter_openid TEXT NOT NULL,
  created_at    INTEGER,
  expires_at    INTEGER,
  used_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fam_invites_family ON family_invites(family_id);
