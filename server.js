// server.js (Firestore)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// ───────────────── DB mode detection ─────────────────
const DB_DISABLED =
  String(process.env.DISABLE_DB || '').trim() === '1';

console.log('[BOOT]', DB_DISABLED ? 'DB DISABLED → using in-memory' : 'DB ENABLED → using Firestore');

// ───────────────── Firestore init ─────────────────
let firestore = null;

function getFirestore() {
  if (DB_DISABLED) return null;
  if (firestore) return firestore;
const { Firestore } = require('@google-cloud/firestore');

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ||
  process.env.GCLOUD_PROJECT ||
  process.env.GCP_PROJECT;

const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '(default)';

const db = new Firestore({
  projectId: PROJECT_ID,
  databaseId: DATABASE_ID,
});


  if (!PROJECT_ID) {
    throw new Error('Missing project id. Set FIREBASE_PROJECT_ID (or GCLOUD_PROJECT).');
  }

  firestore = new Firestore({ projectId: PROJECT_ID, databaseId: DATABASE_ID });
  console.log('[FIRESTORE]', `projectId=${PROJECT_ID} databaseId=${DATABASE_ID}`);
  return firestore;
}

// ───────────────── Data layer ─────────────────
const SONG_SLOTS = [
  'Opener',
  'Song 2',
  'Song 3',
  'Song 4',
  'Song 5',
  'Song 6',
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

// ---------- In-memory fallback ----------
const mem = {
  sessions: new Map(), // id -> { users:Set, picks: Map("user|slot" -> value) }
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

  [...s.users].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
    .forEach(u => state.users.push({ socketId: null, username: u }));

  for (const [key, val] of s.picks.entries()) {
    const [u, slot] = key.split('|');
    if (!state.userSongs[u]) state.userSongs[u] = {};
    state.userSongs[u][slot] = val;
  }
  return state;
}

// ---------- Firestore impl ----------
function picksDocId(username, slot) {
  return `${username}__${slot}`.replaceAll('/', '_');
}

async function fsEnsureSession(sessionId) {
  const db = getFirestore();
  await db.collection('sessions').doc(sessionId).set(
    { createdAt: new Date().toISOString() },
    { merge: true }
  );
}

async function fsEnsureUser(sessionId, username) {
  const db = getFirestore();
  await db.collection('sessions').doc(sessionId)
    .collection('users').doc(username)
    .set({ joinedAt: new Date().toISOString() }, { merge: true });
}

async function fsUpsertPick(sessionId, username, slot, value) {
  const db = getFirestore();
  const docId = picksDocId(username, slot);
  await db.collection('sessions').doc(sessionId)
    .collection('picks').doc(docId)
    .set({ username, slot, value, updatedAt: new Date().toISOString() }, { merge: true });
}

async function fsDeletePick(sessionId, username, slot) {
  const db = getFirestore();
  const docId = picksDocId(username, slot);
  await db.collection('sessions').doc(sessionId)
    .collection('picks').doc(docId).delete();
}

async function fsClearBoard(sessionId, username) {
  const db = getFirestore();
  const picksRef = db.collection('sessions').doc(sessionId).collection('picks');
  const snap = await picksRef.where('username', '==', username).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

async function fsBuildState(sessionId) {
  const db = getFirestore();
  const state = { owner: null, users: [], userSongs: {} };

  const usersSnap = await db.collection('sessions').doc(sessionId).collection('users').get();
  const users = usersSnap.docs.map(d => d.id);
  users.sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  state.users = users.map(u => ({ socketId: null, username: u }));

  const picksSnap = await db.collection('sessions').doc(sessionId).collection('picks').get();
  picksSnap.docs.forEach(d => {
    const { username, slot, value } = d.data();
    if (!state.userSongs[username]) state.userSongs[username] = {};
    state.userSongs[username][slot] = value;
  });

  return state;
}

// Choose backend
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
      ensureSession: fsEnsureSession,
      ensureUser: fsEnsureUser,
      upsertPick: fsUpsertPick,
      deletePick: fsDeletePick,
      clearBoard: fsClearBoard,
      buildState: fsBuildState,
    };

// ───────────────── App / sockets ─────────────────
// ✅ IMPORTANT: app must be initialized BEFORE any app.get/app.post usage
const app = express();
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server);

