require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
const { setupSignaling, getConnectionStatus } = require('./websocket/signaling');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use('/api/auth', authRoutes);

const webClientPath = path.join(__dirname, '..', 'web-client');
app.use(express.static(webClientPath, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));
console.log('Serving static files from:', webClientPath);

const io = new Server(server, {
  cors: {
    origin: true,
    methods: ['GET', 'POST'],
    credentials: true
  },
  maxHttpBufferSize: 2e6,
  perMessageDeflate: false,
  httpCompression: false,
});

const connections = setupSignaling(io);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    ...getConnectionStatus()
  });
});

function splitEnvList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

app.get('/api/webrtc-config', (req, res) => {
  const stunUrls = splitEnvList(process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302');
  const turnUrls = splitEnvList(process.env.TURN_URLS);
  const turnUsername = process.env.TURN_USERNAME || '';
  const turnCredential = process.env.TURN_CREDENTIAL || '';
  const turnConfigured = Boolean(turnUrls.length > 0 && turnUsername && turnCredential);

  const iceServers = [];
  if (stunUrls.length) {
    iceServers.push({ urls: stunUrls });
  }
  if (turnConfigured) {
    iceServers.push({
      urls: turnUrls,
      username: turnUsername,
      credential: turnCredential,
    });
  }

  res.json({
    stunUrls,
    turnConfigured,
    turnUrls: turnConfigured ? turnUrls : [],
    iceServers,
  });
});

const PORT = process.env.PORT || 8080;

server.listen(PORT, () => {
  console.log(`Signal server listening on port ${PORT}`);
});
