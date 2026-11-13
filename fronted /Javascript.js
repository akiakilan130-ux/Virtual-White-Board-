'use strict';
const API = '/api';
const $ = s => document.querySelector(s);
const COLORS = ['#2b59ff','#e0457b','#1f9d6b','#d98a00','#7a4bd6','#0e8fa8'];

const S = {
  token: localStorage.getItem('wb_token'), user: null,
  boardId: null, role: null, ws: null, retry: 0,
  objs: new Map(), tool: 'pen', color: '#1d2733', size: 4,
  cur: null, undo: [], redo: [], view: { x: 0, y: 0, k: 1 }, pan: null, peers: {}
};

/* ---------- helpers ---------- */
async function api(path, method = 'GET', body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(S.token && { Authorization: 'Bearer ' + S.token }) },
    body: body && JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function show(id) { ['auth', 'boards', 'room'].forEach(s => $('#' + s).hidden = s !== id); }
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2500); }
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + Math.random().toString(16));

/* ---------- auth ---------- */
let registering = false;
$('#authToggle').onclick = () => {
  registering = !registering;
  $('#nameRow').hidden = !registering;
  $('#authSubmit').textContent = registering ? 'Create account' : 'Log in';
  $('#authToggle').textContent = registering ? 'Have an account? Log in' : 'New here? Create an account';
};
$('#authForm').onsubmit = async e => {
  e.preventDefault(); $('#authError').textContent = '';
  try {
    const d = await api(registering ? '/register' : '/login', 'POST',
      { email: $('#email').value, password: $('#password').value, name: $('#name').value });
    S.token = d.token; S.user = d.user; localStorage.setItem('wb_token', d.token);
    route();
  } catch (err) { $('#authError').textContent = err.message; }
};
$('#logout').onclick = () => { localStorage.removeItem('wb_token'); S.token = null; S.user = null; location.hash = ''; show('auth'); };

/* ---------- board list ---------- */
async function loadBoards() {
  show('boards');
  $('#who').textContent = S.user ? S.user.name : '';
  const list = await api('/boards');
  const ul = $('#boardList'); ul.innerHTML = '';
  if (!list.length) ul.innerHTML = '<li><span>No boards yet. Name one above to start drawing.</span></li>';
  list.forEach(b => {
    const li = document.createElement('li');
    li.innerHTML = `<span></span><small>${b.role}</small><button>Open</button>${b.role === 'owner' ? '<button class="del">Delete</button>' : ''}`;
    li.querySelector('span').textContent = b.title;
    li.querySelector('button').onclick = () => location.hash = b.id;
    const del = li.querySelector('.del');
    if (del) del.onclick = async () => { if (confirm('Delete "' + b.title + '"?')) { await api('/boards/' + b.id, 'DELETE'); loadBoards(); } };
    ul.appendChild(li);
  });
}
$('#newBoard').onsubmit = async e => {
  e.preventDefault();
  const b = await api('/boards', 'POST', { title: $('#boardTitle').value });
  $('#boardTitle').value = ''; location.hash = b.id;
};

/* ---------- routing ---------- */
async function route() {
  if (!S.token) return show('auth');
  try { if (!S.user) S.user = (await api('/me')).user; }
  catch { localStorage.removeItem('wb_token'); S.token = null; return show('auth'); }
  const id = location.hash.slice(1);
  id ? openBoard(id) : (closeSocket(), loadBoards());
}
window.addEventListener('hashchange', route);
$('#back').onclick = () => location.hash = '';

