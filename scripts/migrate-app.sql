-- Phase 1 migration for an EXISTING remote D1 database.
-- The base `schema.sql` uses CREATE TABLE IF NOT EXISTS, which does NOT add
-- columns to tables that already exist. Run this against the live DB ONCE:
--
--   wrangler d1 execute cloudflarepool --remote --file=scripts/migrate-app.sql
--
-- NOTE on transactions: D1's `wrangler d1 execute` REJECTS raw SQL
-- BEGIN/COMMIT (it wants the JS storage API). Each statement below is
-- standalone. The batch rolls back on any error, so a failed run leaves the
-- DB untouched and can be retried after fixing the script.
--
-- Idempotency: the CREATE TABLE / UPDATE / INSERT are themselves idempotent
-- (IF NOT EXISTS / OR IGNORE / WHERE NULL). The only non-idempotent line is the
-- ALTER (SQLite has no "ADD COLUMN IF NOT EXISTS") — do not run this twice on a
-- DB that already has the `app_id` column.

-- 1) Add app_id to the existing tenants table.
ALTER TABLE tenants ADD COLUMN app_id TEXT DEFAULT 'jiashiben';

-- 2) Backfill any legacy tenant to the default app.
UPDATE tenants SET app_id = 'jiashiben' WHERE app_id IS NULL OR app_id = '';

-- 3) Create the apps registry table (the first app lives here).
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

-- 4) Register the first app record (idempotent via PRIMARY KEY ignore).
INSERT OR IGNORE INTO apps (app_id, name, owner, auth_methods, plan, quota, status, created_at)
VALUES ('jiashiben', '微家事', 'weijiashi', 'wechat', 'free', 10000, 'active', strftime('%s','now'));

-- 5) Collections tables (generic, app-scoped storage for future apps).
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
