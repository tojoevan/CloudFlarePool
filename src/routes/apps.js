import { Hono } from 'hono';

// App-dimension management (Phase 1).
//
// All routes here sit under /v1/a and are already covered by the global
// dual-mode guard in index.js, so only the trusted gateway / operator
// (X-Sync-Key) or a valid admin JWT may call them.
//
// Abstraction: platform core (app-agnostic) -> app -> tenant -> user.
//   - POST   /v1/a                       create an app
//   - GET    /v1/a/:app                  read an app
//   - GET    /v1/a/:app/tenants          list tenants of an app
//   - POST   /v1/a/:app/tenants          create a tenant bound to the app
//   - GET    /v1/a/:app/collections      list registered collection schemas
//   - POST   /v1/a/:app/collections      register/update a collection schema
const appsRoute = new Hono();

// --- App registry ----------------------------------------------------------

appsRoute.post('/', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.app_id) return c.json({ error: 'app_id required' }, 400);
  await c.env.DB.prepare(
    `INSERT INTO apps (app_id, name, owner, auth_methods, plan, quota, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       name         = excluded.name,
       owner        = excluded.owner,
       auth_methods = excluded.auth_methods,
       plan         = excluded.plan,
       quota        = excluded.quota,
       status       = excluded.status`
  )
    .bind(
      b.app_id,
      b.name ?? b.app_id,
      b.owner ?? null,
      b.auth_methods ?? 'wechat',
      b.plan ?? 'free',
      b.quota ?? 10000,
      b.status ?? 'active',
      Date.now()
    )
    .run();
  return c.json({ ok: true, app: b.app_id });
});

appsRoute.get('/:app', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT app_id, name, owner, auth_methods, plan, quota, status, created_at
     FROM apps WHERE app_id = ?`
  )
    .bind(c.req.param('app'))
    .first();
  if (!row) return c.json({ error: 'app not found' }, 404);
  return c.json(row);
});

// --- App-scoped tenant management -----------------------------------------

appsRoute.get('/:app/tenants', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT tenant_id, appid, app_id, name, plan, quota, created_at
     FROM tenants WHERE app_id = ?`
  )
    .bind(c.req.param('app'))
    .all();
  return c.json(rows.results || []);
});

appsRoute.post('/:app/tenants', async (c) => {
  const appId = c.req.param('app');
  const b = await c.req.json().catch(() => ({}));
  if (!b.tenant_id) return c.json({ error: 'tenant_id required' }, 400);
  await c.env.DB.prepare(
    `INSERT INTO tenants (tenant_id, appid, app_id, name, plan, quota, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       app_id = excluded.app_id,
       appid  = excluded.appid,
       name   = excluded.name,
       plan   = excluded.plan,
       quota  = excluded.quota`
  )
    .bind(
      b.tenant_id,
      b.appid ?? null,
      appId,
      b.name ?? null,
      b.plan ?? 'free',
      b.quota ?? 10000,
      Date.now()
    )
    .run();
  return c.json({ ok: true, tenant: b.tenant_id, app_id: appId });
});

// --- Collection schema registry (typed modules) ---------------------------

appsRoute.get('/:app/collections', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT app_id, collection, schema_json, created_at
     FROM collections_meta WHERE app_id = ?`
  )
    .bind(c.req.param('app'))
    .all();
  return c.json(rows.results || []);
});

appsRoute.post('/:app/collections', async (c) => {
  const appId = c.req.param('app');
  const b = await c.req.json().catch(() => ({}));
  if (!b.collection) return c.json({ error: 'collection required' }, 400);
  await c.env.DB.prepare(
    `INSERT INTO collections_meta (app_id, collection, schema_json, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(app_id, collection) DO UPDATE SET
       schema_json = excluded.schema_json`
  )
    .bind(appId, b.collection, b.schema_json ? JSON.stringify(b.schema_json) : null, Date.now())
    .run();
  return c.json({ ok: true, app: appId, collection: b.collection });
});

export { appsRoute };