/* ---------- websocket ---------- */
function closeSocket() { if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; } }
function openBoard(id) {
  closeSocket();
  S.boardId = id; S.objs.clear(); S.undo = []; S.redo = []; S.peers = {}; $('#cursors').innerHTML = '';
  show('room'); resize(); connect();
}
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = S.ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { S.retry = 0; send({ type: 'join', token: S.token, boardId: S.boardId }); };
  ws.onmessage = ev => onMessage(JSON.parse(ev.data));
  ws.onclose = () => { // reconnect with exponential back-off
    const wait = Math.min(1000 * 2 ** S.retry++, 15000);
    toast('Connection lost. Reconnecting…'); setTimeout(() => S.ws === ws && connect(), wait);
  };
}
function send(m) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(m)); }
function onMessage(m) {
  switch (m.type) {
    case 'init':
      S.role = m.role; $('#roomTitle').textContent = m.title;
      S.objs = new Map(m.objects.map(o => [o.id, o])); render();
      document.querySelector('.tray').style.opacity = S.role === 'viewer' ? .5 : 1; break;
    case 'add': S.objs.set(m.obj.id, m.obj); render(); break;
    case 'remove': S.objs.delete(m.id); render(); break;
    case 'clear': S.objs.clear(); render(); break;
    case 'presence': showPresence(m.users); break;
    case 'cursor': moveCursor(m); break;
    case 'error': toast(m.error); break;
  }
}
function showPresence(users) {
  $('#presence').innerHTML = '';
  users.forEach((u, i) => {
    const el = document.createElement('i');
    el.style.background = COLORS[i % COLORS.length]; el.title = u.name; el.textContent = u.name[0].toUpperCase();
    $('#presence').appendChild(el);
    S.peers[u.id] = { name: u.name, color: COLORS[i % COLORS.length] };
  });
  [...$('#cursors').children].forEach(c => { if (!users.some(u => u.id === c.dataset.id)) c.remove(); });
}
function moveCursor(m) {
  const p = S.peers[m.userId]; if (!p) return;
  let el = $(`#cursors [data-id="${m.userId}"]`);
  if (!el) { el = document.createElement('div'); el.className = 'cur'; el.dataset.id = m.userId; el.textContent = p.name; el.style.background = p.color; $('#cursors').appendChild(el); }
  el.style.transform = `translate(${m.x * S.view.k + S.view.x}px,${m.y * S.view.k + S.view.y}px)`;
}

/* ---------- canvas ---------- */
const cv = $('#canvas'), ctx = cv.getContext('2d');
function resize() {
  const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1;
  cv.width = r.width * d; cv.height = r.height * d; render();
}
window.addEventListener('resize', resize);

function drawObj(c, o) {
  c.strokeStyle = c.fillStyle = o.color; c.lineWidth = o.size; c.lineCap = c.lineJoin = 'round';
  c.beginPath();
  if (o.type === 'pen') { o.pts.forEach(([x, y], i) => i ? c.lineTo(x, y) : c.moveTo(x, y)); if (o.pts.length === 1) c.lineTo(o.pts[0][0] + .1, o.pts[0][1]); c.stroke(); }
  else if (o.type === 'line') { c.moveTo(o.x1, o.y1); c.lineTo(o.x2, o.y2); c.stroke(); }
  else if (o.type === 'rect') c.strokeRect(o.x1, o.y1, o.x2 - o.x1, o.y2 - o.y1);
  else if (o.type === 'ellipse') { c.ellipse((o.x1 + o.x2) / 2, (o.y1 + o.y2) / 2, Math.abs(o.x2 - o.x1) / 2, Math.abs(o.y2 - o.y1) / 2, 0, 0, 7); c.stroke(); }
  else if (o.type === 'text') { c.font = `${12 + o.size * 2}px ${getComputedStyle(document.body).fontFamily}`; c.textBaseline = 'top'; c.fillText(o.text, o.x1, o.y1); }
}
function render(target = ctx, bg) {
  const d = devicePixelRatio || 1, v = S.view;
  target.setTransform(1, 0, 0, 1, 0, 0);
  target.clearRect(0, 0, target.canvas.width, target.canvas.height);
  if (bg) { target.fillStyle = bg; target.fillRect(0, 0, target.canvas.width, target.canvas.height); }
  target.setTransform(d * v.k, 0, 0, d * v.k, d * v.x, d * v.y);
  S.objs.forEach(o => drawObj(target, o));
  if (S.cur && !S.cur.erasing) drawObj(target, S.cur);
}
function pos(e) { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left - S.view.x) / S.view.k, y: (e.clientY - r.top - S.view.y) / S.view.k }; }
const canEdit = () => S.role === 'owner' || S.role === 'editor';

function hit(o, p, r) {
  if (o.type === 'pen') return o.pts.some(([x, y]) => Math.hypot(x - p.x, y - p.y) < r + o.size);
  const x1 = Math.min(o.x1, o.x2 ?? o.x1 + 100) - r, x2 = Math.max(o.x1, o.x2 ?? o.x1 + 100) + r;
  const y1 = Math.min(o.y1, o.y2 ?? o.y1 + 24) - r, y2 = Math.max(o.y1, o.y2 ?? o.y1 + 24) + r;
  return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
}
function commit(o) { S.objs.set(o.id, o); S.undo.push(o); S.redo = []; send({ type: 'add', obj: o }); }

