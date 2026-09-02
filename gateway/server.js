import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { loadDotEnv } from './lib/dotenv.js';
import { signSession, verifySession, bearerFrom } from './lib/auth.js';
import { signT1, signT2, signT4, signServiceToken, verifyJwt } from './lib/jwt.js';
import { startDeploy, getDeployStatus } from './lib/deploy.js';
import { createKeyring, verifyServiceLocal } from './lib/keyring.js';

loadDotEnv();

const CFG = {
  dataLakeBase: process.env.DATA_LAKE_BASE || 'https://data.kapibala.icu',
  internalKey: process.env.INTERNAL_KEY || 'change-me',
  wxAppId: process.env.WX_APPID || '',
  wxAppSecret: process.env.WX_APPSECRET || '',
  wxCode2Session: process.env.WX_CODE2SESSION_URL || 'https://api.weixin.qq.com/sns/jscode2session',
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || 'change-me-session-secret',
  tenantId: process.env.TENANT_ID || 'weijiashi',
  // Phase 1: the app this tenant belongs to. Defaults to the tenant id so the
  // gateway keeps emitting legacy aid=tenantId tokens until explicitly set.
  appId: process.env.APP_ID || process.env.TENANT_ID || 'weijiashi',
  // Ed25519 PEM for signing T1 JWTs. Stored single-line in .env with literal
  // "\n" escapes (the zero-dep dotenv loader splits on newlines), so we
  // unescape here. Empty = don't issue JWT (legacy X-Sync-Key proxy only).
  jwtPrivateKey: (process.env.JWT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  sessionTtl: Number(process.env.SESSION_TTL || 2592000),
  // 小程序版本：独立仓库 jiashiben/weijiashi，由服务器 .env 维护（每次发版更新）
  miniappVersion: process.env.MINIAPP_VERSION || null,
  // 运营代签（/api/t4data/tokens/mint）允许签出的租户白名单。cloudlet 走 T2 通道，
  // 此处同样允许 agent 经 T3 访问其数据湖租户。逗号分隔，默认 weijiashi + cloudlet。
  mintTenants: (process.env.MINT_TENANTS || 'weijiashi,cloudlet').split(',').map((s) => s.trim()).filter(Boolean),
};

// 网关密钥环：持有服务密钥 raw_secret 以便为 agent 代签 T3 Bearer。
// KEYRING_FILE 指向受保护持久路径（默认网关根目录 ./keyring.json，部署时改为仓库外路径）。
const __gwRoot = dirname(fileURLToPath(import.meta.url));
if (!process.env.KEYRING_FILE) process.env.KEYRING_FILE = join(__gwRoot, 'keyring.json');
const keyring = createKeyring();

const __dirname = dirname(fileURLToPath(import.meta.url));

// 网关自身部署 HEAD：优先环境变量 GATEWAY_GIT_HEAD，其次部署时由 agent 写入的
// version.json（网关目录经 scp 上服务器、非 git 仓库，故部署时把当前 commit 写入
// version.json 随包带上）。采用**懒读**：每次健康检查都实时读 version.json，以便
// 一键部署脚本重写该文件后无需重启网关即显新 HEAD。
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function readGatewayGit() {
  if (process.env.GATEWAY_GIT_HEAD) return process.env.GATEWAY_GIT_HEAD;
  try { return JSON.parse(readFileSync(join(__dirname, 'version.json'), 'utf8')).git || null; } catch { return null; }
}

// 部署限频：每位 platform-admin 每 5 分钟最多触发 1 次（防止误点/滥用）
const DEPLOY_INTERVAL_MS = 5 * 60 * 1000;
const deployRate = new Map();

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ---- WeChat code2session：用 code 换 openid ----
async function wechatCode2Session(code) {
  const url = `${CFG.wxCode2Session}?appid=${encodeURIComponent(CFG.wxAppId)}&secret=${encodeURIComponent(CFG.wxAppSecret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const resp = await fetch(url);
  const json = await resp.json();
  if (json.errcode) {
    throw new Error(`wechat errcode ${json.errcode}: ${json.errmsg}`);
  }
  return { openid: json.openid, unionid: json.unionid };
}

// ---- 数据湖长连接池 ----
// Node 默认全局 Agent 不复用连接（keepAlive:false），每个反代请求都要重付一次跨境
// TCP+TLS 握手（实测 0.4-1.3s）。这里为数据湖通道建共享 keep-alive Agent，连接复用
// 后单跳约 190ms。Cloudflare 侧会主动关闭空闲连接，Agent 会随之回收套接字，无需
// 手动清理。scheduling:'lifo' 让最热的连接优先被复用。
const lakeAgentHttps = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 16,
  maxFreeSockets: 8,
  scheduling: 'lifo',
});
const lakeAgentHttp = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 16,
  maxFreeSockets: 8,
});

// ---- 流式反代到数据湖（JSON 和图片上传都走这条） ----
// restPath 为 /t/{tenantId}/ 之后的资源路径（如 "todos" 或 "family/invite"）。
function proxyToLake(req, res, tenantId, restPath) {
  const target = new URL(`/t/${encodeURIComponent(tenantId)}/${restPath}`, CFG.dataLakeBase);

  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['authorization'];
  headers['x-sync-key'] = CFG.internalKey;     // 注入数据湖内部密钥（前端永远拿不到）
  headers['x-user-id'] = req.ctx.openid;        // 注入真实用户身份

  const transport = target.protocol === 'https:' ? https : http;
  const agent = target.protocol === 'https:' ? lakeAgentHttps : lakeAgentHttp;
  const proxyReq = transport.request(target, { method: req.method, headers, agent }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, filterOutgoing(proxyRes.headers));
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    if (!res.headersSent) sendJson(res, 502, { error: 'data lake unreachable' });
    else res.end();
  });
  req.pipe(proxyReq);
}

// 回传时去掉会让客户端误判的逐跳头
function filterOutgoing(h) {
  const out = { ...h };
  delete out['transfer-encoding']; // node 会自动重算
  return out;
}

// 轻量、未验签的 JWT 解码，仅用于路由层读取 `typ` 声明（真正密码学验签
// 交给数据湖）。防止把 T4 admin / T1 微信令牌透传到 SPA 代理通道。
function jwtTyp(token) {
  try {
    const p = String(token).split('.')[1];
    if (!p) return null;
    const pad = p.length % 4 ? 4 - (p.length % 4) : 0;
    const json = JSON.parse(Buffer.from(p + '='.repeat(pad), 'base64').toString('utf8'));
    return json && json.typ;
  } catch {
    return null;
  }
}

// 同样轻量、未验签地读取 JWT payload（用于 T3 通道按 tid 路由）。
function jwtPayloadUnsafe(token) {
  try {
    const p = String(token).split('.')[1];
    if (!p) return null;
    const pad = p.length % 4 ? 4 - (p.length % 4) : 0;
    return JSON.parse(Buffer.from(p + '='.repeat(pad), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    // 1) 隐私/落地页
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = await readFile(join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(html);
      return;
    }

    // 1b) Web SPA（T2 客户端）托管在 /app/ 子路径——保持 / 隐私页不动（ICP 合规）
    if (req.method === 'GET' && path.startsWith('/app/')) {
      const rel = (path.slice('/app/'.length) || 'index.html').replace(/\.{2,}/g, '');
      const spaRoot = join(__dirname, 'public', 'spa');
      const file = join(spaRoot, rel);
      if (!file.startsWith(spaRoot)) { sendJson(res, 403, { error: 'forbidden' }); return; }
      try {
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(data);
      } catch {
        sendJson(res, 404, { error: 'not found' });
      }
      return;
    }

    // 1c) 管理后台（T4 客户端）托管在 /admin/ 子路径——保持 / 隐私页与 /app/ 不动
    if (req.method === 'GET' && path.startsWith('/admin/')) {
      const rel = (path.slice('/admin/'.length) || 'index.html').replace(/\.{2,}/g, '');
      const spaRoot = join(__dirname, 'public', 'admin');
      const file = join(spaRoot, rel);
      if (!file.startsWith(spaRoot)) { sendJson(res, 403, { error: 'forbidden' }); return; }
      try {
        const data = await readFile(file);
        res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
        res.end(data);
      } catch {
        sendJson(res, 404, { error: 'not found' });
      }
      return;
    }

    // 2) 健康检查（含后端 git HEAD，透传数据湖 /health）
    if (req.method === 'GET' && path === '/api/health') {
      let backend = null;
      try {
        const r = await fetch(`${CFG.dataLakeBase}/health`, { method: 'GET' });
        if (r.ok) backend = await r.json().catch(() => null);
      } catch (_) {}
      sendJson(res, 200, {
        name: 'cloudflarepool-gateway',
        status: 'ok',
        git: backend?.git ?? null, // 向后兼容：保持为数据湖 HEAD
        gatewayGit: readGatewayGit(),
        dataLakeGit: backend?.git ?? null,
        region: backend?.region ?? null,
        miniappVersion: CFG.miniappVersion,
      });
      return;
    }

    // 3) 登录：小程序 wx.login() 拿 code -> 换 openid -> 签发网关会话
    if (req.method === 'POST' && path === '/api/login') {
      if (!CFG.wxAppId || !CFG.wxAppSecret) {
        sendJson(res, 500, { error: 'gateway WX_APPID/WX_APPSECRET not configured' });
        return;
      }
      const { code } = await readJson(req);
      if (!code) { sendJson(res, 400, { error: 'missing code' }); return; }
      try {
        const { openid } = await wechatCode2Session(code);
        const token = signSession({ openid, tenantId: CFG.tenantId, ttl: CFG.sessionTtl }, CFG.sessionSecret);
        // B1: additionally issue a T1 JWT (Ed25519). The mini-program does not
        // use it yet — it keeps going through the X-Sync-Key proxy — but the
        // token is ready for direct-connect clients (Web/App) and future MCP.
        const jwt = CFG.jwtPrivateKey
          ? signT1({ openid, tenantId: CFG.tenantId, appId: CFG.appId, ttl: CFG.sessionTtl, privateKeyPem: CFG.jwtPrivateKey })
          : null;
        sendJson(res, 200, jwt ? { token, jwt } : { token });
      } catch (e) {
        sendJson(res, 401, { error: 'login failed', detail: e.message });
      }
      return;
    }

    // 5) 账号登录（T2）：native 账号密码 -> 数据湖内部验证 -> 签 T2
    if (req.method === 'POST' && path === '/api/account/login') {
      const { email, password } = await readJson(req);
      if (!email || !password) { sendJson(res, 400, { error: 'email and password required' }); return; }
      try {
        const r = await fetch(`${CFG.dataLakeBase}/internal/account/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sync-key': CFG.internalKey },
          body: JSON.stringify({ email, password }),
        });
        const j = await r.json();
        // 透传 429（数据湖限流）与 401，其余视为上游错误
        if (r.status !== 200) {
          const code = r.status === 401 ? 401 : r.status === 429 ? 429 : 500;
          sendJson(res, code, { error: j.error || 'verify failed' });
          return;
        }
        const jwt = CFG.jwtPrivateKey
          ? signT2({ sub: j.user_id, appId: j.app_id, privateKeyPem: CFG.jwtPrivateKey })
          : null;
        sendJson(res, 200, jwt ? { user_id: j.user_id, token: jwt } : { user_id: j.user_id });
      } catch {
        sendJson(res, 502, { error: 'data lake unreachable' });
      }
      return;
    }

    // 5b) OAuth 登录（T2）：MVP 留口，native 先行
    if (req.method === 'POST' && path === '/api/account/oauth') {
      sendJson(res, 501, { error: 'oauth login not yet enabled', hint: 'use /api/account/login (native)' });
      return;
    }

    // 6) admin 登录（T4）
    if (req.method === 'POST' && path === '/api/admin/login') {
      const { email, password } = await readJson(req);
      if (!email || !password) { sendJson(res, 400, { error: 'email and password required' }); return; }
      try {
        const r = await fetch(`${CFG.dataLakeBase}/internal/admin/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sync-key': CFG.internalKey },
          body: JSON.stringify({ email, password }),
        });
        const j = await r.json();
        // 透传 429（数据湖限流）与 401，其余视为上游错误
        if (r.status !== 200) {
          const code = r.status === 401 ? 401 : r.status === 429 ? 429 : 500;
          sendJson(res, code, { error: j.error || 'verify failed' });
          return;
        }
        const jwt = CFG.jwtPrivateKey
          ? signT4({ sub: j.id, role: j.role, appId: j.app_id, tenantId: j.tenant_id, privateKeyPem: CFG.jwtPrivateKey })
          : null;
        sendJson(res, 200, jwt ? { token: jwt, role: j.role } : { role: j.role });
      } catch {
        sendJson(res, 502, { error: 'data lake unreachable' });
      }
      return;
    }

    // 6b) 忘记密码自助重置（公开，无需令牌）：经 X-Sync-Key 调数据湖 /admin/recover
    if (req.method === 'POST' && path === '/api/admin/recover') {
      const { email, recovery_code, new_password } = await readJson(req);
      if (!email || !recovery_code || !new_password || String(new_password).length < 8) {
        sendJson(res, 400, { error: 'email, recovery_code and new_password(>=8) required' });
        return;
      }
      try {
        const r = await fetch(`${CFG.dataLakeBase}/admin/recover`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sync-key': CFG.internalKey },
          body: JSON.stringify({ email, recovery_code, new_password }),
        });
        const j = await r.json();
        const code = r.status === 200 ? 200 : r.status === 400 ? 400 : 500;
        sendJson(res, code, { ok: j.ok || false, error: j.error || 'recover failed' });
      } catch {
        sendJson(res, 502, { error: 'data lake unreachable' });
      }
      return;
    }

    // 4) 数据反代：所有小程序数据请求都经过这里
    if (path.startsWith('/api/data/')) {
      const token = bearerFrom(req);
      let claims;
      try {
        claims = verifySession(token, CFG.sessionSecret);
      } catch {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      req.ctx = { openid: claims.openid };
      proxyToLake(req, res, claims.tenantId || CFG.tenantId, req.url.replace(/^\/api\/data\/?/, ''));
      return;
    }

    // 4a) 家庭（多家庭模型）：与 /api/data 同通道，转发到 /t/{tenant}/family/*
    // 注意：前端 adapter 发创建请求时用的是 /api/family（无尾斜杠），且 worker 路由
    // /:tenant/family 也是无尾斜杠（Hono strict），故转发时不能硬编码尾斜杠。
    if (path === '/api/family' || path.startsWith('/api/family/')) {
      const token = bearerFrom(req);
      let claims;
      try {
        claims = verifySession(token, CFG.sessionSecret);
      } catch {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      req.ctx = { openid: claims.openid };
      const sub = req.url.replace(/^\/api\/family\/?/, ''); // '' 或 'mine'/'invite'...
      const rest = 'family' + (sub ? '/' + sub : '');
      proxyToLake(req, res, claims.tenantId || CFG.tenantId, rest);
      return;
    }

    // 4b) T2 客户端通道反代：浏览器持 T2 Bearer，原样转发到数据湖
    //     数据湖验签 Ed25519 并据 sub 做 owner 隔离；仅放行 typ=account
    //     （轻量 typ 校验防 T4/T1 透传，密码学验签交给数据湖 dualGuard）
    if (path.startsWith('/api/t2data/')) {
      const token = bearerFrom(req);
      if (!token) { sendJson(res, 401, { error: 'unauthorized: missing bearer' }); return; }
      if (jwtTyp(token) !== 'account') {
        sendJson(res, 403, { error: 'forbidden: only T2 account tokens allowed on this channel' });
        return;
      }
      // 密码学验签后读取 tid：仅 cloudlet 可路由到独立 cloudlet 租户，其余回落 weijiashi。
      // 必须验签——tid 是路由凭据，伪造 tid 会越权写入他人租户。
      let payload;
      try { payload = verifyJwt(token, CFG.jwtPrivateKey); }
      catch { sendJson(res, 401, { error: 'invalid or expired token' }); return; }
      const targetTenant = payload.tid === 'cloudlet' ? 'cloudlet' : CFG.tenantId;
      const rest = req.url.replace(/^\/api\/t2data\/?/, '');
      const target = new URL(`/t/${encodeURIComponent(targetTenant)}/${rest}`, CFG.dataLakeBase);
      const headers = { ...req.headers };
      delete headers['host'];
      // Authorization（T2 Bearer）保留——数据湖据此验签并设置 userId=sub
      const transport = target.protocol === 'https:' ? https : http;
      const proxyReq = transport.request(target, { method: req.method, headers }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, filterOutgoing(proxyRes.headers));
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => {
        if (!res.headersSent) sendJson(res, 502, { error: 'data lake unreachable' });
        else res.end();
      });
      req.pipe(proxyReq);
      return;
    }

    // 4c) T4 管理后台通道反代：admin 持 T4 Bearer，原样转发到数据湖 /admin/*
    //     数据湖校验 typ==='admin' 并据 role 返回租户统计；仅放行 typ=admin
    //     （轻量 typ 校验防 T2/T1 透传，密码学验签交给数据湖 dualGuard）

    // 4d) T3 服务令牌通道：agent / MCP / Skill 经此读写数据（机机 M2M）。
    //     网关用密钥环对 T3 做本地验签 + scope 校验，再按令牌 tid 路由到对应租户；
    //     原样转发 T3 Bearer，数据湖 dualGuard 会再次验签（纵深防御）。
    if (path.startsWith('/api/t3data/')) {
      const token = bearerFrom(req);
      if (!token) { sendJson(res, 401, { error: 'unauthorized: missing bearer' }); return; }
      if (jwtTyp(token) !== 'service') {
        sendJson(res, 403, { error: 'forbidden: only T3 service tokens allowed on this channel' });
        return;
      }
      const payloadUnsafe = jwtPayloadUnsafe(token) || {};
      const keyId = payloadUnsafe.sub;
      const entry = keyId ? keyring.get(keyId) : null;
      let tenant = null, scope = null, verified = false;
      if (entry) {
        const payload = verifyServiceLocal(token, entry.secret);
        if (!payload) { sendJson(res, 401, { error: 'invalid or expired service token' }); return; }
        tenant = payload.tid || entry.tenant;
        scope = payload.scp || entry.scope;
        verified = true;
      } else {
        // 密钥环无此密钥（如他处签发）：退化为仅按 tid 路由，校验交给数据湖。
        tenant = payloadUnsafe.tid || null;
      }
      if (!tenant) { sendJson(res, 400, { error: 'cannot resolve tenant for token' }); return; }
      // scope 校验：读需 data:read|data:*；写需 data:write|data:*（仅本地已知密钥时执行）
      if (verified) {
        const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
        const need = isWrite ? 'data:write' : 'data:read';
        const okScope = (scope || []).includes(need) || (scope || []).includes('data:*');
        if (!okScope) { sendJson(res, 403, { error: `forbidden: token scope lacks ${need}` }); return; }
      }
      const rest = req.url.replace(/^\/api\/t3data\/?/, '');
      const target = new URL(`/t/${encodeURIComponent(tenant)}/${rest}`, CFG.dataLakeBase);
      const headers = { ...req.headers };
      delete headers['host'];
      // Authorization（T3 Bearer）保留——数据湖据此验签并设置 userId=sub
      const transport = target.protocol === 'https:' ? https : http;
      const proxyReq = transport.request(target, { method: req.method, headers }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, filterOutgoing(proxyRes.headers));
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => {
        if (!res.headersSent) sendJson(res, 502, { error: 'data lake unreachable' });
        else res.end();
      });
      req.pipe(proxyReq);
      return;
    }

    // 4e) 签发服务密钥时把 raw_secret 捕获进网关密钥环（仅拦截此端点，
    //     其余 /api/t4data/* 仍走下方通用代理）。这样后续代签 agent 令牌
    //     时网关已持有 raw_secret，可直接签 T3 Bearer。
    if (req.method === 'POST' && path === '/api/t4data/keys') {
      const token = bearerFrom(req);
      let pl = null;
      if (token) { try { pl = verifyJwt(token, CFG.jwtPrivateKey); } catch { pl = null; } }
      if (pl && pl.typ === 'admin') {
        let body;
        try { body = await readJson(req); } catch { body = {}; }
        try {
          const r = await fetch(`${CFG.dataLakeBase}/admin/keys`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          });
          const j = await r.json().catch(() => ({}));
          if (j.raw_secret && j.id) {
            keyring.put(j.id, {
              secret: j.raw_secret,
              scope: j.scope || ['data:read', 'data:write'],
              tenant: j.tenant_id,
              meta: { label: j.label ?? null, used_by: j.used_by ?? null },
            });
          }
          sendJson(res, r.status, j);
        } catch {
          sendJson(res, 502, { error: 'data lake unreachable' });
        }
        return;
      }
      // 非 admin 令牌：交给下方通用代理返回 401
    }

    // 4f) 代签 agent 访问令牌（T4 管理员）：确保目标租户存在可用服务密钥
    //     （密钥环无则经 X-Sync-Key 在数据湖建一个并捕获 raw_secret），然后
    //     用网关持有的 raw_secret 签一个短期 T3 Bearer 返回，agent 可直接粘贴。
    if (req.method === 'POST' && path === '/api/t4data/tokens/mint') {
      const token = bearerFrom(req);
      if (!token) { sendJson(res, 401, { error: 'unauthorized: missing bearer' }); return; }
      let payload;
      try { payload = verifyJwt(token, CFG.jwtPrivateKey); }
      catch { sendJson(res, 401, { error: 'invalid or expired token' }); return; }
      if (payload.typ !== 'admin' || !payload.scp?.some((s) => s === 'admin:platform' || s === 'admin:tenant')) {
        sendJson(res, 403, { error: 'forbidden: admin (platform/tenant) only may mint tokens' });
        return;
      }
      const b = await readJson(req).catch(() => ({}));
      const tenant = String(b.tenant || CFG.tenantId);
      if (!CFG.mintTenants.includes(tenant)) {
        sendJson(res, 400, { error: `tenant not mintable: ${tenant}`, mintable: CFG.mintTenants });
        return;
      }
      const scopeMode =
        b.scope === 'read' ? ['data:read']
        : b.scope === 'write' ? ['data:write']
        : ['data:read', 'data:write'];
      const ttl = Number.isFinite(b.ttl) ? Math.floor(b.ttl) : 86400; // 默认 1 天
      const note = typeof b.note === 'string' ? b.note.slice(0, 200) : '';

      let keyId = keyring.find(tenant, scopeMode);
      let rawSecret = keyId ? keyring.get(keyId).secret : null;
      if (!keyId || !rawSecret) {
        try {
          const cr = await fetch(`${CFG.dataLakeBase}/v1/a/${encodeURIComponent(CFG.appId)}/keys`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-sync-key': CFG.internalKey },
            body: JSON.stringify({
              scope: scopeMode,
              tenant_bound: true,
              tenant_id: tenant,
              label: 'gateway-mint',
              used_by: note || 'agent',
              note,
            }),
          });
          const cj = await cr.json().catch(() => ({}));
          if (cr.status !== 200 || !cj.raw_secret) throw new Error(cj.error || 'key creation failed');
          keyId = cj.id;
          rawSecret = cj.raw_secret;
          keyring.put(keyId, {
            secret: rawSecret,
            scope: scopeMode,
            tenant,
            meta: { label: 'gateway-mint', used_by: note || 'agent' },
          });
        } catch (e) {
          sendJson(res, 502, { error: 'failed to provision service key', detail: e.message });
          return;
        }
      }
      const jwt = signServiceToken({ serviceId: keyId, rawSecret, appId: CFG.appId, tenantId: tenant, scope: scopeMode, ttl });
      const expiresAt = Math.floor(Date.now() / 1000) + ttl;
      sendJson(res, 200, {
        token: jwt,
        keyId,
        tenant,
        scope: scopeMode,
        expires_at: expiresAt,
        note,
        usage: '在 /api/t3data/ 通道携带此 Bearer（Authorization: Bearer <token>）读写数据；scope 决定读/写权限。',
      });
      return;
    }

    // 部署状态轮询（必须在 t4data 代理之前匹配，否则会被透传到数据湖）
    const statusMatch = path.match(/^\/api\/t4data\/deploy\/status\/([\w-]+)$/);
    if (req.method === 'GET' && statusMatch) {
      const task = getDeployStatus(statusMatch[1]);
      if (!task) { sendJson(res, 404, { error: 'task not found (gateway may have restarted)' }); return; }
      sendJson(res, 200, task);
      return;
    }

    // 一键部署（platform / tenant 管理员均可触发）：验签 T4 → 校验 admin 角色 →
    // 限频 → 异步 spawn 部署脚本 → 返回 taskId。高权限操作，务必 crypto 验签。
    // 单租户 MVP 中 tenant 管理员即平台运维者，故两者皆放行；app 级角色不授权部署。
    if (req.method === 'POST' && path === '/api/t4data/deploy') {
      if (!CFG.jwtPrivateKey) { sendJson(res, 500, { error: 'gateway JWT not configured' }); return; }
      const token = bearerFrom(req);
      if (!token) { sendJson(res, 401, { error: 'unauthorized: missing bearer' }); return; }
      let payload;
      try { payload = verifyJwt(token, CFG.jwtPrivateKey); }
      catch { sendJson(res, 401, { error: 'invalid or expired token' }); return; }
      if (payload.typ !== 'admin' || !payload.scp?.some((s) => s === 'admin:platform' || s === 'admin:tenant')) {
        sendJson(res, 403, { error: 'forbidden: admin (platform/tenant) only may deploy' });
        return;
      }
      const now = Date.now();
      const last = deployRate.get(payload.sub) || 0;
      if (now - last < DEPLOY_INTERVAL_MS) {
        const retryAfter = Math.ceil((DEPLOY_INTERVAL_MS - (now - last)) / 1000);
        sendJson(res, 429, { error: 'deploy rate limited, retry later', retryAfter });
        return;
      }
      deployRate.set(payload.sub, now);

      const script = process.env.DEPLOY_SCRIPT || join(process.env.DEPLOY_REPO_DIR || __dirname, 'scripts', 'deploy.sh');
      let task;
      try {
        task = startDeploy({ script, adminId: payload.sub });
      } catch (e) {
        sendJson(res, 500, { error: 'failed to start deploy', detail: e.message });
        return;
      }
      // 审计：服务端留痕（部署触发器本身是 gateway 进程内动作，数据湖无对应写入端点，
      // 故以网关日志形式记录；如需入库可后续为数据湖增加 audit 写入端点）
      console.log(`[deploy] triggered by admin=${payload.sub} task=${task.id}`);

      sendJson(res, 202, { taskId: task.id, status: task.status, message: '部署已触发，正在异步执行' });
      return;
    }

    if (path.startsWith('/api/t4data/')) {
      const token = bearerFrom(req);
      if (!token) { sendJson(res, 401, { error: 'unauthorized: missing bearer' }); return; }
      if (jwtTyp(token) !== 'admin') {
        sendJson(res, 403, { error: 'forbidden: only T4 admin tokens allowed on this channel' });
        return;
      }
      const rest = req.url.replace(/^\/api\/t4data\/?/, '');
      const target = new URL(`/admin/${rest}`, CFG.dataLakeBase);
      const headers = { ...req.headers };
      delete headers['host'];
      // Authorization（T4 Bearer）保留——数据湖据此校验 admin 身份
      const transport = target.protocol === 'https:' ? https : http;
      const proxyReq = transport.request(target, { method: req.method, headers }, (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 502, filterOutgoing(proxyRes.headers));
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => {
        if (!res.headersSent) sendJson(res, 502, { error: 'data lake unreachable' });
        else res.end();
      });
      req.pipe(proxyReq);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: 'internal', detail: e.message });
    else res.end();
  }
});

// 既能被 `node server.js` 直接拉起，也能被测试 import 后指定端口
export function start(port = CFG.port) {
  return new Promise((resolve) => {
    server.listen(port, () => resolve(server));
  });
}

// 仅当作为主模块运行时才监听
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  start().then(() => console.log(`[gateway] listening on :${CFG.port} -> ${CFG.dataLakeBase} (tenant=${CFG.tenantId})`));
}

export { server, CFG };
