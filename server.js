// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');

/**
 * ENV VARS you must set (Cloud Run -> Edit & Deploy -> Variables & Secrets):
 *   PGDATABASE      e.g. "pppp"
 *   PGUSER          e.g. "appuser"
 *   PGPASSWORD      your password
 *   INSTANCE_CONNECTION_NAME  e.g. "pppp-477902:us-east1:ppppbook"
 *
 * For Cloud Run (recommended):
 *   PGHOST is the Unix socket path: `/cloudsql/${INSTANCE_CONNECTION_NAME}`
 *   PGPORT defaults to 5432
 *
 * For local dev: set PGHOST=localhost and run a local Postgres, or use a connection string.
 */

const INSTANCE_CONNECTION_NAME = process.env.INSTANCE_CONNECTION_NAME || '';
const defaultHost = INSTANCE_CONNECTION_NAME ? `/cloudsql/${INSTANCE_CONNECTION_NAME}` : process.env.PGHOST || 'localhost';

const pool = new Pool({
  host: process.env.PGHOST || defaultHost,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
  // For socket connections (Cloud Run) do NOT set ssl
  // For public IP connections you may need: ssl: { rejectUnauthorized: false }
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
  { id: "2025-12-31-denver-co-ogden-2",         title: "Dec 31, 2025 — Ogden Theatre (Denver, CO)" },
];

async function ensureSession(sessionId, maybeOwner) {
  // create if not exists
  await pool.query(`INSERT INTO sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING;`, [sessionId]);
  if (maybeOwner) {
    // set owner if null
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

  const u = await pool.query(
    `SELECT username FROM session_users WHERE session_id = $1 ORDER BY username COLLATE "C";`,
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

io.on('connection', (socket) => {
  // JOIN
  socket.on('join', async ({ sessionId, username }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    if (!cleanId || !username) {
      socket.emit('error', 'Invalid session or username');
      return;
    }
    try {
      await ensureSession(cleanId, username);   // first joiner becomes owner
      await ensureUser(cleanId, username);

      socket.join(cleanId);
      socket.emit('joined', cleanId);

      const state = await buildSessionState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('join error', err);
      socket.emit('error', 'Join failed.');
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
      console.error('set-song error', err);
      socket.emit('error', 'Save failed.');
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
      console.error('delete-song error', err);
      socket.emit('error', 'Delete failed.');
    }
  });

  // OWNER: DELETE a user's whole board
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
      console.error('delete-user-board error', err);
      socket.emit('error', 'Delete board failed.');
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
      console.error('clear-all error', err);
      socket.emit('error', 'Clear failed.');
    }
  });

  socket.on('disconnect', () => { /* no-op */ });
});

// --- boot -------------------------------------------------------------------
(async () => {
  try {
    await initSchema();
    const PORT = process.env.PORT || 8080; // Cloud Run expects 8080
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (e) {
    console.error('Failed to init schema:', e);
    process.exit(1);
  }
})();
