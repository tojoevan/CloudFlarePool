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
  return c.json((rows.results || []).map((u) => ({ ...u, email: u.email ? maskText(u.email) : u.email })));
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

// ===== openid 用户画像（「用户与家庭」页的数据源）=====
// 小程序用户无邮箱账号，以 openid 为身份，散落在各业务表。此处聚合
// todos / archive_items / collections / family_members 四表，返回每个
// openid 的数据量、家庭数与最近活跃时间，供管理后台做用户视角排障入口。
// 只读端点，不写审计。tenant 角色看本租户；platform 角色可选 ?tid=。
//   GET /admin/profiles?q=&limit=&offset=&tid=
adminRoute.get('/profiles', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const db = c.env.DB;
  const role = c.get('userRole');
  const whereSql = [];
  const tp = [];
  if (role !== 'platform') {
    whereSql.push('tenant_id = ?');
    tp.push(c.get('userTid') || 'weijiashi');
  } else {
    const tid = c.req.query('tid');
    if (tid) { whereSql.push('tenant_id = ?'); tp.push(tid); }
  }
  const tSql = whereSql.length ? whereSql.join(' AND ') : '1=1';

  // openid -> 画像。分别查四张表后内存合并，避免 UNION ALL 组合查询的坑。
  const map = new Map();
  const touch = (oid) => {
    let p = map.get(oid);
    if (!p) {
      p = { openid: oid, nickname: null, todos: 0, archives: 0, collections: 0, families: 0, last_active: 0 };
      map.set(oid, p);
    }
    return p;
  };
  const agg = (rows, apply) => {
    for (const r of rows || []) apply(r);
  };

  const q1 = await db
    .prepare(`SELECT owner_openid AS oid, COUNT(*) AS n, MAX(updated_at) AS t FROM todos WHERE ${tSql} GROUP BY owner_openid`)
    .bind(...tp)
    .all();
  agg(q1.results, (r) => { const p = touch(r.oid); p.todos = r.n; if (r.t > p.last_active) p.last_active = r.t; });

  const q2 = await db
    .prepare(`SELECT owner_openid AS oid, COUNT(*) AS n, MAX(updated_at) AS t FROM archive_items WHERE ${tSql} GROUP BY owner_openid`)
    .bind(...tp)
    .all();
  agg(q2.results, (r) => { const p = touch(r.oid); p.archives = r.n; if (r.t > p.last_active) p.last_active = r.t; });

  const q3 = await db
    .prepare(`SELECT owner_openid AS oid, COUNT(*) AS n, MAX(updated_at) AS t FROM collections WHERE ${tSql} GROUP BY owner_openid`)
    .bind(...tp)
    .all();
  agg(q3.results, (r) => { const p = touch(r.oid); p.collections = r.n; if (r.t > p.last_active) p.last_active = r.t; });

  // family_members 无 tenant_id，经 families 子查询收口；昵称取最新加入的家庭
  const q4 = await db
    .prepare(
      `SELECT m.openid AS oid, COUNT(*) AS n, MAX(m.joined_at) AS t,
              (SELECT m2.nickname FROM family_members m2 WHERE m2.openid = m.openid AND m2.nickname IS NOT NULL AND m2.family_id = m.family_id ORDER BY m2.joined_at DESC LIMIT 1) AS nick
       FROM family_members m
       WHERE m.family_id IN (SELECT family_id FROM families WHERE ${tSql})
       GROUP BY m.openid`
    )
    .bind(...tp)
    .all();
  agg(q4.results, (r) => { const p = touch(r.oid); p.families = r.n; p.nickname = r.nick || null; if (r.t > p.last_active) p.last_active = r.t; });

  // 搜索（openid 子串）+ 按最近活跃排序 + 分页
  const q = (c.req.query('q') || '').trim().toLowerCase();
  let all = Array.from(map.values());
  if (q) all = all.filter((p) => p.openid.toLowerCase().includes(q));
  all.sort((a, b) => b.last_active - a.last_active || (a.openid < b.openid ? -1 : 1));

  const limit = Math.min(parseInt(c.req.query('limit') || '20', 10) || 20, 100);
  const offset = Math.max(parseInt(c.req.query('offset') || '0', 10) || 0, 0);
  return c.json({ rows: all.slice(offset, offset + limit), total: all.length, limit, offset });
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
    cols: ['id', 'owner_openid', 'tenant_id', 'title', 'meta', 'tag', 'dot', 'shared', 'co_edit', 'family_id', 'updated_at'],
    searchable: ['title'],
    editable: ['title', 'meta', 'tag', 'dot', 'shared', 'family_id'],
    jsonCols: ['meta'],
    maskCols: ['title', 'meta'], // 标题/正文打码
    key: 'id',
  },
  tasks_doc: {
    label: '任务文档',
    cols: ['tenant_id', 'owner_openid', 'sections', 'updated_at'],
    searchable: [],
    editable: [],
    jsonCols: ['sections'],
    maskCols: ['sections'], // 事务正文打码
    key: 'owner_openid',
  },
  archive_items: {
    label: '归档',
    cols: ['id', 'owner_openid', 'tenant_id', 'type', 'payload', 'shared', 'co_edit', 'family_id', 'created_at', 'updated_at'],
    searchable: ['type'],
    editable: ['type', 'payload', 'shared', 'family_id'],
    jsonCols: ['payload'],
    maskCols: ['payload'], // 归档内容打码
    key: 'id',
  },
  collections: {
    label: '通用集合',
    cols: ['id', 'collection', 'owner_openid', 'tenant_id', 'doc', 'updated_at'],
    searchable: ['collection'],
    editable: ['doc'],
    jsonCols: ['doc'],
    maskCols: ['doc'], // 集合文档打码
    key: 'id',
    familyIdCol: 'family_id', // ?fam= 按家庭过滤（共享项挂家庭）
  },
  families: {
    label: '家庭',
    cols: ['family_id', 'tenant_id', 'name', 'owner_openid', 'created_at'],
    searchable: ['name'],
    editable: [], // v1 只读：家庭记录的修正走业务链路，避免误编辑（撞 id 教训）
    jsonCols: [],
    maskCols: ['name'], // 家庭名打码
    key: 'family_id',
    orderCol: 'created_at',
    familyIdCol: 'family_id',
  },
  family_members: {
    label: '家庭成员',
    cols: ['family_id', 'openid', 'role', 'nickname', 'invited_by', 'joined_at'],
    searchable: ['nickname'],
    editable: [], // 复合主键 (family_id, openid)，无单列 id，保持只读
    jsonCols: [],
    maskCols: ['nickname'], // 成员昵称打码
    key: null, // 复合主键：行级编辑/删除一律拒绝
    orderCol: 'joined_at',
    ownerCol: 'openid',            // ?owner= 筛成员而非 owner_openid
    tenantVia: { table: 'families', pk: 'family_id', fk: 'family_id' }, // 无 tenant_id，经 families 收口
    familyIdCol: 'family_id',
  },
  family_invites: {
    label: '家庭邀请',
    cols: ['code', 'family_id', 'inviter_openid', 'created_at', 'expires_at', 'used_at'],
    searchable: [],
    editable: [], // 凭证类数据，只读
    jsonCols: [],
    maskCols: ['code'], // 邀请码打码
    key: 'code',
    orderCol: 'created_at',
    ownerCol: 'inviter_openid',
    tenantVia: { table: 'families', pk: 'family_id', fk: 'family_id' },
    familyIdCol: 'family_id',
  },
};

