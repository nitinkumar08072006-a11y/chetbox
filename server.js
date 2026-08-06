const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Active rooms state
const rooms = new Map();

io.on('connection', (socket) => {
  socket.on('join-room', ({ room, passwordHash }) => {
    let roomData = rooms.get(room);

    if (!roomData) {
      // First user initializes room
      roomData = { passwordHash, count: 1, clients: new Set([socket.id]) };
      rooms.set(room, roomData);
      socket.join(room);
      socket.currentRoom = room;
      return socket.emit('joined', { room, isHost: true });
    }

    // Room capacity check
    if (roomData.count >= 2) {
      return socket.emit('error-msg', 'Room is full! Maximum 2 users allowed.');
    }

    // Password verification
    if (roomData.passwordHash !== passwordHash) {
      return socket.emit('error-msg', 'Incorrect room password.');
    }

    roomData.count++;
    roomData.clients.add(socket.id);
    socket.join(room);
    socket.currentRoom = room;

    socket.emit('joined', { room, isHost: false });
    io.to(room).emit('peer-status', { count: roomData.count, status: 'connected' });
  });

  socket.on('send-message', ({ room, payload }) => {
    // Relay encrypted message straight to the other user
    socket.to(room).emit('receive-message', payload);
  });

  socket.on('disconnect', () => {
    const room = socket.currentRoom;
    if (room && rooms.has(room)) {
      const roomData = rooms.get(room);
      roomData.count--;
      roomData.clients.delete(socket.id);

      if (roomData.count <= 0) {
        rooms.delete(room); // Wipe room metadata when empty
      } else {
        io.to(room).emit('peer-status', { count: roomData.count, status: 'disconnected' });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Secure Chat running on http://localhost:${PORT}`));