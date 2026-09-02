import { Hono } from 'hono';

// 家庭（多家庭模型）。挂载在 `/t`，路径形如：
//   POST /t/:tenant/family           创建家庭（创建者为 owner）
//   GET  /t/:tenant/family/mine      列出当前用户所属家庭
//   POST /t/:tenant/family/invite    生成邀请（任意成员可发）
//   GET  /t/:tenant/family/invite/info?code=  预览邀请（未接受）
//   POST /t/:tenant/family/accept    接受邀请（写入成员，一次性、7 天有效）
//   GET  /t/:tenant/family/members?family_id=  成员列表（成员可见）
//   POST /t/:tenant/family/leave     退出家庭（owner 禁止，需先 transfer）
//   POST /t/:tenant/family/transfer  转让管理权（仅 owner）
//
// 鉴权：与 /t/* 一致——X-Sync-Key 内部通道（小程序经网关）或 Bearer JWT。
// 用户身份取自 ownerOf(c)（网关注入的 X-User-Id 或 JWT sub）。
// 物理约束：每人最多加入 3 个家庭（创建 / 接受前计数校验）。

const familyRoute = new Hono();

const now = () => Date.now();
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_FAMILIES_PER_USER = 3;

// 身份：X-Sync-Key 通道靠 X-User-Id 头；JWT 通道靠全局 dualGuard 注入的 userId。
const ownerOf = (c) => c.get('userId') || c.req.header('X-User-Id') || 'anonymous';

async function tenantOr404(c) {
  const t = c.req.param('tenant');
  const row = await c.env.DB.prepare(`SELECT tenant_id FROM tenants WHERE tenant_id = ?`).bind(t).first();
  return row ? t : null;
}

// 当前用户所属家庭数（用于 ≤3 约束）。
async function familyCount(c, openid) {
  const r = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM family_members WHERE openid = ?`).bind(openid).first();
  return r ? r.c : 0;
}

// 当前用户是否为某家庭成员；是则返回该行，否则 null。
async function membership(c, familyId, openid) {
  return c.env.DB.prepare(`SELECT * FROM family_members WHERE family_id = ? AND openid = ?`)
    .bind(familyId, openid).first();
}

familyRoute.post('/:tenant/family', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);

  if (await familyCount(c, ow) >= MAX_FAMILIES_PER_USER) {
    return c.json({ error: `最多加入 ${MAX_FAMILIES_PER_USER} 个家庭` }, 429);
  }
  const b = await c.req.json().catch(() => ({}));
  const familyId = crypto.randomUUID();
  const name = (b.name || '我的家庭').trim() || '我的家庭';

  await c.env.DB.prepare(
    `INSERT INTO families (family_id, tenant_id, name, owner_openid, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(familyId, tenant, name, ow, now()).run();

  await c.env.DB.prepare(
    `INSERT INTO family_members (family_id, openid, role, nickname, invited_by, joined_at)
     VALUES (?, ?, 'owner', ?, '', ?)`
  ).bind(familyId, ow, b.nickname || '', now()).run();

  return c.json({ ok: true, family_id: familyId, role: 'owner' });
});

familyRoute.get('/:tenant/family/mine', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);
  const { results } = await c.env.DB.prepare(
    `SELECT m.family_id, m.role, f.name
       FROM family_members m
       JOIN families f ON f.family_id = m.family_id
      WHERE m.openid = ? AND f.tenant_id = ?
      ORDER BY m.joined_at ASC`
  ).bind(ow, tenant).all();
  return c.json((results || []).map((r) => ({ family_id: r.family_id, name: r.name, role: r.role })));
});

