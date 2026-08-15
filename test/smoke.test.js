// Local verification of the data lake using Miniflare (real D1 + R2 bindings).
// Run:  npm test   (node --test test/)
import { Miniflare } from 'miniflare';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { signJwt } from '../gateway/lib/jwt.js';

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

// Miniflare keeps a workerd subprocess alive; dispose it so the process
// can exit. Without this the test hangs forever.
test.after(async () => {
  await mf.dispose();
  process.exit(0);
});
