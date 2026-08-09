import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { loadDotEnv } from './lib/dotenv.js';
import { signSession, verifySession, bearerFrom } from './lib/auth.js';

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

    // 2) 健康检查
    if (req.method === 'GET' && path === '/api/health') {
      sendJson(res, 200, { name: 'cloudflarepool-gateway', status: 'ok' });
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
        sendJson(res, 200, { token });
      } catch (e) {
        sendJson(res, 401, { error: 'login failed', detail: e.message });
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
