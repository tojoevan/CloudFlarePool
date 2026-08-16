// Local verification of the data lake using Miniflare (real D1 + R2 bindings).
// Run:  npm test   (node --test test/)
import { Miniflare } from 'miniflare';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { signJwt, signServiceToken, signT4 } from '../gateway/lib/jwt.js';
import { hashPassword } from '../src/lib/password.js';

const KEY = 'test-internal-key';
const BASE = 'https://data.kapibala.icu';

// B1 test keys: gateway-signed JWT verified by the lake with the public key.
const KP = generateKeyPairSync('ed25519');
const PRIV_PEM = KP.privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUB_RAW_B64 = KP.publicKey.export({ format: 'jwk' }).x; // base64url raw 32 bytes

const mf = new Miniflare({
  modules: true,
  scriptPath: path.resolve('dist/test-bundle.mjs'),
  d1Databases: {
    DB: 'cloudflarepool',
  },
  r2Buckets: {
    BUCKET: 'cloudflarepool',
  },
  bindings: { INTERNAL_KEY: KEY, ALLOW_SETUP: '1', JWT_PUBLIC_KEYS: JSON.stringify({ gw1: PUB_RAW_B64 }) },
});

function req(method, p, { body, headers = {}, raw = false } = {}) {
  return mf.dispatchFetch(BASE + p, {
    method,
    headers: { 'X-Sync-Key': KEY, ...headers },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
}
async function jres(r) {
  const t = await r.text();
  let body;
  try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body };
}

test.before(async () => {
  const r = await jres(await req('POST', '/__setup'));
  assert.equal(r.status, 200, 'schema setup should succeed');
});

test('public endpoints need no key', async () => {
  const r = await jres(await mf.dispatchFetch(BASE + '/health', { method: 'GET' }));
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'ok');
});

test('guard: missing X-Sync-Key -> 403', async () => {
  const r = await mf.dispatchFetch(BASE + '/t/jiashiben/todos', { method: 'GET' });
  assert.equal(r.status, 403);
});

test('tenant + todo CRUD with per-user isolation', async () => {
  let r = await jres(await req('POST', '/tenants', { body: { tenant_id: 'jiashiben', appid: 'wx_x', name: '微家事' } }));
  assert.equal(r.status, 200);

  r = await jres(await req('POST', '/t/jiashiben/todos', { headers: { 'X-User-Id': 'u1' }, body: { id: 't1', title: '买菜', tag: 'shop', shared: true, family_id: 'fam1' } }));
  assert.equal(r.status, 200);

  r = await jres(await req('GET', '/t/jiashiben/todos?owner=me', { headers: { 'X-User-Id': 'u1' } }));
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].title, '买菜');

  r = await jres(await req('PUT', '/t/jiashiben/todos/t1', { headers: { 'X-User-Id': 'u1' }, body: { title: '买水果' } }));
  assert.equal(r.status, 200);

  r = await jres(await req('GET', '/t/jiashiben/todos/t1', { headers: { 'X-User-Id': 'u1' } }));
  assert.equal(r.body.title, '买水果');

  // Another user cannot delete u1's todo.
  r = await jres(await req('DELETE', '/t/jiashiben/todos/t1', { headers: { 'X-User-Id': 'u2' } }));
  assert.equal(r.status, 403);

  // owner can delete.
  r = await jres(await req('DELETE', '/t/jiashiben/todos/t1', { headers: { 'X-User-Id': 'u1' } }));
  assert.equal(r.status, 200);
});

test('archive + family/shared aggregation', async () => {
  await jres(await req('POST', '/t/jiashiben/archive', { headers: { 'X-User-Id': 'u1' }, body: { id: 'a1', type: 'todo', payload: { title: '旧任务' }, shared: true, family_id: 'fam1' } }));
  const r = await jres(await req('GET', '/t/jiashiben/family/shared'));
  assert.equal(r.status, 200);
  assert.equal(r.body.archive.length, 1);
  assert.equal(r.body.archive[0].payload.title, '旧任务');
});

test('tasks document per user', async () => {
  let r = await jres(await req('PUT', '/t/jiashiben/tasks', { headers: { 'X-User-Id': 'u1' }, body: { sections: [{ name: '工作', items: [] }] } }));
  assert.equal(r.status, 200);
  r = await jres(await req('GET', '/t/jiashiben/tasks', { headers: { 'X-User-Id': 'u1' } }));
  assert.equal(r.body.sections.length, 1);
});

