// 微家事 管理后台（T4 客户端）— 账号与密钥中心
// 流程：管理员邮箱密码 → /api/admin/login 取 T4 JWT → 经网关 /api/t4data 调数据湖。
// T4 令牌存 localStorage；所有请求带 Authorization: Bearer <T4>。
const $ = (s) => document.querySelector(s);
const API = ''; // 同源网关
const TOKEN_KEY = 'weijiashi_t4';
const SPA_VERSION = 'v0.0.1'; // 前端语义版本（随发布维护）

const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

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
  renderDeployHistory();
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
    $('#who').textContent = email + ' · ' + (j.role || 'admin');
    $('#password').value = '';
    showMain();
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
        `<td><button class="ghost sm act" data-id="${esc(u.id)}" data-status="${disabled ? 'active' : 'disabled'}">${disabled ? '启用' : '禁用'}</button></td>`;
      body.appendChild(tr);
    }
    body.querySelectorAll('.act').forEach((b) =>
      b.addEventListener('click', () => setUserStatus(b.dataset.id, b.dataset.status))
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

// ===== 服务密钥 =====
async function loadKeys() {
  const body = $('#keys-body');
  body.innerHTML = '<tr><td colspan="5" class="empty">加载中…</td></tr>';
  try {
    const list = await api('/api/t4data/keys');
    if (!list.length) { body.innerHTML = '<tr><td colspan="5" class="empty">暂无密钥</td></tr>'; return; }
    body.innerHTML = '';
    for (const k of list) {
      const tr = document.createElement('tr');
      const revoked = k.status !== 'active';
      tr.innerHTML =
        `<td><code>${esc(k.id)}</code></td>` +
        `<td>${esc((k.scope || []).join(', '))}</td>` +
        `<td><span class="badge ${revoked ? 'bad' : 'ok'}">${revoked ? '已吊销' : '有效'}</span></td>` +
        `<td>${fmtTime(k.created_at)}</td>` +
        `<td>${revoked ? '' : '<button class="ghost sm act" data-id="' + esc(k.id) + '">吊销</button>'}</td>`;
      body.appendChild(tr);
    }
    body.querySelectorAll('.act').forEach((b) =>
      b.addEventListener('click', () => revokeKey(b.dataset.id))
    );
  } catch (err) {
    body.innerHTML = `<tr><td colspan="5" class="empty">${esc(err.message)}</td></tr>`;
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

function copySecret() {
  const v = $('#key-secret-val').textContent;
  navigator.clipboard?.writeText(v).then(() => toast('已复制')).catch(() => toast('复制失败，请手动选择', false));
}

// ===== 数据浏览器 =====
const DATA_TABLES = {
  todos: {
    label: '待办',
    cols: [['id', 'ID'], ['owner_openid', '归属'], ['title', '标题'], ['meta', 'meta'], ['tag', '标签'], ['dot', '圆点'], ['shared', '共享'], ['family_id', '家庭'], ['updated_at', '更新']],
    edit: ['title', 'meta', 'tag', 'dot', 'shared', 'family_id'],
    json: ['meta'],
  },
  archive_items: {
    label: '归档',
    cols: [['id', 'ID'], ['owner_openid', '归属'], ['type', '类型'], ['payload', 'payload'], ['shared', '共享'], ['family_id', '家庭'], ['created_at', '创建'], ['updated_at', '更新']],
    edit: ['type', 'payload', 'shared', 'family_id'],
    json: ['payload'],
  },
  collections: {
    label: '通用集合',
    cols: [['id', 'ID'], ['collection', '集合'], ['owner_openid', '归属'], ['doc', 'doc'], ['updated_at', '更新']],
    edit: ['doc'],
    json: ['doc'],
  },
  tasks_doc: {
    label: '任务文档',
    cols: [['tenant_id', '租户'], ['owner_openid', '归属'], ['sections', 'sections'], ['updated_at', '更新']],
    edit: [],
    json: ['sections'],
  },
};

const dataState = { table: 'todos', q: '', limit: 20, offset: 0, total: 0 };

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
    const d = await api(`/api/t4data/rows/${dataState.table}?${params.toString()}`);
    dataState.total = d.total;
    if (!d.rows.length) {
      body.innerHTML = `<tr><td class="empty" colspan="${t.cols.length + 1}">暂无数据</td></tr>`;
    } else {
      body.innerHTML = '';
      for (const row of d.rows) {
        const tr = document.createElement('tr');
        tr.dataset.row = row.id;
        let cells = `<td class="row-actions"><button class="ghost sm act" data-act="edit" data-id="${esc(row.id)}">编辑</button>`;
        if (t.edit.length) cells += ` <button class="ghost sm act danger" data-act="del" data-id="${esc(row.id)}">删除</button>`;
        cells += '</td>';
        for (const [k] of t.cols) cells += `<td>${fmtCell(row[k])}</td>`;
        tr.innerHTML = cells;
        body.appendChild(tr);
      }
      body.querySelectorAll('.act').forEach((b) =>
        b.addEventListener('click', () => {
          if (b.dataset.act === 'del') delRow(b.dataset.id);
          else editRow(b.dataset.id);
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

async function editRow(id) {
  const t = DATA_TABLES[dataState.table];
  const target = document.querySelector(`#data-body tr[data-row="${CSS.escape(id)}"]`);
  if (!target) return;
  // 已有编辑行则先收起
  const existing = document.querySelector('#data-body tr.edit-row');
  if (existing) existing.remove();

  let row;
  try {
    row = await api(`/api/t4data/rows/${dataState.table}/${encodeURIComponent(id)}`);
  } catch (err) {
    toast(err.message, false);
    return;
  }

  let fields = '';
  for (const col of t.edit) {
    const v = row[col];
    let input;
    if (t.json.includes(col)) {
      let txt = '';
      try { txt = JSON.stringify(v, null, 2); } catch { txt = String(v ?? ''); }
      input = `<textarea data-f="${col}" rows="3">${esc(txt)}</textarea>`;
    } else if (col === 'shared') {
      const on = !!v;
      input = `<select data-f="${col}"><option value="1"${on ? ' selected' : ''}>是</option><option value="0"${!on ? ' selected' : ''}>否</option></select>`;
    } else {
      input = `<input type="text" data-f="${col}" value="${esc(v ?? '')}" />`;
    }
    fields += `<label><span>${col}</span>${input}</label>`;
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
      await api(`/api/t4data/rows/${dataState.table}/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('已保存');
      tr.remove();
      loadData();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
}

async function delRow(id) {
  if (!confirm(`确认删除 ${dataState.table} 中的记录 ${id}？此操作不可恢复。`)) return;
  try {
    await api(`/api/t4data/rows/${dataState.table}/${encodeURIComponent(id)}`, { method: 'DELETE' });
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
const NAV_LABELS = { overview: '概览', deploy: '版本更新', data: '数据统计', users: '用户账号', keys: '服务密钥', security: '系统设置', audit: '审计日志' };
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
  $('#panel-' + name).classList.remove('hidden');
  const crumb = $('#crumb');
  if (crumb) crumb.textContent = NAV_LABELS[name] || name;
  if (name === 'data') { dataHead(); loadData(); }
  if (name === 'users') loadUsers();
  if (name === 'keys') { $('#key-secret').classList.add('hidden'); loadKeys(); }
  if (name === 'audit') loadAudit();
}

function logout() {
  clearToken();
  showLogin();
  toast('已退出');
}

// 绑定事件
$('#login-form').addEventListener('submit', login);
$('#logout').addEventListener('click', logout);
$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t) switchTab(t.dataset.tab);
});
$('#users-refresh').addEventListener('click', loadUsers);
$('#key-issue').addEventListener('click', issueKey);
$('#key-secret-copy').addEventListener('click', copySecret);
$('#pw-form').addEventListener('submit', changePassword);
$('#ver-copy').addEventListener('click', copyVersion);
$('#deploy-btn').addEventListener('click', deploy);
function closeDeployOverlay() { $('#deploy-overlay').classList.add('hidden'); }
$('#deploy-close').addEventListener('click', closeDeployOverlay);
$('#deploy-mask').addEventListener('click', closeDeployOverlay);
$('#deploy-close-foot').addEventListener('click', closeDeployOverlay);

// 数据浏览器事件
$('#data-table').addEventListener('change', (e) => {
  dataState.table = e.target.value;
  dataState.q = ''; dataState.offset = 0;
  $('#data-q').value = '';
  dataHead();
  loadData();
});
$('#data-search').addEventListener('click', () => { dataState.q = $('#data-q').value.trim(); dataState.offset = 0; loadData(); });
$('#data-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { dataState.q = $('#data-q').value.trim(); dataState.offset = 0; loadData(); } });
$('#data-refresh').addEventListener('click', () => { dataState.offset = 0; loadData(); });
$('#data-export-csv').addEventListener('click', () => exportData('csv'));
$('#data-export-json').addEventListener('click', () => exportData('json'));

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

  // footer：前端 · 网关 · 数据湖
  $('#ver-front').textContent = SPA_VERSION;
  $('#ver-gw').textContent = gw || '未配置';
  $('#ver-dl').textContent = dl || '未配置';
  // 网关与数据湖部署自不同 commit → 配套异常，标红
  const mismatch = !!(gw && dl && gw !== dl);
  $('#deploy-btn').classList.toggle('warn', mismatch);
  $('#ver-gw').classList.toggle('warn', mismatch);
  $('#ver-dl').classList.toggle('warn', mismatch);

  // 概览版本矩阵
  $('#ver-sp2').textContent = SPA_VERSION;
  $('#ver-gw2').textContent = gw || '未配置';
  $('#ver-dl2').textContent = dl || '未配置';
  $('#ver-mp').textContent = mp || '未配置';
  $('#ver-mp').classList.toggle('warn', !mp);
}
loadVersion();

// 复制版本矩阵：前端 v0.0.1 · 网关 xxx · 数据湖 yyy
function copyVersion() {
  const full = `前端 ${SPA_VERSION} · 网关 ${$('#ver-gw').textContent} · 数据湖 ${$('#ver-dl').textContent}`;
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
  const dot = $('#deploy-dot');
  if (dot) dot.className = 'status-dot ' + task.status;
  $('#deploy-log').textContent = (task.log || []).join('\n');
  $('#deploy-log').scrollTop = $('#deploy-log').scrollHeight;
}

/* ===== 部署历史（本地持久化，最近 20 条） ===== */
const DEPLOY_HISTORY_KEY = 'weijiashi_deploy_history';
function loadDeployHistory() {
  try { return JSON.parse(localStorage.getItem(DEPLOY_HISTORY_KEY) || '[]'); } catch { return []; }
}
function pushDeployHistory(entry) {
  const list = loadDeployHistory();
  list.unshift(entry);
  if (list.length > 20) list.length = 20;
  try { localStorage.setItem(DEPLOY_HISTORY_KEY, JSON.stringify(list)); } catch {}
  renderDeployHistory();
}
function renderDeployHistory() {
  const box = $('#deploy-history');
  if (!box) return;
  const list = loadDeployHistory();
  if (!list.length) { box.innerHTML = '<p class="empty">暂无部署记录</p>'; return; }
  box.innerHTML = list.map((h) => {
    const dot = h.status === 'success' ? 'ok' : h.status === 'failed' ? 'failed' : 'running';
    const bad = h.exitCode != null && h.exitCode !== 0;
    const meta = bad ? '退出码 ' + h.exitCode : (h.version ? '发布 ' + h.version : '已发布');
    return `<div class="dh-row"><span class="dh-dot ${dot}"></span><span class="dh-time">${fmtTime(h.time)}</span><span class="dh-meta${bad ? ' warn' : ''}">${meta}</span></div>`;
  }).join('');
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
      pushDeployHistory({ time: Date.now(), status: task.status, exitCode: task.exitCode ?? null, version: $('#ver-gw').textContent });
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

// 启动：有令牌直接进主界面
if (getToken()) showMain();
else showLogin();
