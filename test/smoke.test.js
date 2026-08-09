// Local verification of the data lake using Miniflare (real D1 + R2 bindings).
// Run:  npm test   (node --test test/)
import { Miniflare } from 'miniflare';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const KEY = 'test-internal-key';
const BASE = 'https://data.kapibala.icu';

const mf = new Miniflare({
  modules: true,
  scriptPath: path.resolve('dist/test-bundle.mjs'),
  d1Databases: {
    DB: 'cloudflarepool',
  },
  r2Buckets: {
    BUCKET: 'cloudflarepool',
  },
  bindings: { INTERNAL_KEY: KEY, ALLOW_SETUP: '1' },
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
  let r = await jres(await req('POST', '/tenants', { body: { tenant_id: 'jiashiben', appid: 'wx_x', name: '家事本' } }));
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

// Miniflare keeps a workerd subprocess alive; dispose it so the process
// can exit. Without this the test hangs forever.
test.after(async () => {
  await mf.dispose();
  process.exit(0);
});
