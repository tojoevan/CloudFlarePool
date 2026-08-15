import { Hono } from 'hono';
import { healthRoute } from './routes/health.js';
import { tenantsRoute } from './routes/tenants.js';
import { appsRoute } from './routes/apps.js';
import { dataRoute } from './routes/data.js';
import { migrate } from './lib/schema.js';
import { dualGuard } from './lib/auth.js';
import { accountRoute } from './routes/account.js';
import { keysRoute } from './routes/keys.js';
import { adminRoute } from './routes/admin.js';

const app = new Hono();

// --- Public (no auth) -------------------------------------------------------
app.get('/', (c) =>
  c.json({
    name: 'cloudflarepool',
    version: '0.1.0',
    description: 'Multi-tenant data lake on Cloudflare Workers + D1 + R2',
    status: 'ok',
  })
);
app.route('/', healthRoute);

// --- Global guard: dual-mode (B1) ----------------------------------------
// The data lake is a pure storage backend. It accepts two channels:
//   1. Bearer JWT (Ed25519) — client channel, verified with public keys.
//   2. X-Sync-Key            — internal gateway channel (legacy, unchanged).
// The published mini-program still arrives via the gateway's X-Sync-Key
// proxy, so this change is fully backward compatible.
app.use('*', async (c, next) => {
  const res = await dualGuard(c, c.env);
  if (res) return res;
  await next();
});

// Service tokens (T3) may consume tenant data but must NOT manage platform
// resources (apps / tenants / api_keys) — e.g. a leaked key must not mint
// more keys. Only the internal X-Sync-Key channel and admin (T4) JWTs keep
// access here; account (T2) JWTs keep their current behavior.
const forbidService = async (c, next) => {
  if (c.get('userTyp') === 'service') {
    return c.json({ error: 'forbidden: service tokens cannot manage platform resources' }, 403);
  }
  await next();
};
app.use('/tenants', forbidService);
app.use('/tenants/*', forbidService);
app.use('/v1/a/*', forbidService);

// --- Dev bootstrap (disabled in production) --------------------------------
// Creates tables when ALLOW_SETUP=1. In production use
//   wrangler d1 execute cloudflarepool --remote --file=schema.sql
app.post('/__setup', async (c) => {
  if (c.env.ALLOW_SETUP !== '1') return c.json({ error: 'setup disabled' }, 404);
  await migrate(c.env.DB);
  return c.json({ ok: true });
});

// --- Protected routes ------------------------------------------------------
app.route('/tenants', tenantsRoute); // admin tenant registry
app.route('/v1/a', appsRoute); // app-dimension management (Phase 1)
app.route('/t', dataRoute); // /t/:tenant/* data API
app.route('/v1/a', keysRoute); // T3 api_keys management (Phase 2)
app.route('/internal', accountRoute); // internal account verification (Phase 2)
app.route('/admin', adminRoute); // T4 admin read-only dashboard (Phase 3)

export default app;
