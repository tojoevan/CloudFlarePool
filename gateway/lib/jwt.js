// Sign EdDSA (Ed25519) JWTs for the data lake. The gateway holds the private
// key; the data lake holds only the matching public key (see JWT_KEY_SCHEME).
//
// Runs in Node.js (the gateway). Uses node:crypto — do NOT import this file
// from the Workers-runtime data lake.
import { createHmac, createHash, createPrivateKey, createPublicKey, sign as signRaw, verify as verifyRaw } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// privateKeyPem: PEM (PKCS#8) string from env JWT_PRIVATE_KEY.
// opts.kid identifies which public key the lake should use to verify.
export function signJwt(payload, privateKeyPem, { kid = 'gw1', alg = 'EdDSA' } = {}) {
  const privateKey = createPrivateKey(privateKeyPem);
  const header = { alg, typ: 'JWT', kid };
  const now = Math.floor(Date.now() / 1000);
  const full = { ...payload, iat: payload.iat || now };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(full))}`;
  // Ed25519 is deterministic; passing null lets Node infer the alg from the key.
  const sig = signRaw(null, Buffer.from(signingInput), privateKey);
  return `${signingInput}.${b64url(sig)}`;
}

// Convenience: build a T1 (WeChat user) token for the mini-program's owner.
// `appId` is the app this tenant belongs to (Phase 1 two-dimensional model).
// It defaults to `tenantId` so gateways that haven't been upgraded keep
// emitting the legacy aid=tenantId token unchanged.
export function signT1({ openid, tenantId, appId, ttl = 2592000, privateKeyPem, kid = 'gw1' }) {
  return signJwt(
    {
      sub: openid,
      aid: appId || tenantId,
      tid: tenantId,
      typ: 'wx',
      scp: ['user:read', 'user:write'],
      iss: 'gateway',
      aud: 'data.kapibala.icu',
      exp: Math.floor(Date.now() / 1000) + ttl,
    },
    privateKeyPem,
    { kid }
  );
}

// T2: account (native / OAuth) login. `sub` is the user_id resolved by the
// lake's internal /internal/account/verify endpoint.
export function signT2({ sub, appId, ttl = 2592000, privateKeyPem, kid = 'gw1' }) {
  return signJwt(
    {
      sub,
      aid: appId,
      typ: 'account',
      scp: ['user:read', 'user:write'],
      iss: 'gateway',
      aud: 'data.kapibala.icu',
      exp: Math.floor(Date.now() / 1000) + ttl,
    },
    privateKeyPem,
    { kid }
  );
}

// T3 service tokens are symmetric HMAC-SHA256 (see the lake's
// verifyServiceToken). The HMAC key is SHA-256(raw_secret) — identical to what
// the lake stores as `secret_hash` — so signing and verifying stay in sync.
export function signServiceToken({ serviceId, rawSecret, appId, tenantId, scope = ['data:read', 'data:write'], ttl = 31536000, kid }) {
  const header = { alg: 'HS256', typ: 'service', kid: kid || `${serviceId}.v1` };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: serviceId,
    aid: appId || null,
    tid: tenantId || null,
    typ: 'service',
    scp: scope,
    iss: 'gateway',
    aud: 'data.kapibala.icu',
    iat: now,
    exp: now + ttl,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  // key = SHA-256(raw_secret), matching the lake's stored secret_hash.
  const keyBuf = createHash('sha256').update(rawSecret).digest();
  const sig = createHmac('sha256', keyBuf).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

// T4: admin login. `role` is platform | app | tenant; app_id / tenant_id are
// bound only when the role permits (platform has neither).
export function signT4({ sub, role, appId, tenantId, ttl = 2592000, privateKeyPem, kid = 'gw1' }) {
  return signJwt(
    {
      sub,
      aid: appId || null,
      tid: tenantId || null,
      typ: 'admin',
      scp: [`admin:${role}`],
      iss: 'gateway',
      aud: 'data.kapibala.icu',
      exp: Math.floor(Date.now() / 1000) + ttl,
    },
    privateKeyPem,
    { kid }
  );
}

// 验证由本网关签发的 JWT（T2/T4 等）。网关持有私钥，可从中派生公钥做
// 密码学验签——无需额外持有公钥。用于高权限端点（如部署）的鉴权。
// 返回 decoded payload；签名无效或过期则抛错。
export function verifyJwt(token, privateKeyPem) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [h, p, s] = parts;
  const signingInput = `${h}.${p}`;
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const ok = verifyRaw(null, Buffer.from(signingInput), publicKey, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('invalid signature');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('token expired');
  return payload;
}
