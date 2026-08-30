// Gateway-side keyring for T3 service-token proxy-signing.
//
// The data lake stores only `secret_hash` (SHA-256 of the raw secret) and can
// therefore *verify* service tokens but cannot *mint* them (it never holds the
// raw secret). To let the admin console issue ready-to-paste T3 bearer tokens
// for agents, the gateway captures the raw_secret of keys it helps create and
// keeps them here — in memory, persisted to a local file so they survive a
// restart.
//
// SECURITY: this file contains raw HMAC secrets equivalent to the issued keys.
// It MUST be outside the git tree (see .gitignore) and on the server live at a
// protected path with mode 0600 (we chmod on write). Treat it like a private
// key file. Anyone with read access can mint tokens for the captured keys.
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Decode a base64url JWT segment without throwing.
function b64urlDecodeJson(seg) {
  const pad = seg.length % 4 ? 4 - (seg.length % 4) : 0;
  const json = JSON.parse(Buffer.from(seg + '='.repeat(pad), 'base64url').toString('utf8'));
  return json;
}

// Locally verify a T3 service token using a raw secret we hold. Returns the
// decoded payload (with `scp`/`tid`) on success, or null on any failure.
// Mirrors the data lake's verifyServiceToken so the gateway can enforce scope
// before proxying — defense in depth, the lake re-verifies on the way through.
export function verifyServiceLocal(token, rawSecret) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header, payload;
  try {
    header = b64urlDecodeJson(h);
    payload = b64urlDecodeJson(p);
  } catch {
    return null;
  }
  if (header.alg !== 'HS256' || header.typ !== 'service' || !header.kid) return null;
  const keyBuf = createHash('sha256').update(rawSecret).digest();
  const expected = createHmac('sha256', keyBuf).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;
  if (payload.iss !== 'gateway') return null;
  if ((payload.aud || 'data.kapibala.icu') !== 'data.kapibala.icu') return null;
  return payload;
}

export class Keyring {
  constructor(file) {
    this.file = file;
    this.map = new Map(); // keyId -> { secret, scope, tenant, meta }
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const obj = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(obj || {})) this.map.set(k, v);
    } catch {
      // Corrupt / unreadable keyring: start empty rather than crash the gateway.
      this.map = new Map();
    }
  }

  save() {
    try {
      const dir = dirname(this.file);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map), null, 2), { mode: 0o600 });
      try { chmodSync(this.file, 0o600); } catch { /* best-effort */ }
    } catch (e) {
      console.warn(`[keyring] persist failed: ${e.message}`);
    }
  }

  put(keyId, { secret, scope, tenant, meta = {} }) {
    this.map.set(keyId, { secret, scope, tenant, meta });
    this.save();
  }

  get(keyId) {
    return this.map.get(keyId);
  }

  has(keyId) {
    return this.map.has(keyId);
  }

  // Find an existing key for a tenant with an equal scope array. Used by the
  // mint endpoint so we don't proliferate keys for the same (tenant, scope).
  find(tenant, scope) {
    const scopeKey = JSON.stringify(scope);
    for (const [keyId, v] of this.map) {
      if (v.tenant === tenant && JSON.stringify(v.scope || []) === scopeKey) return keyId;
    }
    return null;
  }

  list() {
    return [...this.map.entries()].map(([keyId, v]) => ({ keyId, ...v }));
  }
}

// Default keyring location: ./keyring.json next to this file, overridable via
// KEYRING_FILE (on the server, point this at a protected persistent path,
// e.g. /opt/gateway-keyring.json, OUTSIDE the deployed repo tree).
export function createKeyring() {
  const file = process.env.KEYRING_FILE || join(dirname(fileURLToPath(import.meta.url)), 'keyring.json');
  return new Keyring(file);
}
