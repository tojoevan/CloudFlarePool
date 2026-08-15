import { Hono } from 'hono';
import { hashPassword, verifyPassword } from '../lib/password.js';

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

// ===== Account & Key Center (Phase 3, 账号与密钥中心) =====
// All endpoints below require `userTyp==='admin'` (enforced by requireAdmin).
// Tenant scoping derives from the verified T4 token (userTid / userAid).

function bytesToHex(buf) {
  const u8 = new Uint8Array(buf);
  return [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function bytesToB64url(u8) {
  let bin = '';
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 管理员自助改密：校验旧密码（PBKDF2）后写入新哈希。身份取自 T4 令牌 sub（admin id）。
adminRoute.post('/me/password', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const adminId = c.get('userId');
  const b = await c.req.json().catch(() => ({}));
  if (!b.old_password || !b.new_password) {
    return c.json({ error: 'old_password and new_password required' }, 400);
  }
  if (String(b.new_password).length < 8) {
    return c.json({ error: 'new_password too short (>=8 chars)' }, 400);
  }
  const row = await db
    .prepare('SELECT id, pwd_hash, status FROM admin_accounts WHERE id = ?')
    .bind(adminId)
    .first();
  if (!row || row.status !== 'active') return c.json({ error: 'admin not found' }, 404);
  const ok = await verifyPassword(b.old_password, row.pwd_hash);
  if (!ok) return c.json({ error: 'old password incorrect' }, 401);
  // 防御：hashPassword 必须成功且产出合法字符串，否则绝不写库（避免把 pwd_hash 写成 NULL 锁死账号）
  let newHash;
  try {
    newHash = await hashPassword(b.new_password);
  } catch (e) {
    return c.json({ error: 'password hashing failed' }, 500);
  }
  if (typeof newHash !== 'string' || !/^[0-9a-f]{32}\$\d+\$[0-9a-f]+$/.test(newHash)) {
    return c.json({ error: 'generated hash invalid' }, 500);
  }
  await db.prepare('UPDATE admin_accounts SET pwd_hash = ? WHERE id = ?').bind(newHash, adminId).run();
  return c.json({ ok: true });
});

// 用户账号列表（租户内）。
adminRoute.get('/users', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const tid = c.get('userTid') || 'weijiashi';
  const rows = await db
    .prepare('SELECT id, email, status, provider, created_at FROM users WHERE tenant_id = ? ORDER BY created_at DESC')
    .bind(tid)
    .all();
  return c.json(rows.results || []);
});

// 启用 / 禁用用户账号（仅限本租户）。
adminRoute.post('/users/:id/status', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const tid = c.get('userTid') || 'weijiashi';
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const status = b.status === 'active' ? 'active' : 'disabled';
  const row = await db.prepare('SELECT id, tenant_id FROM users WHERE id = ?').bind(id).first();
  if (!row || row.tenant_id !== tid) return c.json({ error: 'user not found in your tenant' }, 404);
  await db.prepare('UPDATE users SET status = ? WHERE id = ? AND tenant_id = ?').bind(status, id, tid).run();
  return c.json({ ok: true, id, status });
});

// T3 服务密钥列表（租户内）。
adminRoute.get('/keys', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const tid = c.get('userTid') || 'weijiashi';
  const rows = await db
    .prepare(
      'SELECT id, tenant_id, scope, tenant_bound, status, current_kid, created_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC'
    )
    .bind(tid)
    .all();
  return c.json(
    (rows.results || []).map((r) => ({
      id: r.id,
      tenant_id: r.tenant_id,
      scope: JSON.parse(r.scope || '[]'),
      tenant_bound: !!r.tenant_bound,
      status: r.status,
      current_kid: r.current_kid,
      created_at: r.created_at,
    }))
  );
});

// 签发新的 T3 服务密钥（tenant_bound，仅本租户）。raw_secret 仅返回一次。
adminRoute.post('/keys', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const tid = c.get('userTid') || 'weijiashi';
  const appId = c.get('userAid') || 'jiashiben';
  const b = await c.req.json().catch(() => ({}));
  const scope = Array.isArray(b.scope) && b.scope.length ? b.scope : ['data:read', 'data:write'];

  const id = 'svc_' + bytesToB64url(crypto.getRandomValues(new Uint8Array(9))).replace(/[^a-zA-Z0-9]/g, '');
  const rawSecret = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  const secretHash = bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawSecret)));
  const kid = `${id}.v1`;
  await db
    .prepare('INSERT INTO api_keys (id, app_id, tenant_id, secret_hash, scope, tenant_bound, status, current_kid, prev_kid, prev_secret, created_at) VALUES (?, ?, ?, ?, ?, 1, \'active\', ?, NULL, NULL, ?)')
    .bind(id, appId, tid, secretHash, JSON.stringify(scope), kid, Date.now())
    .run();
  return c.json({ id, raw_secret: rawSecret, kid, scope, tenant_bound: true, tenant_id: tid });
});

// 吊销 T3 服务密钥（仅限本租户）。
adminRoute.post('/keys/:id/revoke', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const tid = c.get('userTid') || 'weijiashi';
  const id = c.req.param('id');
  const row = await db.prepare('SELECT id, tenant_id FROM api_keys WHERE id = ?').bind(id).first();
  if (!row || row.tenant_id !== tid) return c.json({ error: 'key not found in your tenant' }, 404);
  await db
    .prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND tenant_id = ?")
    .bind(Date.now(), id, tid)
    .run();
  return c.json({ ok: true, id, status: 'revoked' });
});

export { adminRoute };
