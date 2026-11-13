'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'change-me-in-production';

/* ---------- database ---------- */
const db = new Database(process.env.DB_FILE || 'whiteboard.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users   (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS boards  (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS members (board_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (board_id, user_id));
  CREATE TABLE IF NOT EXISTS objects (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, board_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_objects_board ON objects(board_id);
`);

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, name, email FROM users WHERE id = ?'),
  board: db.prepare('SELECT * FROM boards WHERE id = ?'),
  member: db.prepare('SELECT role FROM members WHERE board_id = ? AND user_id = ?'),
  touch: db.prepare('UPDATE boards SET updated_at = ? WHERE id = ?'),
  objects: db.prepare('SELECT data FROM objects WHERE board_id = ? ORDER BY seq'),
  addObj: db.prepare('INSERT OR REPLACE INTO objects (id, board_id, data) VALUES (?, ?, ?)'),
  delObj: db.prepare('DELETE FROM objects WHERE id = ? AND board_id = ?'),
  clearObjs: db.prepare('DELETE FROM objects WHERE board_id = ?')
};

/** Returns 'owner' | 'editor' | 'viewer' | null. Checked on every REST call and WS operation. */
function roleOf(boardId, userId) {
  const b = q.board.get(boardId);
  if (!b) return null;
  if (b.owner_id === userId) return 'owner';
  const m = q.member.get(boardId, userId);
  return m ? m.role : null;
}

/* ---------- HTTP API ---------- */
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const sign = u => jwt.sign({ id: u.id, name: u.name }, SECRET, { expiresIn: '12h' });
const cleanTitle = t => String(t || '').trim().slice(0, 100);

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try { req.user = jwt.verify(h.replace('Bearer ', ''), SECRET); next(); }
  catch { res.status(401).json({ error: 'Please log in again.' }); }
}

// Basic brute-force protection: lock an email for 5 minutes after 5 failures.
const fails = new Map();

app.post('/api/register', (req, res) => {
  const { email = '', password = '', name = '' } = req.body || {};
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8)
    return res.status(400).json({ error: 'Enter a valid email and a password of at least 8 characters.' });
  const e = email.toLowerCase();
  if (q.userByEmail.get(e)) return res.status(409).json({ error: 'That email is already registered.' });
  const user = { id: randomUUID(), name: name.trim().slice(0, 50) || e.split('@')[0] };
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(user.id, e, user.name, bcrypt.hashSync(password, 12));
  res.status(201).json({ token: sign(user), user });
});

app.post('/api/login', (req, res) => {
  const { email = '', password = '' } = req.body || {};
  const e = email.toLowerCase(), f = fails.get(e) || { n: 0, until: 0 };
  if (f.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const u = q.userByEmail.get(e);
  if (!u || !bcrypt.compareSync(password, u.hash)) {
    f.n++; if (f.n >= 5) { f.until = Date.now() + 5 * 60 * 1000; f.n = 0; }
    fails.set(e, f);
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  fails.delete(e);
  const user = { id: u.id, name: u.name };
  res.json({ token: sign(user), user });
});

app.get('/api/me', auth, (req, res) => {
  const user = q.userById.get(req.user.id);
  user ? res.json({ user }) : res.status(401).json({ error: 'Unknown user.' });
});

app.get('/api/boards', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT b.id, b.title, b.updated_at,
           CASE WHEN b.owner_id = @u THEN 'owner' ELSE m.role END AS role
    FROM boards b LEFT JOIN members m ON m.board_id = b.id AND m.user_id = @u
    WHERE b.owner_id = @u OR m.user_id = @u
    ORDER BY b.updated_at DESC`).all({ u: req.user.id });
  res.json(rows);
});

app.post('/api/boards', auth, (req, res) => {
  const title = cleanTitle(req.body.title);
  if (!title) return res.status(400).json({ error: 'Give the board a name.' });
  const b = { id: randomUUID(), title };
  db.prepare('INSERT INTO boards VALUES (?, ?, ?, ?)').run(b.id, req.user.id, title, Date.now());
  res.status(201).json(b);
});

