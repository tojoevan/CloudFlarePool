import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { loadDotEnv } from './lib/dotenv.js';
import { signSession, verifySession, bearerFrom } from './lib/auth.js';
import { signT1, signT2, signT4 } from './lib/jwt.js';

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
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.txt': 'text/plain' };

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

// ---- 流式反代到数据湖（JSON 和图片上传都走这条） ----
function proxyToDataLake(req, res, tenantId) {
  const rest = req.url.replace(/^\/api\/data\/?/, ''); // 去掉前缀后的资源路径
  const target = new URL(`/t/${encodeURIComponent(tenantId)}/${rest}`, CFG.dataLakeBase);

  const headers = { ...req.headers };
  delete headers['host'];
  delete headers['authorization'];
  headers['x-sync-key'] = CFG.internalKey;     // 注入数据湖内部密钥（前端永远拿不到）
  headers['x-user-id'] = req.ctx.openid;        // 注入真实用户身份

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
        git: backend?.git ?? null,
        region: backend?.region ?? null,
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
      proxyToDataLake(req, res, claims.tenantId || CFG.tenantId);
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
      const rest = req.url.replace(/^\/api\/t2data\/?/, '');
      const target = new URL(`/t/${encodeURIComponent(CFG.tenantId)}/${rest}`, CFG.dataLakeBase);
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