// serve static + pages
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/session/:id', (req, res) => res.sendFile(path.join(__dirname, 'session.html')));

// homepage list
app.get('/sessions', (req, res) => {
  res.json(PRESET_SESSIONS.map(s => ({ id: s.id, title: s.title })));
});

// health
app.get('/healthz', (req, res) => res.send('ok'));

// dbcheck
app.get('/dbcheck', async (req, res) => {
  if (DB_DISABLED) return res.type('text').send('DB DISABLED (in-memory)');
  try {
    // Lightweight Firestore call:
    const db = getFirestore();
    await db.collection('__health').doc('ping').set({ ts: new Date().toISOString() }, { merge: true });
    res.type('text').send('FIRESTORE OK');
  } catch (e) {
    console.error('[DBCHECK ERROR]', e);
    res.status(500).type('text').send('DB FAIL: ' + e.message);
  }
});

// ───────────────── Songs library ─────────────────

// Get all songs (sorted)
app.get('/songs', async (req, res) => {
  if (DB_DISABLED) return res.json({ songs: [] });

  try {
    const db = getFirestore();
    const snap = await db.collection('songs').get();
    const songs = snap.docs.map(d => d.data()?.name).filter(Boolean);
    songs.sort((a, b) => a.localeCompare(b));
    res.json({ songs });
  } catch (e) {
    console.error('[GET /songs ERROR]', e);
    res.status(500).json({ error: e.message });
  }
});

// Add a song (idempotent)
app.post('/songs', async (req, res) => {
  if (DB_DISABLED) return res.status(400).json({ error: 'DB disabled' });

  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Missing name' });
  if (name.length > 120) return res.status(400).json({ error: 'Name too long' });

  try {
    const db = getFirestore();
    // doc id = name (safe unless name contains "/")
    const docId = name.replaceAll('/', '_');
    await db.collection('songs').doc(docId).set(
      { name, createdAt: new Date().toISOString() },
      { merge: true }
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /songs ERROR]', e);
    res.status(500).json({ error: e.message });
  }
});


// Add a song (idempotent)
app.post('/songs', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Missing name' });
    if (name.length > 120) return res.status(400).json({ error: 'Name too long' });

    // Use a safe doc id, but still store the real name for display
    const docId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const ref = db.collection('songs').doc(docId || undefined);

    // Set merge so it's idempotent if it already exists
    await ref.set({ name, updatedAt: new Date() }, { merge: true });

    res.json({ ok: true });
  } catch (e) {
    console.error('[POST /songs ERROR]', e);
    res.status(500).json({ error: e.message });
  }
});

// Delete a song
app.delete('/songs', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Missing name' });

    // Find doc(s) by name and delete them
    const snap = await db.collection('songs').where('name', '==', name).get();
    if (snap.empty) return res.json({ ok: true, deleted: 0 });

    const batch = db.batch();
    snap.forEach(doc => batch.delete(doc.ref));
    await batch.commit();

    res.json({ ok: true, deleted: snap.size });
  } catch (e) {
    console.error('[DELETE /songs ERROR]', e);
    res.status(500).json({ error: e.message });
  }
});

// ───────────────── Sockets ─────────────────

// Track socket -> identity to prevent spoofing
const socketMap = new Map(); // socket.id -> { sessionId, username }

io.on('connection', (socket) => {
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

      const state = await api.buildState(cleanId);
      io.to(cleanId).emit('update-session', state);
    } catch (err) {
      console.error('[JOIN ERROR]', err);
      socket.emit('error', 'Join failed: ' + err.message);
    }
  });

  socket.on('set-song', async ({ sessionId, slot, value }) => {
    const who = socketMap.get(socket.id);
    if (!who) return socket.emit('error', 'Not joined.');

    const cleanId = who.sessionId || decodeURIComponent(String(sessionId || '')).trim();
    const caller = who.username;

    const cleanSlot = String(slot || '').trim();
    const cleanValue = String(value ?? '').trim();

    if (!SONG_SLOTS.includes(cleanSlot)) {
      return socket.emit('error', `Invalid slot "${cleanSlot}".`);
    }

    try {
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

  socket.on('disconnect', () => {
    socketMap.delete(socket.id);
  });
});

// ───────────────── boot ─────────────────
const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
