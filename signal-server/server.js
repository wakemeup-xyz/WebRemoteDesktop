require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
const { loadConfig } = require('./lib/config');
const { readBearerToken, verifyAccessToken } = require('./lib/auth');
const { setupSignaling, getConnectionStatus } = require('./websocket/signaling');

const config = loadConfig();
const app = express();
const server = http.createServer(app);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || config.corsOrigins.length === 0 || config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS origin denied'));
  },
  credentials: false,
}));
app.use(express.json({ limit: '200kb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, max: 20 }), authRoutes);

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
    origin: config.corsOrigins.length ? config.corsOrigins : true,
    methods: ['GET', 'POST'],
    credentials: false
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

function requireAccessToken(req, res, next) {
  try {
    const token = readBearerToken(req.headers.authorization);
    if (!token) {
      return res.status(401).json({ error: 'Missing bearer token' });
    }
    req.user = verifyAccessToken(token);
    return next();
  } catch (_err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

app.get('/api/webrtc-config', requireAccessToken, (req, res) => {
  const turnConfigured = Boolean(config.turnUrls.length > 0 && config.turnUsername && config.turnCredential);

  const iceServers = [];
  if (config.stunUrls.length) {
    iceServers.push({ urls: config.stunUrls });
  }
  if (turnConfigured) {
    iceServers.push({
      urls: config.turnUrls,
      username: config.turnUsername,
      credential: config.turnCredential,
    });
  }

  res.json({
    stunUrls: config.stunUrls,
    turnConfigured,
    turnUrls: turnConfigured ? config.turnUrls : [],
    iceServers,
  });
});

const PORT = config.port || 8080;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signal server listening on 0.0.0.0:${PORT}`);
});
