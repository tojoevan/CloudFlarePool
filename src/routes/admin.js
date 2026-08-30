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

// platform 角色专属：在 requireAdmin 基础上再要求 role === 'platform'。
function requirePlatform(c) {
  const d = requireAdmin(c);
  if (d) return d;
  if (c.get('userRole') !== 'platform') {
    return c.json({ error: 'forbidden: platform role required' }, 403);
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

// 生成一次性恢复码（登录态、需 T4）。返回明文仅一次，库内存 SHA-256(recovery_code)。
// 忘记密码时凭 email + 恢复码自助重置（见下方 /recover）。恢复码用后作废。
adminRoute.post('/me/recovery/generate', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const adminId = c.get('userId');
  const code = bytesToB64url(crypto.getRandomValues(new Uint8Array(18)));
  const codeHash = bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)));
  await db.prepare('UPDATE admin_accounts SET recovery_hash = ? WHERE id = ?').bind(codeHash, adminId).run();
  await audit(c, 'recovery.generate', `admin:${adminId}`);
  return c.json({ ok: true, recovery_code: code });
});

// 忘记密码自助重置（公开端点，经网关 X-Sync-Key 调用，无需 T4 令牌）。
// 凭 email + recovery_code + 新密码重置；成功后作废恢复码（防复用）。
// 错误统一返回 400，不区分「邮箱不存在 / 恢复码错误」，避免账号枚举。
adminRoute.post('/recover', async (c) => {
  const db = c.env.DB;
  const b = await c.req.json().catch(() => ({}));
  const email = String(b.email || '').trim().toLowerCase();
  const code = b.recovery_code || '';
  const np = b.new_password || '';
  if (!email || !code || String(np).length < 8) {
    return c.json({ error: 'invalid request' }, 400);
  }
  const row = await db
    .prepare('SELECT id, status, recovery_hash FROM admin_accounts WHERE email = ?')
    .bind(email)
    .first();
  if (!row || row.status !== 'active' || !row.recovery_hash) {
    return c.json({ error: 'invalid email or recovery code' }, 400);
  }
  const codeHash = bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)));
  if (codeHash !== row.recovery_hash) {
    return c.json({ error: 'invalid email or recovery code' }, 400);
  }
  let newHash;
  try {
    newHash = await hashPassword(np);
  } catch {
    return c.json({ error: 'password hashing failed' }, 500);
  }
  if (typeof newHash !== 'string' || !/^[0-9a-f]{32}\$\d+\$[0-9a-f]+$/.test(newHash)) {
    return c.json({ error: 'generated hash invalid' }, 500);
  }
  await db
    .prepare('UPDATE admin_accounts SET pwd_hash = ?, recovery_hash = NULL WHERE id = ?')
    .bind(newHash, row.id)
    .run();
  await audit(c, 'password.recover', `admin:${row.id}`);
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

// 管理员代重置普通用户密码（仅限本租户）。重置后用户下次用新密码登录；
// 新密码由代操作管理员线下传达（无邮件 / 短信依赖）。身份取自 T4 令牌 sub。
adminRoute.post('/users/:id/reset', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const tid = c.get('userTid') || 'weijiashi';
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const np = b.new_password || '';
  if (String(np).length < 8) {
    return c.json({ error: 'new_password too short (>=8 chars)' }, 400);
  }
  const row = await db.prepare('SELECT id, tenant_id, email FROM users WHERE id = ?').bind(id).first();
  if (!row || row.tenant_id !== tid) return c.json({ error: 'user not found in your tenant' }, 404);
  let newHash;
  try {
    newHash = await hashPassword(np);
  } catch {
    return c.json({ error: 'password hashing failed' }, 500);
  }
  if (typeof newHash !== 'string' || !/^[0-9a-f]{32}\$\d+\$[0-9a-f]+$/.test(newHash)) {
    return c.json({ error: 'generated hash invalid' }, 500);
  }
  await db.prepare('UPDATE users SET pwd_hash = ? WHERE id = ? AND tenant_id = ?').bind(newHash, id, tid).run();
  await audit(c, 'password.reset', `user:${id}`, { by: c.get('userId'), email: row.email });
  return c.json({ ok: true, id });
});

