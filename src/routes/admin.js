import { Hono } from 'hono';

// T4 admin read-only dashboard (Phase 3).
//
// Every request here already passed the global dualGuard in index.js, so it
// carries a verified identity. We additionally require `userTyp==='admin'`
// (injected by dualGuard from the JWT `typ` claim) so that ONLY a T4 admin
// token may read these endpoints — T2 (typ=account) and T3 (typ=service)
// are rejected with 403.
//
// Scope is role-driven (decision D15: first version is read-only):
//   - role === 'platform' -> all tenants aggregated
//   - role === 'tenant'    -> only the token's own tenant (userTid)
const adminRoute = new Hono();

async function countForTenant(db, tenantId) {
  // Count only tables that exist in the current schema. `tasks` is physically
  // named `tasks_doc`; `family_groups`/`family_members`/`images` have no
  // standalone table (family lives in archive_items.family_id, images in R2),
  // so they are intentionally excluded from the row counts.
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM todos         WHERE tenant_id = ?) AS todos,
         (SELECT COUNT(*) FROM tasks_doc     WHERE tenant_id = ?) AS tasks,
         (SELECT COUNT(*) FROM archive_items WHERE tenant_id = ?) AS archives,
         (SELECT COUNT(*) FROM users         WHERE tenant_id = ?) AS users`
    )
    .bind(tenantId, tenantId, tenantId, tenantId)
    .first();
  return {
    todos: row.todos || 0,
    tasks: row.tasks || 0,
    archives: row.archives || 0,
    users: row.users || 0,
  };
}

async function tenantMeta(db, tenantId) {
  const row = await db
    .prepare(`SELECT tenant_id, app_id, name, plan, quota, created_at FROM tenants WHERE tenant_id = ?`)
    .bind(tenantId)
    .first();
  return row || { tenant_id: tenantId };
}

function requireAdmin(c) {
  if (c.get('userTyp') !== 'admin') {
    return c.json({ error: 'forbidden: admin token required' }, 403);
  }
  return null;
}

// Read-only stats. Scope adapts to the admin role.
adminRoute.get('/stats', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const role = c.get('userRole');
  const ownTid = c.get('userTid');

  if (role === 'platform') {
    const tenants = await db
      .prepare(`SELECT tenant_id, app_id, name, plan, quota, created_at FROM tenants ORDER BY created_at DESC`)
      .all();
    const list = [];
    const totals = {
      todos: 0, tasks: 0, archives: 0, family_groups: 0, family_members: 0, images: 0, users: 0,
    };
    for (const t of tenants.results || []) {
      const counts = await countForTenant(db, t.tenant_id);
      list.push({ tenant: t, counts });
      for (const k of Object.keys(totals)) totals[k] += counts[k];
    }
    return c.json({ scope: 'platform', tenants: list, totals, asOf: Date.now() });
  }

  // tenant (default): only the caller's own tenant
  const tid = ownTid || 'weijiashi';
  const counts = await countForTenant(db, tid);
  const meta = await tenantMeta(db, tid);
  return c.json({ scope: 'tenant', tenant: meta, counts, asOf: Date.now() });
});

// Tenant registry view, role-scoped.
adminRoute.get('/tenants', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const role = c.get('userRole');
  const ownTid = c.get('userTid');

  if (role === 'platform') {
    const rows = await db
      .prepare(`SELECT tenant_id, app_id, name, plan, quota, created_at FROM tenants ORDER BY created_at DESC`)
      .all();
    return c.json(rows.results || []);
  }
  const row = await db
    .prepare(`SELECT tenant_id, app_id, name, plan, quota, created_at FROM tenants WHERE tenant_id = ?`)
    .bind(ownTid)
    .first();
  return c.json(row ? [row] : []);
});

export { adminRoute };