test('image upload + fetch (R2)', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const r = await jres(await req('POST', '/t/jiashiben/img', { headers: { 'X-User-Id': 'u1', 'content-type': 'application/json' }, body: { data: png, contentType: 'image/png' } }));
  assert.equal(r.status, 200);
  const key = r.body.key;

  const g = await mf.dispatchFetch(BASE + '/t/jiashiben/img/' + key, { method: 'GET', headers: { 'X-Sync-Key': KEY } });
  assert.equal(g.status, 200);
  assert.equal(g.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await g.arrayBuffer());
  assert.ok(buf.length > 0);
});

test('unknown tenant -> 404', async () => {
  const r = await jres(await req('GET', '/t/nope/todos', { headers: { 'X-User-Id': 'u1' } }));
  assert.equal(r.status, 404);
});

// ===== B1: dual-mode auth (Bearer JWT channel) =====
test('B1: gateway-signed JWT reaches data lake; owner derived from JWT sub', async () => {
  await jres(await req('POST', '/tenants', { body: { tenant_id: 'jiashiben', appid: 'wx_x', name: '微家事' } }));
  const jwt = signJwt(
    {
      sub: 'u_jwt',
      aid: 'jiashiben',
      tid: 'jiashiben',
      typ: 'wx',
      scp: ['user:read', 'user:write'],
      iss: 'gateway',
      aud: 'data.kapibala.icu',
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    PRIV_PEM
  );

  // POST via Bearer (no X-Sync-Key). Body has no owner_openid, so route
  // falls back to the injected x-user-id (= JWT sub).
  const r = await jres(
    await mf.dispatchFetch(BASE + '/t/jiashiben/todos', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + jwt, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'jt1', title: 'JWT 任务' }),
    })
  );
  assert.equal(r.status, 200);

  const got = await jres(
    await mf.dispatchFetch(BASE + '/t/jiashiben/todos/jt1', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + jwt },
    })
  );
  assert.equal(got.status, 200);
  assert.equal(got.body.title, 'JWT 任务');
  assert.equal(got.body.owner_openid, 'u_jwt', 'owner must come from JWT sub, not any injected header');

  await jres(await req('DELETE', '/t/jiashiben/todos/jt1', { headers: { 'X-User-Id': 'u_jwt' } }));
});

test('B1: unknown-kid / tampered JWT -> 401', async () => {
  const jwt = signJwt(
    { sub: 'x', tid: 'jiashiben', iss: 'gateway', aud: 'data.kapibala.icu', exp: Math.floor(Date.now() / 1000) + 3600 },
    PRIV_PEM,
    { kid: 'unknown-kid' }
  );
  const r = await mf.dispatchFetch(BASE + '/t/jiashiben/todos', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + jwt },
  });
  assert.equal(r.status, 401);
});

test('B1: JWT with wrong tenant -> 403', async () => {
  const jwt = signJwt(
    { sub: 'x', tid: 'other-tenant', iss: 'gateway', aud: 'data.kapibala.icu', exp: Math.floor(Date.now() / 1000) + 3600 },
    PRIV_PEM
  );
  const r = await mf.dispatchFetch(BASE + '/t/jiashiben/todos', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + jwt },
  });
  assert.equal(r.status, 403);
});

// ===== Phase 1: app dimension (app_id + tenant_id) =====
test('Phase1: app registry + app-scoped tenant CRUD', async () => {
  let r = await jres(await req('POST', '/v1/a', { body: { app_id: 'demo', name: 'Demo App', owner: 'jiashiben' } }));
  assert.equal(r.status, 200, 'create app');

  r = await jres(await req('GET', '/v1/a/demo'));
  assert.equal(r.status, 200);
  assert.equal(r.body.app_id, 'demo');
  assert.equal(r.body.status, 'active');

  // create a tenant bound to the app
  r = await jres(await req('POST', '/v1/a/demo/tenants', { body: { tenant_id: 'demo-tenant-1', name: 'Demo Tenant' } }));
  assert.equal(r.status, 200);
  assert.equal(r.body.app_id, 'demo');

  // list tenants of the app
  r = await jres(await req('GET', '/v1/a/demo/tenants'));
  assert.equal(r.status, 200);
  assert.ok(r.body.some((t) => t.tenant_id === 'demo-tenant-1'), 'tenant should be listed under its app');
});

