const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7 // Support for up to 10MB photo payloads
});

app.use(express.static('public'));

// Stores active rooms dynamically
const rooms = new Map();

io.on('connection', (socket) => {

  // Create Room Handler
  socket.on('create-room', ({ room, passwordHash, username }) => {
    if (rooms.has(room)) {
      return socket.emit('error-msg', 'Room ID already exists! Choose a different ID or use Join Room.');
    }

    const roomData = {
      passwordHash,
      count: 1,
      clients: new Map([[socket.id], username])
    };

    rooms.set(room, roomData);
    socket.join(room);
    socket.currentRoom = room;

    socket.emit('joined', { room });
    io.to(room).emit('peer-status', { count: roomData.count, user: username, status: 'connected' });
  });

  // Join Room Handler
  socket.on('join-room', ({ room, passwordHash, username }) => {
    const roomData = rooms.get(room);

    if (!roomData) {
      return socket.emit('error-msg', 'Room does not exist. Check the Room ID or create a new room.');
    }

    if (roomData.count >= 10) {
      return socket.emit('error-msg', 'Room is full! Maximum 10 participants allowed.');
    }

    if (roomData.passwordHash !== passwordHash) {
      return socket.emit('error-msg', 'Incorrect room passphrase.');
    }

    roomData.count++;
    roomData.clients.set(socket.id, username);
    socket.join(room);
    socket.currentRoom = room;

    socket.emit('joined', { room });
    io.to(room).emit('peer-status', { count: roomData.count, user: username, status: 'connected' });
  });

  // Relay Encrypted Messages
  socket.on('send-message', ({ room, payload }) => {
    socket.to(room).emit('receive-message', payload);
  });

  // Handle Disconnections
  socket.on('disconnect', () => {
    const room = socket.currentRoom;
    if (room && rooms.has(room)) {
      const roomData = rooms.get(room);
      const username = roomData.clients.get(socket.id);

      roomData.clients.delete(socket.id);
      roomData.count = roomData.clients.size;

      if (roomData.count <= 0) {
        rooms.delete(room);
      } else {
        io.to(room).emit('peer-status', { count: roomData.count, user: username, status: 'disconnected' });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 CipherRoom running on http://localhost:${PORT}`));
