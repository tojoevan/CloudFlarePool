// 会话令牌：网关签发给小程序，用于后续 /api/data/* 鉴权。
// 结构： base64url(payload) + "." + HMAC-SHA256(base64url(payload), SESSION_SECRET)
// payload = { o: openid, t: tenant_id, e: exp(秒) }
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');

export function signSession({ openid, tenantId, ttl }, secret) {
  const payload = { o: openid, t: tenantId, e: Math.floor(Date.now() / 1000) + ttl };
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// 成功返回 { openid, tenantId }，失败抛错。
export function verifySession(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    throw new Error('malformed token');
  }
  const [body, sig] = token.split('.');
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('bad signature');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new Error('bad payload');
  }
  if (!payload.e || payload.e < Math.floor(Date.now() / 1000)) {
    throw new Error('expired');
  }
  return { openid: payload.o, tenantId: payload.t };
}

// 从 Authorization: Bearer <token> 取出令牌
export function bearerFrom(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}