test('Phase1: JWT with wrong app (aid mismatch) -> 403', async () => {
  // Ensure jiashiben resolves to app jiashiben deterministically.
  await jres(await req('POST', '/tenants', { body: { tenant_id: 'jiashiben', app_id: 'jiashiben', name: '微家事' } }));
  const jwt = signJwt(
    { sub: 'x', aid: 'other-app', tid: 'jiashiben', iss: 'gateway', aud: 'data.kapibala.icu', exp: Math.floor(Date.now() / 1000) + 3600 },
    PRIV_PEM
  );
  const r = await mf.dispatchFetch(BASE + '/t/jiashiben/todos', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + jwt },
  });
  assert.equal(r.status, 403, 'app dimension mismatch must be rejected');
});

test('Phase1: legacy JWT without aid still passes (no regression)', async () => {
  // A token emitted before Phase 1 carries no `aid`; it must NOT be rejected
  // on the existing mini-program path.
  await jres(await req('POST', '/tenants', { body: { tenant_id: 'jiashiben', app_id: 'jiashiben', name: '微家事' } }));
  const jwt = signJwt(
    { sub: 'u_legacy', tid: 'jiashiben', iss: 'gateway', aud: 'data.kapibala.icu', exp: Math.floor(Date.now() / 1000) + 3600 },
    PRIV_PEM
  );
  const r = await jres(
    await mf.dispatchFetch(BASE + '/t/jiashiben/todos', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + jwt, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'legacy1', title: 'legacy task' }),
    })
  );
  assert.equal(r.status, 200, 'legacy token (no aid) must still reach the lake');
  await jres(await req('DELETE', '/t/jiashiben/todos/legacy1', { headers: { 'X-User-Id': 'u_legacy' } }));
});

test('Phase1: generic collection CRUD + owner isolation', async () => {
  await jres(await req('POST', '/tenants', { body: { tenant_id: 'jiashiben', app_id: 'jiashiben', name: '微家事' } }));

  // register a collection schema for the app
  let r = await jres(await req('POST', '/v1/a/jiashiben/collections', { body: { collection: 'notes', schema_json: { fields: { text: 'string' } } } }));
  assert.equal(r.status, 200);
  r = await jres(await req('GET', '/v1/a/jiashiben/collections'));
  assert.equal(r.status, 200);
  assert.ok(r.body.some((c) => c.collection === 'notes'), 'collection schema should be registered');

  // generic CRUD under /t/:tenant/c/:collection
  r = await jres(await req('POST', '/t/jiashiben/c/notes', { headers: { 'X-User-Id': 'u1' }, body: { id: 'n1', doc: { text: 'hello' } } }));
  assert.equal(r.status, 200);
  assert.equal(r.body.app, 'jiashiben', 'app_id must be resolved from the tenant');

  r = await jres(await req('GET', '/t/jiashiben/c/notes?owner=me', { headers: { 'X-User-Id': 'u1' } }));
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].doc.text, 'hello');

  r = await jres(await req('PUT', '/t/jiashiben/c/notes/n1', { headers: { 'X-User-Id': 'u1' }, body: { doc: { text: 'world' } } }));
  assert.equal(r.status, 200);

  r = await jres(await req('GET', '/t/jiashiben/c/notes/n1', { headers: { 'X-User-Id': 'u1' } }));
  assert.equal(r.body.doc.text, 'world');

  // owner isolation
  r = await jres(await req('DELETE', '/t/jiashiben/c/notes/n1', { headers: { 'X-User-Id': 'u2' } }));
  assert.equal(r.status, 403);
  r = await jres(await req('DELETE', '/t/jiashiben/c/notes/n1', { headers: { 'X-User-Id': 'u1' } }));
  assert.equal(r.status, 200);
});

// ===== Phase 2 (B2): T3 service keys (symmetric HMAC) =====
test('B2: issue api_key, sign service token, reach data lake via HMAC', async () => {
  const issued = await jres(await req('POST', '/v1/a/jiashiben/keys', { body: { scope: ['data:read', 'data:write'] } }));
  assert.equal(issued.status, 200);
  assert.ok(issued.body.raw_secret, 'raw_secret must be returned once');
  assert.ok(issued.body.kid, 'kid returned');

  const svc = signServiceToken({
    serviceId: issued.body.id,
    rawSecret: issued.body.raw_secret,
    appId: 'jiashiben',
    scope: ['data:read', 'data:write'],
  });

  // service token reaches the lake through the dualGuard service branch.
  const r = await jres(
    await mf.dispatchFetch(BASE + '/t/jiashiben/todos', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + svc, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'svc1', title: 'service task' }),
    })
  );
  assert.equal(r.status, 200, 'service token must reach the lake');
  await jres(await req('DELETE', '/t/jiashiben/todos/svc1', { headers: { 'X-User-Id': issued.body.id } }));
});

