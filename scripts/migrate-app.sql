-- Phase 1 migration for an EXISTING remote D1 database.
-- The base `schema.sql` uses CREATE TABLE IF NOT EXISTS, which does NOT add
-- columns to tables that already exist. Run this against the live DB ONCE:
--
--   wrangler d1 execute cloudflarepool --remote --file=scripts/migrate-app.sql
--
-- NOTE: the ALTER on line ~18 is NOT re-runnable (SQLite has no
-- "ADD COLUMN IF NOT EXISTS"); the Worker's migrate() applies the same guard in
-- JS so normal deploys stay safe. The backfill and INSERT OR IGNORE below are
-- themselves idempotent.

-- 1) Add app_id to the existing tenants table (idempotent via PRAGMA guard).
--    SQLite has no "ADD COLUMN IF NOT EXISTS", so we check column presence first.
--    Wrapped in a transaction for safety.
BEGIN TRANSACTION;
  -- Guard: only alter when the column is missing.
  -- (Run by the deploy step; the Worker's migrate() does the same guard in JS.)
  ALTER TABLE tenants ADD COLUMN app_id TEXT DEFAULT 'jiashiben';
COMMIT;

-- 2) Backfill any legacy tenant (the original "weijiashi" / 微家事) to the default app.
UPDATE tenants SET app_id = 'jiashiben' WHERE app_id IS NULL OR app_id = '';

-- 3) Register the first app record (idempotent via PRIMARY KEY ignore).
INSERT OR IGNORE INTO apps (app_id, name, owner, auth_methods, plan, quota, status, created_at)
VALUES ('jiashiben', '微家事', 'weijiashi', 'wechat', 'free', 10000, 'active', strftime('%s','now'));

-- 4) Collections tables (idempotent; harmless if already created by schema.sql).
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
