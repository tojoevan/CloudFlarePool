import { Hono } from 'hono';
import { hasScope, resolveApp } from '../lib/auth.js';
import { rateLimit } from '../lib/ratelimit.js';

// Multi-tenant data API. Mounted at `/t` so paths look like:
//   /t/:tenant/todos
//   /t/:tenant/tasks
//   /t/:tenant/archive[/:id]
//   /t/:tenant/family/shared
//   /t/:tenant/img[/:key]
//   /t/:tenant/c/:collection[/:id]   (generic collections, Phase 1, additive)
//
// Auth model:
//   - X-Sync-Key must be valid (global guard) — the data lake trusts the
//     gateway (home.inkspcl.com) which performs WeChat login upstream.
//   - X-User-Id header carries the verified end-user identity (openid) and
//     is used for per-user ownership isolation within a tenant.
//   - Rows are always scoped by tenant_id; cross-tenant access is impossible.

const dataRoute = new Hono();

// 安全注销宽限期：首次「申请注销」后须满此时长，DELETE /me 才放行。
// 即「今天申请 → 明天再次确认才会真正删除」的宽限语义。
const DELETION_GRACE_MS = 24 * 60 * 60 * 1000;

// T3 service-token scope enforcement (closes the design §8 technical debt).
// Only `typ=service` tokens carry an explicit scope; enforce at the HTTP-method
// level so a leaked read-only key cannot mutate data:
//   GET/HEAD      -> requires `data:read`
//   POST/PUT/...  -> requires `data:write`
// (`data:*` grants both.) The mini-program (X-Sync-Key internal channel), T2
// account JWTs and T4 admin JWTs carry no `scopes` and are completely
// unaffected.
dataRoute.use('*', async (c, next) => {
  const m = c.req.method;
  const isWrite = m !== 'GET' && m !== 'HEAD';

  // T3 service-token scope enforcement (closes the design §8 technical debt).
  // Only `typ=service` tokens carry an explicit scope; enforce at the HTTP-method
  // level so a leaked read-only key cannot mutate data:
  //   GET/HEAD      -> requires `data:read`
  //   POST/PUT/...  -> requires `data:write`
  // (`data:*` grants both.) The mini-program (X-Sync-Key internal channel), T2
  // account JWTs and T4 admin JWTs carry no `scopes` and are completely
  // unaffected.
  if (c.get('userTyp') === 'service') {
    const required = isWrite ? 'data:write' : 'data:read';
    if (!hasScope(c.get('scopes') || [], required)) {
      return c.json({ error: `forbidden: scope '${required}' required for ${m}` }, 403);
    }
    // 滥用防护：每个服务密钥 读 600/分、写 60/分
    const rl = await rateLimit(c, `key:${c.get('userId')}`, { limit: isWrite ? 60 : 600 });
    if (rl) return rl;
  } else if (c.get('userTyp') === 'account') {
    // 账号令牌：写 60/分（读不限，读量大）
    if (isWrite) {
      const rl = await rateLimit(c, `acct:${c.get('userId')}`, { limit: 60 });
      if (rl) return rl;
    }
  }
  // X-Sync-Key 内部通道（小程序经网关）userTyp 未设置 -> 完全豁免
  await next();
});

const now = () => Date.now();
// Identity comes from the X-User-Id header (gateway proxy, X-Sync-Key channel)
// or, on the JWT channel, from the verified token subject surfaced as context
// state by the global dual guard (B1). Falls back to 'anonymous'.
const ownerOf = (c) => c.get('userId') || c.req.header('X-User-Id') || 'anonymous';

// JSON columns are stored as TEXT; parse them back into objects on read so
// callers receive structured data instead of raw strings.
const parseTodo = (r) => {
  if (r && r.meta) { try { r.meta = JSON.parse(r.meta); } catch { /* keep as-is */ } }
  return r;
};
const parseArchive = (r) => {
  if (r && r.payload) { try { r.payload = JSON.parse(r.payload); } catch { /* keep as-is */ } }
  return r;
};

// Resolve the tenant; returns the id or null (unknown tenant).
async function tenantOr404(c) {
  const t = c.req.param('tenant');
  const row = await c.env.DB.prepare(
    `SELECT tenant_id FROM tenants WHERE tenant_id = ?`
  )
    .bind(t)
    .first();
  return row ? t : null;
}