function parseAdminJson(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

// ===== 隐私脱敏（方案 A：后台不直接读明文隐私）=====
// 后台只读聚合统计/排障元数据，敏感内容字段一律打码。设计取舍：
//   - 列表/导出/画像：脱敏，防止一览无余看到用户家事内容。
//   - 单行详情（:id GET）：platform 不脱敏（需编辑表单回填原文，否则会把
//     "空调滤网清洗"存成"空**"）；tenant 脱敏，防其借详情绕过列表脱敏读取明文。
//   - 本人数据（T2 通道）不经过此处，不受影响。

// 文本打码：保留首字符、其余用 * 填充（长度信息保留，辅助判断规模）。
function maskText(v) {
  if (v == null) return v;
  const s = String(v);
  if (s.length === 0) return s;
  if (s.length === 1) return s + '**';
  return s[0] + '*'.repeat(Math.min(s.length - 1, 12));
}

// 按 ROW_TABLES[].maskCols 脱敏一行；mask=false 时原样返回（详情编辑场景）。
function serializeRow(meta, r, mask = true) {
  const o = {};
  for (const col of meta.cols) {
    let val = meta.jsonCols.includes(col) ? parseAdminJson(r[col]) : r[col];
    if (mask && meta.maskCols && meta.maskCols.includes(col)) {
      // JSON 类敏感字段（meta/payload/doc/sections）整体替换为占位，不泄露结构
      val = meta.jsonCols.includes(col) ? '[已隐藏]' : maskText(val);
    }
    o[col] = val;
  }
  return o;
}

// 组装租户可见行的查询条件；返回 { where, params }
// meta 可选扩展：
//   ownerCol    —— 归属列名（默认 owner_openid；family_members 是 openid）
//   tenantVia   —— 表无 tenant_id 列时，经 { table, pk, fk } 子查询收口租户
//   familyIdCol —— 支持 ?fam= 按家庭 id 过滤（家庭成员/邀请/共享项）
function rowWhere(c, meta, { withOwnerKey = false, collection = null } = {}) {
  const role = c.get('userRole');
  const ownTid = c.get('userTid');
  const where = [];
  const params = [];

  // 租户约束：tenant 角色强制本租户；platform 角色可选 ?tid=
  let tenantCond = null;
  let tenantParam = null;
  if (role !== 'platform') {
    tenantCond = 'tenant_id = ?';
    tenantParam = ownTid || 'weijiashi';
  } else {
    const tid = c.req.query('tid');
    if (tid) { tenantCond = 'tenant_id = ?'; tenantParam = tid; }
  }
  if (tenantCond) {
    if (meta.tenantVia) {
      const { table, pk, fk } = meta.tenantVia;
      where.push(`${fk} IN (SELECT ${pk} FROM ${table} WHERE ${tenantCond})`);
      params.push(tenantParam);
    } else {
      where.push(tenantCond);
      params.push(tenantParam);
    }
  }

  const owner = c.req.query('owner');
  if (owner && !withOwnerKey) {
    where.push(`${meta.ownerCol || 'owner_openid'} = ?`);
    params.push(owner);
  }

  const fam = c.req.query('fam');
  if (fam && meta.familyIdCol) { where.push(`${meta.familyIdCol} = ?`); params.push(fam); }

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
    .prepare(`SELECT * FROM ${c.req.param('table')} WHERE ${where} ORDER BY ${meta.orderCol || 'updated_at'} DESC LIMIT ? OFFSET ?`)
    .bind(...params, limit, offset)
    .all();

  const rows = (results || []).map((r) => serializeRow(meta, r));
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
    .prepare(`SELECT * FROM ${c.req.param('table')} WHERE ${where} ORDER BY ${meta.orderCol || 'updated_at'} DESC LIMIT 10000`)
    .bind(...params)
    .all();

  const rows = (results || []).map((r) => serializeRow(meta, r));
  await audit(c, 'row.export', c.req.param('table'), { count: rows.length });
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
  if (!meta.key) return c.json({ error: 'table has composite key, no single-row access' }, 400);

  const db = c.env.DB;
  const table = c.req.param('table');
  const id = c.req.param('id');
  const { where, params } = rowWhere(c, meta, { withOwnerKey: true, collection: c.req.query('collection') });
  const row = await db
    .prepare(`SELECT * FROM ${table} WHERE ${where} AND ${meta.key} = ?`)
    .bind(...params, id)
    .first();
  if (!row) return c.json({ error: 'not found in your scope' }, 404);
  // 脱敏按角色：platform 看原文（需编辑表单回填），tenant 仅看脱敏值，
  // 防止 tenant 借单行详情绕过列表脱敏直接读取用户明文隐私。
  return c.json(serializeRow(meta, row, c.get('userRole') !== 'platform'));
});

adminRoute.put('/rows/:table/:id', async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  // 业务数据行级编辑收限 platform：租户管理员仅只读，防止越权改/删用户家事内容
  const dp = requirePlatform(c);
  if (dp) return dp;

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

  // 业务数据行级删除收限 platform：租户管理员仅只读
  const dp = requirePlatform(c);
  if (dp) return dp;

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
