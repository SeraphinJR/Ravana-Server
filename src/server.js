// ── The Entry Point ─────────────────────────────────────────
// Boots Express + Socket.io with wide-open CORS for local dev.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { setupSockets } = require('./sockets');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// Health-check endpoint (handy for hackathon demos)
app.get('/', (_req, res) => {
  res.json({ status: 'Ravana render server running 🔥' });
});

// Socket.io test console
app.get('/test', (_req, res) => {
  res.sendFile(path.join(__dirname, 'test.html'));
});

setupSockets(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⚡ Ravana server listening on http://localhost:${PORT}`);
});
