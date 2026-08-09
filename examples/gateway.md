# Gateway integration: `home.inkspcl.com` → `data.kapibala.icu`

`cloudflarepool` is a **pure storage** data lake. It never touches WeChat
credentials. The trusted gateway is where authentication happens, and it is the
only caller the lake accepts (validated by `X-Sync-Key`).

## Responsibilities of the gateway

1. **WeChat login.** Receive `code` from the mini-program, call
   `https://api.weixin.qq.com/sns/jscode2session` with the AppID + AppSecret, get
   the user `openid`, and issue your own session token (signed JWT or opaque
   token stored in KV).
2. **Token verification.** For every downstream call, verify the user's session
   token and resolve the `openid`.
3. **Tenant resolution.** Map the WeChat `appid` → `tenant_id` (the row you
   created via `POST /tenants`). Cache this mapping.
4. **Translation + forwarding.** Turn the mini-program's API into the
   `/t/:tenant/*` contract and forward it with the required headers.

## Headers the gateway must send

| Header         | Value                                              |
|----------------|----------------------------------------------------|
| `X-Sync-Key`   | the shared `INTERNAL_KEY` secret (server-to-server) |
| `X-User-Id`    | the verified WeChat `openid` of the end user       |
| `Authorization`| `Bearer <user_session_token>` (passed through)      |

The data lake uses `X-User-Id` for per-user ownership and `tenant_id` (from the
path) for isolation. It trusts these because only the gateway knows
`X-Sync-Key`.

## Example: Node.js (Hono / Express) forwarder

```js
// pseudo-code for the gateway
const TENANT = 'jiashiben';
const LAKE = 'https://data.kapibala.icu';
const SYNC_KEY = process.env.INTERNAL_KEY; // same secret as the lake

app.all('/api/:resource(.+)', async (c) => {
  const user = await verifySession(c.req.header('Authorization')); // -> { openid }
  const url = `${LAKE}/t/${TENANT}/${c.req.param('resource')}${c.req.url.search}`;
  const upstream = await fetch(url, {
    method: c.req.method,
    headers: {
      'X-Sync-Key': SYNC_KEY,
      'X-User-Id': user.openid,
      'Authorization': c.req.header('Authorization'),
      'content-type': c.req.header('content-type'),
    },
    body: ['GET','HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') },
  });
});
```

## WeChat legal-domain compliance

- The mini-program's **request / uploadFile / downloadFile** legal domains must
  include `home.inkspcl.com` (the ICP-filed, in-China domain).
- Images stored in R2 are served back **through the gateway**
  (`GET /api/img/:key` → lake `GET /t/:tenant/img/:key`), so they are also served
  from the legal domain — no extra R2 domain registration needed.
- `data.kapibala.icu` (Cloudflare, global Anycast) is never exposed to the
  mini-program directly, preserving the compliance boundary.

## Mini-program client (jiashiben)

The client (`utils/sync/adapters/cloudflare.js`) talks only to the gateway at
`home.inkspcl.com`. It sends the user session token; the gateway enriches the
request with `X-Sync-Key` + `X-User-Id` before calling the lake. No Cloudflare
secret ever leaves the gateway.