cv.addEventListener('pointerdown', e => {
  cv.setPointerCapture(e.pointerId);
  if (S.tool === 'select' || e.button === 1) { S.pan = { x: e.clientX - S.view.x, y: e.clientY - S.view.y }; return; }
  if (!canEdit()) return toast('You have view-only access to this board.');
  const p = pos(e), base = { id: uid(), color: S.color, size: S.size };
  if (S.tool === 'text') {
    const text = prompt('Text'); if (text) commit({ ...base, type: 'text', x1: p.x, y1: p.y, text }); render(); return;
  }
  if (S.tool === 'eraser') { S.cur = { erasing: true }; erase(p); return; }
  S.cur = S.tool === 'pen' ? { ...base, type: 'pen', pts: [[p.x, p.y]] } : { ...base, type: S.tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
});
cv.addEventListener('pointermove', e => {
  const p = pos(e);
  send({ type: 'cursor', x: p.x, y: p.y });
  if (S.pan) { S.view.x = e.clientX - S.pan.x; S.view.y = e.clientY - S.pan.y; return render(); }
  if (!S.cur) return;
  if (S.cur.erasing) return erase(p);
  if (S.cur.type === 'pen') S.cur.pts.push([p.x, p.y]); else { S.cur.x2 = p.x; S.cur.y2 = p.y; }
  render();
});
cv.addEventListener('pointerup', () => {
  S.pan = null;
  if (S.cur && !S.cur.erasing) commit(S.cur);
  S.cur = null; render();
});
function erase(p) {
  S.objs.forEach(o => { if (hit(o, p, 6 / S.view.k)) { S.objs.delete(o.id); send({ type: 'remove', id: o.id }); } });
  render();
}
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const k = Math.min(4, Math.max(.1, S.view.k * (e.deltaY < 0 ? 1.1 : .9)));
  S.view.x = mx - (mx - S.view.x) * (k / S.view.k); S.view.y = my - (my - S.view.y) * (k / S.view.k); S.view.k = k; render();
}, { passive: false });

/* ---------- toolbar ---------- */
document.querySelectorAll('.tool').forEach(b => b.onclick = () => setTool(b.dataset.tool));
function setTool(t) { S.tool = t; document.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); }
$('#color').oninput = e => S.color = e.target.value;
$('#size').oninput = e => S.size = +e.target.value;

function undo() {
  const o = S.undo.pop(); if (!o) return;
  S.objs.delete(o.id); S.redo.push(o); send({ type: 'remove', id: o.id }); render();
}
function redo() {
  const o = S.redo.pop(); if (!o) return;
  S.objs.set(o.id, o); S.undo.push(o); send({ type: 'add', obj: o }); render();
}
$('#undo').onclick = undo; $('#redo').onclick = redo;
$('#clear').onclick = () => { if (canEdit() && confirm('Clear the whole board for everyone?')) { S.objs.clear(); send({ type: 'clear' }); render(); } };
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  const map = { h: 'select', v: 'select', p: 'pen', e: 'eraser', r: 'rect', t: 'text' };
  if (!mod && map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
});

/* ---------- share / export ---------- */
$('#share').onclick = async () => {
  if (S.role !== 'owner') return toast('Only the owner can share this board.');
  const email = prompt('Email of the person to invite:'); if (!email) return;
  const role = confirm('Let them edit?\nOK = Editor, Cancel = Viewer') ? 'editor' : 'viewer';
  try { await api(`/boards/${S.boardId}/share`, 'POST', { email, role }); toast('Invited as ' + role + '. Send them this page link.'); }
  catch (err) { toast(err.message); }
};
$('#exportPng').onclick = () => {
  const out = document.createElement('canvas'); out.width = cv.width; out.height = cv.height;
  render(out.getContext('2d'), '#ffffff'); render();
  const a = document.createElement('a'); a.download = ($('#roomTitle').textContent || 'board') + '.png'; a.href = out.toDataURL('image/png'); a.click();
};

route();
