// 微家事 Web SPA —— 第一个真实消费 T2 的客户端。
// 流程：账号密码 → /api/account/login 取 T2 JWT → 经网关 /api/t2data 代理调数据湖。
// T2 令牌存 localStorage；所有数据请求带 Authorization: Bearer <T2>。
const $ = (s) => document.querySelector(s);
const API = ''; // 同源网关
const TOKEN_KEY = 'weijiashi_t2';

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
  loadTodos();
}

async function api(path, opts = {}) {
  const token = getToken();
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(API + path, Object.assign({ headers }, opts));
  if (res.status === 401) {
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
    const r = await fetch(API + '/api/account/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || '登录失败 ' + r.status);
    if (!j.token) throw new Error('未返回令牌');
    setToken(j.token);
    $('#password').value = '';
    showMain();
    toast('登录成功');
  } catch (err) {
    $('#login-err').textContent = err.message;
  } finally {
    $('#login-btn').disabled = false;
  }
}

async function loadTodos() {
  try {
    const list = await api('/api/t2data/todos?owner=me');
    render(list);
  } catch (err) {
    toast(err.message, false);
  }
}

function render(list) {
  const ul = $('#list');
  ul.innerHTML = '';
  $('#empty').classList.toggle('hidden', list.length > 0);
  for (const it of list) {
    const done = !!(it.meta && it.meta.done);
    const li = document.createElement('li');
    li.className = 'item' + (done ? ' done' : '');

    const chk = document.createElement('button');
    chk.className = 'chk';
    chk.setAttribute('aria-label', '完成');
    chk.textContent = done ? '✓' : '';
    chk.onclick = () => toggle(it);

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = it.title || '(无标题)';

    const del = document.createElement('button');
    del.className = 'del';
    del.setAttribute('aria-label', '删除');
    del.textContent = '✕';
    del.onclick = () => remove(it);

    li.append(chk, title, del);
    ul.appendChild(li);
  }
}

async function addTodo(e) {
  e.preventDefault();
  const title = $('#title').value.trim();
  if (!title) return;
  try {
    await api('/api/t2data/todos', {
      method: 'POST',
      body: JSON.stringify({ title, meta: { done: false } }),
    });
    $('#title').value = '';
    toast('已添加');
    loadTodos();
  } catch (err) {
    toast(err.message, false);
  }
}

async function toggle(it) {
  const done = !(it.meta && it.meta.done);
  try {
    await api('/api/t2data/todos/' + encodeURIComponent(it.id), {
      method: 'PUT',
      body: JSON.stringify({
        title: it.title,
        meta: Object.assign({}, it.meta, { done }),
      }),
    });
    loadTodos();
  } catch (err) {
    toast(err.message, false);
  }
}

async function remove(it) {
  try {
    await api('/api/t2data/todos/' + encodeURIComponent(it.id), { method: 'DELETE' });
    toast('已删除');
    loadTodos();
  } catch (err) {
    toast(err.message, false);
  }
}

function logout() {
  clearToken();
  showLogin();
  toast('已退出');
}

$('#login-form').addEventListener('submit', login);
$('#add-form').addEventListener('submit', addTodo);
$('#logout').addEventListener('click', logout);

// 启动：有令牌直接进主界面（令牌可能已过期，首个请求 401 会触发重新登录）
if (getToken()) showMain();
else showLogin();
