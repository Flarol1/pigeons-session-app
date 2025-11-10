const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// in-memory sessions
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

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/session/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'session.html'));
});

// optional: list sessions
app.get('/sessions', (req, res) => {
  res.json(Object.keys(sessions));
});

io.on('connection', (socket) => {
  console.log('User connected');

  // CREATE
  socket.on('create', (sessionId) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    if (!cleanId) {
      socket.emit('error', 'Invalid session name.');
      return;
    }
    if (!sessions[cleanId]) {
      sessions[cleanId] = {
        users: [],      // [{socketId, username}]
        userSongs: {}   // { username: { slot: value } }
      };
      console.log('Created session:', cleanId);
    }
    socket.join(cleanId);
    socket.emit('created', cleanId);
  });

  // JOIN
  socket.on('join', ({ sessionId, username }) => {
  const cleanId = decodeURIComponent(sessionId || '').trim();
  if (!cleanId || !username) {
    socket.emit('error', 'Invalid session or username');
    return;
  }

  // create session if missing
  if (!sessions[cleanId]) {
    sessions[cleanId] = {
      users: [],
      userSongs: {}
    };
  }

  const session = sessions[cleanId];

  // 1) make sure this user has a songs object (their board)
  if (!session.userSongs[username]) {
    session.userSongs[username] = {};   // slot -> song
  }

  // 2) if this name is already in the session, update its socketId
  const existingUser = session.users.find(u => u.username === username);
  if (existingUser) {
    // replace old socket with this new connection
    existingUser.socketId = socket.id;
  } else {
    // otherwise add a new user entry
    session.users.push({ socketId: socket.id, username });
  }

  socket.join(cleanId);
  socket.emit('joined', cleanId);
  io.to(cleanId).emit('update-session', session);
});

  // SET SONG – only allow editing your own board
  socket.on('set-song', ({ sessionId, slot, value, username }) => {
  const cleanId = decodeURIComponent(sessionId || '').trim();
  const session = sessions[cleanId];
  if (!session) return;

  // find who this socket really is (after we updated it in join)
  const userRecord = session.users.find(u => u.socketId === socket.id);
  if (!userRecord || userRecord.username !== username) {
    socket.emit('error', 'You can only edit your own board.');
    return;
  }

  if (!session.userSongs[username]) {
    session.userSongs[username] = {};
  }
  session.userSongs[username][slot] = value;

  io.to(cleanId).emit('update-session', session);
});


  // CLEAR ONE SLOT – only yours
  socket.on('clear-slot', ({ sessionId, slot, username }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    const session = sessions[cleanId];
    if (!session) return;

    const userRecord = session.users.find(u => u.socketId === socket.id);
    if (!userRecord) return;
    if (userRecord.username !== username) {
      socket.emit('error', 'You cannot clear another user’s picks.');
      return;
    }

    if (session.userSongs[username]) {
      delete session.userSongs[username][slot];
    }

    io.to(cleanId).emit('update-session', session);
  });

  // CLEAR ALL – wipe everyone in that session
  socket.on('clear-all', ({ sessionId }) => {
    const cleanId = decodeURIComponent(sessionId || '').trim();
    const session = sessions[cleanId];
    if (!session) return;
    Object.keys(session.userSongs).forEach(user => {
      session.userSongs[user] = {};
    });
    io.to(cleanId).emit('update-session', session);
  });

  // disconnect cleanup
socket.on('disconnect', () => {
  // do nothing, we want boards to stay visible
});

});

const PORT = process.env.PORT || 3005;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