test('B2: tenant_bound key rejects wrong tenant, allows its own', async () => {
  const issued = await jres(
    await req('POST', '/v1/a/jiashiben/keys', { body: { tenant_bound: true, tenant_id: 'jiashiben', scope: ['data:read'] } })
  );
  assert.equal(issued.status, 200);
  const svc = signServiceToken({
    serviceId: issued.body.id,
    rawSecret: issued.body.raw_secret,
    appId: 'jiashiben',
    tenantId: 'jiashiben',
    scope: ['data:read'],
  });

  const bad = await mf.dispatchFetch(BASE + '/t/other-tenant/todos', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + svc },
  });
  assert.equal(bad.status, 403, 'tenant_bound key must reject other tenants');

  const ok = await mf.dispatchFetch(BASE + '/t/jiashiben/todos', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + svc },
  });
  assert.equal(ok.status, 200, 'tenant_bound key must allow its own tenant');
});

test('B2: revoked key is rejected', async () => {
  const issued = await jres(await req('POST', '/v1/a/jiashiben/keys', { body: { scope: ['data:read'] } }));
  const svc = signServiceToken({
    serviceId: issued.body.id,
    rawSecret: issued.body.raw_secret,
    appId: 'jiashiben',
    scope: ['data:read'],
  });

  const rev = await jres(await req('POST', `/v1/a/jiashiben/keys/${issued.body.id}/revoke`));
  assert.equal(rev.status, 200);

  const r = await mf.dispatchFetch(BASE + '/t/jiashiben/todos', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + svc },
  });
  assert.equal(r.status, 401, 'revoked key must be rejected');
});

test('B2: rotation keeps old kid valid during grace period', async () => {
  const issued = await jres(await req('POST', '/v1/a/jiashiben/keys', { body: { scope: ['data:read'] } }));
  const oldKid = issued.body.kid;
  const oldToken = signServiceToken({
    serviceId: issued.body.id,
    rawSecret: issued.body.raw_secret,
    appId: 'jiashiben',
    scope: ['data:read'],
    kid: oldKid,
  });

  const rot = await jres(await req('POST', `/v1/a/jiashiben/keys/${issued.body.id}/rotate`));
  assert.equal(rot.status, 200);
  assert.notEqual(rot.body.kid, oldKid, 'new kid after rotation');

  // old kid still valid (grace period)
  const oldR = await mf.dispatchFetch(BASE + '/t/jiashiben/todos', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + oldToken },
  });
  assert.equal(oldR.status, 200, 'old kid valid during grace period');
});

// ===== Scope enforcement (T3) — closes the design §8 technical debt =====
// A service key's scope (data:read / data:write / data:*) must be enforced by
// the lake, not just declared in the MCP tool layer.
test('Scope: read-only service key can read but NOT write (403)', async () => {
  await jres(await req('POST', '/tenants', { body: { tenant_id: 'weijiashi', app_id: 'jiashiben', name: '微家事' } }));
  const issued = await jres(await req('POST', '/v1/a/jiashiben/keys', { body: { scope: ['data:read'] } }));
  assert.equal(issued.status, 200);
  const svc = signServiceToken({
    serviceId: issued.body.id,
    rawSecret: issued.body.raw_secret,
    appId: 'jiashiben',
    scope: ['data:read'],
  });

  const read = await mf.dispatchFetch(BASE + '/t/weijiashi/todos', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + svc },
  });
  assert.equal(read.status, 200, 'data:read key must be allowed to read');

  const write = await mf.dispatchFetch(BASE + '/t/weijiashi/todos', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + svc, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'must-fail' }),
  });
  assert.equal(write.status, 403, 'data:read key must be forbidden from writing');
});