// ---------------------------------------------------------------------------
// TODOS
// ---------------------------------------------------------------------------
dataRoute.post('/:tenant/todos', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);

  const b = await c.req.json().catch(() => ({}));
  const id = b.id || crypto.randomUUID();
  const ow = ownerOf(c);

  await c.env.DB.prepare(
    `INSERT INTO todos (id, tenant_id, owner_openid, title, meta, tag, dot, shared, family_id, co_edit, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenant,
      ow,
      b.title || '',
      JSON.stringify(b.meta || {}),
      b.tag || null,
      b.dot || null,
      b.shared ? 1 : 0,
      b.family_id || null,
      b.co_edit ? 1 : 0,
      now()
    )
    .run();

  return c.json({ ok: true, id, owner: ow });
});

dataRoute.get('/:tenant/todos', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);

  const ownerQ = c.req.query('owner') || 'me';
  const ow = ownerOf(c);
  let where = 'tenant_id = ?';
  const p = [tenant];
  if (ownerQ === 'me') {
    where += ' AND owner_openid = ?';
    p.push(ow);
  } else if (ownerQ !== 'all') {
    where += ' AND owner_openid = ?';
    p.push(ownerQ);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT * FROM todos WHERE ${where} ORDER BY updated_at DESC`
  )
    .bind(...p)
    .all();
  return c.json(results.map(parseTodo));
});

dataRoute.get('/:tenant/todos/:id', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const row = await c.env.DB.prepare(
    `SELECT * FROM todos WHERE tenant_id = ? AND id = ?`
  )
    .bind(tenant, c.req.param('id'))
    .first();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(parseTodo(row));
});

dataRoute.put('/:tenant/todos/:id', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const id = c.req.param('id');
  const exist = await c.env.DB.prepare(
    `SELECT * FROM todos WHERE tenant_id = ? AND id = ?`
  )
    .bind(tenant, id)
    .first();
  if (!exist) return c.json({ error: 'not found' }, 404);

  const b = await c.req.json().catch(() => ({}));
  // 非 owner 仅当该项开放协作编辑（co_edit=1）才允许改内容；否则 403。
  // （"勾完成"走独立的 /family/shared/done 端点，对家庭成员开放。）
  const ow = ownerOf(c);
  if (exist.owner_openid !== ow && !(exist.shared === 1 && exist.co_edit === 1)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  await c.env.DB.prepare(
    `UPDATE todos SET title=?, meta=?, tag=?, dot=?, shared=?, family_id=?, co_edit=?, updated_at=?
     WHERE tenant_id=? AND id=?`
  )
    .bind(
      b.title ?? exist.title,
      b.meta !== undefined ? JSON.stringify(b.meta) : exist.meta,
      b.tag ?? exist.tag,
      b.dot ?? exist.dot,
      b.shared !== undefined ? (b.shared ? 1 : 0) : exist.shared,
      b.family_id ?? exist.family_id,
      // co_edit 仅 owner 可改；非 owner 即使携带也忽略，保留原值
      (b.co_edit !== undefined && exist.owner_openid === ow) ? (b.co_edit ? 1 : 0) : exist.co_edit,
      now(),
      tenant,
      id
    )
    .run();
  return c.json({ ok: true });
});

dataRoute.delete('/:tenant/todos/:id', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const id = c.req.param('id');
  const exist = await c.env.DB.prepare(
    `SELECT * FROM todos WHERE tenant_id = ? AND id = ?`
  )
    .bind(tenant, id)
    .first();
  if (!exist) return c.json({ error: 'not found' }, 404);
  if (exist.owner_openid !== ownerOf(c)) return c.json({ error: 'forbidden' }, 403);

  await c.env.DB.prepare(`DELETE FROM todos WHERE tenant_id=? AND id=?`)
    .bind(tenant, id)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// TASKS (per-item storage; supports room grouping + family sharing)
// 2026-09-03 起替代「整篇 sections 文档」模型，每个事务为独立行，可跨成员聚合。
// ---------------------------------------------------------------------------
dataRoute.post('/:tenant/tasks', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const id = b.id || crypto.randomUUID();
  const ow = ownerOf(c);
  await c.env.DB.prepare(
    `INSERT INTO tasks (id, tenant_id, owner_openid, title, meta, tag, dot, shared, family_id, co_edit, room, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, tenant, ow,
      b.title || '',
      JSON.stringify(b.meta || {}),
      b.tag || null,
      b.dot || null,
      b.shared ? 1 : 0,
      b.family_id || null,
      b.co_edit ? 1 : 0,
      b.room || null,
      now()
    )
    .run();
  return c.json({ ok: true, id, owner: ow });
});

dataRoute.get('/:tenant/tasks', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ownerQ = c.req.query('owner') || 'me';
  const ow = ownerOf(c);
  let where = 'tenant_id = ?';
  const p = [tenant];
  if (ownerQ === 'me') {
    where += ' AND owner_openid = ?';
    p.push(ow);
  } else if (ownerQ !== 'all') {
    where += ' AND owner_openid = ?';
    p.push(ownerQ);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM tasks WHERE ${where} ORDER BY updated_at DESC`
  )
    .bind(...p)
    .all();
  return c.json(results.map(parseTodo));
});

