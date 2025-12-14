const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');

// ---------- DB POOL (supports DATABASE_URL or individual vars) ----------
function makePool() {
  // Prefer DATABASE_URL if present
  if (process.env.DATABASE_URL) {
    // In Cloud Run with Unix socket, you can use:
    // postgres://USER:PASS@/DBNAME?host=/cloudsql/INSTANCE
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      // If you enable a public IP with SSL, uncomment:
      // ssl: { rejectUnauthorized: false }
    });
  }

  // Otherwise use discrete vars
  const config = {
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'postgres',
    host: process.env.PGHOST || '127.0.0.1', // For Cloud Run socket: /cloudsql/INSTANCE
    port: +(process.env.PGPORT || 5432),
    // ssl: { rejectUnauthorized: false } // only if using public IP with SSL
  };
  return new Pool(config);
}

const pool = makePool();

// Simple helper so we can await pool queries
async function q(text, params) {
  const res = await pool.query(text, params);
  return res;
}

// ---------- Constants / helpers ----------
const SONG_SLOTS = [
  'Opener', 'Song 2', 'Song 3', 'Song 4', 'Song 5', 'Encore', 'Cover', 'Bustout'
];

const PRESET_SESSIONS = [
  { id: "2025-12-19-port-chester-ny-capitol-1",     title: "Dec 19, 2025 — The Capitol Theatre (Port Chester, NY)" },
  { id: "2025-12-20-port-chester-ny-capitol-2",     title: "Dec 20, 2025 — The Capitol Theatre (Port Chester, NY)" },
  { id: "2025-12-30-denver-co-ogden-1",             title: "Dec 30, 2025 — Ogden Theatre (Denver, CO)" },
  { id: "2025-12-31-denver-co-ogden-2",             title: "Dec 31, 2025 — Ogden Theatre (Denver, CO)" },
  { id: "2026-01-23-baltimore-md-soundstage-1",     title: "Jan 23, 2026 — Baltimore Soundstage (Baltimore, MD)" },
  { id: "2026-01-24-baltimore-md-soundstage-2",     title: "Jan 24, 2026 — Baltimore Soundstage (Baltimore, MD)" },
  { id: "2026-02-06-pittsburgh-pa-mr-smalls-1",     title: "Feb 6, 2026 — Mr. Smalls Theatre (Pittsburgh, PA)" },
  { id: "2026-02-07-pittsburgh-pa-mr-smalls-2",     title: "Feb 7, 2026 — Mr. Smalls Theatre (Pittsburgh, PA)" },
  { id: "2026-02-26-burlington-vt-higher-ground",   title: "Feb 26, 2026 — Higher Ground (Burlington, VT)" },
  { id: "2026-02-27-portland-me-state-theatre",     title: "Feb 27, 2026 — State Theatre (Portland, ME)" },
  { id: "2026-02-28-albany-ny-empire-live",         title: "Feb 28, 2026 — Empire Live (Albany, NY)" },
  { id: "2026-03-04-savannah-ga-victory-north",     title: "Mar 4, 2026 — Victory North (Savannah, GA)" },
  { id: "2026-03-05-jacksonville-fl-intuition",     title: "Mar 5, 2026 — Intuition Ale Works (Jacksonville, FL)" },
  { id: "2026-03-06-sanford-fl-tuffys",             title: "Mar 6, 2026 — Tuffy’s Outdoor Stage (Sanford, FL)" },
  { id: "2026-03-07-st-petersburg-fl-jannus",       title: "Mar 7, 2026 — Jannus Live (St. Petersburg, FL)" }
];

// ensure a session exists; set owner only if currently null
async function ensureSession(sessionId, maybeOwner) {
  await q(`INSERT INTO sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [sessionId]);

  if (maybeOwner) {
    await q(
      `UPDATE sessions
         SET owner = COALESCE(owner, $1)
       WHERE id = $2`,
      [maybeOwner, sessionId]
    );
  }
}

async function ensureUser(sessionId, username) {
  await q(
    `INSERT INTO session_users (session_id, username)
     VALUES ($1, $2)
     ON CONFLICT (session_id, username) DO NOTHING`,
    [sessionId, username]
  );
}

async function buildSessionState(sessionId) {
  const session = { owner: null, users: [], userSongs: {} };

  const ownerRow = await q(`SELECT owner FROM sessions WHERE id = $1`, [sessionId]);
  session.owner = ownerRow.rows[0]?.owner || null;

  const usersRes = await q(
    `SELECT username
       FROM session_users
      WHERE session_id = $1
      ORDER BY username COLLATE "C"`, // simple case-insensitive-ish order
    [sessionId]
  );
  session.users = usersRes.rows.map(r => ({ socketId: null, username: r.username }));

  const picksRes = await q(
    `SELECT username, slot, value
       FROM user_picks
      WHERE session_id = $1`,
    [sessionId]
  );
  for (const p of picksRes.rows) {
    if (!session.userSongs[p.username]) session.userSongs[p.username] = {};
    session.userSongs[p.username][p.slot] = p.value;
  }
  return session;
}

// ---------- HTTP / SOCKETS ----------
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

io.on('connection', (socket) => {
  // JOIN
  socket.on('join', async ({ sessionId, username }) => {
    try {
      const cleanId = decodeURIComponent(sessionId || '').trim();
      if (!cleanId || !username) {
        socket.emit('error', 'Invalid session or username');
        return;
      }

      await ensureSession(cleanId, username); // first joiner becomes owner (if empty)
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

  // SET SONG
  socket.on('set-song', async ({ sessionId, slot, value, username }) => {
    try {
      const cleanId = decodeURIComponent(sessionId || '').trim();
      if (!SONG_SLOTS.includes(slot)) return;

      await ensureSession(cleanId);
      await ensureUser(cleanId, username);

      await q(
        `INSERT INTO user_picks (session_id, username, slot, value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (session_id, username, slot)
         DO UPDATE SET value = EXCLUDED.value`,
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
    try {
      const cleanId = decodeURIComponent(sessionId || '').trim();
      await q(
        `DELETE FROM user_picks
          WHERE session_id = $1 AND username = $2 AND slot = $3`,
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
    try {
      const cleanId = decodeURIComponent(sessionId || '').trim();
      // (Owner check could be added here)

      await q(
        `DELETE FROM user_picks
          WHERE session_id = $1 AND username = $2`,
        [cleanId, targetUsername]
      );
      await q(
        `DELETE FROM session_users
          WHERE session_id = $1 AND username = $2`,
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
    try {
      const cleanId = decodeURIComponent(sessionId || '').trim();
      await q(`DELETE FROM user_picks WHERE session_id = $1`, [cleanId]);
      const state = await buildSessionState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('clear-all error', err);
      socket.emit('error', 'Clear failed.');
    }
  });

  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3005;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
