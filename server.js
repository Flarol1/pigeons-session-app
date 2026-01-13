// server.js — Firestore-backed (with in-memory fallback)
// Requires: npm i firebase-admin
//
// Env you should set on Cloud Run (recommended):
//   FIREBASE_PROJECT_ID=your-gcp-project-id
// And run Cloud Run with a service account that has:
//   "Cloud Datastore User" (Firestore access)
//
// Optional:
//   DISABLE_FIRESTORE=1  -> forces in-memory mode

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const admin = require('firebase-admin');

const { Firestore } = require('@google-cloud/firestore');

// Cloud Run usually provides GOOGLE_CLOUD_PROJECT automatically
const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.GCP_PROJECT;

// Firestore default database id is literally "(default)"
const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '(default)';

if (!PROJECT_ID) {
  throw new Error(
    'Missing PROJECT_ID. Set FIREBASE_PROJECT_ID or rely on GOOGLE_CLOUD_PROJECT in Cloud Run.'
  );
}

const db = new Firestore({
  projectId: PROJECT_ID,
  databaseId: DATABASE_ID,
});

app.get('/songs', async (req, res) => {
  try {
    const snap = await db.collection('songs').orderBy('name').get();
    const songs = snap.docs.map(d => d.get('name')).filter(Boolean);
    res.json({ songs, count: songs.length });
  } catch (e) {
    console.error('[GET /songs]', e);
    res.status(500).json({ error: e.message });
  }
});

// ───────────────── Firestore mode detection ─────────────────
const FIRESTORE_DISABLED =
  String(process.env.DISABLE_FIRESTORE || '').trim() === '1' ||
  !String(process.env.FIREBASE_PROJECT_ID || '').trim();

let fs = null;

if (!FIRESTORE_DISABLED) {
  // Uses Application Default Credentials (ADC) on Cloud Run
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
  fs = admin.firestore();

  console.log('[BOOT] Firestore enabled:', process.env.FIREBASE_PROJECT_ID);
} else {
  console.log('[BOOT] Firestore disabled → using in-memory');
}

// --- Admin gate (simple allow-list) ---
const ADMIN_NAMES = (process.env.ADMIN_NAMES || 'zaq,zack')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function requireAdminName(req, res, next) {
  const name = String(req.header('x-admin-name') || '').trim().toLowerCase();
  if (!name) return res.status(401).json({ error: 'Missing admin name' });
  if (!ADMIN_NAMES.includes(name)) return res.status(403).json({ error: 'Forbidden' });
  next();
}
// Read songs (public)
app.get('/songs', async (req, res) => {
  try {
    const snap = await db.collection('songs').orderBy('name').get();
    res.json({ songs: snap.docs.map(d => d.data().name) });
  } catch (e) {
    console.error('[GET /songs]', e);
    res.status(500).json({ error: e.message });
  }
});

// Add song (admin only)
app.post('/songs', requireAdminName, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Missing name' });
  if (name.length > 120) return res.status(400).json({ error: 'Name too long' });

  try {
    // Use normalized id to avoid duplicates
    const id = name.toLowerCase().replace(/\s+/g, ' ').trim();
    await db.collection('songs').doc(id).set(
      { name, created_at: new Date().toISOString() },
      { merge: true }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /songs]', e);
    res.status(500).json({ error: e.message });
  }
});

// Delete song (admin only)
app.delete('/songs', requireAdminName, async (req, res) => {
  const name = String(req.query?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Missing name' });

  try {
    const id = name.toLowerCase().replace(/\s+/g, ' ').trim();
    await db.collection('songs').doc(id).delete();
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /songs]', e);
    res.status(500).json({ error: e.message });
  }
});





// ───────────────── Data layer ─────────────────
const SONG_SLOTS = [
  'Opener',
  'Song 2',
  'Song 3',
  'Song 4',
  'Song 5',
  'Song 6', // ✅ included
  'Encore',
  'Cover',
  'Bustout',
];