dataRoute.get('/:tenant/tasks/:id', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const row = await c.env.DB.prepare(
    `SELECT * FROM tasks WHERE tenant_id = ? AND id = ?`
  )
    .bind(tenant, c.req.param('id'))
    .first();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json(parseTodo(row));
});

dataRoute.put('/:tenant/tasks/:id', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const id = c.req.param('id');
  const exist = await c.env.DB.prepare(
    `SELECT * FROM tasks WHERE tenant_id = ? AND id = ?`
  )
    .bind(tenant, id)
    .first();
  if (!exist) return c.json({ error: 'not found' }, 404);

  const b = await c.req.json().catch(() => ({}));
  // 非 owner 仅当该项开放协作编辑（co_edit=1）才允许改内容；否则 403。
  const ow = ownerOf(c);
  if (exist.owner_openid !== ow && !(exist.shared === 1 && exist.co_edit === 1)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  await c.env.DB.prepare(
    `UPDATE tasks SET title=?, meta=?, tag=?, dot=?, shared=?, family_id=?, co_edit=?, room=?, updated_at=?
     WHERE tenant_id=? AND id=?`
  )
    .bind(
      b.title ?? exist.title,
      b.meta !== undefined ? JSON.stringify(b.meta) : exist.meta,
      b.tag ?? exist.tag,
      b.dot ?? exist.dot,
      b.shared !== undefined ? (b.shared ? 1 : 0) : exist.shared,
      b.family_id ?? exist.family_id,
      (b.co_edit !== undefined && exist.owner_openid === ow) ? (b.co_edit ? 1 : 0) : exist.co_edit,
      b.room ?? exist.room,
      now(),
      tenant,
      id
    )
    .run();
  return c.json({ ok: true });
});

dataRoute.delete('/:tenant/tasks/:id', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const id = c.req.param('id');
  const exist = await c.env.DB.prepare(
    `SELECT * FROM tasks WHERE tenant_id = ? AND id = ?`
  )
    .bind(tenant, id)
    .first();
  if (!exist) return c.json({ error: 'not found' }, 404);
  if (exist.owner_openid !== ownerOf(c)) return c.json({ error: 'forbidden' }, 403);

  await c.env.DB.prepare(`DELETE FROM tasks WHERE tenant_id=? AND id=?`)
    .bind(tenant, id)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// ARCHIVE
// ---------------------------------------------------------------------------
dataRoute.post('/:tenant/archive', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const id = b.id || crypto.randomUUID();
  const ow = ownerOf(c);

  await c.env.DB.prepare(
    `INSERT INTO archive_items (id, tenant_id, owner_openid, type, payload, shared, family_id, co_edit, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenant,
      ow,
      b.type || 'todo',
      JSON.stringify(b.payload || {}),
      b.shared ? 1 : 0,
      b.family_id || null,
      b.co_edit ? 1 : 0,
      now(),
      now()
    )
    .run();
  return c.json({ ok: true, id });
});

dataRoute.get('/:tenant/archive', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ownerQ = c.req.query('owner') || 'me';
  const ow = ownerOf(c);
  let where = 'tenant_id = ?';
  const p = [tenant];
  if (ownerQ === 'me') {
    where += ' AND owner_openid = ?';
    p.push(ow);
  } else if (ownerQ !== 'all') {
    where += ' AND owner_openid = ?';
    p.push(ownerQ);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM archive_items WHERE ${where} ORDER BY updated_at DESC`
  )
    .bind(...p)
    .all();
  return c.json(results.map(parseArchive));
});

dataRoute.put('/:tenant/archive/:id', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const id = c.req.param('id');
  const exist = await c.env.DB.prepare(
    `SELECT * FROM archive_items WHERE tenant_id = ? AND id = ?`
  )
    .bind(tenant, id)
    .first();
  if (!exist) return c.json({ error: 'not found' }, 404);

  const b = await c.req.json().catch(() => ({}));
  // 非 owner 仅当该项开放协作编辑（co_edit=1）才允许改内容；否则 403。
  const ow = ownerOf(c);
  if (exist.owner_openid !== ow && !(exist.shared === 1 && exist.co_edit === 1)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  await c.env.DB.prepare(
    `UPDATE archive_items SET type=?, payload=?, shared=?, family_id=?, co_edit=?, updated_at=?
     WHERE tenant_id=? AND id=?`
  )
    .bind(
      b.type ?? exist.type,
      b.payload !== undefined ? JSON.stringify(b.payload) : exist.payload,
      b.shared !== undefined ? (b.shared ? 1 : 0) : exist.shared,
      b.family_id ?? exist.family_id,
      (b.co_edit !== undefined && exist.owner_openid === ow) ? (b.co_edit ? 1 : 0) : exist.co_edit,
      now(),
      tenant,
      id
    )
    .run();
  return c.json({ ok: true });
});

