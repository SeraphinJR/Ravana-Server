// ── The Entry Point ─────────────────────────────────────────
// Boots Express + Socket.io with wide-open CORS for local dev.

const path = require('path');
const express = require('express');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');
const { setupSockets } = require('./sockets');

const app = express();
const server = http.createServer(app);

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 1e8
});

// Get all network IP addresses
function getAllNetworkIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({
          address: iface.address,
          interface: name
        });
      }
    }
  }
  return ips;
}

// Get best network IP address (prefer 10.x.x.x over 192.168.x.x)
function getNetworkIP() {
  const ips = getAllNetworkIPs();
  
  if (ips.length === 0) return 'localhost';
  
  // Prioritize 10.x.x.x addresses (common in larger networks)
  const tenNet = ips.find(ip => ip.address.startsWith('10.'));
  if (tenNet) return tenNet.address;
  
  // Then 172.16-31.x.x addresses
  const seventeenNet = ips.find(ip => {
    const parts = ip.address.split('.');
    return parts[0] === '172' && parseInt(parts[1]) >= 16 && parseInt(parts[1]) <= 31;
  });
  if (seventeenNet) return seventeenNet.address;
  
  // Finally 192.168.x.x addresses
  const oneNineTwo = ips.find(ip => ip.address.startsWith('192.168.'));
  if (oneNineTwo) return oneNineTwo.address;
  
  // Return first available
  return ips[0].address;
}

// Health-check endpoint (handy for hackathon demos)
app.get('/', (_req, res) => {
  res.json({ status: 'Ravana render server running 🔥' });
});

// Network IP endpoint
app.get('/network-ip', (_req, res) => {
  const allIPs = getAllNetworkIPs();
  const bestIP = getNetworkIP();
  res.json({ 
    ip: bestIP,
    allIPs: allIPs,
    interfaces: allIPs.map(ip => `${ip.interface}: ${ip.address}`)
  });
});

// Socket.io test console
app.get('/test', (_req, res) => {
  res.sendFile(path.join(__dirname, 'test.html'));
});

setupSockets(io);

const PORT = process.env.PORT || 3000;
const networkIP = getNetworkIP();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`⚡ Ravana server listening on:`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${networkIP}:${PORT}`);
});
