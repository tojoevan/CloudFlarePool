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

function showLogin() {
  $('#login').classList.remove('hidden');
  $('#main').classList.add('hidden');
}
function showMain() {
  $('#login').classList.add('hidden');
  $('#main').classList.remove('hidden');
  loadStats();
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
  if (name === 'users') loadUsers();
  if (name === 'keys') { $('#key-secret').classList.add('hidden'); loadKeys(); }
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

// 启动：底部双版本（前端语义版本 + 后端 git HEAD）
async function loadVersion() {
  $('#ver-front').textContent = '前端 ' + SPA_VERSION;
  try {
    const r = await fetch(API + '/api/health');
    const j = await r.json().catch(() => ({}));
    $('#ver-back').textContent = '后端 ' + (j.git ? j.git : (j.name ? '已连接' : '-'));
  } catch (_) {
    $('#ver-back').textContent = '后端 -';
  }
}
loadVersion();

// 启动：有令牌直接进主界面
if (getToken()) showMain();
else showLogin();
