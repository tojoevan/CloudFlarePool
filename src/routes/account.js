import { Hono } from 'hono';
import { clientIp, rateLimit } from '../lib/ratelimit.js';

// Internal account verification endpoints. Reached only through the trusted
// gateway (X-Sync-Key channel) or an admin JWT — the global dual-mode guard in
// index.js rejects everything else. The gateway forwards credentials here; this
// route verifies the password (PBKDF2-SHA256) and returns the identity; the
// gateway then signs T2/T4. Passwords never leave the lake.
//
// PBKDF2 note: §18.3 mentioned bcrypt, but Cloudflare Workers (WebCrypto) has
// no bcrypt, and bcrypt can't verify tokens anyway. PBKDF2-SHA256 is supported
// on both Worker and Node runtimes with zero deps.
const accountRoute = new Hono();

function bytesToHex(buf) {
  const u8 = new Uint8Array(buf);
  return [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Verify a password against a stored `salt$iterations$hashHex` (PBKDF2-SHA256).
async function pbkdf2Verify(password, stored) {
  const [salt, iterStr, hashHex] = (stored || '').split('$');
  if (!salt || !iterStr || !hashHex) return false;
  const iterations = Number(iterStr);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  const got = bytesToHex(bits);
  if (got.length !== hashHex.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ hashHex.charCodeAt(i);
  return diff === 0;
}

accountRoute.post('/account/verify', async (c) => {
  // 防爆破：同一邮箱 5 次/分钟 + 同一来源 IP 30 次/分钟（超出 429）
  const b = await c.req.json().catch(() => ({}));
  if (!b.email || !b.password) return c.json({ error: 'email and password required' }, 400);
  const email = String(b.email).toLowerCase();
  const ip = clientIp(c);
  const rl = (await rateLimit(c, `login:${email}`, { limit: 5 })) || (await rateLimit(c, `ip:${ip}`, { limit: 30 }));
  if (rl) return rl;

  const row = await c.env.DB.prepare('SELECT id, app_id, tenant_id, pwd_hash, status FROM users WHERE email = ?')
    .bind(email)
    .first();
  if (!row || row.status !== 'active') return c.json({ error: 'invalid credentials' }, 401);
  const ok = await pbkdf2Verify(b.password, row.pwd_hash);
  if (!ok) return c.json({ error: 'invalid credentials' }, 401);
  return c.json({ user_id: row.id, app_id: row.app_id, tenant_id: row.tenant_id });
});

accountRoute.post('/admin/verify', async (c) => {
  // 防爆破：同一邮箱 5 次/分钟 + 同一来源 IP 30 次/分钟（超出 429）
  const b = await c.req.json().catch(() => ({}));
  if (!b.email || !b.password) return c.json({ error: 'email and password required' }, 400);
  const email = String(b.email).toLowerCase();
  const ip = clientIp(c);
  const rl = (await rateLimit(c, `admin_login:${email}`, { limit: 5 })) || (await rateLimit(c, `ip:${ip}`, { limit: 30 }));
  if (rl) return rl;

  const row = await c.env.DB.prepare('SELECT id, app_id, tenant_id, pwd_hash, role, status FROM admin_accounts WHERE email = ?')
    .bind(email)
    .first();
  if (!row || row.status !== 'active') return c.json({ error: 'invalid credentials' }, 401);
  const ok = await pbkdf2Verify(b.password, row.pwd_hash);
  if (!ok) return c.json({ error: 'invalid credentials' }, 401);
  return c.json({ id: row.id, role: row.role, app_id: row.app_id, tenant_id: row.tenant_id });
});

export { accountRoute };