test('Scope: write-only service key can write but NOT read (least privilege)', async () => {
  const issued = await jres(await req('POST', '/v1/a/jiashiben/keys', { body: { scope: ['data:write'] } }));
  assert.equal(issued.status, 200);
  const svc = signServiceToken({
    serviceId: issued.body.id,
    rawSecret: issued.body.raw_secret,
    appId: 'jiashiben',
    scope: ['data:write'],
  });

  const write = await mf.dispatchFetch(BASE + '/t/weijiashi/todos', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + svc, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'scope_w1', title: 'scope write' }),
  });
  assert.equal(write.status, 200, 'data:write key must be allowed to write');
  await jres(await req('DELETE', '/t/weijiashi/todos/scope_w1', { headers: { 'X-User-Id': issued.body.id } }));

  const read = await mf.dispatchFetch(BASE + '/t/weijiashi/todos', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + svc },
  });
  assert.equal(read.status, 403, 'data:write key must be forbidden from reading (strict)');
});

test('Scope: data:* wildcard grants both read and write', async () => {
  const issued = await jres(await req('POST', '/v1/a/jiashiben/keys', { body: { scope: ['data:*'] } }));
  assert.equal(issued.status, 200);
  const svc = signServiceToken({
    serviceId: issued.body.id,
    rawSecret: issued.body.raw_secret,
    appId: 'jiashiben',
    scope: ['data:*'],
  });

  const write = await mf.dispatchFetch(BASE + '/t/weijiashi/todos', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + svc, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'scope_w2', title: 'wild' }),
  });
  assert.equal(write.status, 200, 'data:* must be allowed to write');
  await jres(await req('DELETE', '/t/weijiashi/todos/scope_w2', { headers: { 'X-User-Id': issued.body.id } }));

  const read = await mf.dispatchFetch(BASE + '/t/weijiashi/todos', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + svc },
  });
  assert.equal(read.status, 200, 'data:* must be allowed to read');
});

test('Scope: service token cannot manage platform resources (mint keys)', async () => {
  const issued = await jres(await req('POST', '/v1/a/jiashiben/keys', { body: { scope: ['data:read'] } }));
  const svc = signServiceToken({
    serviceId: issued.body.id,
    rawSecret: issued.body.raw_secret,
    appId: 'jiashiben',
    scope: ['data:read'],
  });
  const r = await mf.dispatchFetch(BASE + '/v1/a/jiashiben/keys', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + svc, 'content-type': 'application/json' },
    body: JSON.stringify({ scope: ['data:read'] }),
  });
  assert.equal(r.status, 403, 'service token must not be able to mint new keys');
});

test('B2: /internal/account/verify rejects unknown user', async () => {
  const r = await jres(await req('POST', '/internal/account/verify', { body: { email: 'nobody@example.com', password: 'x' } }));
  assert.equal(r.status, 401, 'unknown user must be rejected');
});

// ===== Phase 3 (B3): T4 admin read-only dashboard =====
test('Phase3: T4 admin reads /admin/stats for own tenant', async () => {
  await jres(await req('POST', '/tenants', { body: { tenant_id: 'weijiashi', app_id: 'jiashiben', name: '微家事' } }));
  await jres(await req('POST', '/t/weijiashi/todos', { headers: { 'X-User-Id': 'u1' }, body: { id: 'pa1', title: 'admin-visible' } }));

  const t4 = signT4({ sub: 'adm1', role: 'tenant', appId: 'jiashiben', tenantId: 'weijiashi', privateKeyPem: PRIV_PEM });
  const r = await jres(
    await mf.dispatchFetch(BASE + '/admin/stats', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + t4 },
    })
  );
  assert.equal(r.status, 200, 'T4 must reach /admin/stats');
  assert.equal(r.body.scope, 'tenant');
  assert.equal(r.body.counts.todos, 1, 'stats must reflect seeded todo');
  assert.equal(r.body.tenant.tenant_id, 'weijiashi');

  await jres(await req('DELETE', '/t/weijiashi/todos/pa1', { headers: { 'X-User-Id': 'u1' } }));
});

test('Phase3: T2 token cannot reach /admin (403)', async () => {
  const t2 = signJwt(
    { sub: 'u2', aid: 'jiashiben', tid: 'weijiashi', typ: 'account', iss: 'gateway', aud: 'data.kapibala.icu', exp: Math.floor(Date.now() / 1000) + 3600 },
    PRIV_PEM
  );
  const r = await mf.dispatchFetch(BASE + '/admin/stats', {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + t2 },
  });
  assert.equal(r.status, 403, 'non-admin token must be rejected from /admin');
});

