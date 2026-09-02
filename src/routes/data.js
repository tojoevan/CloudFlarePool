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

export { dataRoute };