// T3 服务密钥列表（租户内）。
adminRoute.get('/keys', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const tid = c.get('userTid') || 'weijiashi';
  const rows = await db
    .prepare(
      'SELECT id, tenant_id, scope, tenant_bound, status, current_kid, created_at, label, note, used_by, expires_at FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC'
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
      label: r.label ?? null,
      note: r.note ?? null,
      used_by: r.used_by ?? null,
      expires_at: r.expires_at ?? null,
    }))
  );
});

// 签发新的 T3 服务密钥（tenant_bound，仅本租户）。raw_secret 仅返回一次。
// Phase 3.1：接受并持久化 label / note / used_by / expires_at 运营备注。
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
  const label = typeof b.label === 'string' ? b.label.slice(0, 120) : null;
  const note = typeof b.note === 'string' ? b.note.slice(0, 500) : null;
  const usedBy = typeof b.used_by === 'string' ? b.used_by.slice(0, 120) : null;
  const expiresAt = Number.isFinite(b.expires_at) ? Math.floor(b.expires_at) : null;
  await db
    .prepare('INSERT INTO api_keys (id, app_id, tenant_id, secret_hash, scope, tenant_bound, status, current_kid, prev_kid, prev_secret, created_at, label, note, used_by, expires_at) VALUES (?, ?, ?, ?, ?, 1, \'active\', ?, NULL, NULL, ?, ?, ?, ?, ?)')
    .bind(id, appId, tid, secretHash, JSON.stringify(scope), kid, Date.now(), label, note, usedBy, expiresAt)
    .run();
  await audit(c, 'key.issue', `key:${id}`, { scope, label, used_by: usedBy });
  return c.json({ id, raw_secret: rawSecret, kid, scope, tenant_bound: true, tenant_id: tid, label, note, used_by: usedBy, expires_at: expiresAt });
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

