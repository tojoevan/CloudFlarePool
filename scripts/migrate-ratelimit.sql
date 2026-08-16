-- cloudflarepool — rate limiting counter migration (2026-08-16)
-- Apply once:  wrangler d1 execute cloudflarepool --remote --file=scripts/migrate-ratelimit.sql

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key   TEXT,
  window_start INTEGER,
  count        INTEGER,
  PRIMARY KEY (bucket_key, window_start)
);
