// 微家事 管理后台（T4 客户端）
// 流程：管理员邮箱密码 → /api/admin/login 取 T4 JWT → 经网关 /api/t4data 调数据湖 /admin 只读统计。
// T4 令牌存 localStorage；所有请求带 Authorization: Bearer <T4>。
const $ = (s) => document.querySelector(s);
const API = ''; // 同源网关
const TOKEN_KEY = 'weijiashi_t4';

const getToken = () => localStorage.getItem(TOKEN_KEY);
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

function toast(msg, ok = true) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + (ok ? 'ok' : 'bad');
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

const LABELS = {
  todos: '待办',
  tasks: '任务',
  archives: '归档',
  users: '用户',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadStats() {
  try {
    const d = await api('/api/t4data/stats');
    render(d);
  } catch (err) {
    toast(err.message, false);
  }
}

function render(d) {
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

function logout() {
  clearToken();
  showLogin();
  toast('已退出');
}

$('#login-form').addEventListener('submit', login);
$('#logout').addEventListener('click', logout);

// 启动：有令牌直接进主界面（令牌可能已过期，首个请求 401 会触发重新登录）
if (getToken()) showMain();
else showLogin();
