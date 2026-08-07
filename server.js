const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7 // Support up to 10MB photo payloads
});

// Database Setup
const db = new Database('chat.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    room_id TEXT PRIMARY KEY,
    room_name TEXT NOT NULL,
    passphrase_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT,
    user_id TEXT,
    PRIMARY KEY (room_id, user_id),
    FOREIGN KEY(room_id) REFERENCES rooms(room_id),
    FOREIGN KEY(user_id) REFERENCES users(user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    iv TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(room_id) REFERENCES rooms(room_id)
  );
`);

// Prepared Statements
const stmtGetUser = db.prepare('SELECT * FROM users WHERE LOWER(user_id) = LOWER(?)');
const stmtCreateUser = db.prepare('INSERT INTO users (user_id, password_hash, display_name) VALUES (?, ?, ?)');

const stmtGetRoom = db.prepare('SELECT * FROM rooms WHERE room_id = ?');
const stmtCreateRoom = db.prepare('INSERT INTO rooms (room_id, room_name, passphrase_hash) VALUES (?, ?, ?)');

const stmtAddMember = db.prepare('INSERT OR IGNORE INTO room_members (room_id, user_id) VALUES (?, ?)');
const stmtGetUserRooms = db.prepare(`
  SELECT r.room_id, r.room_name 
  FROM rooms r 
  JOIN room_members rm ON r.room_id = rm.room_id 
  WHERE LOWER(rm.user_id) = LOWER(?)
`);

const stmtSaveMessage = db.prepare('INSERT INTO messages (room_id, iv, data) VALUES (?, ?, ?)');
const stmtGetMessages = db.prepare('SELECT iv, data FROM messages WHERE room_id = ? ORDER BY id ASC');

app.use(express.static('public'));

const activeSessions = new Map(); // socket.id -> { userId, displayName, activeRoom }

io.on('connection', (socket) => {

  // Auth: Register
  socket.on('register', async ({ userId, displayName, password }) => {
    try {
      const cleanUserId = userId.trim().toLowerCase();
      if (stmtGetUser.get(cleanUserId)) {
        return socket.emit('auth-error', 'User ID already taken. Choose another.');
      }
      const hash = await bcrypt.hash(password, 10);
      stmtCreateUser.run(cleanUserId, hash, displayName.trim());
      socket.emit('auth-success', { userId: cleanUserId, displayName: displayName.trim(), rooms: [] });
    } catch (err) {
      socket.emit('auth-error', 'Registration failed: ' + err.message);
    }
  });

  // Auth: Login
  socket.on('login', async ({ userId, password }) => {
    try {
      const cleanUserId = userId.trim().toLowerCase();
      const user = stmtGetUser.get(cleanUserId);
      if (!user) return socket.emit('auth-error', 'User ID not found.');

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return socket.emit('auth-error', 'Invalid password.');

      const userRooms = stmtGetUserRooms.all(cleanUserId);
      activeSessions.set(socket.id, { userId: cleanUserId, displayName: user.display_name, activeRoom: null });

      socket.emit('auth-success', { userId: cleanUserId, displayName: user.display_name, rooms: userRooms });
    } catch (err) {
      socket.emit('auth-error', 'Login failed: ' + err.message);
    }
  });

  // Room Action: Create Room
  socket.on('create-room', ({ userId, roomId, roomName, passphraseHash }) => {
    try {
      const cleanUserId = userId.trim().toLowerCase();
      const cleanRoomId = roomId.trim();

      if (stmtGetRoom.get(cleanRoomId)) {
        return socket.emit('room-error', 'Room ID already exists!');
      }

      stmtCreateRoom.run(cleanRoomId, roomName.trim(), passphraseHash);
      stmtAddMember.run(cleanRoomId, cleanUserId);

      const userRooms = stmtGetUserRooms.all(cleanUserId);
      socket.emit('update-rooms', userRooms);
      socket.emit('room-action-success', { roomId: cleanRoomId, roomName: roomName.trim() });
    } catch (err) {
      socket.emit('room-error', 'Failed to create room: ' + err.message);
    }
  });

  // Room Action: Join Existing Room
  socket.on('join-room', ({ userId, roomId, passphraseHash }) => {
    try {
      const cleanUserId = userId.trim().toLowerCase();
      const cleanRoomId = roomId.trim();

      const room = stmtGetRoom.get(cleanRoomId);
      if (!room) return socket.emit('room-error', 'Room ID does not exist.');
      if (room.passphrase_hash !== passphraseHash) return socket.emit('room-error', 'Incorrect room passphrase.');

      stmtAddMember.run(cleanRoomId, cleanUserId);

      const userRooms = stmtGetUserRooms.all(cleanUserId);
      socket.emit('update-rooms', userRooms);
      socket.emit('room-action-success', { roomId: cleanRoomId, roomName: room.room_name });
    } catch (err) {
      socket.emit('room-error', 'Failed to join room: ' + err.message);
    }
  });

  // Open Room Chat
  socket.on('open-room', ({ roomId }) => {
    const session = activeSessions.get(socket.id);
    if (!session) return;

    if (session.activeRoom) {
      socket.leave(session.activeRoom);
    }

    socket.join(roomId);
    session.activeRoom = roomId;

    const dbMessages = stmtGetMessages.all(roomId);
    const history = dbMessages.map(msg => ({
      iv: JSON.parse(msg.iv),
      data: JSON.parse(msg.data)
    }));

    socket.emit('room-opened', { roomId, history });
  });

  // Relay & Save Message
  socket.on('send-message', ({ roomId, payload }) => {
    stmtSaveMessage.run(roomId, JSON.stringify(payload.iv), JSON.stringify(payload.data));
    socket.to(roomId).emit('receive-message', { roomId, payload });
  });

  // Disconnect Handler
  socket.on('disconnect', () => {
    activeSessions.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 CipherRoom running on http://localhost:${PORT}`));
