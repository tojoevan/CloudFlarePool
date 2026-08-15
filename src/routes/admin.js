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

// 管理员操作留痕（best-effort：审计失败不阻断主操作）。所有 T4 写操作在
// 成功后调用，写入 admin_audit_log（tenant_id 取令牌归属租户，platform 为 NULL）。
async function audit(c, action, target, detail) {
  try {
    const db = c.env.DB;
    await db
      .prepare(
        'INSERT INTO admin_audit_log (id, app_id, tenant_id, admin_id, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .bind(
        crypto.randomUUID(),
        c.get('userAid') || 'jiashiben',
        c.get('userTid') || null,
        c.get('userId') || null,
        action,
        target || null,
        detail ? JSON.stringify(detail) : null,
        c.req.header('cf-connecting-ip') || null,
        Date.now()
      )
      .run();
  } catch (_) {
    /* best-effort */
  }
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
  await audit(c, 'password.change', `admin:${adminId}`);
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
  await audit(c, 'user.status', `user:${id}`, { status });
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
  await audit(c, 'key.issue', `key:${id}`, { scope });
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
  await audit(c, 'key.revoke', `key:${id}`);
  return c.json({ ok: true, id, status: 'revoked' });
});

// ===== Data Browser & Content Management（数据浏览器/内容管理） =====
// 管理员按租户浏览/编辑/删除业务数据。表名与列名**仅来自下方白名单**，绝不
// 拼接用户输入，杜绝 SQL 注入；tenant 角色只能看/改自己租户（userTid），
// platform 角色可选 ?tid= 过滤（缺省看全部）。
//   GET    /admin/rows/:table?limit=&offset=&q=&owner=&tid=
//   PUT    /admin/rows/:table/:id   （仅白名单内的可编辑字段）
//   DELETE /admin/rows/:table/:id   （tasks_doc 不可删，返回 400）

const ROW_TABLES = {
  todos: {
    label: '待办',
    cols: ['id', 'owner_openid', 'title', 'meta', 'tag', 'dot', 'shared', 'family_id', 'updated_at'],
    searchable: ['title'],
    editable: ['title', 'meta', 'tag', 'dot', 'shared', 'family_id'],
    jsonCols: ['meta'],
    key: 'id',
  },
  tasks_doc: {
    label: '任务文档',
    cols: ['tenant_id', 'owner_openid', 'sections', 'updated_at'],
    searchable: [],
    editable: [],
    jsonCols: ['sections'],
    key: 'owner_openid',
  },
  archive_items: {
    label: '归档',
    cols: ['id', 'owner_openid', 'type', 'payload', 'shared', 'family_id', 'created_at', 'updated_at'],
    searchable: ['type'],
    editable: ['type', 'payload', 'shared', 'family_id'],
    jsonCols: ['payload'],
    key: 'id',
  },
  collections: {
    label: '通用集合',
    cols: ['id', 'collection', 'owner_openid', 'doc', 'updated_at'],
    searchable: ['collection'],
    editable: ['doc'],
    jsonCols: ['doc'],
    key: 'id',
  },
};

function parseAdminJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

// 组装租户可见行的查询条件；返回 { where, params }
function rowWhere(c, meta, { withOwnerKey = false } = {}) {
  const role = c.get('userRole');
  const ownTid = c.get('userTid');
  const where = [];
  const params = [];

  if (role !== 'platform') {
    where.push('tenant_id = ?');
    params.push(ownTid || 'weijiashi');
  } else {
    const tid = c.req.query('tid');
    if (tid) { where.push('tenant_id = ?'); params.push(tid); }
  }

  const owner = c.req.query('owner');
  if (owner && !withOwnerKey) { where.push('owner_openid = ?'); params.push(owner); }

  const q = c.req.query('q');
  if (q && meta.searchable.length) {
    where.push('(' + meta.searchable.map((col) => `${col} LIKE ?`).join(' OR ') + ')');
    for (let i = 0; i < meta.searchable.length; i++) params.push(`%${q}%`);
  }
  return { where: where.length ? where.join(' AND ') : '1=1', params };
}

adminRoute.get('/rows/:table', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const meta = ROW_TABLES[c.req.param('table')];
  if (!meta) return c.json({ error: 'unknown table' }, 404);

  const db = c.env.DB;
  const { where, params } = rowWhere(c, meta);

  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10) || 20, 100);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM ${c.req.param('table')} WHERE ${where}`)
    .bind(...params)
    .first();
  const { results } = await db
    .prepare(`SELECT * FROM ${c.req.param('table')} WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
    .bind(...params, limit, offset)
    .all();

  const rows = (results || []).map((r) => {
    const o = {};
    for (const col of meta.cols) o[col] = meta.jsonCols.includes(col) ? parseAdminJson(r[col]) : r[col];
    return o;
  });
  return c.json({ table: c.req.param('table'), label: meta.label, rows, total: totalRow?.n || 0, limit, offset });
});