const PRESET_SESSIONS = [
  { id: '2025-12-19-port-chester-ny-capitol-1', title: 'Dec 19, 2025 — The Capitol Theatre (Port Chester, NY)' },
  { id: '2025-12-20-port-chester-ny-capitol-2', title: 'Dec 20, 2025 — The Capitol Theatre (Port Chester, NY)' },
  { id: '2025-12-30-denver-co-ogden-1', title: 'Dec 30, 2025 — Ogden Theatre (Denver, CO)' },
  { id: '2025-12-31-denver-co-ogden-2', title: 'Dec 31, 2025 — Ogden Theatre (Denver, CO)' },

  { id: '2026-01-23-baltimore-md-soundstage-1', title: 'Jan 23, 2026 — Baltimore Soundstage (Baltimore, MD)' },
  { id: '2026-01-24-baltimore-md-soundstage-2', title: 'Jan 24, 2026 — Baltimore Soundstage (Baltimore, MD)' },

  { id: '2026-02-06-pittsburgh-pa-mr-smalls-1', title: 'Feb 6, 2026 — Mr. Smalls Theatre (Pittsburgh, PA)' },
  { id: '2026-02-07-pittsburgh-pa-mr-smalls-2', title: 'Feb 7, 2026 — Mr. Smalls Theatre (Pittsburgh, PA)' },

  { id: '2026-02-26-burlington-vt-higher-ground-1', title: 'Feb 26, 2026 — Higher Ground (Burlington, VT)' },
  { id: '2026-02-27-portland-me-state-theatre-1', title: 'Feb 27, 2026 — State Theatre (Portland, ME)' },
  { id: '2026-02-28-albany-ny-empire-live-1', title: 'Feb 28, 2026 — Empire Live (Albany, NY)' },

  { id: '2026-03-04-savannah-ga-victory-north-1', title: 'Mar 4, 2026 — Victory North (Savannah, GA)' },
  { id: '2026-03-05-jacksonville-fl-intuition-ale-works-1', title: 'Mar 5, 2026 — Intuition Ale Works (Jacksonville, FL)' },

  { id: '2026-03-06-sanford-fl-tuffys-outdoor-stage-1', title: "Mar 6, 2026 — Tuffy's Outdoor Stage (Sanford, FL)" },
  { id: '2026-03-07-st-petersburg-fl-jannus-live-1', title: 'Mar 7, 2026 — Jannus Live (St. Petersburg, FL)' },
  { id: '2026-03-08-fort-lauderdale-fl-culture-room-1', title: 'Mar 8, 2026 — Culture Room (Fort Lauderdale, FL)' },

  { id: '2026-03-10-birmingham-al-workplay-theatre-1', title: 'Mar 10, 2026 — WorkPlay Theatre (Birmingham, AL)' },
  { id: '2026-03-11-nashville-tn-the-basement-east-1', title: 'Mar 11, 2026 — The Basement East (Nashville, TN)' },
  { id: '2026-03-12-indianapolis-in-the-vogue-theatre-1', title: 'Mar 12, 2026 — The Vogue Theatre (Indianapolis, IN)' },
  { id: '2026-03-13-detroit-mi-saint-andrews-hall-1', title: "Mar 13, 2026 — Saint Andrew's Hall (Detroit, MI)" },
  { id: '2026-03-14-columbus-oh-the-bluestone-1', title: 'Mar 14, 2026 — The Bluestone (Columbus, OH)' },

  { id: '2026-03-28-estes-park-co-frozen-dead-guy-days-coffin-race-1', title: 'Mar 28, 2026 — Frozen Dead Guy Days & Coffin Race (Estes Park, CO)' },

  { id: '2026-08-06-new-river-gorge-wv-domefest-1', title: 'Aug 6, 2026 — Domefest (New River Gorge, WV)' },
  { id: '2026-08-07-new-river-gorge-wv-domefest-2', title: 'Aug 7, 2026 — Domefest (New River Gorge, WV)' },
  { id: '2026-08-08-new-river-gorge-wv-domefest-3', title: 'Aug 8, 2026 — Domefest (New River Gorge, WV)' },
];

// ───────────────── In-memory fallback ─────────────────
const mem = {
  sessions: new Map(), // id -> { users:Set, picks: Map("user|slot" -> value) }
  songs: new Set(),
};

function memEnsureSession(id) {
  if (!mem.sessions.has(id)) mem.sessions.set(id, { users: new Set(), picks: new Map() });
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

  [...s.users].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })).forEach((u) => {
    state.users.push({ socketId: null, username: u });
  });

  for (const [key, val] of s.picks.entries()) {
    const [u, slot] = key.split('|');
    if (!state.userSongs[u]) state.userSongs[u] = {};
    state.userSongs[u][slot] = val;
  }
  return state;
}
function memGetSongs() {
  return Array.from(mem.songs).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}
function memAddSong(name) {
  mem.songs.add(name);
}

