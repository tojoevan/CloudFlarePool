// Lightweight fixed-window rate limiter backed by D1 (SQLite).
//
// Free-tier friendly: the data lake is a personal-scale platform, so a couple
// of extra D1 rows per Bearer request is fine (D1 free tier allows 100k row
// writes/day). Applied selectively:
//   - auth verify endpoints (per email + per IP) -> brute-force protection
//   - tenant data endpoints (per service key / per account sub) -> abuse guard
// The internal X-Sync-Key channel (mini-program via gateway) is trusted and
// EXEMPT — the frozen mini-program path must stay byte-identical.
//
// Fail-open: any DB error returns null (never break the API because of the
// limiter).

const STALE_WINDOWS = 86400; // keep counters for at most 1 day

export function clientIp(c) {
  return (
    c.req.header('cf-connecting-ip') ||
    (c.req.header('x-forwarded-for') || '').split(',')[0]?.trim() ||
    'unknown'
  );
}

// Returns a 429 Response when over the limit, otherwise null.
export async function rateLimit(c, bucketKey, { limit, windowSec = 60 } = {}) {
  const db = c.env && c.env.DB;
  if (!db || !limit) return null;
  const now = Math.floor(Date.now() / 1000);
  const win = Math.floor(now / windowSec) * windowSec;
  try {
    const row = await db
      .prepare('SELECT count FROM rate_limits WHERE bucket_key = ? AND window_start = ?')
      .bind(bucketKey, win)
      .first();
    if (row && row.count >= limit) {
      const retryAfter = Math.max(1, win + windowSec - now);
      return c.json({ error: 'rate limited, retry later', retry_after: retryAfter }, 429, {
        'retry-after': String(retryAfter),
      });
    }
    if (row) {
      await db
        .prepare('UPDATE rate_limits SET count = count + 1 WHERE bucket_key = ? AND window_start = ?')
        .bind(bucketKey, win)
        .run();
    } else {
      await db
        .prepare('INSERT INTO rate_limits (bucket_key, window_start, count) VALUES (?, ?, 1)')
        .bind(bucketKey, win)
        .run();
    }
    // best-effort: drop stale windows for this bucket so the table stays small
    await db
      .prepare('DELETE FROM rate_limits WHERE bucket_key = ? AND window_start < ?')
      .bind(bucketKey, now - STALE_WINDOWS)
      .run();
    return null;
  } catch (_) {
    return null; // fail-open
  }
}
