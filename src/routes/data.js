import { Hono } from 'hono';

// Multi-tenant data API. Mounted at `/t` so paths look like:
//   /t/:tenant/todos
//   /t/:tenant/tasks
//   /t/:tenant/archive[/:id]
//   /t/:tenant/family/shared
//   /t/:tenant/img[/:key]
//
// Auth model:
//   - X-Sync-Key must be valid (global guard) — the data lake trusts the
//     gateway (home.inkspcl.com) which performs WeChat login upstream.
//   - X-User-Id header carries the verified end-user identity (openid) and
//     is used for per-user ownership isolation within a tenant.
//   - Rows are always scoped by tenant_id; cross-tenant access is impossible.

const dataRoute = new Hono();

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
  const ow = b.owner_openid || ownerOf(c);

  await c.env.DB.prepare(
    `INSERT INTO todos (id, tenant_id, owner_openid, title, meta, tag, dot, shared, family_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
  if (exist.owner_openid !== ownerOf(c)) return c.json({ error: 'forbidden' }, 403);

  const b = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare(
    `UPDATE todos SET title=?, meta=?, tag=?, dot=?, shared=?, family_id=?, updated_at=?
     WHERE tenant_id=? AND id=?`
  )
    .bind(
      b.title ?? exist.title,
      b.meta !== undefined ? JSON.stringify(b.meta) : exist.meta,
      b.tag ?? exist.tag,
      b.dot ?? exist.dot,
      b.shared !== undefined ? (b.shared ? 1 : 0) : exist.shared,
      b.family_id ?? exist.family_id,
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
// TASKS DOC (single JSON document per user)
// ---------------------------------------------------------------------------
dataRoute.get('/:tenant/tasks', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const row = await c.env.DB.prepare(
    `SELECT sections FROM tasks_doc WHERE tenant_id = ? AND owner_openid = ?`
  )
    .bind(tenant, ownerOf(c))
    .first();
  return c.json({ sections: row ? JSON.parse(row.sections) : [] });
});

dataRoute.put('/:tenant/tasks', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const b = await c.req.json().catch(() => ({}));
  const sections = JSON.stringify(b.sections || []);
  await c.env.DB.prepare(
    `INSERT INTO tasks_doc (tenant_id, owner_openid, sections, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(tenant_id, owner_openid) DO UPDATE SET sections=excluded.sections, updated_at=excluded.updated_at`
  )
    .bind(tenant, ownerOf(c), sections, now())
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
  const ow = b.owner_openid || ownerOf(c);

  await c.env.DB.prepare(
    `INSERT INTO archive_items (id, tenant_id, owner_openid, type, payload, shared, family_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tenant,
      ow,
      b.type || 'todo',
      JSON.stringify(b.payload || {}),
      b.shared ? 1 : 0,
      b.family_id || null,
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
  if (exist.owner_openid !== ownerOf(c)) return c.json({ error: 'forbidden' }, 403);

  const b = await c.req.json().catch(() => ({}));
  await c.env.DB.prepare(
    `UPDATE archive_items SET type=?, payload=?, shared=?, family_id=?, updated_at=?
     WHERE tenant_id=? AND id=?`
  )
    .bind(
      b.type ?? exist.type,
      b.payload !== undefined ? JSON.stringify(b.payload) : exist.payload,
      b.shared !== undefined ? (b.shared ? 1 : 0) : exist.shared,
      b.family_id ?? exist.family_id,
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

  const todos = await c.env.DB.prepare(
    `SELECT 'todo' AS kind, id, title, meta, tag, dot, family_id, updated_at
       FROM todos WHERE tenant_id = ? AND shared = 1 ORDER BY updated_at DESC`
  )
    .bind(tenant)
    .all();

  const archive = await c.env.DB.prepare(
    `SELECT 'archive' AS kind, id, type, payload, family_id, updated_at
       FROM archive_items WHERE tenant_id = ? AND shared = 1 ORDER BY updated_at DESC`
  )
    .bind(tenant)
    .all();

  return c.json({
    todos: todos.results.map(parseTodo),
    archive: archive.results.map(parseArchive),
  });
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

export { dataRoute };