// ───────────────── Firestore impls ─────────────────
//
// Collections layout:
//
// sessions/{sessionId}
// sessions/{sessionId}/users/{userKey}   { username }
// sessions/{sessionId}/boards/{userKey}  { username, "Opener": "...", "Song 2": "...", ... }
//
// songs/{songKey}  { name, createdAt }
//
// Notes:
// - Document IDs cannot contain "/" so we sanitize.
// - We store slot values as dynamic fields on the user's board doc (simple + cheap).
//
function userKey(username) {
  return String(username || '').trim().replaceAll('/', '_');
}
function songKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replaceAll('/', '-')
    .replace(/[^a-z0-9\-]/g, '');
}

async function fsEnsureSession(sessionId) {
  await fs.collection('sessions').doc(sessionId).set({ id: sessionId }, { merge: true });
}
async function fsEnsureUser(sessionId, username) {
  await fsEnsureSession(sessionId);
  await fs.collection('sessions')
    .doc(sessionId)
    .collection('users')
    .doc(userKey(username))
    .set({ username }, { merge: true });
}
async function fsUpsertPick(sessionId, username, slot, value) {
  await fsEnsureUser(sessionId, username);
  await fs.collection('sessions')
    .doc(sessionId)
    .collection('boards')
    .doc(userKey(username))
    .set({ username, [slot]: value }, { merge: true });
}
async function fsDeletePick(sessionId, username, slot) {
  const ref = fs.collection('sessions')
    .doc(sessionId)
    .collection('boards')
    .doc(userKey(username));

  await ref.set({ [slot]: admin.firestore.FieldValue.delete() }, { merge: true });
}
async function fsClearBoard(sessionId, username) {
  const ref = fs.collection('sessions')
    .doc(sessionId)
    .collection('boards')
    .doc(userKey(username));

  const snap = await ref.get();
  if (!snap.exists) return;

  const data = snap.data() || {};
  const updates = {};
  for (const k of Object.keys(data)) {
    if (k !== 'username') updates[k] = admin.firestore.FieldValue.delete();
  }
  if (Object.keys(updates).length) {
    await ref.set(updates, { merge: true });
  }
}
async function fsBuildState(sessionId) {
  const state = { owner: null, users: [], userSongs: {} };

  const usersSnap = await fs.collection('sessions').doc(sessionId).collection('users').get();
  state.users = usersSnap.docs
    .map((d) => d.data()?.username)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
    .map((u) => ({ socketId: null, username: u }));

  const boardsSnap = await fs.collection('sessions').doc(sessionId).collection('boards').get();
  boardsSnap.docs.forEach((doc) => {
    const b = doc.data() || {};
    const uname = b.username || doc.id;
    state.userSongs[uname] = {};
    for (const [k, v] of Object.entries(b)) {
      if (k === 'username') continue;
      state.userSongs[uname][k] = v;
    }
  });

  return state;
}

async function fsGetSongs() {
  const snap = await fs.collection('songs').orderBy('name').get();
  return snap.docs.map((d) => d.data()?.name).filter(Boolean);
}
async function fsAddSong(name) {
  const clean = String(name || '').trim();
  const id = songKey(clean) || userKey(clean) || clean; // ensure non-empty-ish
  await fs.collection('songs').doc(id).set(
    { name: clean, createdAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
}

// Choose backend (Firestore or memory)
const api = FIRESTORE_DISABLED
  ? {
      ensureSession: memEnsureSession,
      ensureUser: memEnsureUser,
      upsertPick: memUpsertPick,
      deletePick: memDeletePick,
      clearBoard: memClearBoard,
      buildState: memBuildState,
      getSongs: async () => memGetSongs(),
      addSong: async (name) => memAddSong(name),
    }
  : {
      ensureSession: fsEnsureSession,
      ensureUser: fsEnsureUser,
      upsertPick: fsUpsertPick,
      deletePick: fsDeletePick,
      clearBoard: fsClearBoard,
      buildState: fsBuildState,
      getSongs: fsGetSongs,
      addSong: fsAddSong,
    };

// ───────────────── App / sockets ─────────────────
const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server);

// serve static + pages
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/session/:id', (req, res) => res.sendFile(path.join(__dirname, 'session.html')));

// index list for homepage
app.get('/sessions', (req, res) => {
  res.json(PRESET_SESSIONS.map((s) => ({ id: s.id, title: s.title })));
});

// health + dbcheck
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/dbcheck', async (req, res) => {
  if (FIRESTORE_DISABLED) return res.type('text').send('FIRESTORE DISABLED (in-memory)');
  try {
    // very small read/write-free check
    await fs.collection('_health').doc('ping').get();
    res.type('text').send('FIRESTORE OK');
  } catch (e) {
    console.error('[DBCHECK ERROR]', e);
    res.status(500).type('text').send('FIRESTORE FAIL: ' + e.message);
  }
});