// ===== Phase 3 (B3): T4 admin — Account & Key Center =====
test('Phase3: T4 lists users of own tenant + disable/enable', async () => {
  await jres(await req('POST', '/tenants', { body: { tenant_id: 'weijiashi', app_id: 'jiashiben', name: '微家事' } }));
  const db = await mf.getD1Database('DB');
  await db
    .prepare('INSERT INTO users (id, tenant_id, email, status, provider, created_at) VALUES (?,?,?,?,?,?)')
    .bind('u_adm_1', 'weijiashi', 'member@weijiashi.app', 'active', 'native', Date.now())
    .run();

  const t4 = signT4({ sub: 'adm1', role: 'tenant', appId: 'jiashiben', tenantId: 'weijiashi', privateKeyPem: PRIV_PEM });

  let r = await jres(await mf.dispatchFetch(BASE + '/admin/users', { method: 'GET', headers: { Authorization: 'Bearer ' + t4 } }));
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.some((u) => u.email === 'member@weijiashi.app'), 'seeded user must appear');

  r = await jres(
    await mf.dispatchFetch(BASE + '/admin/users/u_adm_1/status', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t4, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    })
  );
  assert.equal(r.status, 200);
  let row = await db.prepare('SELECT status FROM users WHERE id=?').bind('u_adm_1').first();
  assert.equal(row.status, 'disabled', 'user must be disabled');

  r = await jres(
    await mf.dispatchFetch(BASE + '/admin/users/u_adm_1/status', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t4, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
  );
  assert.equal(r.status, 200);

  await db.prepare('DELETE FROM users WHERE id=?').bind('u_adm_1').run();
});

test('Phase3: T4 lists + issues + revokes service keys', async () => {
  await jres(await req('POST', '/tenants', { body: { tenant_id: 'weijiashi', app_id: 'jiashiben', name: '微家事' } }));
  const t4 = signT4({ sub: 'adm1', role: 'tenant', appId: 'jiashiben', tenantId: 'weijiashi', privateKeyPem: PRIV_PEM });

  let r = await jres(await mf.dispatchFetch(BASE + '/admin/keys', { method: 'GET', headers: { Authorization: 'Bearer ' + t4 } }));
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));

  r = await jres(
    await mf.dispatchFetch(BASE + '/admin/keys', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t4, 'content-type': 'application/json' },
      body: JSON.stringify({ scope: ['data:read', 'data:write'] }),
    })
  );
  assert.equal(r.status, 200);
  assert.ok(r.body.raw_secret, 'raw_secret returned once');
  assert.equal(r.body.tenant_bound, true);
  assert.equal(r.body.tenant_id, 'weijiashi');
  const kid = r.body.id;

  r = await jres(await mf.dispatchFetch(BASE + '/admin/keys', { method: 'GET', headers: { Authorization: 'Bearer ' + t4 } }));
  assert.ok(r.body.some((k) => k.id === kid), 'issued key must be listed');

  r = await jres(
    await mf.dispatchFetch(BASE + '/admin/keys/' + kid + '/revoke', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t4 },
    })
  );
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'revoked');
});

test('Phase3: T4 self password change (wrong old -> 401, correct old -> 200)', async () => {
  const db = await mf.getD1Database('DB');
  const oldPwd = 'OldPass1234';
  const newPwd = 'NewPass5678';
  const hash = await hashPassword(oldPwd);
  await db
    .prepare('INSERT INTO admin_accounts (id, app_id, tenant_id, email, pwd_hash, role, status, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .bind('adm_self', 'jiashiben', 'weijiashi', 'self@weijiashi.app', hash, 'tenant', 'active', Date.now())
    .run();

  const t4 = signT4({ sub: 'adm_self', role: 'tenant', appId: 'jiashiben', tenantId: 'weijiashi', privateKeyPem: PRIV_PEM });

  let r = await jres(
    await mf.dispatchFetch(BASE + '/admin/me/password', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t4, 'content-type': 'application/json' },
      body: JSON.stringify({ old_password: 'WrongPass', new_password: newPwd }),
    })
  );
  assert.equal(r.status, 401, 'wrong old password must be rejected');

  r = await jres(
    await mf.dispatchFetch(BASE + '/admin/me/password', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + t4, 'content-type': 'application/json' },
      body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }),
    })
  );
  assert.equal(r.status, 200, 'correct old password must allow change');

  const row = await db.prepare('SELECT pwd_hash FROM admin_accounts WHERE id=?').bind('adm_self').first();
  assert.notEqual(row.pwd_hash, hash, 'pwd_hash must be updated');
  assert.ok(
    typeof row.pwd_hash === 'string' && /^[0-9a-f]{32}\$\d+\$[0-9a-f]+$/.test(row.pwd_hash),
    'new pwd_hash must be a valid non-empty PBKDF2 string (regression: must never be NULL/empty)'
  );

  // 改密后：新密码必须能登录、旧密码失效（account.js pbkdf2Verify 同为 WebCrypto，能验过 me/password 生成的 hash）
  const vNew = await jres(
    await mf.dispatchFetch(BASE + '/internal/admin/verify', {
      method: 'POST',
      headers: { 'X-Sync-Key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'self@weijiashi.app', password: newPwd }),
    })
  );
  assert.equal(vNew.status, 200, 'new password must log in after change');
  const vOld = await jres(
    await mf.dispatchFetch(BASE + '/internal/admin/verify', {
      method: 'POST',
      headers: { 'X-Sync-Key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'self@weijiashi.app', password: oldPwd }),
    })
  );
  assert.equal(vOld.status, 401, 'old password must be invalid after change');

  await db.prepare('DELETE FROM admin_accounts WHERE id=?').bind('adm_self').run();
});

