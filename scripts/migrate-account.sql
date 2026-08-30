-- Phase 2 (B2) migration: create the four new account / service-key tables
-- on an EXISTING remote D1 database. Pure additive — no ALTER, no drops, so
-- it is safe to run and re-run.
--
--   wrangler d1 execute cloudflarepool --remote --file=scripts/migrate-account.sql
--
-- Idempotency: every statement uses CREATE TABLE IF NOT EXISTS, so a second
-- run is a no-op. (The base schema.sql already contains these tables for fresh
-- deployments; this script is for databases created before Phase 2.)
--
-- Implementation note (vs 02-设计 §18.3): `pwd_hash` and `api_keys.secret_hash`
-- use PBKDF2-SHA256 / SHA-256 respectively, NOT bcrypt. Cloudflare Workers
-- (WebCrypto) has no bcrypt, and bcrypt cannot verify a signature anyway.

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  app_id       TEXT,
  tenant_id    TEXT,
  email        TEXT UNIQUE,
  pwd_hash     TEXT,                     -- PBKDF2-SHA256: "salt$iterations$hashHex"
  provider     TEXT DEFAULT 'native',   -- native | oauth
  status       TEXT DEFAULT 'active',    -- active | disabled
  created_at   INTEGER
);

CREATE TABLE IF NOT EXISTS account_oauth (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  provider     TEXT,                     -- github | wechat-open
  external_id  TEXT,
  created_at   INTEGER
);

CREATE TABLE IF NOT EXISTS api_keys (
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
  revoked_at    INTEGER,
  -- Phase 3.1: operator-facing metadata (optional, for the admin console)
  label         TEXT,                    -- 人类可读名称，如「cloudlet 运维 agent」
  note          TEXT,                    -- 自由备注
  used_by       TEXT,                    -- 使用者 / 用途，如「CodeBuddy agent」
  expires_at    INTEGER                  -- 令牌建议失效时间（仅展示与提醒用，真正失效由 token exp 决定）
);

CREATE TABLE IF NOT EXISTS admin_accounts (
  id           TEXT PRIMARY KEY,
  app_id       TEXT,                     -- NULL = platform scope
  tenant_id    TEXT,                     -- NULL = platform / app scope
  email        TEXT UNIQUE,
  pwd_hash     TEXT,                     -- PBKDF2-SHA256
  role         TEXT DEFAULT 'tenant',    -- platform | app | tenant
  status       TEXT DEFAULT 'active',
  created_at   INTEGER
);