// 更新 T3 服务密钥的运营备注（label / note / used_by / expires_at）。
// 不改变 secret / scope / 租户绑定，仅补充展示信息。仅限本租户。
adminRoute.post('/keys/:id/meta', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const tid = c.get('userTid') || 'weijiashi';
  const id = c.req.param('id');
  const row = await db.prepare('SELECT id, tenant_id FROM api_keys WHERE id = ?').bind(id).first();
  if (!row || row.tenant_id !== tid) return c.json({ error: 'key not found in your tenant' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const label = typeof b.label === 'string' ? b.label.slice(0, 120) : null;
  const note = typeof b.note === 'string' ? b.note.slice(0, 500) : null;
  const usedBy = typeof b.used_by === 'string' ? b.used_by.slice(0, 120) : null;
  const expiresAt = Number.isFinite(b.expires_at) ? Math.floor(b.expires_at) : null;
  await db
    .prepare('UPDATE api_keys SET label = ?, note = ?, used_by = ?, expires_at = ? WHERE id = ? AND tenant_id = ?')
    .bind(label, note, usedBy, expiresAt, id, tid)
    .run();
  return c.json({ ok: true, id, label, note, used_by: usedBy, expires_at: expiresAt });
});

// ===== Admin Management (platform only) =====
// 平台管理员名录（不含 pwd_hash / recovery_hash）。tenant 角色无权访问。
adminRoute.get('/accounts', async (c) => {
  const deny = requirePlatform(c);
  if (deny) return deny;

  const db = c.env.DB;
  const rows = await db
    .prepare('SELECT id, email, role, status, created_at FROM admin_accounts ORDER BY created_at DESC')
    .all();
  return c.json(rows.results || []);
});

// 平台管理员代重置某管理员密码（platform 专属）。重置后作废其恢复码，
// 强制其重新生成；新密码由代操作管理员线下传达（无邮件/短信依赖）。
adminRoute.post('/accounts/:id/reset', async (c) => {
  const deny = requirePlatform(c);
  if (deny) return deny;

  const db = c.env.DB;
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const np = b.new_password || '';
  if (String(np).length < 8) {
    return c.json({ error: 'new_password too short (>=8 chars)' }, 400);
  }
  const row = await db.prepare('SELECT id, status FROM admin_accounts WHERE id = ?').bind(id).first();
  if (!row) return c.json({ error: 'admin not found' }, 404);
  let newHash;
  try {
    newHash = await hashPassword(np);
  } catch {
    return c.json({ error: 'password hashing failed' }, 500);
  }
  if (typeof newHash !== 'string' || !/^[0-9a-f]{32}\$\d+\$[0-9a-f]+$/.test(newHash)) {
    return c.json({ error: 'generated hash invalid' }, 500);
  }
  await db.prepare('UPDATE admin_accounts SET pwd_hash = ?, recovery_hash = NULL WHERE id = ?').bind(newHash, id).run();
  await audit(c, 'password.reset', `admin:${id}`, { by: c.get('userId') });
  return c.json({ ok: true, id });
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
    cols: ['id', 'owner_openid', 'tenant_id', 'title', 'meta', 'tag', 'dot', 'shared', 'family_id', 'updated_at'],
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
    cols: ['id', 'owner_openid', 'tenant_id', 'type', 'payload', 'shared', 'family_id', 'created_at', 'updated_at'],
    searchable: ['type'],
    editable: ['type', 'payload', 'shared', 'family_id'],
    jsonCols: ['payload'],
    key: 'id',
  },
  collections: {
    label: '通用集合',
    cols: ['id', 'collection', 'owner_openid', 'tenant_id', 'doc', 'updated_at'],
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
function rowWhere(c, meta, { withOwnerKey = false, collection = null } = {}) {
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

  // collections 表用 id 作主键，但不同集合（如 cloudlet_saves / cloudlet_accounts）
  // 会复用同一 id，必须按 collection 进一步唯一定位，否则编辑/删除会命中撞 id 的其它行
  if (collection) { where.push('collection = ?'); params.push(collection); }

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

// 导出（JSON，一次返回当前过滤条件下全部行，上限 10000 防超限）。注册在
// /rows/:table/:id 之前，避免 "export" 被当作 id 匹配。
adminRoute.get('/rows/:table/export', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const meta = ROW_TABLES[c.req.param('table')];
  if (!meta) return c.json({ error: 'unknown table' }, 404);

  const db = c.env.DB;
  const { where, params } = rowWhere(c, meta);
  const { results } = await db
    .prepare(`SELECT * FROM ${c.req.param('table')} WHERE ${where} ORDER BY updated_at DESC LIMIT 10000`)
    .bind(...params)
    .all();

  const rows = (results || []).map((r) => {
    const o = {};
    for (const col of meta.cols) o[col] = meta.jsonCols.includes(col) ? parseAdminJson(r[col]) : r[col];
    return o;
  });
  return c.json({
    table: c.req.param('table'),
    label: meta.label,
    count: rows.length,
    truncated: rows.length >= 10000,
    rows,
  });
});

adminRoute.get('/rows/:table/:id', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const meta = ROW_TABLES[c.req.param('table')];
  if (!meta) return c.json({ error: 'unknown table' }, 404);

  const db = c.env.DB;
  const table = c.req.param('table');
  const id = c.req.param('id');
  const { where, params } = rowWhere(c, meta, { withOwnerKey: true, collection: c.req.query('collection') });
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
  const { where, params } = rowWhere(c, meta, { withOwnerKey: true, collection: c.req.query('collection') });
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
  const { where, params } = rowWhere(c, meta, { withOwnerKey: true, collection: c.req.query('collection') });
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
