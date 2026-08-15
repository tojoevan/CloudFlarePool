import { Hono } from 'hono';

// T3 service keys (MCP / Skill / server-to-server).
//
// Endpoints (all under /v1/a/:app, already covered by the global dual-mode
// guard in index.js, so only the trusted gateway / operator — X-Sync-Key — or
// a valid admin JWT may call them):
//   POST /v1/a/:app/keys              issue a new key (raw_secret shown ONCE)
//   GET  /v1/a/:app/keys              list keys (never returns raw_secret)
//   POST /v1/a/:app/keys/:id/rotate   rotate: new secret, old kept 7d grace
//   POST /v1/a/:app/keys/:id/revoke   revoke
//
// Service tokens are symmetric HMAC-SHA256 (see auth.js verifyServiceToken).
// `secret_hash` stores SHA-256(raw_secret), used directly as the verify key.
const keysRoute = new Hono();

function bytesToB64url(u8) {
  let bin = '';
  for (const b of u8) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesToHex(buf) {
  const u8 = new Uint8Array(buf);
  return [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
}

keysRoute.post('/:app/keys', async (c) => {
  const appId = c.req.param('app');
  const b = await c.req.json().catch(() => ({}));
  const scope = Array.isArray(b.scope) && b.scope.length ? b.scope : ['data:read', 'data:write'];
  const tenantBound = !!b.tenant_bound;
  const tenantId = b.tenant_id ?? null;
  if (tenantBound && !tenantId) {
    return c.json({ error: 'tenant_bound keys require tenant_id' }, 400);
  }

  const id = 'svc_' + bytesToB64url(crypto.getRandomValues(new Uint8Array(9))).replace(/[^a-zA-Z0-9]/g, '');
  const rawSecret = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  const secretHash = bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawSecret)));
  const kid = `${id}.v1`;

  await c.env.DB.prepare(
    `INSERT INTO api_keys (id, app_id, tenant_id, secret_hash, scope, tenant_bound, status, current_kid, prev_kid, prev_secret, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, ?)`
  )
    .bind(id, appId, tenantId, secretHash, JSON.stringify(scope), tenantBound ? 1 : 0, kid, Date.now())
    .run();

  // raw_secret is returned exactly once; the lake never stores it in recoverable form.
  return c.json({ id, raw_secret: rawSecret, kid, scope, tenant_bound: tenantBound, tenant_id: tenantId });
});

keysRoute.get('/:app/keys', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, app_id, tenant_id, scope, tenant_bound, status, current_kid, created_at
     FROM api_keys WHERE app_id = ? ORDER BY created_at DESC`
  )
    .bind(c.req.param('app'))
    .all();
  return c.json(
    (rows.results || []).map((r) => ({
      id: r.id,
      app_id: r.app_id,
      tenant_id: r.tenant_id,
      scope: JSON.parse(r.scope || '[]'),
      tenant_bound: !!r.tenant_bound,
      status: r.status,
      current_kid: r.current_kid,
      created_at: r.created_at,
    }))
  );
});

keysRoute.post('/:app/keys/:id/rotate', async (c) => {
  const appId = c.req.param('app');
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT id, app_id, current_kid, secret_hash FROM api_keys WHERE id = ? AND app_id = ?')
    .bind(id, appId)
    .first();
  if (!row) return c.json({ error: 'key not found' }, 404);

  const prevKid = row.current_kid;
  const prevSecret = row.secret_hash;
  const ver = parseInt(prevKid.split('.v')[1] || '1', 10) + 1;
  const rawSecret = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
  const secretHash = bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawSecret)));
  const newKid = `${id}.v${ver}`;

  await c.env.DB.prepare(
    `UPDATE api_keys SET prev_kid = ?, prev_secret = ?, secret_hash = ?, current_kid = ?, created_at = ? WHERE id = ? AND app_id = ?`
  )
    .bind(prevKid, prevSecret, secretHash, newKid, Date.now(), id, appId)
    .run();

  // Old kid stays valid for the rotation grace period (verified via prev_kid).
  return c.json({ id, raw_secret: rawSecret, kid: newKid, previous_kid: prevKid });
});

keysRoute.post('/:app/keys/:id/revoke', async (c) => {
  const appId = c.req.param('app');
  const id = c.req.param('id');
  const res = await c.env.DB.prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND app_id = ?")
    .bind(Date.now(), id, appId)
    .run();
  if (!res.success) return c.json({ error: 'revoke failed' }, 500);
  return c.json({ ok: true, id, status: 'revoked' });
});

export { keysRoute };