dataRoute.delete('/:tenant/archive/:id', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const id = c.req.param('id');
  const exist = await c.env.DB.prepare(
    `SELECT * FROM archive_items WHERE tenant_id = ? AND id = ?`
  )
    .bind(tenant, id)
    .first();
  if (!exist) return c.json({ error: 'not found' }, 404);
  if (exist.owner_openid !== ownerOf(c)) return c.json({ error: 'forbidden' }, 403);

  await c.env.DB.prepare(`DELETE FROM archive_items WHERE tenant_id=? AND id=?`)
    .bind(tenant, id)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// FAMILY / SHARED  (read-only aggregated view of everything shared=1)
// ---------------------------------------------------------------------------
dataRoute.get('/:tenant/family/shared', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);

  // Optional ?family=<id> scope. Absent => legacy tenant-wide aggregation
  // (safe today because family_id is single-valued 'default'). When the
  // multi-family model lands, clients MUST pass ?family=<member's family>
  // so cross-family items are never leaked.
  const fam = c.req.query('family');
  const p = [tenant];
  let cond = 'tenant_id = ? AND shared = 1';
  if (fam) {
    cond += ' AND family_id = ?';
    p.push(fam);
  }

  const todos = await c.env.DB.prepare(
    `SELECT 'todo' AS kind, id, title, meta, tag, dot, family_id, owner_openid, co_edit, updated_at
       FROM todos WHERE ${cond} ORDER BY updated_at DESC`
  )
    .bind(...p)
    .all();

  const archive = await c.env.DB.prepare(
    `SELECT 'archive' AS kind, id, type, payload, family_id, owner_openid, co_edit, updated_at
       FROM archive_items WHERE ${cond} ORDER BY updated_at DESC`
  )
    .bind(...p)
    .all();

  const tasksQ = await c.env.DB.prepare(
    `SELECT 'task' AS kind, id, title, meta, tag, dot, family_id, owner_openid, co_edit, room, updated_at
       FROM tasks WHERE ${cond} ORDER BY updated_at DESC`
  )
    .bind(...p)
    .all();

  return c.json({
    todos: todos.results.map(parseTodo),
    tasks: tasksQ.results.map(parseTodo),
    archive: archive.results.map(parseArchive),
  });
});

// 协作编辑开关：仅所有者可切换某共享项的 co_edit（family 成员是否可改内容）。
dataRoute.post('/:tenant/family/shared/perm', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const id = b.id;
  const coEdit = b.co_edit ? 1 : 0;
  if (!id) return c.json({ error: 'id required' }, 400);

  const todo = await c.env.DB.prepare(
    `SELECT id, owner_openid FROM todos WHERE tenant_id = ? AND id = ?`
  ).bind(tenant, id).first();
  if (todo) {
    if (todo.owner_openid !== ownerOf(c)) return c.json({ error: 'forbidden' }, 403);
    await c.env.DB.prepare(
      `UPDATE todos SET co_edit = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`
    ).bind(coEdit, now(), tenant, id).run();
    return c.json({ ok: true, co_edit: coEdit });
  }
  const arc = await c.env.DB.prepare(
    `SELECT id, owner_openid FROM archive_items WHERE tenant_id = ? AND id = ?`
  ).bind(tenant, id).first();
  if (arc) {
    if (arc.owner_openid !== ownerOf(c)) return c.json({ error: 'forbidden' }, 403);
    await c.env.DB.prepare(
      `UPDATE archive_items SET co_edit = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`
    ).bind(coEdit, now(), tenant, id).run();
    return c.json({ ok: true, co_edit: coEdit });
  }
  const tsk = await c.env.DB.prepare(
    `SELECT id, owner_openid FROM tasks WHERE tenant_id = ? AND id = ?`
  ).bind(tenant, id).first();
  if (tsk) {
    if (tsk.owner_openid !== ownerOf(c)) return c.json({ error: 'forbidden' }, 403);
    await c.env.DB.prepare(
      `UPDATE tasks SET co_edit = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`
    ).bind(coEdit, now(), tenant, id).run();
    return c.json({ ok: true, co_edit: coEdit });
  }
  return c.json({ error: 'not found' }, 404);
});