// ===== Phase 3 (B3): T4 Data Browser & Content Management =====
test('Phase3: T4 data browser lists, searches, edits, deletes own-tenant rows', async () => {
  await jres(await req('POST', '/tenants', { body: { tenant_id: 'weijiashi', app_id: 'jiashiben', name: '微家事' } }));
  await jres(await req('POST', '/t/weijiashi/todos', { headers: { 'X-User-Id': 'u1' }, body: { id: 'db1', title: 'browse-me', tag: 'shop' } }));
  await jres(await req('POST', '/t/weijiashi/archive', { headers: { 'X-User-Id': 'u1' }, body: { id: 'db_a1', type: 'todo', payload: { title: '旧' } } }));

  const t4 = signT4({ sub: 'adm1', role: 'tenant', appId: 'jiashiben', tenantId: 'weijiashi', privateKeyPem: PRIV_PEM });
  const hdr = { Authorization: 'Bearer ' + t4 };

  // list todos
  let r = await jres(await mf.dispatchFetch(BASE + '/admin/rows/todos?limit=20', { method: 'GET', headers: hdr }));
  assert.equal(r.status, 200);
  assert.equal(r.body.table, 'todos');
  assert.ok(r.body.rows.some((x) => x.id === 'db1'), 'seeded todo must be listed');
  assert.equal(typeof r.body.total, 'number');

  // search by title
  r = await jres(await mf.dispatchFetch(BASE + '/admin/rows/todos?q=browse', { method: 'GET', headers: hdr }));
  assert.equal(r.status, 200);
  assert.ok(r.body.rows.some((x) => x.id === 'db1'), 'search must find the row');

  // export (respects q filter + tenant scope)
  r = await jres(await mf.dispatchFetch(BASE + '/admin/rows/todos/export?q=browse', { method: 'GET', headers: hdr }));
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 1, 'export must respect q filter');
  assert.equal(r.body.rows[0].id, 'db1');
  assert.equal(r.body.truncated, false);

  // unknown table -> 404
  r = await jres(await mf.dispatchFetch(BASE + '/admin/rows/nope', { method: 'GET', headers: hdr }));
  assert.equal(r.status, 404, 'unknown table must 404 (allowlist)');

  // edit todo (title + json meta)
  r = await jres(
    await mf.dispatchFetch(BASE + '/admin/rows/todos/db1', {
      method: 'PUT',
      headers: { ...hdr, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'browse-me-edited', meta: { done: true } }),
    })
  );
  assert.equal(r.status, 200);
  r = await jres(await mf.dispatchFetch(BASE + '/admin/rows/todos?q=edited', { method: 'GET', headers: hdr }));
  const row = r.body.rows.find((x) => x.id === 'db1');
  assert.equal(row.title, 'browse-me-edited', 'title must be updated');
  assert.deepEqual(row.meta, { done: true }, 'json column must be parsed on read');

  // single-row read (used by the editor)
  r = await jres(await mf.dispatchFetch(BASE + '/admin/rows/todos/db1', { method: 'GET', headers: hdr }));
  assert.equal(r.status, 200);
  assert.equal(r.body.title, 'browse-me-edited');
  assert.deepEqual(r.body.meta, { done: true });

  // tasks_doc is read-only -> PUT rejected
  r = await jres(
    await mf.dispatchFetch(BASE + '/admin/rows/tasks_doc/x', {
      method: 'PUT',
      headers: { ...hdr, 'content-type': 'application/json' },
      body: JSON.stringify({ sections: [] }),
    })
  );
  assert.equal(r.status, 400, 'read-only table must reject PUT');

  // delete + gone
  r = await jres(await mf.dispatchFetch(BASE + '/admin/rows/todos/db1', { method: 'DELETE', headers: hdr }));
  assert.equal(r.status, 200);
  r = await jres(await mf.dispatchFetch(BASE + '/admin/rows/archive_items/db_a1', { method: 'DELETE', headers: hdr }));
  assert.equal(r.status, 200);
  r = await jres(await mf.dispatchFetch(BASE + '/admin/rows/todos/db1', { method: 'DELETE', headers: hdr }));
  assert.equal(r.status, 404, 'deleted row must 404 on second delete');
});

