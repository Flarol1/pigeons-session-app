const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// in-memory session store
const sessions = {};

const SONG_SLOTS = [
  "Opener",
  "Song 2",
  "Song 3",
  "Song 4",
  "Song 5",
  "Encore",
  "Cover",
  "Bustout"
];
// ---- PREBUILT TOUR SESSIONS ----
// id = URL-safe slug used in /session/:id
// title = nice label shown on the index page
const PRESET_SESSIONS = [
  { id: "2025-11-11-jackson-ms-duling-hall",        title: "Nov 11, 2025 — Duling Hall (Jackson, MS)" },
  { id: "2025-11-12-houston-tx-the-heights-theater",title: "Nov 12, 2025 — The Heights Theater (Houston, TX)" },
  { id: "2025-11-14-austin-tx-mohawk",              title: "Nov 14, 2025 — Mohawk (Austin, TX)" },
  { id: "2025-11-15-dallas-tx-echo-lounge",         title: "Nov 15, 2025 — The Echo Lounge & Music Hall (Dallas, TX)" },
  { id: "2025-11-16-fayetteville-ar-georges-majestic", title: "Nov 16, 2025 — George’s Majestic Lounge (Fayetteville, AR)" },
  { id: "2025-11-18-omaha-ne-slowdown",             title: "Nov 18, 2025 — Slowdown (Omaha, NE)" },
  { id: "2025-11-19-minneapolis-mn-fine-line",      title: "Nov 19, 2025 — Fine Line (Minneapolis, MN)" },
  { id: "2025-11-20-madison-wi-majestic",           title: "Nov 20, 2025 — Majestic Theatre (Madison, WI)" },
  { id: "2025-11-21-stl-mo-the-sovereign",          title: "Nov 21, 2025 — The Sovereign (St. Louis, MO)" },
  { id: "2025-11-22-covington-ky-madison-theater",  title: "Nov 22, 2025 — Madison Theater (Covington, KY)" },
  { id: "2025-12-05-richmond-va-the-national-1",    title: "Dec 5, 2025 — The National (Richmond, VA)" },
  { id: "2025-12-06-richmond-va-the-national-2",    title: "Dec 6, 2025 — The National (Richmond, VA)" },
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

// Create each preset session at boot (owner/users will fill in as people join)
for (const s of PRESET_SESSIONS) {
  if (!sessions[s.id]) {
    sessions[s.id] = { owner: null, users: [], userSongs: {} };
  }
}


// static (optional public/)
app.use(express.static(path.join(__dirname, 'public')));

// homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// session page
app.get('/session/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'session.html'));
});

// list sessions with labels for the index page
app.get('/sessions', (req, res) => {
  // Prefer PRESET_SESSIONS order/labels, but also include any ad-hoc sessions if you keep that flow
  const listed = PRESET_SESSIONS.map(s => ({ id: s.id, title: s.title }));
  res.json(listed);
});


// health for Render
app.get('/healthz', (req, res) => {
  res.send('ok');
});

