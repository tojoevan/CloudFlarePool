-- cloudflarepool — admin audit log migration (Phase 3, 2026-08-16)
-- Apply once:  wrangler d1 execute cloudflarepool --remote --file=scripts/migrate-audit.sql

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