// 家庭成员勾选完成：仅对「已共享」的待办开放，且要求请求者是该项所属家庭的成员。
// 与内容编辑（受 co_edit 门控）解耦——只读成员也能标记完成（家庭协作最常做的动作）。
dataRoute.post('/:tenant/family/shared/done', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const id = b.id;
  const done = b.done ? 1 : 0;
  if (!id) return c.json({ error: 'id required' }, 400);

  const rowT = await c.env.DB.prepare(
    `SELECT * FROM todos WHERE tenant_id = ? AND id = ?`
  ).bind(tenant, id).first();
  let row = rowT;
  let table = 'todos';
  if (!row) {
    const rowK = await c.env.DB.prepare(
      `SELECT * FROM tasks WHERE tenant_id = ? AND id = ?`
    ).bind(tenant, id).first();
    if (!rowK) return c.json({ error: 'not found' }, 404);
    row = rowK; table = 'tasks';
  }
  if (row.shared !== 1 || !row.family_id) return c.json({ error: 'forbidden' }, 403);
  // 校验请求者是该家庭（family_id）的成员
  const mem = await c.env.DB.prepare(
    `SELECT 1 AS ok FROM family_members WHERE family_id = ? AND openid = ?`
  ).bind(row.family_id, ownerOf(c)).first();
  if (!mem) return c.json({ error: 'forbidden' }, 403);

  // 安全处理 meta：对象型追加 done 字段；旧版字符串型 meta 不覆盖，避免丢原文。
  let isObj = false;
  let meta = {};
  try { meta = JSON.parse(row.meta || '{}'); isObj = true; } catch { meta = row.meta || ''; }
  if (isObj) {
    meta.done = done;
    await c.env.DB.prepare(
      `UPDATE ${table} SET meta = ?, updated_at = ? WHERE tenant_id = ? AND id = ?`
    ).bind(JSON.stringify(meta), now(), tenant, id).run();
  }
  return c.json({ ok: true, done });
});

// ---------------------------------------------------------------------------
// IMAGES (R2)
// ---------------------------------------------------------------------------
dataRoute.post('/:tenant/img', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);

  let key, data, contentType;
  const ct = c.req.header('content-type') || '';

  if (ct.includes('multipart/form-data')) {
    const form = await c.req.parseBody({ all: false });
    const file = form.file;
    if (!file) return c.json({ error: 'no file field' }, 400);
    data = file; // Blob/File
    contentType = file.type || 'application/octet-stream';
    const ext = (contentType.split('/')[1] || 'bin').split('+')[0];
    key = `img_${tenant}_${ow}_${crypto.randomUUID()}`.replace(/[^a-zA-Z0-9_.-]/g, '_') + '.' + ext;
  } else {
    const j = await c.req.json().catch(() => ({}));
    if (!j.data) return c.json({ error: 'data (base64) required' }, 400);
    data = Uint8Array.from(atob(j.data), (ch) => ch.charCodeAt(0));
    contentType = j.contentType || 'application/octet-stream';
    key = j.key || `img_${tenant}_${ow}_${crypto.randomUUID()}.bin`;
  }

  await c.env.BUCKET.put(key, data, {
    httpMetadata: { contentType },
    customMetadata: { tenant, owner: ow },
  });
  return c.json({ ok: true, key, url: `/t/${tenant}/img/${key}` });
});

dataRoute.get('/:tenant/img/:key', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const key = c.req.param('key');
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.json({ error: 'not found' }, 404);
  const meta = obj.customMetadata || {};
  if (meta.tenant && meta.tenant !== tenant) return c.json({ error: 'forbidden' }, 403);

  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
});

// ---------------------------------------------------------------------------
// GENERIC COLLECTIONS (Phase 1, additive — for future apps / typed modules)
//   /t/:tenant/c/:collection
//   /t/:tenant/c/:collection/:id
// Storage is keyed by (app_id, tenant_id, collection, id). The app_id is
// resolved from the tenant (resolveApp), so callers never pass it explicitly.
// Micro 家事's existing todos/tasks/archive routes above are completely
// untouched — this is a parallel, additive capability.
// ---------------------------------------------------------------------------
dataRoute.post('/:tenant/c/:collection', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const collection = c.req.param('collection');
  const aid = await resolveApp(c, tenant);
  const b = await c.req.json().catch(() => ({}));
  const id = b.id || crypto.randomUUID();
  const ow = ownerOf(c);
  await c.env.DB.prepare(
    `INSERT INTO collections (id, app_id, tenant_id, collection, owner_openid, doc, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, aid, tenant, collection, ow, JSON.stringify(b.doc || {}), now())
    .run();
  return c.json({ ok: true, id, app: aid, owner: ow });
});

dataRoute.get('/:tenant/c/:collection', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const collection = c.req.param('collection');
  const aid = await resolveApp(c, tenant);
  const ownerQ = c.req.query('owner') || 'me';
  const ow = ownerOf(c);
  let where = 'app_id = ? AND tenant_id = ? AND collection = ?';
  const p = [aid, tenant, collection];
  if (ownerQ === 'me') {
    where += ' AND owner_openid = ?';
    p.push(ow);
  } else if (ownerQ !== 'all') {
    where += ' AND owner_openid = ?';
    p.push(ownerQ);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, app_id, tenant_id, collection, owner_openid, doc, updated_at
     FROM collections WHERE ${where} ORDER BY updated_at DESC`
  )
    .bind(...p)
    .all();
  const parsed = (results || []).map((r) => {
    if (r.doc) { try { r.doc = JSON.parse(r.doc); } catch { /* keep as-is */ } }
    return r;
  });
  return c.json(parsed);
});