app.patch('/api/boards/:id', auth, (req, res) => {
  if (roleOf(req.params.id, req.user.id) !== 'owner') return res.status(403).json({ error: 'Only the owner can rename.' });
  db.prepare('UPDATE boards SET title = ? WHERE id = ?').run(cleanTitle(req.body.title) || 'Untitled', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/boards/:id', auth, (req, res) => {
  if (roleOf(req.params.id, req.user.id) !== 'owner') return res.status(403).json({ error: 'Only the owner can delete.' });
  const id = req.params.id;
  db.transaction(() => {
    q.clearObjs.run(id);
    db.prepare('DELETE FROM members WHERE board_id = ?').run(id);
    db.prepare('DELETE FROM boards WHERE id = ?').run(id);
  })();
  closeRoom(id, 'This board was deleted.');
  res.json({ ok: true });
});

app.post('/api/boards/:id/share', auth, (req, res) => {
  const id = req.params.id;
  if (roleOf(id, req.user.id) !== 'owner') return res.status(403).json({ error: 'Only the owner can share.' });
  const { email = '', role } = req.body || {};
  if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role must be editor or viewer.' });
  const target = q.userByEmail.get(email.toLowerCase());
  if (!target) return res.status(404).json({ error: 'No account uses that email yet.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You already own this board.' });
  db.prepare('INSERT OR REPLACE INTO members VALUES (?, ?, ?)').run(id, target.id, role);
  res.json({ ok: true });
});

app.delete('/api/boards/:id/share/:userId', auth, (req, res) => {
  if (roleOf(req.params.id, req.user.id) !== 'owner') return res.status(403).json({ error: 'Only the owner can revoke access.' });
  db.prepare('DELETE FROM members WHERE board_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  closeRoom(req.params.id, 'Your access was removed.', req.params.userId);
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

/* ---------- WebSocket: real-time collaboration ---------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
const rooms = new Map(); // boardId -> Set<ws>

const out = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
function broadcast(boardId, m, except) {
  (rooms.get(boardId) || []).forEach(c => c !== except && out(c, m));
}
function presence(boardId) {
  const seen = new Map();
  (rooms.get(boardId) || []).forEach(c => seen.set(c.user.id, { id: c.user.id, name: c.user.name }));
  broadcast(boardId, { type: 'presence', users: [...seen.values()] });
}
function closeRoom(boardId, reason, onlyUser) {
  (rooms.get(boardId) || []).forEach(c => {
    if (!onlyUser || c.user.id === onlyUser) { out(c, { type: 'error', error: reason }); c.close(); }
  });
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    // First message must be a join with a valid token and board access.
    if (!ws.boardId) {
      if (m.type !== 'join') return ws.close();
      try { ws.user = jwt.verify(m.token, SECRET); } catch { return ws.close(); }
      const role = roleOf(m.boardId, ws.user.id);
      if (!role) { out(ws, { type: 'error', error: 'You do not have access to this board.' }); return ws.close(); }
      ws.boardId = m.boardId;
      if (!rooms.has(m.boardId)) rooms.set(m.boardId, new Set());
      rooms.get(m.boardId).add(ws);
      out(ws, {
        type: 'init', role, title: q.board.get(m.boardId).title,
        objects: q.objects.all(m.boardId).map(r => JSON.parse(r.data))
      });
      return presence(m.boardId);
    }

    // Re-check permissions on every operation (access may have been revoked).
    const role = roleOf(ws.boardId, ws.user.id);
    if (!role) return ws.close();
    const canEdit = role === 'owner' || role === 'editor';

    switch (m.type) {
      case 'cursor':
        broadcast(ws.boardId, { type: 'cursor', userId: ws.user.id, x: +m.x || 0, y: +m.y || 0 }, ws);
        break;
      case 'add': {
        if (!canEdit) return out(ws, { type: 'error', error: 'You have view-only access.' });
        const o = m.obj;
        if (!o || typeof o.id !== 'string' || !['pen', 'line', 'rect', 'ellipse', 'text'].includes(o.type)) return;
        if (o.type === 'text') o.text = String(o.text).slice(0, 500);
        q.addObj.run(o.id, ws.boardId, JSON.stringify(o));
        q.touch.run(Date.now(), ws.boardId);
        broadcast(ws.boardId, { type: 'add', obj: o }, ws);
        break;
      }
      case 'remove':
        if (!canEdit) return out(ws, { type: 'error', error: 'You have view-only access.' });
        q.delObj.run(String(m.id), ws.boardId);
        q.touch.run(Date.now(), ws.boardId);
        broadcast(ws.boardId, { type: 'remove', id: m.id }, ws);
        break;
      case 'clear':
        if (!canEdit) return out(ws, { type: 'error', error: 'You have view-only access.' });
        q.clearObjs.run(ws.boardId);
        broadcast(ws.boardId, { type: 'clear' }, ws);
        break;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.boardId);
    if (!room) return;
    room.delete(ws);
    room.size ? presence(ws.boardId) : rooms.delete(ws.boardId);
  });
});

// Drop dead connections every 30 s.
setInterval(() => wss.clients.forEach(c => {
  if (!c.isAlive) return c.terminate();
  c.isAlive = false; c.ping();
}), 30000);

server.listen(PORT, () => console.log(`Virtual Whiteboard running at http://localhost:${PORT}`));
