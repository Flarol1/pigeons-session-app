// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');

/**
 * REQUIRED ENV (set these in Cloud Run → Edit & Deploy → Variables & Secrets)
 *   INSTANCE_CONNECTION_NAME  e.g. "pppp-477902:us-east1:ppppbook"  (Cloud Run)
 *   PGUSER                    e.g. "appuser"
 *   PGPASSWORD                your password
 *   PGDATABASE                e.g. "pppp"
 *   PGPORT                    (optional, defaults to 5432)
 *
 * How connection is chosen:
 * - If INSTANCE_CONNECTION_NAME is set, we use the Unix socket at /cloudsql/<instance>
 *   (this is the recommended way on Cloud Run and does NOT use SSL).
 * - Otherwise we fall back to PGHOST (or 'localhost'), which can be used for local dev
 *   or a public IP Postgres. If you go over public internet and your server needs SSL,
 *   set PGSSL=true.
 */

const INSTANCE_CONNECTION_NAME = process.env.INSTANCE_CONNECTION_NAME || '';
const defaultHost = INSTANCE_CONNECTION_NAME
  ? `/cloudsql/${INSTANCE_CONNECTION_NAME}` // Cloud Run unix socket
  : process.env.PGHOST || 'localhost';

const useSocket = String(defaultHost || '').startsWith('/cloudsql');
const useSsl = !useSocket && String(process.env.PGSSL || '').toLowerCase() === 'true';

