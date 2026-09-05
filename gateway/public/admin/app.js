// 微家事 管理后台（T4 客户端）— 账号与密钥中心
// 流程：管理员邮箱密码 → /api/admin/login 取 T4 JWT → 经网关 /api/t4data 调数据湖。
// T4 令牌存 localStorage；所有请求带 Authorization: Bearer <T4>。
const $ = (s) => document.querySelector(s);
const API = ''; // 同源网关
const TOKEN_KEY = 'weijiashi_t4';
const SPA_VERSION = 'v0.0.3'; // 前端语义版本（随发布维护）

const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);
let ADMIN_ROLE = null; // 当前登录管理员角色（platform 才显示「管理员」tab）

function toast(msg, ok = true) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + (ok ? 'ok' : 'bad');
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2200);
}

function setDeployEnabled(on) {
  const b = $('#deploy-btn');
  if (!b) return;
  b.disabled = !on;
  b.title = on
    ? '一键部署：拉取最新代码，数据湖 + SPA 配套发布（platform-admin 专属）'
    : '请先登录管理员账号后再操作';
}
function showLogin() {
  $('#login').classList.remove('hidden');
  $('#main').classList.add('hidden');
  setDeployEnabled(false);
}
function showMain() {
  $('#login').classList.add('hidden');
  $('#main').classList.remove('hidden');
  setDeployEnabled(true);
  loadStats();
}

// 从 T4 JWT 解析 payload（仅取声明用于 UI，不验签）
function decodeJwtPayload(t) {
  try {
    const p = String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(p));
  } catch (_) { return null; }
}

// 统一应用会话 UI：登录成功与刷新恢复共用，确保角色、身份、租户下拉都重建
function applySession(role, whoText) {
  ADMIN_ROLE = role || 'admin';
  $('#tab-admins').classList.toggle('hidden', ADMIN_ROLE !== 'platform');
  $('#who').textContent = whoText || (ADMIN_ROLE || '');
  showMain();
  if (ADMIN_ROLE === 'platform') loadDataTenants();
}

async function api(path, opts = {}) {
  const token = getToken();
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(API + path, Object.assign({ headers }, opts));
  if (res.status === 401 || res.status === 403) {
    clearToken();
    showLogin();
    throw new Error('会话已失效，请重新登录');
  }
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((body && body.error) || '请求失败 ' + res.status);
  return body;
}

async function login(e) {
  e.preventDefault();
  const email = $('#email').value.trim();
  const password = $('#password').value;
  $('#login-err').textContent = '';
  $('#login-btn').disabled = true;
  try {
    const r = await fetch(API + '/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '登录失败 ' + r.status);
    if (!j.token) throw new Error('未返回令牌');
    setToken(j.token);
    $('#password').value = '';
    localStorage.setItem('weijiashi_email', email);
    applySession(j.role || 'admin', email + ' · ' + (j.role || 'admin'));
    toast('登录成功');
  } catch (err) {
    $('#login-err').textContent = err.message;
  } finally {
    $('#login-btn').disabled = false;
  }
}

const LABELS = { todos: '待办', tasks: '任务', archives: '归档', users: '用户' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(ms) {
  if (!ms) return '-';
  try { return new Date(ms).toLocaleString('zh-CN', { hour12: false }); } catch { return String(ms); }
}

async function loadStats() {
  try {
    const d = await api('/api/t4data/stats');
    renderStats(d);
  } catch (err) {
    toast(err.message, false);
  }
}

function renderStats(d) {
  const ten = $('#tenant');
  if (d.scope === 'tenant' && d.tenant) {
    const t = d.tenant;
    ten.classList.remove('hidden');
    ten.innerHTML =
      `<div class="t-row"><span>租户</span><b>${esc(t.tenant_id)}</b></div>` +
      `<div class="t-row"><span>名称</span><b>${esc(t.name || '-')}</b></div>` +
      `<div class="t-row"><span>套餐</span><b>${esc(t.plan || '-')}</b></div>` +
      `<div class="t-row"><span>配额</span><b>${esc(t.quota ?? '-')}</b></div>`;
  } else {
    ten.classList.add('hidden');
  }

  const cards = $('#cards');
  cards.innerHTML = '';
  const counts = d.counts || (d.totals ? d.totals : {});
  for (const [k, label] of Object.entries(LABELS)) {
    const v = counts[k] ?? 0;
    const card = document.createElement('div');
    card.className = 'card-stat';
    card.innerHTML = `<div class="num">${v}</div><div class="lab">${label}</div>`;
    cards.appendChild(card);
  }
  if (d.scope === 'platform') {
    const hint = document.createElement('p');
    hint.className = 'empty';
    hint.textContent = `平台级视图：${(d.tenants || []).length} 个租户`;
    cards.appendChild(hint);
  }
}

// ===== 用户账号 =====
async function loadUsers() {
  const body = $('#users-body');
  body.innerHTML = '<tr><td colspan="5" class="empty">加载中…</td></tr>';
  try {
    const list = await api('/api/t4data/users');
    if (!list.length) { body.innerHTML = '<tr><td colspan="5" class="empty">暂无用户</td></tr>'; return; }
    body.innerHTML = '';
    for (const u of list) {
      const tr = document.createElement('tr');
      const disabled = u.status !== 'active';
      tr.innerHTML =
        `<td>${esc(u.email)}</td>` +
        `<td><span class="badge ${disabled ? 'bad' : 'ok'}">${disabled ? '已禁用' : '正常'}</span></td>` +
        `<td>${esc(u.provider || 'native')}</td>` +
        `<td>${fmtTime(u.created_at)}</td>` +
        `<td><button class="ghost sm act" data-act="status" data-id="${esc(u.id)}" data-status="${disabled ? 'active' : 'disabled'}">${disabled ? '启用' : '禁用'}</button> <button class="ghost sm act" data-act="reset" data-id="${esc(u.id)}">重置密码</button></td>`;
      body.appendChild(tr);
    }
    body.querySelectorAll('.act').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.act === 'reset') resetUser(b.dataset.id);
        else setUserStatus(b.dataset.id, b.dataset.status);
      })
    );
  } catch (err) {
    body.innerHTML = `<tr><td colspan="5" class="empty">${esc(err.message)}</td></tr>`;
  }
}