// ===== Phase 3 (B3): T4 admin audit log =====
test('Phase3: T4 audit log records mutating actions + role-scoped read', async () => {
  await jres(await req('POST', '/tenants', { body: { tenant_id: 'weijiashi', app_id: 'jiashiben', name: '微家事' } }));
  const db = await mf.getD1Database('DB');
  await db
    .prepare('INSERT INTO users (id, tenant_id, email, status, provider, created_at) VALUES (?,?,?,?,?,?)')
    .bind('u_aud_1', 'weijiashi', 'aud@weijiashi.app', 'active', 'native', Date.now())
    .run();

  const t4 = signT4({ sub: 'adm_aud', role: 'tenant', appId: 'jiashiben', tenantId: 'weijiashi', privateKeyPem: PRIV_PEM });
  const hdr = { Authorization: 'Bearer ' + t4, 'content-type': 'application/json' };

  // 1) disable a user -> audited
  let r = await jres(await mf.dispatchFetch(BASE + '/admin/users/u_aud_1/status', { method: 'POST', headers: hdr, body: JSON.stringify({ status: 'disabled' }) }));
  assert.equal(r.status, 200);

  // 2) issue a key -> audited
  r = await jres(await mf.dispatchFetch(BASE + '/admin/keys', { method: 'POST', headers: hdr, body: JSON.stringify({ scope: ['data:read'] }) }));
  assert.equal(r.status, 200);
  const keyId = r.body.id;

  // 3) audit log contains both entries, tenant-scoped
  r = await jres(await mf.dispatchFetch(BASE + '/admin/audit?limit=20', { method: 'GET', headers: { Authorization: 'Bearer ' + t4 } }));
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.rows), 'audit rows array');
  assert.ok(r.body.rows.some((x) => x.action === 'user.status' && x.target === 'user:u_aud_1'), 'user.status entry');
  assert.ok(r.body.rows.some((x) => x.action === 'key.issue' && x.target === 'key:' + keyId), 'key.issue entry');
  assert.ok(r.body.rows.every((x) => x.tenant_id === 'weijiashi'), 'tenant-scoped rows');

  // 4) revoke key -> audited; filter by action works
  r = await jres(await mf.dispatchFetch(BASE + '/admin/keys/' + keyId + '/revoke', { method: 'POST', headers: hdr }));
  assert.equal(r.status, 200);
  r = await jres(await mf.dispatchFetch(BASE + '/admin/audit?action=key.revoke', { method: 'GET', headers: { Authorization: 'Bearer ' + t4 } }));
  assert.ok(r.body.rows.some((x) => x.target === 'key:' + keyId), 'key.revoke entry with action filter');

  // 5) T2 (account) cannot read the audit log
  const t2 = signJwt(
    { sub: 'u2', aid: 'jiashiben', tid: 'weijiashi', typ: 'account', iss: 'gateway', aud: 'data.kapibala.icu', exp: Math.floor(Date.now() / 1000) + 3600 },
    PRIV_PEM
  );
  r = await jres(await mf.dispatchFetch(BASE + '/admin/audit', { method: 'GET', headers: { Authorization: 'Bearer ' + t2 } }));
  assert.equal(r.status, 403, 'non-admin must not read audit log');

  await db.prepare('DELETE FROM users WHERE id=?').bind('u_aud_1').run();
});

// Miniflare keeps a workerd subprocess alive; dispose it so the process
// can exit. Without this the test hangs forever.
test.after(async () => {
  await mf.dispose();
  process.exit(0);
});
