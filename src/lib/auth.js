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

import { DEFAULT_APP_ID } from './schema.js';

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

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Verify an HMAC-SHA256 service token (T3, api_keys). Unlike the Ed25519
// client JWTs, service tokens are symmetric: each api_key carries its own
// raw_secret, and `secret_hash` stores SHA-256(raw_secret) used directly as
// the HMAC verify key (see §18 implementation-correction note).
// Returns { payload, key } on success, throws on any failure.
export async function verifyServiceToken(token, env) {
  const decoded = decodeJwt(token);
  if (!decoded) throw new Error('malformed jwt');
  const { header, payload, sig, signingInput } = decoded;
  if (header.alg !== 'HS256') throw new Error('unexpected alg');
  if (header.typ !== 'service') throw new Error('not a service token');
  if (!header.kid) throw new Error('missing kid');

  const db = env && env.DB;
  if (!db) throw new Error('no db binding');
  const row = await db
    .prepare(
      'SELECT id, app_id, tenant_id, secret_hash, prev_secret, current_kid, prev_kid, status, scope, tenant_bound FROM api_keys WHERE id = ?'
    )
    .bind(payload.sub)
    .first();
  if (!row || row.status !== 'active') throw new Error('unknown or revoked key');

  // Pick the verify key: current_kid is preferred; prev_kid is honored during
  // the rotation grace period.
  let keyHex = null;
  if (header.kid === row.current_kid) keyHex = row.secret_hash;
  else if (row.prev_kid && header.kid === row.prev_kid) keyHex = row.prev_secret;
  if (!keyHex) throw new Error('kid mismatch');

  const key = await crypto.subtle.importKey(
    'raw',
    hexToBytes(keyHex),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const ok = await crypto.subtle.verify(
    'HMAC',
    key,
    sig,
    new TextEncoder().encode(signingInput)
  );
  if (!ok) throw new Error('bad signature');

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) throw new Error('expired');
  if (payload.iss !== DEFAULT_ISS) throw new Error('bad iss');
  if ((payload.aud || DEFAULT_AUD) !== DEFAULT_AUD) throw new Error('bad aud');

  return {
    payload,
    key: { tenantBound: !!row.tenant_bound, tenantId: row.tenant_id },
  };
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

// Resolve the app_id that owns a tenant. Falls back to DEFAULT_APP_ID when the
// tenant has no explicit app_id (legacy rows) or the DB is unreachable, so the
// two-dimensional isolation never hard-fails on existing data.
export async function resolveApp(c, tenant) {
  const db = c.env && c.env.DB;
  if (!db || !tenant) return DEFAULT_APP_ID;
  try {
    const row = await db
      .prepare('SELECT app_id FROM tenants WHERE tenant_id = ?')
      .bind(tenant)
      .first();
    const aid = row && row.app_id;
    return aid && aid !== '' ? aid : DEFAULT_APP_ID;
  } catch {
    return DEFAULT_APP_ID;
  }
}

// Returns a Response (rejection) or null (pass). On pass, the verified
// subject is injected as `x-user-id` for downstream routes.
export async function dualGuard(c, env) {
  const auth = c.req.header('Authorization') || c.req.header('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) {
    const decoded = decodeJwt(m[1]);
    if (!decoded) return c.json({ error: 'unauthorized: malformed jwt' }, 401);
    try {
      // T3 service token (symmetric HMAC) vs client JWT (Ed25519). Dispatched
      // by the `typ` claim so the two verification paths stay isolated.
      if (decoded.header.typ === 'service') {
        const svc = await verifyServiceToken(m[1], env);
        if (svc.key.tenantBound) {
          const t = extractTenant(c);
          if (t && t !== svc.key.tenantId) {
            return c.json({ error: 'forbidden: tenant mismatch' }, 403);
          }
        }
        c.set('userId', String(svc.payload.sub));
        c.set('scopes', svc.payload.scp || []);
        return null;
      }

      const p = await verifyJwt(m[1], env.JWT_PUBLIC_KEYS);
      // Tenant isolation: a JWT scoped to a tenant must match the URL tenant.
      const tenant = extractTenant(c);
      if (tenant && p.tid && p.tid !== tenant) {
        return c.json({ error: 'forbidden: tenant mismatch' }, 403);
      }
      // App-dimension isolation (Phase 1): enforce only when the token explicitly
      // carries an `aid` that does NOT match the tenant's app. Legacy tokens
      // emitted before this change carry no `aid`, so the published mini-program
      // (which reaches the lake only via the gateway's X-Sync-Key proxy) is
      // completely unaffected. When present we surface the resolved app_id for
      // downstream routes.
      if (tenant && p.aid) {
        const aid = await resolveApp(c, tenant);
        if (p.aid !== aid) {
          return c.json({ error: 'forbidden: app mismatch' }, 403);
        }
        c.set('appId', aid);
      }
      // Surface the verified subject via Hono context state so downstream /t/*
      // routes can read it. (Mutating incoming request headers is disallowed
      // under workerd; context state is the portable approach.) The X-Sync-Key
      // path leaves userId unset and keeps using the X-User-Id header.
      c.set('userId', String(p.sub));
      return null;
    } catch (e) {
      return c.json({ error: `unauthorized: ${e.message}` }, 401);
    }
  }

  // --- legacy internal channel (unchanged) ---
  const key = c.req.header('X-Sync-Key') || c.req.header('x-sync-key');
  if (!env.INTERNAL_KEY || key !== env.INTERNAL_KEY) {
    return c.json({ error: 'forbidden: invalid or missing X-Sync-Key' }, 403);
  }
  return null;
}
