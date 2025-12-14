// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// ---- DB mode detection -----------------------------------------------------
const DB_DISABLED =
  String(process.env.DISABLE_DB || '').trim() === '1' ||
  ((!process.env.PGUSER || !process.env.PGPASSWORD || !process.env.PGDATABASE) &&
    !process.env.INSTANCE_CONNECTION_NAME);

let useSocket = false;
let useSsl = false;
let pool = null;
let defaultHost = process.env.PGHOST || 'localhost';

if (!DB_DISABLED) {
  const { Pool } = require('pg');
  const INSTANCE_CONNECTION_NAME = process.env.INSTANCE_CONNECTION_NAME || '';
  defaultHost = INSTANCE_CONNECTION_NAME
    ? `/cloudsql/${INSTANCE_CONNECTION_NAME}`
    : process.env.PGHOST || 'localhost';

  useSocket = String(defaultHost || '').startsWith('/cloudsql');
  useSsl = !useSocket && String(process.env.PGSSL || '').toLowerCase() === 'true';

  pool = new Pool({
    host: process.env.PGHOST || defaultHost,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', (e) => console.error('[PG POOL ERROR]', e));
}

console.log(
  '[BOOT]',
  DB_DISABLED
    ? 'DB DISABLED → using in-memory'
    : JSON.stringify({
        host: process.env.PGHOST || defaultHost,
        db: process.env.PGDATABASE,
        user: process.env.PGUSER,
        usingSocket: useSocket,
        ssl: useSsl,
      })
);

// ---- Schema (PG only) ------------------------------------------------------
async function initSchema() {
  if (DB_DISABLED) return;

  // We keep "owner" column for compatibility but never use it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      owner TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_users (
      session_id TEXT NOT NULL,
      username   TEXT NOT NULL,
      PRIMARY KEY (session_id, username),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_picks (
      session_id TEXT NOT NULL,
      username   TEXT NOT NULL,
      slot       TEXT NOT NULL,
      value      TEXT NOT NULL,
      PRIMARY KEY (session_id, username, slot),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
}

// ---- Data layer ------------------------------------------------------------
const SONG_SLOTS = [
  'Opener', 'Song 2', 'Song 3', 'Song 4', 'Song 5', 'Encore', 'Cover', 'Bustout'
];

const PRESET_SESSIONS = [
  { id: "2025-12-19-port-chester-ny-capitol-1", title: "Dec 19, 2025 — The Capitol Theatre (Port Chester, NY)" },
  { id: "2025-12-20-port_chester-ny-capitol-2", title: "Dec 20, 2025 — The Capitol Theatre (Port Chester, NY)" },
  { id: "2025-12-30-denver-co-ogden-1",         title: "Dec 30, 2025 — Ogden Theatre (Denver, CO)" },
  { id: "2025-12-31-denver-co-ogden-2",         title: "Dec 31, 2025 — Ogden Theatre (Denver, CO)" },
];

// In-memory (fallback) -------------------------------------------------------
const mem = {
  sessions: new Map(), // id -> { users:Set, picks: Map("user|slot" -> value) }
};
function memEnsureSession(id) {
  if (!mem.sessions.has(id)) {
    mem.sessions.set(id, { users: new Set(), picks: new Map() });
  }
}
function memEnsureUser(id, username) {
  memEnsureSession(id);
  mem.sessions.get(id).users.add(username);
}
function memUpsertPick(id, username, slot, value) {
  memEnsureUser(id, username);
  mem.sessions.get(id).picks.set(`${username}|${slot}`, value);
}
function memDeletePick(id, username, slot) {
  const s = mem.sessions.get(id);
  if (!s) return;
  s.picks.delete(`${username}|${slot}`);
}
function memClearBoard(id, username) {
  const s = mem.sessions.get(id);
  if (!s) return;
  for (const key of Array.from(s.picks.keys())) {
    if (key.startsWith(username + '|')) s.picks.delete(key);
  }
}
function memBuildState(id) {
  const s = mem.sessions.get(id) || { users: new Set(), picks: new Map() };
  const state = { owner: null, users: [], userSongs: {} };
  [...s.users].sort((a,b)=>a.localeCompare(b,'en',{sensitivity:'base'})).forEach(u=>{
    state.users.push({ socketId: null, username: u });
  });
  for (const [key,val] of s.picks.entries()) {
    const [u, slot] = key.split('|');
    if (!state.userSongs[u]) state.userSongs[u] = {};
    state.userSongs[u][slot] = val;
  }
  return state;
}

// Postgres implementations ---------------------------------------------------
async function pgEnsureSession(sessionId) {
  await pool.query(
    `INSERT INTO sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING;`,
    [sessionId]
  );
}
async function pgEnsureUser(sessionId, username) {
  await pool.query(
    `INSERT INTO session_users (session_id, username)
     VALUES ($1, $2)
     ON CONFLICT (session_id, username) DO NOTHING;`,
    [sessionId, username]
  );
}
async function pgUpsertPick(sessionId, username, slot, value) {
  await pool.query(
    `INSERT INTO user_picks (session_id, username, slot, value)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_id, username, slot)
     DO UPDATE SET value = EXCLUDED.value;`,
    [sessionId, username, slot, value]
  );
}
async function pgDeletePick(sessionId, username, slot) {
  await pool.query(
    `DELETE FROM user_picks WHERE session_id = $1 AND username = $2 AND slot = $3;`,
    [sessionId, username, slot]
  );
}
async function pgClearBoard(sessionId, username) {
  await pool.query(
    `DELETE FROM user_picks WHERE session_id = $1 AND username = $2;`,
    [sessionId, username]
  );
}
async function pgBuildState(sessionId) {
  const state = { owner: null, users: [], userSongs: {} };
  const u = await pool.query(
    `SELECT username FROM session_users
     WHERE session_id = $1
     ORDER BY username COLLATE "C";`,
    [sessionId]
  );
  state.users = u.rows.map(r => ({ socketId: null, username: r.username }));
  const picks = await pool.query(
    `SELECT username, slot, value FROM user_picks WHERE session_id = $1;`,
    [sessionId]
  );
  for (const row of picks.rows) {
    if (!state.userSongs[row.username]) state.userSongs[row.username] = {};
    state.userSongs[row.username][row.slot] = row.value;
  }
  return state;
}

// Choose backend -------------------------------------------------------------
const api = DB_DISABLED
  ? {
      ensureSession: memEnsureSession,
      ensureUser: memEnsureUser,
      upsertPick: memUpsertPick,
      deletePick: memDeletePick,
      clearBoard: memClearBoard,
      buildState: memBuildState,
    }
  : {
      ensureSession: pgEnsureSession,
      ensureUser: pgEnsureUser,
      upsertPick: pgUpsertPick,
      deletePick: pgDeletePick,
      clearBoard: pgClearBoard,
      buildState: pgBuildState,
    };

// ---- App / sockets ---------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/session/:id', (req, res) => res.sendFile(path.join(__dirname, 'session.html')));

app.get('/sessions', (req, res) => {
  res.json(PRESET_SESSIONS.map(s => ({ id: s.id, title: s.title })));
});

app.get('/healthz', (req, res) => res.send('ok'));
app.get('/dbcheck', async (req, res) => {
  if (DB_DISABLED) return res.type('text').send('DB DISABLED (in-memory)');
  try {
    const r = await pool.query('SELECT 1 AS ok, NOW() AS ts');
    res.type('text').send(`DB OK: ${r.rows[0].ok} @ ${r.rows[0].ts}`);
  } catch (e) {
    console.error('[DBCHECK ERROR]', e);
    res.status(500).type('text').send('DB FAIL: ' + e.message);
  }
});

// ✅ SINGLE connection block
io.on('connection', (socket) => {
  const readyOrDie = () => {
    if (!DB_DISABLED && !dbReady) {
      socket.emit('error', 'Database not ready yet. Try again in a moment.');
      return false;
    }
    return true;
  };

  // JOIN
  socket.on('join', async ({ sessionId, username }) => {
    if (!readyOrDie()) return;
    const cleanId = decodeURIComponent(sessionId || '').trim();
    if (!cleanId || !username) {
      socket.emit('error', 'Invalid session or username');
      return;
    }
    try {
      await api.ensureSession(cleanId, username);   // <-- await!
      await api.ensureUser(cleanId, username);      // <-- await!
      socket.join(cleanId);
      socket.emit('joined', cleanId);

      const state = await api.buildState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[JOIN ERROR]', err);
      socket.emit('error', 'Join failed: ' + err.message);
    }
  });

  // SET SONG
  socket.on('set-song', async ({ sessionId, slot, value, username }) => {
    if (!readyOrDie()) return;
    const cleanId = decodeURIComponent(sessionId || '').trim();
    if (!SONG_SLOTS.includes(slot)) return;
    try {
      await api.upsertPick(cleanId, username, slot, value);
      const state = await api.buildState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[SET-SONG ERROR]', err);
      socket.emit('error', 'Save failed: ' + err.message);
    }
  });

  // DELETE one slot
  socket.on('delete-song', async ({ sessionId, slot, username }) => {
    if (!readyOrDie()) return;
    const cleanId = decodeURIComponent(sessionId || '').trim();
    try {
      await api.deletePick(cleanId, username, slot);
      const state = await api.buildState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[DELETE-SONG ERROR]', err);
      socket.emit('error', 'Delete failed: ' + err.message);
    }
  });

  // ✅ CLEAR ALL (works again)
  socket.on('clear-all', async ({ sessionId }) => {
    if (!readyOrDie()) return;
    const cleanId = decodeURIComponent(sessionId || '').trim();
    try {
      await api.clearAll(cleanId);
      const state = await api.buildState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[CLEAR-ALL ERROR]', err);
      socket.emit('error', 'Clear failed: ' + err.message);
    }
  });

  // DELETE a user's entire board (only if you still expose it in the UI)
  socket.on('delete-user-board', async ({ sessionId, targetUsername }) => {
    if (!readyOrDie()) return;
    const cleanId = decodeURIComponent(sessionId || '').trim();
    try {
      await api.deleteBoard(cleanId, targetUsername);
      const state = await api.buildState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[DELETE-BOARD ERROR]', err);
      socket.emit('error', 'Delete board failed: ' + err.message);
    }
  });
});

  socket.on('disconnect', () => {
    socketMap.delete(socket.id);
  });


// ---- boot ------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`[DB CONFIG] host=${process.env.PGHOST || defaultHost} usingSocket=${useSocket} ssl=${useSsl}`);
});

initSchema()
  .then(() => console.log('DB schema ready'))
  .catch((e) => console.error('DB init failed (serving anyway):', e.message));