dataRoute.get('/:tenant/c/:collection/:id', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const collection = c.req.param('collection');
  const aid = await resolveApp(c, tenant);
  const row = await c.env.DB.prepare(
    `SELECT id, app_id, tenant_id, collection, owner_openid, doc, updated_at
     FROM collections WHERE app_id = ? AND tenant_id = ? AND collection = ? AND id = ?`
  )
    .bind(aid, tenant, collection, c.req.param('id'))
    .first();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (row.doc) { try { row.doc = JSON.parse(row.doc); } catch { /* keep as-is */ } }
  return c.json(row);
});

dataRoute.put('/:tenant/c/:collection/:id', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const collection = c.req.param('collection');
  const id = c.req.param('id');
  const aid = await resolveApp(c, tenant);
  const exist = await c.env.DB.prepare(
    `SELECT * FROM collections WHERE app_id = ? AND tenant_id = ? AND collection = ? AND id = ?`
  )
    .bind(aid, tenant, collection, id)
    .first();
  if (!exist) return c.json({ error: 'not found' }, 404);
  if (exist.owner_openid !== ownerOf(c)) return c.json({ error: 'forbidden' }, 403);
  const b = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare(
    `UPDATE collections SET doc = ?, updated_at = ?
     WHERE app_id = ? AND tenant_id = ? AND collection = ? AND id = ?`
  )
    .bind(
      b.doc !== undefined ? JSON.stringify(b.doc) : exist.doc,
      now(),
      aid, tenant, collection, id
    )
    .run();
  return c.json({ ok: true });
});

dataRoute.delete('/:tenant/c/:collection/:id', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const collection = c.req.param('collection');
  const id = c.req.param('id');
  const aid = await resolveApp(c, tenant);
  const exist = await c.env.DB.prepare(
    `SELECT * FROM collections WHERE app_id = ? AND tenant_id = ? AND collection = ? AND id = ?`
  )
    .bind(aid, tenant, collection, id)
    .first();
  if (!exist) return c.json({ error: 'not found' }, 404);
  if (exist.owner_openid !== ownerOf(c)) return c.json({ error: 'forbidden' }, 403);
  await c.env.DB.prepare(
    `DELETE FROM collections WHERE app_id = ? AND tenant_id = ? AND collection = ? AND id = ?`
  )
    .bind(aid, tenant, collection, id)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// SELF-SERVICE: 用户数据主权（个保法 / GDPR 合规入口）
//   本人数据导出（GET /me/export）+ 账号注销删除（DELETE /me）。
// 身份由网关注入的 X-User-Id 强制确定：网关 proxyToLake 用
//   headers['x-user-id'] = req.ctx.openid  覆盖客户端传入值，
// /api/data/* 段先 verifySession 才转发（无令牌直接 401）。因此客户端
// 无法伪造身份。ownerOf(c) 严格隔离：所有查询/删除均带 owner_openid = 本人，
// 跨用户 / 跨租户不可达。
// ---------------------------------------------------------------------------

// GET /t/:tenant/me/export —— 返回本人全部数据明文（供用户自助下载备份）
dataRoute.get('/:tenant/me/export', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);
  if (ow === 'anonymous') return c.json({ error: 'unauthorized' }, 401);

  const [todos, tasks, archive, collections, members, user] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM todos WHERE tenant_id = ? AND owner_openid = ? ORDER BY updated_at DESC').bind(tenant, ow).all(),
    c.env.DB.prepare('SELECT * FROM tasks WHERE tenant_id = ? AND owner_openid = ? ORDER BY updated_at DESC').bind(tenant, ow).all(),
    c.env.DB.prepare('SELECT * FROM archive_items WHERE tenant_id = ? AND owner_openid = ? ORDER BY updated_at DESC').bind(tenant, ow).all(),
    c.env.DB.prepare('SELECT * FROM collections WHERE tenant_id = ? AND owner_openid = ? ORDER BY updated_at DESC').bind(tenant, ow).all(),
    c.env.DB.prepare('SELECT family_id, role, nickname, joined_at FROM family_members WHERE openid = ?').bind(ow).all(),
    c.env.DB.prepare('SELECT id, email, status, provider, created_at FROM users WHERE tenant_id = ? AND id = ?').bind(tenant, ow).all(),
  ]);

  return c.json({
    schema: 'weijiashi-self-export/v1',
    exportedAt: new Date().toISOString(),
    owner_openid: ow,
    tenant_id: tenant,
    counts: {
      todos: (todos.results || []).length,
      tasks: (tasks.results || []).length,
      archive: (archive.results || []).length,
      collections: (collections.results || []).length,
      families: (members.results || []).length,
    },
    todos: (todos.results || []).map(parseTodo),
    tasks: (tasks.results || []).map(parseTodo),
    archive: (archive.results || []).map(parseArchive),
    collections: (collections.results || []).map((r) => {
      if (r.doc) { try { r.doc = JSON.parse(r.doc); } catch { /* keep as-is */ } }
      return r;
    }),
    families: members.results || [],
    account: (user.results && user.results[0]) ? user.results[0] : null,
  });
});

