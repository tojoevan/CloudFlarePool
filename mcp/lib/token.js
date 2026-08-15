// Sign an HS256 service token (T3) for the data lake.
//
// The data lake verifies service tokens with HMAC-SHA256 where the key is
// SHA-256(raw_secret) used verbatim (see src/lib/auth.js verifyServiceToken:
// `secret_hash` stores exactly that hex, and the verifier imports it as a raw
// HMAC key). So this signer must derive the SAME key: sha256(rawSecret).
//
// Token shape (mirrors the design doc §5.5, T3 row):
//   header: { alg: 'HS256', typ: 'service', kid }
//   payload: { sub, aid, tid, scp, iss, aud, iat, exp }

import crypto from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function signServiceToken(rawSecret, opts = {}) {
  const header = { alg: 'HS256', typ: 'service', kid: opts.kid };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: opts.sub,
    aid: opts.aid || 'jiashiben',
    tid: opts.tid || 'weijiashi',
    scp: opts.scope || ['data:read', 'data:write'],
    iss: 'gateway',
    aud: 'data.kapibala.icu',
    iat: now,
    exp: now + (opts.ttl || 600),
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const key = crypto.createHash('sha256').update(rawSecret).digest();
  const sig = crypto.createHmac('sha256', key).update(signingInput).digest();
  return `${signingInput}.${b64url(sig)}`;
}
