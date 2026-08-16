// 本地验证：用 mock 数据湖 + mock 微信，跑通网关的登录与反代。
// 断言：登录发 token、/api/data 注入正确头与租户路径、缺/错 token 返回 401。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { signT4 } from '../lib/jwt.js';

// 测试用临时假部署脚本：仅回显并退出 0，避免测试真跑 wrangler/git
writeFileSync('/tmp/fake-deploy.sh', '#!/bin/bash\necho "[fake-deploy] ok"; exit 0\n');
const DEPLOY_TEST_SCRIPT = '/tmp/fake-deploy.sh';

// ---- 1) mock 数据湖：记录收到的请求并回显 ----
let lastLakeReq = null;
function startMockLake() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastLakeReq = { method: req.method, path: req.url, headers: req.headers, body };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, echo: lastLakeReq.path }));
      });
    });
    srv.listen(0, () => resolve(srv));
  });
}

// ---- 2) mock 微信 code2session ----
function startMockWx() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ openid: 'oTEST123', session_key: 'sk' }));
    });
    srv.listen(0, () => resolve(srv));
  });
}

const freePort = (srv) => srv.address().port;
const get = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve({ status: r.statusCode, body: d }));
    });
    req.on('error', reject);
    req.end();
  });
const post = (port, path, payload, headers = {}) =>
  new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(payload);
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => resolve({ status: r.statusCode, body: d }));
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });

test('gateway: login + proxy injects headers & tenant path; rejects bad token', async () => {
  const lake = await startMockLake();
  const wx = await startMockWx();

  // 在 import 网关前注入配置（CFG 在模块加载时读取）
  process.env.DATA_LAKE_BASE = `http://127.0.0.1:${freePort(lake)}`;
  process.env.INTERNAL_KEY = 'lake-key-xyz';
  process.env.WX_CODE2SESSION_URL = `http://127.0.0.1:${freePort(wx)}/sns/jscode2session`;
  process.env.WX_APPID = 'wxapp';
  process.env.WX_APPSECRET = 'wxsec';
  process.env.SESSION_SECRET = 'sess-secret';
  process.env.TENANT_ID = 'jiashiben';
  process.env.PORT = '0';
  // 部署端点需 Ed25519 私钥验签（CFG 在模块加载时读取）
  const { privateKey } = generateKeyPairSync('ed25519');
  process.env.JWT_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.DEPLOY_SCRIPT = DEPLOY_TEST_SCRIPT;

  const { start } = await import('../server.js');
  const gw = await start(0);
  const gwPort = freePort(gw);

  try {
    // 健康
    const h = await get(gwPort, '/api/health');
    assert.equal(h.status, 200);

    // 登录拿 token
    const login = await post(gwPort, '/api/login', { code: 'abc' });
    assert.equal(login.status, 200);
    const { token } = JSON.parse(login.body);
    assert.ok(token && token.includes('.'), 'should return a signed token');

    // 带 token 访问 /api/data/todos -> 数据湖应收到 /t/jiashiben/todos + 注入头
    const ok = await get(gwPort, '/api/data/todos', { Authorization: `Bearer ${token}` });
    assert.equal(ok.status, 200);
    assert.equal(lastLakeReq.path, '/t/jiashiben/todos');
    assert.equal(lastLakeReq.headers['x-sync-key'], 'lake-key-xyz');
    assert.equal(lastLakeReq.headers['x-user-id'], 'oTEST123');
    assert.ok(!lastLakeReq.headers['authorization'], '不应把客户端 token 透传给数据湖');

    // 写一条 todo（POST 带 body），确认 body 被转发
    const w = await post(gwPort, '/api/data/todos', { id: 't1', title: 'hi' }, { Authorization: `Bearer ${token}` });
    assert.equal(w.status, 200);
    assert.equal(lastLakeReq.method, 'POST');
    assert.equal(lastLakeReq.headers['x-user-id'], 'oTEST123');
    assert.ok(lastLakeReq.body.includes('t1'));

    // 无 token -> 401
    const noTok = await get(gwPort, '/api/data/todos');
    assert.equal(noTok.status, 401);

    // 假 token -> 401
    const badTok = await get(gwPort, '/api/data/todos', { Authorization: 'Bearer not.a.token' });
    assert.equal(badTok.status, 401);

    // ---- 部署端点（platform-admin 专属）----
    const t4plat = signT4({ sub: 'admin-plat', role: 'platform', privateKeyPem: process.env.JWT_PRIVATE_KEY });
    const t4tenant = signT4({ sub: 'admin-tenant', role: 'tenant', privateKeyPem: process.env.JWT_PRIVATE_KEY });

    // tenant 角色 -> 403（禁止部署）
    const depTenant = await post(gwPort, '/api/t4data/deploy', {}, { Authorization: `Bearer ${t4tenant}` });
    assert.equal(depTenant.status, 403, 'tenant T4 不可触发部署');

    // platform 角色 -> 202（异步触发，返回 taskId）
    const depPlat = await post(gwPort, '/api/t4data/deploy', {}, { Authorization: `Bearer ${t4plat}` });
    assert.equal(depPlat.status, 202, 'platform T4 应触发部署');
    const { taskId } = JSON.parse(depPlat.body);
    assert.ok(taskId, '应返回 taskId');

    // 轮询状态 -> 200
    const st = await get(gwPort, `/api/t4data/deploy/status/${taskId}`);
    assert.equal(st.status, 200, '状态轮询应返回 200');

    // 同 admin 5 分钟内二次触发 -> 429（限频）
    const depAgain = await post(gwPort, '/api/t4data/deploy', {}, { Authorization: `Bearer ${t4plat}` });
    assert.equal(depAgain.status, 429, '同 admin 限频应 429');
  } finally {
    gw.close();
    lake.close();
    wx.close();
  }
});
