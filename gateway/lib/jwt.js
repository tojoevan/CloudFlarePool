// Sign EdDSA (Ed25519) JWTs for the data lake. The gateway holds the private
// key; the data lake holds only the matching public key (see JWT_KEY_SCHEME).
//
// Runs in Node.js (the gateway). Uses node:crypto — do NOT import this file
// from the Workers-runtime data lake.
import { createPrivateKey, sign as signRaw } from 'node:crypto';

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
export function signT1({ openid, tenantId, ttl = 2592000, privateKeyPem, kid = 'gw1' }) {
  return signJwt(
    {
      sub: openid,
      aid: tenantId,
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
