require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const authRoutes = require('./routes/auth');
const { loadConfig, getTurnStatus } = require('./lib/config');
const { readBearerToken, verifyAccessToken } = require('./lib/auth');
const { setupSignaling, getConnectionStatus } = require('./websocket/signaling');
const { setupTerminal } = require('./websocket/terminal');
const { ensureNodePtySpawnHelperExecutable } = require('./lib/terminal/node-pty-setup');

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

function createServerApp(options = {}) {
  const config = options.config || loadConfig();
  const logger = options.logger || console;
  ensureNodePtySpawnHelperExecutable(logger);

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
  logger.log?.('Serving static files from:', webClientPath);

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

  setupSignaling(io);
  const terminal = setupTerminal(io, { config, logger });

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

  app.get('/api/webrtc-config', requireAccessToken, (req, res) => {
    const turnState = getTurnStatus(config);

    const iceServers = [];
    if (config.stunUrls.length) {
      iceServers.push({ urls: config.stunUrls });
    }
    if (turnState.turnConfigured) {
      iceServers.push({
        urls: config.turnUrls,
        username: config.turnUsername,
        credential: config.turnCredential,
      });
    }

    res.json({
      stunUrls: config.stunUrls,
      turnConfigured: turnState.turnConfigured,
      turnMisconfigured: turnState.turnMisconfigured,
      turnStatus: turnState.turnStatus,
      turnUrls: turnState.turnConfigured ? config.turnUrls : [],
      iceServers,
    });
  });

  app.get('/api/terminal/bootstrap', requireAccessToken, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    return res.json({
      enabled: config.enableTerminal,
      softWarnSessionCount: config.terminalSoftWarnSessionCount,
      pool: terminal.sessionManager.getPoolSnapshot(),
    });
  });

  return {
    app,
    server,
    io,
    config,
    terminal,
  };
}

function startServer(options = {}) {
  const runtime = createServerApp(options);
  const port = runtime.config.port || 8080;
  runtime.server.listen(port, '0.0.0.0', () => {
    (options.logger || console).log?.(`Signal server listening on 0.0.0.0:${port}`);
  });
  return runtime;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createServerApp,
  startServer,
  requireAccessToken,
};