// ---- 安全注销：两阶段（申请 → 24h 宽限 → 次日二次确认/可撤销）----
// 状态落在独立表 account_deletion（静默登录无 users 行）。

// POST /t/:tenant/me/deletion-request —— 第一阶段：申请注销，写入待注销行
dataRoute.post('/:tenant/me/deletion-request', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);
  if (ow === 'anonymous') return c.json({ error: 'unauthorized' }, 401);
  // 防滥用：同一 openid 每分钟最多 5 次（申请/撤销循环）
  const rl = await rateLimit(c, `selfreq:${ow}`, { limit: 5, windowSec: 60 });
  if (rl) return rl;

  const nowMs = Date.now();
  const scheduled = nowMs + DELETION_GRACE_MS;
  await c.env.DB.prepare(
    'INSERT OR REPLACE INTO account_deletion (tenant_id, openid, requested_at) VALUES (?, ?, ?)'
  ).bind(tenant, ow, nowMs).run();
  return c.json({ ok: true, requested_at: nowMs, scheduled_at: scheduled, grace_ms: DELETION_GRACE_MS });
});

// POST /t/:tenant/me/deletion-cancel —— 撤销注销申请（宽限期内可随时取消，数据保留）
dataRoute.post('/:tenant/me/deletion-cancel', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);
  if (ow === 'anonymous') return c.json({ error: 'unauthorized' }, 401);
  await c.env.DB.prepare(
    'DELETE FROM account_deletion WHERE tenant_id = ? AND openid = ?'
  ).bind(tenant, ow).run();
  return c.json({ ok: true, cancelled: true });
});

// GET /t/:tenant/me/deletion-status —— 查询待注销状态（前端启动/进页时判断是否弹次日确认）
dataRoute.get('/:tenant/me/deletion-status', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);
  if (ow === 'anonymous') return c.json({ error: 'unauthorized' }, 401);
  const row = await c.env.DB.prepare(
    'SELECT requested_at FROM account_deletion WHERE tenant_id = ? AND openid = ?'
  ).bind(tenant, ow).first();
  if (!row || !row.requested_at) return c.json({ pending: false });
  const nowMs = Date.now();
  const scheduled = row.requested_at + DELETION_GRACE_MS;
  const due = (nowMs - row.requested_at) >= DELETION_GRACE_MS;
  return c.json({
    pending: true,
    requested_at: row.requested_at,
    scheduled_at: scheduled,
    due,
    remaining_sec: due ? 0 : Math.max(0, Math.ceil((scheduled - nowMs) / 1000)),
  });
});

