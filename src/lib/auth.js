// B1 dual-mode auth for the data lake (Cloudflare Workers runtime / WebCrypto).
//
// Two mutually exclusive channels:
//   1. Bearer JWT  -> verified with Ed25519 public keys (client channel, B1 new)
//   2. X-Sync-Key  -> internal gateway channel (legacy, unchanged behavior)
//
// Backward compatibility is the hard contract here: the X-Sync-Key branch is
// byte-for-byte equivalent to the old global guard, so the published
// mini-program (which only ever reaches the lake through the gateway's
// X-Sync-Key proxy) is completely untouched.
//
// On the JWT path we inject `x-user-id` from the token subject so the existing
// `/t/*` routes (which read `c.req.header('X-User-Id')`) keep working without
// any change.

const DEFAULT_AUD = 'data.kapibala.icu';
const DEFAULT_ISS = 'gateway';

function b64urlToBytes(s) {
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    return { header, payload, sig: b64urlToBytes(parts[2]), signingInput: parts[0] + '.' + parts[1] };
  } catch {
    return null;
  }
}

async function importPubKey(rawB64) {
  const bytes = b64urlToBytes(rawB64);
  return crypto.subtle.importKey('raw', bytes, 'Ed25519', false, ['verify']);
}

// Verify an EdDSA (Ed25519) JWT.
//   publicKeysJson: JSON string `{ "<kid>": "<raw 32-byte public key, base64url>" }`
// Returns the decoded payload on success, throws on any failure.
export async function verifyJwt(token, publicKeysJson) {
  const decoded = decodeJwt(token);
  if (!decoded) throw new Error('malformed jwt');
  const { header, payload, sig, signingInput } = decoded;
  if (header.alg !== 'EdDSA') throw new Error('unexpected alg');
  if (!header.kid) throw new Error('missing kid');

  let map = null;
  if (publicKeysJson) {
    try { map = JSON.parse(publicKeysJson); } catch { /* fall through to unknown kid */ }
  }
  if (!map || typeof map[header.kid] !== 'string') throw new Error('unknown kid');

  const key = await importPubKey(map[header.kid]);
  const ok = await crypto.subtle.verify(
    'Ed25519',
    key,
    sig,
    new TextEncoder().encode(signingInput)
  );
  if (!ok) throw new Error('bad signature');

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) throw new Error('expired');
  if (payload.iss !== DEFAULT_ISS) throw new Error('bad iss');
  if ((payload.aud || DEFAULT_AUD) !== DEFAULT_AUD) throw new Error('bad aud');
  return payload;
}

// Extract the tenant id from a `/t/:tenant/...` URL, or null otherwise.
function extractTenant(c) {
  const u = new URL(c.req.url);
  const m = /\/t\/([^/]+)/.exec(u.pathname);
  return m ? m[1] : null;
}

// Returns a Response (rejection) or null (pass). On pass, the verified
// subject is injected as `x-user-id` for downstream routes.
export async function dualGuard(c, env) {
  const auth = c.req.header('Authorization') || c.req.header('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) {
    let p;
    try {
      p = await verifyJwt(m[1], env.JWT_PUBLIC_KEYS);
    } catch (e) {
      return c.json({ error: `unauthorized: ${e.message}` }, 401);
    }
    // Tenant isolation: a JWT scoped to a tenant must match the URL tenant.
    // (app/scope enforcement lands with the app-dimension sub-phase.)
    const tenant = extractTenant(c);
    if (tenant && p.tid && p.tid !== tenant) {
      return c.json({ error: 'forbidden: tenant mismatch' }, 403);
    }
    // Surface the verified subject via Hono context state so downstream /t/*
    // routes can read it. (Mutating incoming request headers is disallowed
    // under workerd; context state is the portable approach.) The X-Sync-Key
    // path leaves userId unset and keeps using the X-User-Id header.
    c.set('userId', String(p.sub));
    return null;
  }

  // --- legacy internal channel (unchanged) ---
  const key = c.req.header('X-Sync-Key') || c.req.header('x-sync-key');
  if (!env.INTERNAL_KEY || key !== env.INTERNAL_KEY) {
    return c.json({ error: 'forbidden: invalid or missing X-Sync-Key' }, 403);
  }
  return null;
}
