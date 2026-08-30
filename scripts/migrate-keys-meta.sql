-- Phase 3.1 migration: add operator-facing metadata columns to api_keys.
--
--   wrangler d1 execute cloudflarepool --remote --file=scripts/migrate-keys-meta.sql
--
-- Idempotency: SQLite has no `ADD COLUMN IF NOT EXISTS`, so **run this once**
-- per database. Re-running will error on the first already-existing column and
-- abort — that is harmless (the columns are already there). The data-lake code
-- is written to tolerate these columns being absent, so skipping this migration
-- only means the admin console won't show labels / notes / expiry.

ALTER TABLE api_keys ADD COLUMN label      TEXT;
ALTER TABLE api_keys ADD COLUMN note       TEXT;
ALTER TABLE api_keys ADD COLUMN used_by    TEXT;
ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;
