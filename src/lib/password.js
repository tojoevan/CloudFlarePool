// Shared PBKDF2-SHA256 password helpers for the data lake (WebCrypto runtime).
//
// ⚠️ ITERATION HARD CAP = 100000. Do NOT raise this: a 200k iteration count
// was empirically found to exceed the Cloudflare Worker CPU budget and gets
// the request killed (gateway surfaces it as a 502 "data lake unreachable").
// 100k is proven to work in production. See docs/05-开发指南.md §4.4.
const PBKDF2_ITER = 100000;
const PBKDF2_BITS = 256;

function bytesToHex(buf) {
  const u8 = new Uint8Array(buf);
  return [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randHex(n) {
  const u8 = crypto.getRandomValues(new Uint8Array(n));
  return bytesToHex(u8);
}

// Hash a plaintext password -> "salt$iterations$hashHex".
export async function hashPassword(password) {
  const salt = randHex(16);
  const km = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITER, hash: 'SHA-256' },
    km,
    PBKDF2_BITS
  );
  return `${salt}$${PBKDF2_ITER}$${bytesToHex(bits)}`;
}

// Verify a plaintext password against a stored "salt$iterations$hashHex".
export async function verifyPassword(password, stored) {
  const [salt, iterStr, hashHex] = (stored || '').split('$');
  if (!salt || !iterStr || !hashHex) return false;
  const iterations = Number(iterStr);
  const km = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations, hash: 'SHA-256' },
    km,
    PBKDF2_BITS
  );
  const got = bytesToHex(bits);
  if (got.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}