const pool = new Pool({
  host: process.env.PGHOST || defaultHost,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

// --- schema (run once on boot) ---------------------------------------------
async function initSchema() {
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

// --- helpers ---------------------------------------------------------------
const SONG_SLOTS = ['Opener','Song 2','Song 3','Song 4','Song 5','Encore','Cover','Bustout'];

const PRESET_SESSIONS = [
  { id: "2025-12-19-port-chester-ny-capitol-1", title: "Dec 19, 2025 — The Capitol Theatre (Port Chester, NY)" },
  { id: "2025-12-20-port-chester-ny-capitol-2", title: "Dec 20, 2025 — The Capitol Theatre (Port Chester, NY)" },
  { id: "2025-12-30-denver-co-ogden-1",         title: "Dec 30, 2025 — Ogden Theatre (Denver, CO)" },
  { id: "2025-12-31",         title: "Dec 31, 2025 — Ogden Theatre (Denver, CO)" },
];

async function ensureSession(sessionId, maybeOwner) {
  await pool.query(
    `INSERT INTO sessions (id) VALUES ($1)
     ON CONFLICT (id) DO NOTHING;`,
    [sessionId]
  );
  if (maybeOwner) {
    await pool.query(
      `UPDATE sessions SET owner = COALESCE(owner, $1) WHERE id = $2;`,
      [maybeOwner, sessionId]
    );
  }
}

async function ensureUser(sessionId, username) {
  await pool.query(
    `INSERT INTO session_users (session_id, username)
     VALUES ($1, $2)
     ON CONFLICT (session_id, username) DO NOTHING;`,
    [sessionId, username]
  );
}

async function buildSessionState(sessionId) {
  const session = { owner: null, users: [], userSongs: {} };

  const s = await pool.query(`SELECT owner FROM sessions WHERE id = $1;`, [sessionId]);
  session.owner = s.rows[0]?.owner || null;

  // Keep this collate stable; "C" puts capitals before lowercase; for true case-insensitive,
  // consider lower(username) ORDER BY lower(username).
  const u = await pool.query(
    `SELECT username FROM session_users
      WHERE session_id = $1
      ORDER BY username COLLATE "C";`,
    [sessionId]
  );
  session.users = u.rows.map(r => ({ socketId: null, username: r.username }));

  const picks = await pool.query(
    `SELECT username, slot, value FROM user_picks WHERE session_id = $1;`,
    [sessionId]
  );
  for (const row of picks.rows) {
    if (!session.userSongs[row.username]) session.userSongs[row.username] = {};
    session.userSongs[row.username][row.slot] = row.value;
  }

  return session;
}

// --- app / sockets ----------------------------------------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/session/:id', (req, res) => res.sendFile(path.join(__dirname, 'session.html')));

// index list
app.get('/sessions', (req, res) => {
  res.json(PRESET_SESSIONS.map(s => ({ id: s.id, title: s.title })));
});

app.get('/healthz', (req, res) => res.send('ok'));

// quick DB probe for debugging Cloud Run connection/env
app.get('/dbcheck', async (req, res) => {
  try {
    const r = await pool.query('SELECT 1 AS ok, NOW() AS now');
    res.status(200).send(`DB OK: ${r.rows[0].ok} @ ${r.rows[0].now.toISOString()}`);
  } catch (e) {
    console.error('[DBCHECK ERROR]', e);
    res.status(500).send('DB FAIL: ' + e.message);
  }
});

io.on('connection', (socket) => {
  // JOIN
  socket.on('join', async ({ sessionId, username }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    if (!cleanId || !username) {
      socket.emit('error', 'Invalid session or username');
      return;
    }
    try {
      console.log('[JOIN] sessionId=%s username=%s', cleanId, username);
      await ensureSession(cleanId, username);   // first joiner becomes owner
      await ensureUser(cleanId, username);

      socket.join(cleanId);
      socket.emit('joined', cleanId);

      const state = await buildSessionState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[JOIN ERROR]', err);
      socket.emit('error', 'Join failed: ' + err.message);
    }
  });

  // SET SONG (upsert)
  socket.on('set-song', async ({ sessionId, slot, value, username }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    if (!SONG_SLOTS.includes(slot)) return;

    try {
      await ensureSession(cleanId);
      await ensureUser(cleanId, username);

      await pool.query(
        `INSERT INTO user_picks (session_id, username, slot, value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (session_id, username, slot)
         DO UPDATE SET value = EXCLUDED.value;`,
        [cleanId, username, slot, value]
      );

      const state = await buildSessionState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[SET-SONG ERROR]', err);
      socket.emit('error', 'Save failed: ' + err.message);
    }
  });

  // DELETE one slot
  socket.on('delete-song', async ({ sessionId, slot, username }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    try {
      await pool.query(
        `DELETE FROM user_picks WHERE session_id = $1 AND username = $2 AND slot = $3;`,
        [cleanId, username, slot]
      );
      const state = await buildSessionState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[DELETE-SONG ERROR]', err);
      socket.emit('error', 'Delete failed: ' + err.message);
    }
  });

  // OWNER: DELETE a user's entire board
  socket.on('delete-user-board', async ({ sessionId, targetUsername }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    try {
      await pool.query(
        `DELETE FROM user_picks WHERE session_id = $1 AND username = $2;`,
        [cleanId, targetUsername]
      );
      await pool.query(
        `DELETE FROM session_users WHERE session_id = $1 AND username = $2;`,
        [cleanId, targetUsername]
      );
      const state = await buildSessionState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[DELETE-BOARD ERROR]', err);
      socket.emit('error', 'Delete board failed: ' + err.message);
    }
  });

  // CLEAR ALL picks (keep users)
  socket.on('clear-all', async ({ sessionId }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    try {
      await pool.query(`DELETE FROM user_picks WHERE session_id = $1;`, [cleanId]);
      const state = await buildSessionState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[CLEAR-ALL ERROR]', err);
      socket.emit('error', 'Clear failed: ' + err.message);
    }
  });

  socket.on('disconnect', () => { /* keep data in DB; nothing to do */ });
});

// --- boot -------------------------------------------------------------------
(async () => {
  try {
    await initSchema();
    const PORT = process.env.PORT || 8080; // Cloud Run expects 8080
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Socket mode: ${useSocket ? 'Unix socket /cloudsql' : 'TCP host ' + (process.env.PGHOST || defaultHost)}`);
      console.log(`SSL: ${useSsl ? 'enabled' : 'disabled'}`);
    });
  } catch (e) {
    console.error('Failed to init schema:', e);
    process.exit(1);
  }
})();