io.on('connection', (socket) => {
  console.log('user connected');

  // optional create from index
  socket.on('create', (sessionId) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    if (!cleanId) {
      socket.emit('error', 'Invalid session name.');
      return;
    }
    if (!sessions[cleanId]) {
      sessions[cleanId] = {
        owner: null,
        users: [],
        userSongs: {}
      };
      console.log('created session', cleanId);
    }
    socket.join(cleanId);
    socket.emit('created', cleanId);
  });

  // join a session with a name
  socket.on('join', ({ sessionId, username }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    if (!cleanId || !username) {
      socket.emit('error', 'Invalid session or username');
      return;
    }

    // create if missing
    if (!sessions[cleanId]) {
      sessions[cleanId] = {
        owner: null,
        users: [],
        userSongs: {}
      };
    }

    const session = sessions[cleanId];

    // first person is owner
    if (!session.owner) {
      session.owner = username;
    }

    // make sure user has a board
    if (!session.userSongs[username]) {
      session.userSongs[username] = {};
    }

    // update or add user entry
    const existingUser = session.users.find(u => u.username === username);
    if (existingUser) {
      existingUser.socketId = socket.id;
    } else {
      session.users.push({ socketId: socket.id, username });
    }

    socket.join(cleanId);
    socket.emit('joined', cleanId);
    io.to(cleanId).emit('update-session', session);
  });

  // user sets their own slot
  socket.on('set-song', ({ sessionId, slot, value, username }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    const session = sessions[cleanId];
    if (!session) return;
// bulk set songs for one user
socket.on('set-many-songs', ({ sessionId, username, songs }) => {
  const cleanId = decodeURIComponent(sessionId || '').trim();
  const session = sessions[cleanId];
  if (!session) return;

  // who is calling?
  const caller = session.users.find(u => u.socketId === socket.id);
  if (!caller) {
    socket.emit('error', 'Not in session.');
    return;
  }

  // only let users save their OWN board
  if (caller.username !== username) {
    socket.emit('error', 'You can only save your own songs.');
    return;
  }

  // make sure their board exists
  if (!session.userSongs[username]) {
    session.userSongs[username] = {};
  }

  // songs is an object: { "Opener": "Avalanche", "Song 2": "Horizon", ... }
  for (const [slot, value] of Object.entries(songs)) {
    // ignore unknown slots
    if (!SONG_SLOTS.includes(slot)) continue;

    if (value && value.trim() !== '') {
      session.userSongs[username][slot] = value.trim();
    } else {
      // if they cleared it, remove it
      delete session.userSongs[username][slot];
    }
  }

  // send updated session to everyone in the room
  io.to(cleanId).emit('update-session', session);
});


    // find caller
    const caller = session.users.find(u => u.socketId === socket.id);
    if (!caller) {
      socket.emit('error', 'Not in session.');
      return;
    }
    // only edit your own board
    if (caller.username !== username) {
      socket.emit('error', 'You can only edit your own board.');
      return;
    }
    if (!SONG_SLOTS.includes(slot)) {
      socket.emit('error', 'Invalid slot.');
      return;
    }

    if (!session.userSongs[username]) {
      session.userSongs[username] = {};
    }
    session.userSongs[username][slot] = value;

    io.to(cleanId).emit('update-session', session);
  });

  // delete a single slot value (owner OR board owner)
  socket.on('delete-song', ({ sessionId, slot, username }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    const session = sessions[cleanId];
    if (!session) return;

    const caller = session.users.find(u => u.socketId === socket.id);
    if (!caller) {
      socket.emit('error', 'Not in session.');
      return;
    }

    const isSessionOwner = caller.username === session.owner;
    const isBoardOwner = caller.username === username;

    if (!isSessionOwner && !isBoardOwner) {
      socket.emit('error', 'You can only delete your own entry.');
      return;
    }

    if (session.userSongs[username] && session.userSongs[username][slot]) {
      delete session.userSongs[username][slot];
    }

    io.to(cleanId).emit('update-session', session);
  });

  // OWNER-ONLY: delete a whole user's board
  socket.on('delete-user-board', ({ sessionId, targetUsername }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    const session = sessions[cleanId];
    if (!session) return;

    const caller = session.users.find(u => u.socketId === socket.id);
    if (!caller) {
      socket.emit('error', 'Not in session.');
      return;
    }

    const isOwner = caller.username === session.owner;
    if (!isOwner) {
      socket.emit('error', 'Only the session owner can delete a user board.');
      return;
    }

    // remove their songs
    if (session.userSongs[targetUsername]) {
      delete session.userSongs[targetUsername];
    }

    // remove from users list
    session.users = session.users.filter(u => u.username !== targetUsername);

    io.to(cleanId).emit('update-session', session);
  });

  // clear all boards
  socket.on('clear-all', ({ sessionId }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    const session = sessions[cleanId];
    if (!session) return;

    Object.keys(session.userSongs).forEach(user => {
      session.userSongs[user] = {};
    });

    io.to(cleanId).emit('update-session', session);
  });

  // don't remove users on disconnect so boards stay visible
  socket.on('disconnect', () => {
    console.log('user disconnected');
  });
});

const PORT = process.env.PORT || 3005;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
