// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// 1) open / create db
const db = new sqlite3.Database('./data.db');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_picks (
      session_id TEXT,
      username   TEXT,
      slot       TEXT,
      value      TEXT,
      PRIMARY KEY (session_id, username, slot)
    )
  `);
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const sessions = {};

const SONG_SLOTS = [
  'Opener',
  'Song 2',
  'Song 3',
  'Song 4',
  'Song 5',
  'Encore',
  'Cover',
  'Bustout'
];

// prebuilt sessions
const PRESET_SESSIONS = [
  { id: '2025-11-11-jackson-ms-duling-hall', title: 'Nov 11, 2025 — Duling Hall (Jackson, MS)' },
  { id: '2025-11-12-houston-tx-the-heights-theater', title: 'Nov 12, 2025 — The Heights Theater (Houston, TX)' },
  { id: '2025-11-14-austin-tx-mohawk', title: 'Nov 14, 2025 — Mohawk (Austin, TX)' },
  { id: '2025-11-15-dallas-tx-echo-lounge', title: 'Nov 15, 2025 — The Echo Lounge & Music Hall (Dallas, TX)' },
  { id: '2025-11-16-fayetteville-ar-georges-majestic', title: 'Nov 16, 2025 — George’s Majestic Lounge (Fayetteville, AR)' },
  { id: '2025-11-18-omaha-ne-slowdown', title: 'Nov 18, 2025 — Slowdown (Omaha, NE)' },
  { id: '2025-11-19-minneapolis-mn-fine-line', title: 'Nov 19, 2025 — Fine Line (Minneapolis, MN)' },
  { id: '2025-11-20-madison-wi-majestic', title: 'Nov 20, 2025 — Majestic Theatre (Madison, WI)' },
  { id: '2025-11-21-stl-mo-the-sovereign', title: 'Nov 21, 2025 — The Sovereign (St. Louis, MO)' },
  { id: '2025-11-22-covington-ky-madison-theater', title: 'Nov 22, 2025 — Madison Theater (Covington, KY)' },
  { id: '2025-12-05-richmond-va-the-national-1', title: 'Dec 5, 2025 — The National (Richmond, VA)' },
  { id: '2025-12-06-richmond-va-the-national-2', title: 'Dec 6, 2025 — The National (Richmond, VA)' },
  { id: '2025-12-19-port-chester-ny-capitol-1', title: 'Dec 19, 2025 — The Capitol Theatre (Port Chester, NY)' },
  { id: '2025-12-20-port-chester-ny-capitol-2', title: 'Dec 20, 2025 — The Capitol Theatre (Port Chester, NY)' },
  { id: '2025-12-30-denver-co-ogden-1', title: 'Dec 30, 2025 — Ogden Theatre (Denver, CO)' },
  { id: '2025-12-31-denver-co-ogden-2', title: 'Dec 31, 2025 — Ogden Theatre (Denver, CO)' },
  { id: '2026-01-23-baltimore-md-soundstage-1', title: 'Jan 23, 2026 — Baltimore Soundstage (Baltimore, MD)' },
  { id: '2026-01-24-baltimore-md-soundstage-2', title: 'Jan 24, 2026 — Baltimore Soundstage (Baltimore, MD)' },
  { id: '2026-02-06-pittsburgh-pa-mr-smalls-1', title: 'Feb 6, 2026 — Mr. Smalls Theatre (Pittsburgh, PA)' },
  { id: '2026-02-07-pittsburgh-pa-mr-smalls-2', title: 'Feb 7, 2026 — Mr. Smalls Theatre (Pittsburgh, PA)' },
  { id: '2026-02-26-burlington-vt-higher-ground', title: 'Feb 26, 2026 — Higher Ground (Burlington, VT)' },
  { id: '2026-02-27-portland-me-state-theatre', title: 'Feb 27, 2026 — State Theatre (Portland, ME)' },
  { id: '2026-02-28-albany-ny-empire-live', title: 'Feb 28, 2026 — Empire Live (Albany, NY)' },
  { id: '2026-03-04-savannah-ga-victory-north', title: 'Mar 4, 2026 — Victory North (Savannah, GA)' },
  { id: '2026-03-05-jacksonville-fl-intuition', title: 'Mar 5, 2026 — Intuition Ale Works (Jacksonville, FL)' },
  { id: '2026-03-06-sanford-fl-tuffys', title: 'Mar 6, 2026 — Tuffy’s Outdoor Stage (Sanford, FL)' },
  { id: '2026-03-07-st-petersburg-fl-jannus', title: 'Mar 7, 2026 — Jannus Live (St. Petersburg, FL)' }
];

// create in-memory placeholders
for (const s of PRESET_SESSIONS) {
  if (!sessions[s.id]) {
    sessions[s.id] = { owner: null, users: [], userSongs: {} };
  }
}

// static
app.use(express.static(path.join(__dirname)));

// index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// session page
app.get('/session/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'session.html'));
});

// list sessions for index
app.get('/sessions', (req, res) => {
  res.json(PRESET_SESSIONS);
});

// health
app.get('/healthz', (req, res) => res.send('ok'));

// -------------- SOCKET.IO --------------
io.on('connection', (socket) => {
  console.log('user connected');

  // joining
  socket.on('join', ({ sessionId, username }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    if (!cleanId || !username) {
      socket.emit('error', 'Invalid session or username');
      return;
    }

    // create session in memory if missing
    if (!sessions[cleanId]) {
      sessions[cleanId] = { owner: null, users: [], userSongs: {} };
    }

    const session = sessions[cleanId];

    // first joinee is owner
    if (!session.owner) {
      session.owner = username;
    }

    // add user to list (or update socketId)
    const existing = session.users.find(u => u.username === username);
    if (existing) {
      existing.socketId = socket.id;
    } else {
      session.users.push({ socketId: socket.id, username });
    }

    // build userSongs from DB for this session
    db.all(
      `SELECT username, slot, value FROM user_picks WHERE session_id = ?`,
      [cleanId],
      (err, rows) => {
        if (!err && rows) {
          session.userSongs = {};
          // make sure users are present
          session.users.forEach(u => {
            session.userSongs[u.username] = session.userSongs[u.username] || {};
          });
          rows.forEach(r => {
            session.userSongs[r.username] = session.userSongs[r.username] || {};
            session.userSongs[r.username][r.slot] = r.value;
          });
        }

        socket.join(cleanId);
        socket.emit('joined', cleanId);
        io.to(cleanId).emit('update-session', session);
      }
    );
  });

  // auto-save when user picks a song
  socket.on('set-song', ({ sessionId, slot, value, username }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    const session = sessions[cleanId];
    if (!session) return;

    // find caller
    const caller = session.users.find(u => u.socketId === socket.id);
    if (!caller) {
      socket.emit('error', 'Not in session.');
      return;
    }
    if (caller.username !== username) {
      socket.emit('error', 'You can only edit your own board.');
      return;
    }
    if (!SONG_SLOTS.includes(slot)) {
      socket.emit('error', 'Invalid slot.');
      return;
    }

    // make sure user board exists
    session.userSongs[username] = session.userSongs[username] || {};
    session.userSongs[username][slot] = value;

    // write to db (upsert)
    db.run(`INSERT OR IGNORE INTO sessions (id) VALUES (?)`, [cleanId]);
    db.run(
      `INSERT INTO user_picks (session_id, username, slot, value)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, username, slot) DO UPDATE SET value = excluded.value`,
      [cleanId, username, slot, value]
    );

    io.to(cleanId).emit('update-session', session);
  });

  // delete whole user board (owner)
  socket.on('delete-user-board', ({ sessionId, targetUsername }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    const session = sessions[cleanId];
    if (!session) return;

    const caller = session.users.find(u => u.socketId === socket.id);
    if (!caller) return;
    if (caller.username !== session.owner) {
      socket.emit('error', 'Only the session owner can delete a user board.');
      return;
    }

    delete session.userSongs[targetUsername];
    session.users = session.users.filter(u => u.username !== targetUsername);

    // delete from db too
    db.run(
      `DELETE FROM user_picks WHERE session_id = ? AND username = ?`,
      [cleanId, targetUsername]
    );

    io.to(cleanId).emit('update-session', session);
  });

  // clear-all: just wipe picks for this session
  socket.on('clear-all', ({ sessionId }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    const session = sessions[cleanId];
    if (!session) return;

    // wipe in memory
    Object.keys(session.userSongs).forEach(u => {
      session.userSongs[u] = {};
    });

    // wipe in db
    db.run(`DELETE FROM user_picks WHERE session_id = ?`, [cleanId]);

    io.to(cleanId).emit('update-session', session);
  });

  socket.on('disconnect', () => {
    console.log('user disconnected');
  });
});

// -------------- START SERVER --------------
const PORT = process.env.PORT || 3005;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port', PORT);
});
