// Multi-tenant data lake schema (D1 / SQLite).
// Single database, logical isolation via `tenant_id` on every row.
// This module is also used by the dev `/__setup` endpoint and `schema.sql`.

export const CREATE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tenants (
    tenant_id  TEXT PRIMARY KEY,          -- e.g. "weijiashi"
    appid      TEXT UNIQUE,              -- WeChat AppID; gateway maps AppID -> tenant
    name       TEXT,
    plan       TEXT DEFAULT 'free',      -- free | pro | ... (paid resource sharing later)
    quota      INTEGER DEFAULT 10000,    -- per-tenant row/storage quota hint
    created_at INTEGER
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
];

// Run all CREATE statements. Called from the dev `/__setup` endpoint
// (ALLOW_SETUP=1) or by `wrangler d1 execute --file=schema.sql` in production.
export async function migrate(db) {
  for (const sql of CREATE_STATEMENTS) {
    await db.prepare(sql).run();
  }
}