familyRoute.post('/:tenant/family/invite', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);
  const b = await c.req.json().catch(() => ({}));
  const familyId = b.family_id;
  if (!familyId) return c.json({ error: 'family_id required' }, 400);

  if (!(await membership(c, familyId, ow))) {
    return c.json({ error: '你不是该家庭成员，无法邀请' }, 403);
  }
  const code = crypto.randomUUID();
  const ts = now();
  await c.env.DB.prepare(
    `INSERT INTO family_invites (code, family_id, inviter_openid, created_at, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  ).bind(code, familyId, ow, ts, ts + INVITE_TTL_MS).run();

  return c.json({ ok: true, code, expires_at: ts + INVITE_TTL_MS });
});

familyRoute.get('/:tenant/family/invite/info', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const code = c.req.query('code');
  if (!code) return c.json({ error: 'code required' }, 400);

  const inv = await c.env.DB.prepare(`SELECT * FROM family_invites WHERE code = ?`).bind(code).first();
  if (!inv) return c.json({ error: '邀请不存在或已失效' }, 404);
  if (inv.used_at) return c.json({ error: '邀请已被使用' }, 409);
  if (inv.expires_at < now()) return c.json({ error: '邀请已过期' }, 410);

  const fam = await c.env.DB.prepare(`SELECT name FROM families WHERE family_id = ?`).bind(inv.family_id).first();
  const inviter = await c.env.DB.prepare(
    `SELECT nickname FROM family_members WHERE family_id = ? AND openid = ?`
  ).bind(inv.family_id, inv.inviter_openid).first();

  return c.json({
    ok: true,
    family_id: inv.family_id,
    family_name: fam ? fam.name : '家庭',
    inviter_name: (inviter && inviter.nickname) || '好友',
  });
});

familyRoute.post('/:tenant/family/accept', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);
  const b = await c.req.json().catch(() => ({}));
  const code = b.code;
  if (!code) return c.json({ error: 'code required' }, 400);

  const inv = await c.env.DB.prepare(`SELECT * FROM family_invites WHERE code = ?`).bind(code).first();
  if (!inv) return c.json({ error: '邀请不存在或已失效' }, 404);
  if (inv.used_at) return c.json({ error: '邀请已被使用', joined: false }, 409);
  if (inv.expires_at < now()) return c.json({ error: '邀请已过期', joined: false }, 410);

  const familyId = inv.family_id;

  if (await familyCount(c, ow) >= MAX_FAMILIES_PER_USER) {
    return c.json({ error: `最多加入 ${MAX_FAMILIES_PER_USER} 个家庭`, joined: false }, 429);
  }

  const existing = await membership(c, familyId, ow);
  if (existing) {
    // 已是成员：不重复写入，如实返回 joined:false（避免「假成功」）。
    return c.json({ ok: true, joined: false, family_id: familyId, role: existing.role });
  }

  await c.env.DB.prepare(
    `INSERT INTO family_members (family_id, openid, role, nickname, invited_by, joined_at)
     VALUES (?, ?, 'member', ?, ?, ?)`
  ).bind(familyId, ow, b.nickname || '', inv.inviter_openid, now()).run();

  await c.env.DB.prepare(`UPDATE family_invites SET used_at = ? WHERE code = ?`).bind(now(), code).run();

  return c.json({ ok: true, joined: true, family_id: familyId, role: 'member' });
});

familyRoute.get('/:tenant/family/members', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);
  const familyId = c.req.query('family_id');
  if (!familyId) return c.json({ error: 'family_id required' }, 400);
  if (!(await membership(c, familyId, ow))) return c.json({ error: '你不是该家庭成员' }, 403);

  const { results } = await c.env.DB.prepare(
    `SELECT openid, nickname, role, joined_at FROM family_members WHERE family_id = ? ORDER BY joined_at ASC`
  ).bind(familyId).all();
  return c.json((results || []).map((r) => ({
    openid: r.openid,
    nickname: r.nickname,
    role: r.role,
    joined_at: r.joined_at,
    is_self: r.openid === ow,
  })));
});

// 当前成员更新自己在家庭内的昵称（用于补全创建家庭时漏存的昵称等场景）。
familyRoute.post('/:tenant/family/nickname', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);
  const b = await c.req.json().catch(() => ({}));
  const familyId = b.family_id;
  const nickname = (b.nickname || '').toString().slice(0, 32);
  if (!familyId) return c.json({ error: 'family_id required' }, 400);
  if (!(await membership(c, familyId, ow))) return c.json({ error: '你不是该家庭成员' }, 403);
  await c.env.DB.prepare(
    `UPDATE family_members SET nickname = ? WHERE family_id = ? AND openid = ?`
  ).bind(nickname, familyId, ow).run();
  return c.json({ ok: true });
});

familyRoute.post('/:tenant/family/leave', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);
  const b = await c.req.json().catch(() => ({}));
  const familyId = b.family_id;
  if (!familyId) return c.json({ error: 'family_id required' }, 400);

  const me = await membership(c, familyId, ow);
  if (!me) return c.json({ error: '你不是该家庭成员' }, 403);
  if (me.role === 'owner') {
    return c.json({ error: '家庭创建者不能直接退出，请先转让管理权给其他成员' }, 403);
  }

  await c.env.DB.prepare(`DELETE FROM family_members WHERE family_id = ? AND openid = ?`).bind(familyId, ow).run();

  // 家庭已无成员则清理家庭与其邀请，避免孤儿数据。
  const left = await c.env.DB.prepare(`SELECT COUNT(*) AS c FROM family_members WHERE family_id = ?`).bind(familyId).first();
  if (left && left.c === 0) {
    await c.env.DB.prepare(`DELETE FROM families WHERE family_id = ?`).bind(familyId).run();
    await c.env.DB.prepare(`DELETE FROM family_invites WHERE family_id = ?`).bind(familyId).run();
  }
  return c.json({ ok: true });
});

familyRoute.post('/:tenant/family/transfer', async (c) => {
  const tenant = await tenantOr404(c);
  if (!tenant) return c.json({ error: 'tenant not found' }, 404);
  const ow = ownerOf(c);
  const b = await c.req.json().catch(() => ({}));
  const familyId = b.family_id;
  const toOpenid = b.to_openid;
  if (!familyId || !toOpenid) return c.json({ error: 'family_id and to_openid required' }, 400);

  const me = await membership(c, familyId, ow);
  if (!me) return c.json({ error: '你不是该家庭成员' }, 403);
  if (me.role !== 'owner') return c.json({ error: '只有家庭创建者可转让管理权' }, 403);

  const target = await membership(c, familyId, toOpenid);
  if (!target) return c.json({ error: '接收人不是该家庭成员' }, 400);
  if (toOpenid === ow) return c.json({ error: '不能转让给自己' }, 400);

  await c.env.DB.prepare(`UPDATE family_members SET role = 'owner' WHERE family_id = ? AND openid = ?`).bind(familyId, toOpenid).run();
  await c.env.DB.prepare(`UPDATE family_members SET role = 'member' WHERE family_id = ? AND openid = ?`).bind(familyId, ow).run();
  return c.json({ ok: true });
});

export { familyRoute };
