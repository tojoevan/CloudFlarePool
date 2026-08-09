import { Hono } from 'hono';
import { healthRoute } from './routes/health.js';
import { tenantsRoute } from './routes/tenants.js';
import { dataRoute } from './routes/data.js';
import { migrate } from './lib/schema.js';

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

// --- Global guard: every other route requires a valid X-Sync-Key ----------
// The data lake is a pure storage backend. It only trusts the gateway
// (home.inkspcl.com) which has authenticated the end user upstream.
app.use('*', async (c, next) => {
  const key = c.req.header('X-Sync-Key');
  if (!c.env.INTERNAL_KEY || key !== c.env.INTERNAL_KEY) {
    return c.json({ error: 'forbidden: invalid or missing X-Sync-Key' }, 403);
  }
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
app.route('/t', dataRoute); // /t/:tenant/* data API

export default app;