async function setUserStatus(id, status) {
  try {
    await api('/api/t4data/users/' + encodeURIComponent(id) + '/status', {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
    toast(status === 'active' ? '已启用' : '已禁用');
    loadUsers();
  } catch (err) {
    toast(err.message, false);
  }
}

async function resetUser(id) {
  const np = prompt('为该用户设置新密码（至少 8 位）：');
  if (!np) return;
  if (np.length < 8) { toast('密码至少 8 位', false); return; }
  try {
    await api('/api/t4data/users/' + encodeURIComponent(id) + '/reset', {
      method: 'POST',
      body: JSON.stringify({ new_password: np }),
    });
    toast('已重置，请线下将新密码告知对方');
    loadUsers();
  } catch (err) {
    toast(err.message, false);
  }
}

// ===== 服务密钥 =====
async function loadKeys() {
  const body = $('#keys-body');
  body.innerHTML = '<tr><td colspan="7" class="empty">加载中…</td></tr>';
  try {
    const list = await api('/api/t4data/keys');
    if (!list.length) { body.innerHTML = '<tr><td colspan="7" class="empty">暂无密钥</td></tr>'; return; }
    body.innerHTML = '';
    for (const k of list) {
      const tr = document.createElement('tr');
      const revoked = k.status !== 'active';
      const who = [k.label, k.used_by].filter(Boolean).join(' · ') || '-';
      const note = k.note ? `<div class="knote">${esc(k.note)}</div>` : '';
      tr.innerHTML =
        `<td><code>${esc(k.id)}</code></td>` +
        `<td>${esc(who)}${note}</td>` +
        `<td>${esc((k.scope || []).join(', '))}</td>` +
        `<td><span class="badge ${revoked ? 'bad' : 'ok'}">${revoked ? '已吊销' : '有效'}</span></td>` +
        `<td>${fmtTime(k.created_at)}</td>` +
        `<td>${fmtTime(k.expires_at) || (k.expires_at ? esc(k.expires_at) : '长期')}</td>` +
        `<td>${revoked ? '' : '<button class="ghost sm act" data-act="revoke" data-id="' + esc(k.id) + '">吊销</button> <button class="ghost sm act" data-act="edit" data-id="' + esc(k.id) + '">备注</button>'}</td>`;
      body.appendChild(tr);
    }
    body.querySelectorAll('.act').forEach((b) =>
      b.addEventListener('click', () => {
        if (b.dataset.act === 'revoke') revokeKey(b.dataset.id);
        else editKeyMeta(b.dataset.id);
      })
    );
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="empty">${esc(err.message)}</td></tr>`;
  }
}

async function issueKey() {
  try {
    const k = await api('/api/t4data/keys', { method: 'POST', body: JSON.stringify({ scope: ['data:read', 'data:write'] }) });
    $('#key-secret-val').textContent = k.raw_secret;
    $('#key-secret').classList.remove('hidden');
    toast('密钥已签发');
    loadKeys();
  } catch (err) {
    toast(err.message, false);
  }
}

async function revokeKey(id) {
  if (!confirm('确认吊销该密钥？吊销后依赖它的 MCP/Skill 将立刻失效。')) return;
  try {
    await api('/api/t4data/keys/' + encodeURIComponent(id) + '/revoke', { method: 'POST' });
    toast('已吊销');
    loadKeys();
  } catch (err) {
    toast(err.message, false);
  }
}

// 编辑密钥备注 / 使用者 / 有效期（不改动 secret 与 scope）
async function editKeyMeta(id) {
  const label = prompt('备注名称（label，如 cloudlet 运维 agent）：');
  if (label === null) return;
  const usedBy = prompt('使用者（used_by，如 CodeBuddy agent）：') || '';
  const note = prompt('自由备注（note）：') || '';
  const expStr = prompt('有效期时间戳（留空=长期）：') || '';
  const expiresAt = expStr.trim() ? Number(expStr.trim()) : null;
  try {
    await api('/api/t4data/keys/' + encodeURIComponent(id) + '/meta', {
      method: 'POST',
      body: JSON.stringify({ label, used_by: usedBy, note, expires_at: expiresAt }),
    });
    toast('备注已更新');
    loadKeys();
  } catch (err) {
    toast(err.message, false);
  }
}

// 签出访问令牌：网关代签一个可直接粘贴的 T3 Bearer 给 agent 使用
async function mintToken() {
  const tenant = $('#mint-tenant').value;
  const scope = $('#mint-scope').value;
  const ttl = Number($('#mint-ttl').value) || 86400;
  const note = $('#mint-note').value.trim();
  const btn = $('#mint-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/t4data/tokens/mint', {
      method: 'POST',
      body: JSON.stringify({ tenant, scope, ttl, note }),
    });
    $('#mint-token').textContent = r.token;
    $('#mint-usage').textContent = r.usage || '';
    $('#mint-result').classList.remove('hidden');
    toast('令牌已签出（仅显示一次）');
  } catch (err) {
    toast(err.message, false);
  } finally {
    btn.disabled = false;
  }
}
function copyMint() {
  const v = $('#mint-token').textContent;
  navigator.clipboard?.writeText(v).then(() => toast('已复制')).catch(() => toast('复制失败，请手动选择', false));
}

function copySecret() {
  const v = $('#key-secret-val').textContent;
  navigator.clipboard?.writeText(v).then(() => toast('已复制')).catch(() => toast('复制失败，请手动选择', false));
}

// ===== 数据浏览器 =====
const DATA_TABLES = {
  todos: {
    label: '待办',
    cols: [['id', 'ID'], ['owner_openid', '归属'], ['tenant_id', '租户'], ['title', '标题'], ['meta', 'meta'], ['tag', '标签'], ['dot', '圆点'], ['shared', '共享'], ['co_edit', '协作'], ['family_id', '家庭'], ['updated_at', '更新']],
    edit: ['title', 'meta', 'tag', 'dot', 'shared', 'family_id'],
    json: ['meta'],
  },
  archive_items: {
    label: '归档',
    cols: [['id', 'ID'], ['owner_openid', '归属'], ['tenant_id', '租户'], ['type', '类型'], ['payload', 'payload'], ['shared', '共享'], ['co_edit', '协作'], ['family_id', '家庭'], ['created_at', '创建'], ['updated_at', '更新']],
    edit: ['type', 'payload', 'shared', 'family_id'],
    json: ['payload'],
  },
  collections: {
    label: '通用集合',
    cols: [['id', 'ID'], ['collection', '集合'], ['owner_openid', '归属'], ['tenant_id', '租户'], ['doc', 'doc'], ['updated_at', '更新']],
    edit: ['doc'],
    json: ['doc'],
  },
  families: {
    label: '家庭',
    cols: [['family_id', '家庭 ID'], ['tenant_id', '租户'], ['name', '名称'], ['owner_openid', '创建者'], ['created_at', '创建']],
    edit: [],
    json: [],
  },
  family_members: {
    label: '家庭成员',
    cols: [['family_id', '家庭 ID'], ['openid', '成员 openid'], ['role', '角色'], ['nickname', '昵称'], ['invited_by', '邀请人'], ['joined_at', '加入']],
    edit: [],
    json: [],
  },
  family_invites: {
    label: '家庭邀请',
    cols: [['code', '邀请码'], ['family_id', '家庭 ID'], ['inviter_openid', '邀请人'], ['created_at', '创建'], ['expires_at', '过期'], ['used_at', '已使用']],
    edit: [],
    json: [],
  },
  tasks_doc: {
    label: '任务文档',
    cols: [['tenant_id', '租户'], ['owner_openid', '归属'], ['sections', 'sections'], ['updated_at', '更新']],
    edit: [],
    json: ['sections'],
  },
};

const dataState = { table: 'todos', q: '', owner: '', tid: '', limit: 20, offset: 0, total: 0 };

function fmtCell(v) {
  if (v === null || v === undefined || v === '') return '-';
  if (typeof v === 'object') {
    let s;
    try { s = JSON.stringify(v); } catch { s = String(v); }
    return s.length > 80 ? `<span title="${esc(s)}">${esc(s.slice(0, 80))}…</span>` : esc(s);
  }
  if (typeof v === 'boolean') return v ? '是' : '否';
  return esc(String(v));
}

// 平台管理员：填充数据浏览器的租户下拉；tenant 角色不会显示该控件。
// 复用 /api/t4data/stats 返回的 d.tenants（数据湖无独立 /admin/tenants 端点，单独调用会 404）。
async function loadDataTenants() {
  const sel = $('#data-tenant');
  if (!sel) return;
  try {
    const d = await api('/api/t4data/stats');
    const list = (d && d.tenants) || [];
    sel.innerHTML =
      '<option value="">全部租户</option>' +
      list.map((t) => {
        const tt = t.tenant || t; // stats 返回 {tenant,counts}，兜底兼容裸对象
        return `<option value="${esc(tt.tenant_id)}">${esc(tt.name || tt.tenant_id)}</option>`;
      }).join('');
    sel.classList.remove('hidden');
  } catch (err) {
    console.warn('加载租户列表失败', err);
  }
}

function dataHead() {
  const t = DATA_TABLES[dataState.table];
  let h = '<tr><th>操作</th>';
  for (const [, label] of t.cols) h += `<th>${label}</th>`;
  $('#data-head').innerHTML = h + '</tr>';
}

async function loadData() {
  const t = DATA_TABLES[dataState.table];
  const body = $('#data-body');
  body.innerHTML = `<tr><td class="empty" colspan="${t.cols.length + 1}">加载中…</td></tr>`;
  try {
    const params = new URLSearchParams({ limit: dataState.limit, offset: dataState.offset });
    if (dataState.q) params.set('q', dataState.q);
    if (dataState.owner) params.set('owner', dataState.owner);
    if (dataState.tid) params.set('tid', dataState.tid);
    const d = await api(`/api/t4data/rows/${dataState.table}?${params.toString()}`);
    dataState.total = d.total;
    if (!d.rows.length) {
      body.innerHTML = `<tr><td class="empty" colspan="${t.cols.length + 1}">暂无数据</td></tr>`;
    } else {
      body.innerHTML = '';
      for (const row of d.rows) {
        const tr = document.createElement('tr');
        // id 在不同集合间会撞车（如 cloudlet_saves/cloudlet_accounts 同用 accountId），
        // 必须用 集合:id 作唯一键，否则 querySelector 会命中另一条
        tr.dataset.row = (row.collection || '') + '‡' + row.id;
        // 编辑/删除按钮仅 platform 管理员可见：tenant 仅只读（后端 PUT/DELETE 已收限 platform），
        // 避免 tenant 看到可点按钮却必然失败，造成困惑。
        const canEdit = t.edit.length && ADMIN_ROLE === 'platform';
        let cells = `<td class="row-actions">${canEdit ? `<button class="ghost sm act" data-act="edit" data-id="${esc(row.id)}" data-coll="${esc(row.collection || '')}">编辑</button> <button class="ghost sm act danger" data-act="del" data-id="${esc(row.id)}" data-coll="${esc(row.collection || '')}">删除</button>` : (t.edit.length ? '<span class="empty">只读（需平台管理员）</span>' : '<span class="empty">只读</span>')}</td>`;
        for (const [k] of t.cols) cells += `<td>${fmtCell(row[k])}</td>`;
        tr.innerHTML = cells;
        body.appendChild(tr);
      }
      body.querySelectorAll('.act').forEach((b) =>
        b.addEventListener('click', () => {
          const tr = b.closest('tr');
          if (b.dataset.act === 'del') delRow(b.dataset.id, b.dataset.coll, tr);
          else editRow(b.dataset.id, b.dataset.coll, tr);
        })
      );
    }
  } catch (err) {
    body.innerHTML = `<tr><td class="empty" colspan="${t.cols.length + 1}">${esc(err.message)}</td></tr>`;
  }
  renderPager();
  $('#data-meta').textContent = `共 ${dataState.total} 条 · 第 ${Math.floor(dataState.offset / dataState.limit) + 1} 页`;
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(dataState.total / dataState.limit));
  const cur = Math.floor(dataState.offset / dataState.limit) + 1;
  $('#data-pager').innerHTML =
    `<button class="ghost sm" id="pg-prev" ${cur <= 1 ? 'disabled' : ''}>‹ 上一页</button>` +
    `<span class="pg-info">第 ${cur} / ${pages} 页</span>` +
    `<button class="ghost sm" id="pg-next" ${cur >= pages ? 'disabled' : ''}>下一页 ›</button>` +
    `<select id="pg-size" class="sm-select"><option value="20"${dataState.limit === 20 ? ' selected' : ''}>20/页</option><option value="50"${dataState.limit === 50 ? ' selected' : ''}>50/页</option><option value="100"${dataState.limit === 100 ? ' selected' : ''}>100/页</option></select>`;
  const prev = $('#pg-prev'), next = $('#pg-next'), size = $('#pg-size');
  if (prev) prev.addEventListener('click', () => { dataState.offset = Math.max(0, dataState.offset - dataState.limit); loadData(); });
  if (next) next.addEventListener('click', () => { dataState.offset += dataState.limit; loadData(); });
  if (size) size.addEventListener('change', () => { dataState.limit = +size.value; dataState.offset = 0; loadData(); });
}

async function editRow(id, coll, target) {
  const t = DATA_TABLES[dataState.table];
  if (!target) return;
  coll = coll || '';
  // 已有编辑行则先收起
  const existing = document.querySelector('#data-body tr.edit-row');
  if (existing) existing.remove();

  let row;
  try {
    row = await api(`/api/t4data/rows/${dataState.table}/${encodeURIComponent(id)}?collection=${encodeURIComponent(coll)}`);
  } catch (err) {
    toast(err.message, false);
    return;
  }

  let fields = '';
  for (const col of t.edit) {
    const v = row[col];
    let input;
    const isJson = t.json.includes(col);
    if (isJson) {
      let txt = '';
      try { txt = JSON.stringify(v, null, 2); } catch { txt = String(v ?? ''); }
      input = `<textarea data-f="${col}" rows="3">${esc(txt)}</textarea>`;
    } else if (col === 'shared') {
      const on = !!v;
      input = `<select data-f="${col}"><option value="1"${on ? ' selected' : ''}>是</option><option value="0"${!on ? ' selected' : ''}>否</option></select>`;
    } else {
      input = `<input type="text" data-f="${col}" value="${esc(v ?? '')}" />`;
    }
    fields += `<label class="${isJson ? 'full' : ''}"><span>${col}</span>${input}</label>`;
  }
  if (!fields) fields = '<p class="empty">该表只读，不可编辑</p>';

  const tr = document.createElement('tr');
  tr.className = 'edit-row';
  tr.innerHTML =
    `<td colspan="${t.cols.length + 1}"><div class="edit-form">` +
    `<div class="edit-grid">${fields}</div>` +
    `<div class="edit-actions"><button class="primary sm" id="edit-save">保存</button>` +
    `<button class="ghost sm" id="edit-cancel">取消</button><span class="err" id="edit-msg"></span></div>` +
    `</div></td>`;
  target.after(tr);

  $('#edit-cancel').addEventListener('click', () => tr.remove());
  $('#edit-save').addEventListener('click', async () => {
    const payload = {};
    const msg = $('#edit-msg');
    msg.textContent = '';
    for (const col of t.edit) {
      const el = tr.querySelector(`[data-f="${col}"]`);
      const raw = el.value;
      if (t.json.includes(col)) {
        try { payload[col] = JSON.parse(raw); } catch { msg.textContent = `${col} 不是合法 JSON`; return; }
      } else if (col === 'shared') {
        payload[col] = raw === '1';
      } else {
        payload[col] = raw;
      }
    }
    try {
      await api(`/api/t4data/rows/${dataState.table}/${encodeURIComponent(id)}?collection=${encodeURIComponent(coll)}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已保存');
      tr.remove();
      loadData();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

async function delRow(id, coll, target) {
  coll = coll || '';
  if (!confirm(`确认删除 ${dataState.table} 中的记录 ${id}？此操作不可恢复。`)) return;
  try {
    await api(`/api/t4data/rows/${dataState.table}/${encodeURIComponent(id)}?collection=${encodeURIComponent(coll)}`, { method: 'DELETE' });
    toast('已删除');
    loadData();
  } catch (err) {
    toast(err.message, false);
  }
}

// ===== 数据导出（CSV / JSON）=====
function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function rowsToCsv(rows) {
  const cols = DATA_TABLES[dataState.table].cols.map(([k]) => k);
  const head = cols.join(',');
  const body = rows.map((r) => cols.map((k) => csvCell(r[k])).join(',')).join('\n');
  return head + '\n' + body;
}

async function exportData(fmt) {
  try {
    const params = new URLSearchParams();
    if (dataState.q) params.set('q', dataState.q);
    if (dataState.owner) params.set('owner', dataState.owner);
    if (dataState.tid) params.set('tid', dataState.tid);
    const d = await api(`/api/t4data/rows/${dataState.table}/export?${params.toString()}`);
    if (!d.rows.length) { toast('无数据可导出', false); return; }
    const date = new Date().toISOString().slice(0, 10);
    if (fmt === 'json') {
      downloadBlob(JSON.stringify(d.rows, null, 2), `${dataState.table}-${date}.json`, 'application/json');
    } else {
      // BOM 前缀保证 Excel 正确识别 UTF-8 中文
      downloadBlob('\ufeff' + rowsToCsv(d.rows), `${dataState.table}-${date}.csv`, 'text/csv;charset=utf-8');
    }
    toast(`已导出 ${d.rows.length} 条${d.truncated ? '（超过上限已截断）' : ''}`);
  } catch (err) {
    toast(err.message, false);
  }
}

// ===== 用户与家庭（openid 画像）=====
const profilesState = { q: '', limit: 20, offset: 0, total: 0 };

async function loadProfiles() {
  const body = $('#profiles-body');
  body.innerHTML = '<tr><td colspan="8" class="empty">加载中…</td></tr>';
  // 每次进列表都回到列表视图（清掉可能残留的详情）
  showProfilesView('list');
  try {
    const params = new URLSearchParams({ limit: profilesState.limit, offset: profilesState.offset });
    if (profilesState.q) params.set('q', profilesState.q);
    const d = await api(`/api/t4data/profiles?${params.toString()}`);
    profilesState.total = d.total;
    if (!d.rows.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">暂无用户</td></tr>';
    } else {
      body.innerHTML = '';
      for (const p of d.rows) {
        const tr = document.createElement('tr');
        tr.innerHTML =
          `<td><code>${esc(p.openid)}</code></td>` +
          `<td>${esc(p.nickname || '-')}</td>` +
          `<td>${p.todos}</td><td>${p.archives}</td><td>${p.collections}</td><td>${p.families}</td>` +
          `<td>${fmtTime(p.last_active)}</td>` +
          `<td><button class="ghost sm pd-open" data-oid="${esc(p.openid)}">详情</button></td>`;
        body.appendChild(tr);
      }
      body.querySelectorAll('.pd-open').forEach((b) =>
        b.addEventListener('click', () => showProfileDetail(b.dataset.oid))
      );
    }
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" class="empty">${esc(err.message)}</td></tr>`;
  }
  renderProfilesPager();
  $('#profiles-meta').textContent = `共 ${profilesState.total} 位用户 · 第 ${Math.floor(profilesState.offset / profilesState.limit) + 1} 页`;
}

function renderProfilesPager() {
  const pages = Math.max(1, Math.ceil(profilesState.total / profilesState.limit));
  const cur = Math.floor(profilesState.offset / profilesState.limit) + 1;
  $('#profiles-pager').innerHTML =
    `<button class="ghost sm" id="ppg-prev" ${cur <= 1 ? 'disabled' : ''}>‹ 上一页</button>` +
    `<span class="pg-info">第 ${cur} / ${pages} 页</span>` +
    `<button class="ghost sm" id="ppg-next" ${cur >= pages ? 'disabled' : ''}>下一页 ›</button>`;
  const prev = $('#ppg-prev'), next = $('#ppg-next');
  if (prev) prev.addEventListener('click', () => { profilesState.offset = Math.max(0, profilesState.offset - profilesState.limit); loadProfiles(); });
  if (next) next.addEventListener('click', () => { profilesState.offset += profilesState.limit; loadProfiles(); });
}

// 视图切换：list / profile / family（family 由用户详情下钻进入）
function showProfilesView(view) {
  $('#profiles-list').classList.toggle('hidden', view !== 'list');
  const d = $('#profiles-detail');
  d.classList.toggle('hidden', view === 'list');
  if (view === 'list') d.innerHTML = '';
}

// 用户详情：聚合该 openid 的家庭关系 + 三类业务数据（均走 rows 端点 owner 过滤）
async function showProfileDetail(openid) {
  showProfilesView('profile');
  const box = $('#profiles-detail');
  box.innerHTML = '<p class="empty">加载中…</p>';
  try {
    const [famRes, todoRes, archRes, collRes] = await Promise.all([
      api(`/api/t4data/rows/family_members?owner=${encodeURIComponent(openid)}&limit=50`),
      api(`/api/t4data/rows/todos?owner=${encodeURIComponent(openid)}&limit=10`),
      api(`/api/t4data/rows/archive_items?owner=${encodeURIComponent(openid)}&limit=10`),
      api(`/api/t4data/rows/collections?owner=${encodeURIComponent(openid)}&limit=10`),
    ]);
    // 家庭名称：按 membership 的 family_id 逐个查（每人 ≤3 个家庭）
    const memberships = famRes.rows || [];
    const famInfos = await Promise.all(
      memberships.map((m) => api(`/api/t4data/rows/families?fam=${encodeURIComponent(m.family_id)}&limit=1`).then((r) => r.rows[0] || null).catch(() => null))
    );

    const famRows = memberships.map((m, i) => {
      const f = famInfos[i];
      return `<tr>` +
        `<td><a class="pd-fam link" data-fid="${esc(m.family_id)}">${esc(f && f.name ? f.name : m.family_id)}</a></td>` +
        `<td><code>${esc(m.family_id)}</code></td>` +
        `<td>${m.role === 'owner' ? '<span class="badge ok">创建者</span>' : '成员'}</td>` +
        `<td>${esc(m.nickname || '-')}</td>` +
        `<td>${fmtTime(m.joined_at)}</td></tr>`;
    }).join('');

    const mini = (rows, cols) => rows.map((r) =>
      '<tr>' + cols.map(([k]) => `<td>${fmtCell(r[k])}</td>`).join('') + '</tr>'
    ).join('') || '<tr><td class="empty" colspan="' + cols.length + '">无数据</td></tr>';

    box.innerHTML =
      `<div class="panel-head"><h2>用户详情</h2><button class="ghost sm" id="pd-back">‹ 返回列表</button></div>` +
      `<div class="t-row"><span>openid</span><b><code>${esc(openid)}</code></b></div>` +
      `<div class="pd-sec"><h3>家庭关系（${memberships.length}）</h3>` +
      `<div class="table-wrap"><table class="tbl"><thead><tr><th>家庭</th><th>家庭 ID</th><th>角色</th><th>昵称</th><th>加入时间</th></tr></thead><tbody>${famRows}</tbody></table></div></div>` +
      `<div class="pd-sec"><h3>待办（共 ${todoRes.total}）</h3>` +
      `<div class="table-wrap"><table class="tbl"><thead><tr><th>标题</th><th>标签</th><th>共享</th><th>家庭</th><th>更新</th></tr></thead><tbody>${mini(todoRes.rows || [], [['title'], ['tag'], ['shared'], ['family_id'], ['updated_at']])}</tbody></table></div></div>` +
      `<div class="pd-sec"><h3>归档（共 ${archRes.total}）</h3>` +
      `<div class="table-wrap"><table class="tbl"><thead><tr><th>类型</th><th>共享</th><th>家庭</th><th>创建</th></tr></thead><tbody>${mini(archRes.rows || [], [['type'], ['shared'], ['family_id'], ['created_at']])}</tbody></table></div></div>` +
      `<div class="pd-sec"><h3>集合（共 ${collRes.total}）</h3>` +
      `<div class="table-wrap"><table class="tbl"><thead><tr><th>集合</th><th>更新</th></tr></thead><tbody>${mini(collRes.rows || [], [['collection'], ['updated_at']])}</tbody></table></div></div>`;

    $('#pd-back').addEventListener('click', () => showProfilesView('list'));
    box.querySelectorAll('.pd-fam').forEach((a) =>
      a.addEventListener('click', () => showFamilyDetail(a.dataset.fid, openid))
    );
  } catch (err) {
    box.innerHTML = `<p class="empty">${esc(err.message)}</p><button class="ghost sm" id="pd-back">‹ 返回列表</button>`;
    $('#pd-back').addEventListener('click', () => showProfilesView('list'));
  }
}

// 家庭详情：从用户详情下钻，看家庭信息 + 全部成员 + 邀请记录
async function showFamilyDetail(familyId, backOpenid) {
  showProfilesView('family');
  const box = $('#profiles-detail');
  box.innerHTML = '<p class="empty">加载中…</p>';
  try {
    const [famRes, memRes, invRes] = await Promise.all([
      api(`/api/t4data/rows/families?fam=${encodeURIComponent(familyId)}&limit=1`),
      api(`/api/t4data/rows/family_members?fam=${encodeURIComponent(familyId)}&limit=100`),
      api(`/api/t4data/rows/family_invites?fam=${encodeURIComponent(familyId)}&limit=100`),
    ]);
    const f = famRes.rows[0];
    const members = memRes.rows || [];
    const invites = invRes.rows || [];
    const now = Date.now();
    const memRows = members.map((m) =>
      `<tr><td><code>${esc(m.openid)}</code></td>` +
      `<td>${m.role === 'owner' ? '<span class="badge ok">创建者</span>' : '成员'}</td>` +
      `<td>${esc(m.nickname || '-')}</td>` +
      `<td><code>${esc(m.invited_by || '-')}</code></td>` +
      `<td>${fmtTime(m.joined_at)}</td></tr>`
    ).join('');
    const invRows = invites.map((iv) => {
      const state = iv.used_at ? '<span class="badge">已使用</span>' : (iv.expires_at && iv.expires_at < now ? '<span class="badge bad">已过期</span>' : '<span class="badge ok">有效</span>');
      return `<tr><td><code>${esc(iv.code)}</code></td><td><code>${esc(iv.inviter_openid)}</code></td><td>${state}</td><td>${fmtTime(iv.created_at)}</td><td>${fmtTime(iv.expires_at)}</td><td>${fmtTime(iv.used_at)}</td></tr>`;
    }).join('');

    box.innerHTML =
      `<div class="panel-head"><h2>家庭详情</h2><button class="ghost sm" id="pd-back">‹ 返回用户详情</button></div>` +
      (f
        ? `<div class="t-row"><span>名称</span><b>${esc(f.name || '-')}</b></div>` +
          `<div class="t-row"><span>家庭 ID</span><b><code>${esc(f.family_id)}</code></b></div>` +
          `<div class="t-row"><span>创建者</span><b><code>${esc(f.owner_openid)}</code></b></div>` +
          `<div class="t-row"><span>创建时间</span><b>${fmtTime(f.created_at)}</b></div>`
        : '<p class="empty">家庭记录不存在或不在当前租户范围</p>') +
      `<div class="pd-sec"><h3>成员（${members.length}）</h3>` +
      `<div class="table-wrap"><table class="tbl"><thead><tr><th>成员 openid</th><th>角色</th><th>昵称</th><th>邀请人</th><th>加入时间</th></tr></thead><tbody>${memRows || '<tr><td class="empty" colspan="5">无成员</td></tr>'}</tbody></table></div></div>` +
      `<div class="pd-sec"><h3>邀请记录（${invites.length}）</h3>` +
      `<div class="table-wrap"><table class="tbl"><thead><tr><th>邀请码</th><th>邀请人</th><th>状态</th><th>创建</th><th>过期</th><th>使用</th></tr></thead><tbody>${invRows || '<tr><td class="empty" colspan="6">无邀请记录</td></tr>'}</tbody></table></div></div>`;

    $('#pd-back').addEventListener('click', () => showProfileDetail(backOpenid));
  } catch (err) {
    box.innerHTML = `<p class="empty">${esc(err.message)}</p><button class="ghost sm" id="pd-back">‹ 返回用户详情</button>`;
    $('#pd-back').addEventListener('click', () => showProfileDetail(backOpenid));
  }
}

// ===== 审计日志 =====
const AUDIT_LABELS = {
  'password.change': '改密',
  'user.status': '用户启停',
  'key.issue': '签发密钥',
  'key.revoke': '吊销密钥',
  'row.update': '编辑数据',
  'row.delete': '删除数据',
};
const auditState = { action: '', limit: 20, offset: 0, total: 0 };

async function loadAudit() {
  const body = $('#audit-body');
  body.innerHTML = '<tr><td colspan="6" class="empty">加载中…</td></tr>';
  try {
    const params = new URLSearchParams({ limit: auditState.limit, offset: auditState.offset });
    if (auditState.action) params.set('action', auditState.action);
    const d = await api(`/api/t4data/audit?${params.toString()}`);
    auditState.total = d.total;
    if (!d.rows.length) {
      body.innerHTML = '<tr><td colspan="6" class="empty">暂无审计记录</td></tr>';
    } else {
      body.innerHTML = '';
      for (const r of d.rows) {
        const tr = document.createElement('tr');
        let detail = '-';
        if (r.detail !== null && r.detail !== undefined) {
          detail = typeof r.detail === 'object' ? JSON.stringify(r.detail) : String(r.detail);
          if (detail.length > 60) detail = detail.slice(0, 60) + '…';
        }
        tr.innerHTML =
          `<td>${fmtTime(r.created_at)}</td>` +
          `<td>${esc(r.admin_id || '-')}</td>` +
          `<td><span class="badge ok">${esc(AUDIT_LABELS[r.action] || r.action)}</span></td>` +
          `<td><code>${esc(r.target || '-')}</code></td>` +
          `<td>${esc(detail)}</td>` +
          `<td>${esc(r.ip || '-')}</td>`;
        body.appendChild(tr);
      }
    }
  } catch (err) {
    body.innerHTML = `<tr><td colspan="6" class="empty">${esc(err.message)}</td></tr>`;
  }
  renderAuditPager();
  $('#audit-meta').textContent = `共 ${auditState.total} 条 · 第 ${Math.floor(auditState.offset / auditState.limit) + 1} 页`;
}

function renderAuditPager() {
  const pages = Math.max(1, Math.ceil(auditState.total / auditState.limit));
  const cur = Math.floor(auditState.offset / auditState.limit) + 1;
  $('#audit-pager').innerHTML =
    `<button class="ghost sm" id="apg-prev" ${cur <= 1 ? 'disabled' : ''}>‹ 上一页</button>` +
    `<span class="pg-info">第 ${cur} / ${pages} 页</span>` +
    `<button class="ghost sm" id="apg-next" ${cur >= pages ? 'disabled' : ''}>下一页 ›</button>`;
  const prev = $('#apg-prev'), next = $('#apg-next');
  if (prev) prev.addEventListener('click', () => { auditState.offset = Math.max(0, auditState.offset - auditState.limit); loadAudit(); });
  if (next) next.addEventListener('click', () => { auditState.offset += auditState.limit; loadAudit(); });
}

// ===== 安全：改密 =====
async function changePassword(e) {
  e.preventDefault();
  const oldp = $('#pw-old').value;
  const newp = $('#pw-new').value;
  const conf = $('#pw-confirm').value;
  $('#pw-msg').textContent = '';
  if (newp.length < 8) { $('#pw-msg').textContent = '新密码至少 8 位'; return; }
  if (newp !== conf) { $('#pw-msg').textContent = '两次输入不一致'; return; }
  $('#pw-btn').disabled = true;
  try {
    await api('/api/t4data/me/password', {
      method: 'POST',
      body: JSON.stringify({ old_password: oldp, new_password: newp }),
    });
    $('#pw-old').value = ''; $('#pw-new').value = ''; $('#pw-confirm').value = '';
    toast('密码已更新');
  } catch (err) {
    $('#pw-msg').textContent = err.message;
  } finally {
    $('#pw-btn').disabled = false;
  }
}

// ===== 标签切换 =====
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
  $('#panel-' + name).classList.remove('hidden');
  if (name === 'data') { dataHead(); loadData(); }
  if (name === 'profiles') loadProfiles();
  if (name === 'users') loadUsers();
  if (name === 'keys') { $('#key-secret').classList.add('hidden'); loadKeys(); }
  if (name === 'audit') loadAudit();
  if (name === 'admins') loadAdmins();
  if (name === 'deployauth') loadDeployAuth();
}

function logout() {
  clearToken();
  showLogin();
  toast('已退出');
}

// ===== 忘记密码（公开，无令牌）=====
function showForgot() {
  $('#login-form').classList.add('hidden');
  $('#login-forgot').classList.add('hidden');
  $('#forgot-form').classList.remove('hidden');
  $('#forgot-err').textContent = '';
}
function showLoginForm() {
  $('#forgot-form').classList.add('hidden');
  $('#login-form').classList.remove('hidden');
  $('#login-forgot').classList.remove('hidden');
}
async function submitForgot(e) {
  e.preventDefault();
  const email = $('#f-email').value.trim();
  const code = $('#f-code').value.trim();
  const pw = $('#f-pw').value;
  const pw2 = $('#f-pw2').value;
  $('#forgot-err').textContent = '';
  if (pw !== pw2) { $('#forgot-err').textContent = '两次密码不一致'; return; }
  if (pw.length < 8) { $('#forgot-err').textContent = '新密码至少 8 位'; return; }
  $('#forgot-btn').disabled = true;
  try {
    const r = await fetch(API + '/api/admin/recover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, recovery_code: code, new_password: pw }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '重置失败 ' + r.status);
    toast('密码已重置，请使用新密码登录');
    showLoginForm();
    $('#forgot-form').reset();
  } catch (err) {
    $('#forgot-err').textContent = err.message;
  } finally {
    $('#forgot-btn').disabled = false;
  }
}

// ===== 账户恢复码（登录态）=====
async function generateRecovery() {
  try {
    const k = await api('/api/t4data/me/recovery/generate', { method: 'POST' });
    $('#rc-val').textContent = k.recovery_code;
    $('#rc-box').classList.remove('hidden');
    toast('恢复码已生成（旧码已作废）');
  } catch (err) {
    toast(err.message, false);
  }
}
function copyRecovery() {
  const v = $('#rc-val').textContent;
  navigator.clipboard?.writeText(v).then(() => toast('已复制')).catch(() => toast('复制失败，请手动选择', false));
}

// ===== 管理员管理（platform）=====
async function loadAdmins() {
  const body = $('#admins-body');
  body.innerHTML = '<tr><td colspan="5" class="empty">加载中…</td></tr>';
  try {
    const list = await api('/api/t4data/accounts');
    if (!list.length) { body.innerHTML = '<tr><td colspan="5" class="empty">暂无其他管理员</td></tr>'; return; }
    body.innerHTML = '';
    for (const a of list) {
      const tr = document.createElement('tr');
      const disabled = a.status !== 'active';
      tr.innerHTML =
        `<td>${esc(a.email)}</td>` +
        `<td>${esc(a.role || 'tenant')}</td>` +
        `<td><span class="badge ${disabled ? 'bad' : 'ok'}">${disabled ? '已禁用' : '正常'}</span></td>` +
        `<td>${fmtTime(a.created_at)}</td>` +
        `<td><button class="ghost sm act" data-id="${esc(a.id)}">代重置密码</button></td>`;
      body.appendChild(tr);
    }
    body.querySelectorAll('.act').forEach((b) =>
      b.addEventListener('click', () => resetAdmin(b.dataset.id))
    );
  } catch (err) {
    body.innerHTML = `<tr><td colspan="5" class="empty">${esc(err.message)}</td></tr>`;
  }
}

async function resetAdmin(id) {
  const np = prompt('为该管理员设置新密码（至少 8 位）：');
  if (!np) return;
  if (np.length < 8) { toast('密码至少 8 位', false); return; }
  try {
    await api('/api/t4data/accounts/' + encodeURIComponent(id) + '/reset', {
      method: 'POST',
      body: JSON.stringify({ new_password: np }),
    });
    toast('已重置，请线下将新密码告知对方');
    loadAdmins();
  } catch (err) {
    toast(err.message, false);
  }
}

// 绑定事件
$('#login-form').addEventListener('submit', login);
$('#logout').addEventListener('click', logout);
$('#login-forgot').addEventListener('click', showForgot);
$('#forgot-back').addEventListener('click', showLoginForm);
$('#forgot-form').addEventListener('submit', submitForgot);
$('#rc-gen').addEventListener('click', generateRecovery);
$('#rc-copy').addEventListener('click', copyRecovery);
$('#admins-refresh').addEventListener('click', loadAdmins);
$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t) switchTab(t.dataset.tab);
});
$('#users-refresh').addEventListener('click', loadUsers);
$('#key-issue').addEventListener('click', issueKey);
$('#key-secret-copy').addEventListener('click', copySecret);
$('#mint-btn').addEventListener('click', mintToken);
$('#mint-copy').addEventListener('click', copyMint);
$('#pw-form').addEventListener('submit', changePassword);
$('#ver-copy').addEventListener('click', copyVersion);
$('#deploy-btn').addEventListener('click', deploy);
$('#deploy-close').addEventListener('click', () => $('#deploy-overlay').classList.add('hidden'));

// 部署授权（Agent 临时令牌审批）
$('#da-refresh').addEventListener('click', loadDeployAuth);
$('#da-pending').addEventListener('click', async (e) => {
  const ap = e.target.getAttribute('data-approve');
  const rj = e.target.getAttribute('data-reject');
  if (ap) {
    const ttl = Number($('#da-ttl-' + ap).value) || 8;
    try {
      const r = await api('/api/t4data/agent-token/approve', { method: 'POST', body: JSON.stringify({ requestId: ap, ttl_hours: ttl }) });
      $('#da-token-val').textContent = r.token;
      $('#da-token').classList.remove('hidden');
      toast('已批准，令牌已激活');
      loadDeployAuth();
    } catch (err) { toast(err.message, false); }
  } else if (rj) {
    try { await api('/api/t4data/agent-token/reject', { method: 'POST', body: JSON.stringify({ requestId: rj }) }); toast('已拒绝'); loadDeployAuth(); }
    catch (err) { toast(err.message, false); }
  }
});
$('#da-token-copy').addEventListener('click', () => {
  const v = $('#da-token-val').textContent;
  navigator.clipboard?.writeText(v).then(() => toast('已复制')).catch(() => toast('复制失败', false));
});
$('#da-revoke').addEventListener('click', async () => {
  if (!confirm('确认吊销当前 Agent 部署令牌？Agent 正在进行的部署将立即失效。')) return;
  try { await api('/api/t4data/agent-token/revoke', { method: 'POST', body: '{}' }); $('#da-token').classList.add('hidden'); toast('已吊销'); loadDeployAuth(); }
  catch (err) { toast(err.message, false); }
});

// 数据浏览器事件
$('#data-table').addEventListener('change', (e) => {
  dataState.table = e.target.value;
  dataState.q = ''; dataState.offset = 0;
  $('#data-q').value = '';
  dataHead();
  loadData();
});
$('#data-search').addEventListener('click', () => { dataState.q = $('#data-q').value.trim(); dataState.owner = $('#data-owner').value.trim(); dataState.offset = 0; loadData(); });
$('#data-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { dataState.q = $('#data-q').value.trim(); dataState.owner = $('#data-owner').value.trim(); dataState.offset = 0; loadData(); } });
$('#data-owner').addEventListener('keydown', (e) => { if (e.key === 'Enter') { dataState.owner = $('#data-owner').value.trim(); dataState.q = $('#data-q').value.trim(); dataState.offset = 0; loadData(); } });
$('#data-refresh').addEventListener('click', () => { dataState.offset = 0; loadData(); });
$('#data-export-csv').addEventListener('click', () => exportData('csv'));
$('#data-export-json').addEventListener('click', () => exportData('json'));
$('#data-tenant').addEventListener('change', (e) => {
  dataState.tid = e.target.value;
  dataState.offset = 0;
  loadData();
});

// 用户与家庭事件
$('#profiles-search').addEventListener('click', () => { profilesState.q = $('#profiles-q').value.trim(); profilesState.offset = 0; loadProfiles(); });
$('#profiles-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { profilesState.q = $('#profiles-q').value.trim(); profilesState.offset = 0; loadProfiles(); } });
$('#profiles-refresh').addEventListener('click', () => { profilesState.offset = 0; loadProfiles(); });

// 审计日志事件
$('#audit-action').addEventListener('change', (e) => { auditState.action = e.target.value; auditState.offset = 0; loadAudit(); });
$('#audit-refresh').addEventListener('click', () => { auditState.offset = 0; loadAudit(); });

// 启动：拉取版本矩阵（网关 / 数据湖 / 小程序），填充 footer 与概览
async function loadVersion() {
  let gw = '', dl = '', mp = '';
  try {
    const r = await fetch(API + '/api/health');
    const j = await r.json().catch(() => ({}));
    dl = j.dataLakeGit || j.git || '';
    gw = j.gatewayGit || '';
    mp = j.miniappVersion || '';
  } catch (_) {}

  // 前端双版本号：语义版本 + 网关 git HEAD（SPA 随网关同源部署，可溯源到具体 commit）
  const spaVer = SPA_VERSION + (gw ? '.' + gw : '');
  // footer：前端 · 网关 · 数据湖
  $('#ver-front').textContent = spaVer;
  $('#ver-gw').textContent = gw || '未配置';
  $('#ver-dl').textContent = dl || '未配置';
  // 网关与数据湖部署自不同 commit → 配套异常，标红
  const mismatch = !!(gw && dl && gw !== dl);
  $('#deploy-btn').classList.toggle('warn', mismatch);
  $('#ver-gw').classList.toggle('warn', mismatch);
  $('#ver-dl').classList.toggle('warn', mismatch);

  // 概览版本矩阵
  $('#ver-sp2').textContent = spaVer;
  $('#ver-gw2').textContent = gw || '未配置';
  $('#ver-dl2').textContent = dl || '未配置';
  $('#ver-mp').textContent = mp || '未配置';
  $('#ver-mp').classList.toggle('warn', !mp);
}
loadVersion();

// 复制版本矩阵：前端 x.y.z.HEAD · 网关 xxx · 数据湖 yyy
function copyVersion() {
  const full = `前端 ${$('#ver-front').textContent} · 网关 ${$('#ver-gw').textContent} · 数据湖 ${$('#ver-dl').textContent}`;
  navigator.clipboard?.writeText(full)
    .then(() => toast('已复制版本 ' + full))
    .catch(() => toast('复制失败，请手动选择', false));
}

// 一键版本更新（异步轮询）：调 /api/t4data/deploy 触发，轮询
// /api/t4data/deploy/status/:id 展示实时日志，直到 success/failed。
const DEPLOY_READY = true;
let deployTimer = null;

function renderDeployOverlay(task) {
  const ov = $('#deploy-overlay');
  ov.classList.remove('hidden');
  $('#deploy-status').textContent =
    task.status === 'running' ? '● 进行中…'
    : task.status === 'success' ? '✓ 部署成功'
    : '✗ 部署失败（退出码 ' + (task.exitCode ?? '?') + '）';
  $('#deploy-status').className = 'overlay-status ' + task.status;
  $('#deploy-log').textContent = (task.log || []).join('\n');
  $('#deploy-log').scrollTop = $('#deploy-log').scrollHeight;
}

async function pollDeploy(taskId) {
  try {
    const task = await api(`/api/t4data/deploy/status/${encodeURIComponent(taskId)}`);
    renderDeployOverlay(task);
    if (task.status === 'running') {
      deployTimer = setTimeout(() => pollDeploy(taskId), 2000);
    } else {
      $('#deploy-title').textContent = task.status === 'success' ? '部署完成' : '部署失败';
      $('#deploy-btn').disabled = false; // 部署结束才解禁按钮，防止并发触发
      loadVersion(); // 刷新版本矩阵
      toast(task.status === 'success' ? '部署成功' : '部署失败', task.status === 'success');
    }
  } catch (err) {
    $('#deploy-status').textContent = '✗ 查询进度失败：' + err.message;
    $('#deploy-status').className = 'overlay-status failed';
    $('#deploy-btn').disabled = false; // 轮询异常也解禁，避免卡死
  }
}

async function deploy() {
  if (!getToken()) { toast('请先登录管理员账号后再操作', false); return; }
  if (!confirm('确认从当前代码 HEAD 触发重新部署？将拉取最新代码并配套发布数据湖 + SPA。')) return;
  const btn = $('#deploy-btn');
  btn.disabled = true;
  $('#deploy-title').textContent = '部署进行中…';
  try {
    const r = await api('/api/t4data/deploy', { method: 'POST' });
    if (r.taskId) {
      $('#deploy-overlay').classList.remove('hidden');
      $('#deploy-log').textContent = '已触发，等待任务启动…';
      pollDeploy(r.taskId); // 异步轮询；按钮保持禁用直到 success/failed
    } else {
      toast('部署触发：' + (r.message || '已提交'), true);
      btn.disabled = false;
    }
  } catch (err) {
    toast('部署失败：' + err.message, false);
    btn.disabled = false;
  }
  // 注意：成功触发后不在此处解禁按钮，改由 pollDeploy 在任务结束时解禁
}

// ---- 部署授权（Agent 临时令牌审批）----
function daBadge(status) {
  const map = {
    pending: ['待审批', 'badge bad'], approved: ['已批准', 'badge ok'],
    rejected: ['已拒绝', 'badge bad'], revoked: ['已吊销', 'badge bad'],
  };
  const [txt, cls] = map[status] || [status, ''];
  return `<span class="${cls}">${esc(txt)}</span>`;
}
async function loadDeployAuth() {
  try {
    const d = await api('/api/t4data/agent-token/requests');
    renderDeployAuth(d);
  } catch (err) { toast(err.message, false); }
}
function renderDeployAuth(d) {
  const all = d.requests || [];
  const pending = all.filter((r) => r.status === 'pending');
  const history = all.filter((r) => r.status !== 'pending');
  const pe = $('#da-pending');
  if (!pending.length) pe.innerHTML = '<tr><td colspan="5" class="empty">暂无待审批申请</td></tr>';
  else pe.innerHTML = pending.map((r) => `
    <tr>
      <td>${esc(r.purpose)}</td>
      <td>${r.requestedTtlHours}h</td>
      <td>${fmtTime(r.createdAt)}</td>
      <td>${daBadge(r.status)}</td>
      <td>
        <button class="primary sm" data-approve="${esc(r.requestId)}" type="button">批准</button>
        <input class="sm" type="number" min="1" max="72" value="${r.requestedTtlHours}" id="da-ttl-${esc(r.requestId)}" style="width:60px;display:inline-block;vertical-align:middle" />
        <button class="ghost sm" data-reject="${esc(r.requestId)}" type="button">拒绝</button>
      </td>
    </tr>`).join('');
  const he = $('#da-history');
  if (!history.length) he.innerHTML = '<tr><td colspan="5" class="empty">无</td></tr>';
  else he.innerHTML = history.map((r) => `
    <tr>
      <td>${esc(r.purpose)}</td>
      <td>${fmtTime(r.createdAt)}</td>
      <td>${daBadge(r.status)}</td>
      <td>${r.expiresAtMs ? fmtTime(r.expiresAtMs) : '-'}</td>
      <td>${r.active ? '✓ 活跃' : '-'}</td>
    </tr>`).join('');
}

// 启动：有令牌则恢复会话（重建角色/身份/租户下拉），否则进登录页
if (getToken()) {
  const payload = decodeJwtPayload(getToken());
  const email = localStorage.getItem('weijiashi_email') || (payload && payload.sub) || '';
  const role = (payload && payload.role) || 'admin';
  applySession(role, email ? `${email} · ${role}` : role);
} else {
  showLogin();
}
