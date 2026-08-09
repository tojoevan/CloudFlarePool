import { Hono } from 'hono';

// Public, unauthenticated health & liveness endpoints.
const healthRoute = new Hono();

healthRoute.get('/health', (c) =>
  c.json({ status: 'ok', ts: Date.now(), region: c.req.raw.cf?.colo ?? null })
);

export { healthRoute };