// ───────────────── Songs API ─────────────────
// Get all songs (sorted)
app.get('/songs', async (req, res) => {
  try {
    const songs = await api.getSongs();
    res.json({ songs });
  } catch (e) {
    console.error('[GET /songs ERROR]', e);
    res.status(500).json({ error: e.message });
  }
});

// Add a song (idempotent-ish)
app.post('/songs', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Missing name' });
  if (name.length > 120) return res.status(400).json({ error: 'Name too long' });

  try {
    await api.addSong(name);
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /songs ERROR]', e);
    res.status(500).json({ error: e.message });
  }
});

// Track socket -> identity to prevent spoofing
const socketMap = new Map(); // socket.id -> { sessionId, username }

io.on('connection', (socket) => {
  // JOIN: register user and room
  socket.on('join', async ({ sessionId, username }) => {
    const cleanId = decodeURIComponent(String(sessionId || '')).trim();
    const cleanUser = String(username || '').trim();

    if (!cleanId || !cleanUser) {
      socket.emit('error', 'Invalid session or username');
      return;
    }

    try {
      await api.ensureSession(cleanId);
      await api.ensureUser(cleanId, cleanUser);

      socket.join(cleanId);
      socketMap.set(socket.id, { sessionId: cleanId, username: cleanUser });

      socket.emit('joined', cleanId);

      const state = await api.buildState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[JOIN ERROR]', err);
      socket.emit('error', 'Join failed: ' + err.message);
    }
  });

  // SET SONG: only allow caller to edit their board
  socket.on('set-song', async ({ sessionId, slot, value }) => {
    const who = socketMap.get(socket.id);
    if (!who) return socket.emit('error', 'Not joined.');

    const cleanId = who.sessionId || decodeURIComponent(String(sessionId || '')).trim();
    const caller = who.username;

    const cleanSlot = String(slot || '').trim();
    const cleanValue = String(value ?? '').trim();

    if (!SONG_SLOTS.includes(cleanSlot)) {
      return socket.emit(
        'error',
        `Invalid slot "${cleanSlot}". Allowed: ${SONG_SLOTS.join(', ')}`
      );
    }

    try {
      // Empty value deletes the pick
      if (!cleanValue) {
        await api.deletePick(cleanId, caller, cleanSlot);
      } else {
        await api.upsertPick(cleanId, caller, cleanSlot, cleanValue);
      }

      const state = await api.buildState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[SET-SONG ERROR]', err);
      socket.emit('error', 'Save failed: ' + err.message);
    }
  });

  // DELETE one slot: only caller’s own pick
  socket.on('delete-song', async ({ sessionId, slot }) => {
    const who = socketMap.get(socket.id);
    if (!who) return socket.emit('error', 'Not joined.');

    const cleanId = who.sessionId || decodeURIComponent(String(sessionId || '')).trim();
    const caller = who.username;
    const cleanSlot = String(slot || '').trim();

    try {
      await api.deletePick(cleanId, caller, cleanSlot);
      const state = await api.buildState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[DELETE-SONG ERROR]', err);
      socket.emit('error', 'Delete failed: ' + err.message);
    }
  });

  // CLEAR ALL: only clears the caller’s board
  socket.on('clear-all', async ({ sessionId }) => {
    const who = socketMap.get(socket.id);
    if (!who) return socket.emit('error', 'Not joined.');

    const cleanId = who.sessionId || decodeURIComponent(String(sessionId || '')).trim();
    const caller = who.username;

    try {
      await api.clearBoard(cleanId, caller);
      const state = await api.buildState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[CLEAR-ALL ERROR]', err);
      socket.emit('error', 'Clear failed: ' + err.message);
    }
  });

  // “Delete user board” is disabled intentionally
  socket.on('delete-user-board', () => {
    socket.emit('error', 'This action is disabled.');
  });

  socket.on('disconnect', () => {
    socketMap.delete(socket.id);
  });
});

// ───────────────── boot ────────────────
const PORT = process.env.PORT || 8080; // Cloud Run expects 8080
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`[FS CONFIG] enabled=${!FIRESTORE_DISABLED} project=${process.env.FIREBASE_PROJECT_ID || '(none)'}`);
});