adminRoute.get('/rows/:table/:id', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const meta = ROW_TABLES[c.req.param('table')];
  if (!meta) return c.json({ error: 'unknown table' }, 404);

  const db = c.env.DB;
  const table = c.req.param('table');
  const id = c.req.param('id');
  const { where, params } = rowWhere(c, meta, { withOwnerKey: true });
  const row = await db
    .prepare(`SELECT * FROM ${table} WHERE ${where} AND ${meta.key} = ?`)
    .bind(...params, id)
    .first();
  if (!row) return c.json({ error: 'not found in your scope' }, 404);
  const o = {};
  for (const col of meta.cols) o[col] = meta.jsonCols.includes(col) ? parseAdminJson(row[col]) : row[col];
  return c.json(o);
});

adminRoute.put('/rows/:table/:id', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const meta = ROW_TABLES[c.req.param('table')];
  if (!meta) return c.json({ error: 'unknown table' }, 404);
  if (!meta.editable.length) return c.json({ error: 'table is read-only' }, 400);

  const db = c.env.DB;
  const table = c.req.param('table');
  const id = c.req.param('id');
  const { where, params } = rowWhere(c, meta, { withOwnerKey: true });
  const exist = await db
    .prepare(`SELECT * FROM ${table} WHERE ${where} AND ${meta.key} = ?`)
    .bind(...params, id)
    .first();
  if (!exist) return c.json({ error: 'not found in your scope' }, 404);

  const b = await c.req.json().catch(() => ({}));
  const sets = [];
  const vp = [];
  const changed = [];
  for (const col of meta.editable) {
    if (b[col] === undefined) continue;
    changed.push(col);
    sets.push(`${col} = ?`);
    if (meta.jsonCols.includes(col)) {
      vp.push(typeof b[col] === 'string' ? b[col] : JSON.stringify(b[col]));
    } else if (col === 'shared') {
      vp.push(b[col] ? 1 : 0);
    } else {
      vp.push(b[col]);
    }
  }
  if (!sets.length) return c.json({ error: 'no editable fields provided' }, 400);
  sets.push('updated_at = ?');
  vp.push(Date.now());
  vp.push(...params, id);

  await db
    .prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${where} AND ${meta.key} = ?`)
    .bind(...vp)
    .run();
  await audit(c, 'row.update', `${table}:${id}`, { fields: changed });
  return c.json({ ok: true, id });
});

adminRoute.delete('/rows/:table/:id', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const meta = ROW_TABLES[c.req.param('table')];
  if (!meta) return c.json({ error: 'unknown table' }, 404);
  if (!meta.editable.length) return c.json({ error: 'table is read-only' }, 400);

  const db = c.env.DB;
  const table = c.req.param('table');
  const id = c.req.param('id');
  const { where, params } = rowWhere(c, meta, { withOwnerKey: true });
  const exist = await db
    .prepare(`SELECT * FROM ${table} WHERE ${where} AND ${meta.key} = ?`)
    .bind(...params, id)
    .first();
  if (!exist) return c.json({ error: 'not found in your scope' }, 404);

  await db.prepare(`DELETE FROM ${table} WHERE ${where} AND ${meta.key} = ?`).bind(...params, id).run();
  await audit(c, 'row.delete', `${table}:${id}`);
  return c.json({ ok: true, id });
});

// 审计日志查询（管理员操作留痕）。tenant 角色只看本租户；platform 角色可
// 可选 ?tid= 过滤；支持 ?action= 按动作过滤。
adminRoute.get('/audit', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const role = c.get('userRole');
  const ownTid = c.get('userTid');
  const where = [];
  const params = [];

  if (role !== 'platform') {
    where.push('tenant_id = ?');
    params.push(ownTid || 'weijiashi');
  } else {
    const tid = c.req.query('tid');
    if (tid) { where.push('tenant_id = ?'); params.push(tid); }
  }
  const action = c.req.query('action');
  if (action) { where.push('action = ?'); params.push(action); }

  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10) || 20, 100);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);
  const whereSql = where.length ? where.join(' AND ') : '1=1';

  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM admin_audit_log WHERE ${whereSql}`)
    .bind(...params)
    .first();
  const { results } = await db
    .prepare(
      `SELECT id, tenant_id, admin_id, action, target, detail, ip, created_at
       FROM admin_audit_log WHERE ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(...params, limit, offset)
    .all();

  const rows = (results || []).map((r) => ({ ...r, detail: parseAdminJson(r.detail) }));
  return c.json({ rows, total: totalRow?.n || 0, limit, offset });
});

export { adminRoute };