// DELETE /t/:tenant/me —— 注销并删除本人全部数据（高危，须先申请且满宽限期）
dataRoute.delete('/:tenant/me', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);
  if (ow === 'anonymous') return c.json({ error: 'unauthorized' }, 401);

  // 防误触/滥用：同一 openid 每分钟最多 3 次
  const rl = await rateLimit(c, `selfdel:${ow}`, { limit: 3, windowSec: 60 });
  if (rl) return rl;

  // 安全注销闸门：必须先经「申请」且距申请 ≥ 24h 才允许硬删。
  // 否则返回 409 + 剩余时间，杜绝误触或客户端直调导致的即时删除。
  const pending = await c.env.DB.prepare(
    'SELECT requested_at FROM account_deletion WHERE tenant_id = ? AND openid = ?'
  ).bind(tenant, ow).first();
  const nowMs = Date.now();
  if (!pending || !pending.requested_at || (nowMs - pending.requested_at) < DELETION_GRACE_MS) {
    const scheduled = pending && pending.requested_at ? pending.requested_at + DELETION_GRACE_MS : null;
    const remainingSec = scheduled ? Math.max(0, Math.ceil((scheduled - nowMs) / 1000)) : null;
    return c.json({ error: 'deletion not due', scheduled_at: scheduled, remaining_sec: remainingSec }, 409);
  }
  // 闸门通过：先撤掉待注销行，避免重复执行
  await c.env.DB.prepare(
    'DELETE FROM account_deletion WHERE tenant_id = ? AND openid = ?'
  ).bind(tenant, ow).run();

  const detail = { tenant, steps: [] };

  // 1) 收集本人图片 key（R2，前缀 img_{tenant}_{ow}_），用于后续清理
  let imgKeys = [];
  try {
    const listed = await c.env.BUCKET.list({ prefix: `img_${tenant}_${ow}_` });
    imgKeys = (listed.objects || []).map((o) => o.key);
    detail.imgCount = imgKeys.length;
  } catch (e) { detail.imgListError = String(e); }

  // 2) 退出/清理所有家庭关联（不丢他人数据）
  try {
    const owned = await c.env.DB.prepare(
      'SELECT family_id FROM families WHERE tenant_id = ? AND owner_openid = ?'
    ).bind(tenant, ow).all();
    for (const fam of (owned.results || [])) {
      const fid = fam.family_id;
      const others = await c.env.DB.prepare(
        'SELECT openid FROM family_members WHERE family_id = ? AND openid <> ? ORDER BY joined_at ASC LIMIT 1'
      ).bind(fid, ow).all();
      if (others.results && others.results.length) {
        // 转让给最早加入的其他成员，本人降级为普通成员后退出
        const next = others.results[0].openid;
        await c.env.DB.prepare("UPDATE family_members SET role = 'owner' WHERE family_id = ? AND openid = ?").bind(fid, next).run();
        await c.env.DB.prepare('UPDATE families SET owner_openid = ? WHERE family_id = ?').bind(next, fid).run();
        await c.env.DB.prepare('DELETE FROM family_members WHERE family_id = ? AND openid = ?').bind(fid, ow).run();
      } else {
        // 无其他成员：删除整个家庭（含邀请与成员）
        await c.env.DB.prepare('DELETE FROM family_invites WHERE family_id = ?').bind(fid).run();
        await c.env.DB.prepare('DELETE FROM family_members WHERE family_id = ?').bind(fid).run();
        await c.env.DB.prepare('DELETE FROM families WHERE family_id = ?').bind(fid).run();
      }
    }
    // 兜底清掉本人剩余的普通成员记录（非 owner 家庭）
    await c.env.DB.prepare('DELETE FROM family_members WHERE openid = ?').bind(ow).run();
    detail.familyCleaned = true;
  } catch (e) { detail.familyError = String(e); }

  // 3) 删除本人全部业务数据行（严格 owner_openid 隔离）
  try {
    await c.env.DB.prepare('DELETE FROM todos WHERE tenant_id = ? AND owner_openid = ?').bind(tenant, ow).run();
    await c.env.DB.prepare('DELETE FROM tasks WHERE tenant_id = ? AND owner_openid = ?').bind(tenant, ow).run();
    await c.env.DB.prepare('DELETE FROM archive_items WHERE tenant_id = ? AND owner_openid = ?').bind(tenant, ow).run();
    await c.env.DB.prepare('DELETE FROM collections WHERE tenant_id = ? AND owner_openid = ?').bind(tenant, ow).run();
    detail.dataDeleted = true;
  } catch (e) { detail.dataError = String(e); }

  // 4) 账号记录（若存在，账号登录体系）：标记删除；微家事静默登录无记录则 no-op
  try {
    await c.env.DB.prepare("UPDATE users SET status = 'deleted' WHERE tenant_id = ? AND id = ? AND status = 'active'").bind(tenant, ow).run();
  } catch (e) { detail.userError = String(e); }

  // 5) 清理 R2 本人图片
  let imgDeleted = 0;
  for (const k of imgKeys) {
    try { await c.env.BUCKET.delete(k); imgDeleted++; } catch (e) { /* best-effort */ }
  }
  detail.imgDeleted = imgDeleted;

  // 6) 审计（best-effort，列签名与 admin.audit 一致）
  try {
    await c.env.DB.prepare(
      'INSERT INTO admin_audit_log (id, app_id, tenant_id, admin_id, action, target, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      crypto.randomUUID(),
      null,
      tenant,
      ow,
      'self.delete',
      'self',
      JSON.stringify(detail),
      null,
      now()
    ).run();
  } catch (e) { /* best-effort */ }

  return c.json({ ok: true, deleted: { imgKeys: imgDeleted } });
});

export { dataRoute };
