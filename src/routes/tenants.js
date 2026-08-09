import { Hono } from 'hono';

// Admin tenant registry. Every route here already requires a valid
// X-Sync-Key (enforced by the global guard in index.js), i.e. only the
// trusted gateway / operator may create or read tenants.
const tenantsRoute = new Hono();

// Create or update a tenant.
tenantsRoute.post('/', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!b.tenant_id) return c.json({ error: 'tenant_id required' }, 400);

  await c.env.DB.prepare(
    `INSERT INTO tenants (tenant_id, appid, name, plan, quota, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id) DO UPDATE SET
       appid = excluded.appid,
       name  = excluded.name,
       plan  = excluded.plan,
       quota = excluded.quota`
  )
    .bind(
      b.tenant_id,
      b.appid ?? null,
      b.name ?? null,
      b.plan ?? 'free',
      b.quota ?? 10000,
      Date.now()
    )
    .run();

  return c.json({ ok: true, tenant: b.tenant_id });
});

// Read a tenant's metadata.
tenantsRoute.get('/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT tenant_id, appid, name, plan, quota, created_at FROM tenants WHERE tenant_id = ?`
  )
    .bind(c.req.param('id'))
    .first();
  if (!row) return c.json({ error: 'tenant not found' }, 404);
  return c.json(row);
});

export { tenantsRoute };
