import { Hono } from 'hono';
import { healthRoute } from './routes/health.js';
import { tenantsRoute } from './routes/tenants.js';
import { appsRoute } from './routes/apps.js';
import { dataRoute } from './routes/data.js';
import { migrate } from './lib/schema.js';
import { dualGuard } from './lib/auth.js';

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

export default app;
