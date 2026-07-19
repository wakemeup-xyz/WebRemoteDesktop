require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const proxyaddr = require('proxy-addr');
const { Server } = require('socket.io');
const { createAuthRouter } = require('./routes/auth');
const {
  loadConfig,
  getTurnStatus,
  getPublicEntryConfig,
  getMediaModeCapabilities,
} = require('./lib/config');
const { readBearerToken, verifyAccessToken } = require('./lib/auth');
const {
  setupSignaling,
  connections,
  getConnectionStatus,
  getHostCapabilities,
} = require('./websocket/signaling');
const {
  loadRecentDiagnostics,
  dedupeDiagnosticsByAttempt,
  buildConnectionSummary,
  ingestDiagnosticPayload,
} = require('./lib/diagnostic');
const { setupTerminal } = require('./websocket/terminal');
const { ensureNodePtySpawnHelperExecutable } = require('./lib/terminal/node-pty-setup');
const { createRotatingFileSink, createStructuredLogger } = require('./lib/observability/logger');
const { createRecentEventStore } = require('./lib/observability/store');
const { createTerminalAudit } = require('./lib/terminal/audit');
const { TerminalMetrics } = require('./lib/terminal/metrics');
const rateLimit = require('express-rate-limit');
const { createTurnSelfTestRunner } = require('./lib/turn-selftest');

const trustLoopbackProxy = proxyaddr.compile('loopback');

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
  const recentEventStore = options.recentEventStore || createRecentEventStore();
  const structuredFileSink = createRotatingFileSink({
    filePath: config.logDir ? path.join(config.logDir, 'signal-server.jsonl') : '',
    maxBytes: config.logMaxBytes,
    backupCount: config.logBackupCount,
  });
  const structuredLogger = options.structuredLogger || createStructuredLogger({
    write(line) {
      structuredFileSink.write(line + '\n');
      try {
        logger.info?.(JSON.parse(line));
      } catch (_error) {
        logger.info?.(line);
      }
    },
  });
  const terminalAudit = options.terminalAudit || createTerminalAudit({
    logger,
    structuredLogger,
    recentEventStore,
    auditLogPath: config.terminalAuditLog,
    maxBytes: config.logMaxBytes,
    backupCount: config.logBackupCount,
  });
  const terminalOptions = options.terminal || {};
  if (
    options.terminalMetrics
    && terminalOptions.metrics
    && options.terminalMetrics !== terminalOptions.metrics
  ) {
    throw new Error('[terminal] Explicit metrics instances must match');
  }
  const explicitTerminalMetrics = options.terminalMetrics || terminalOptions.metrics || null;
  const managerMetrics = terminalOptions.sessionManager?.metrics || null;
  if (explicitTerminalMetrics && managerMetrics && explicitTerminalMetrics !== managerMetrics) {
    throw new Error('[terminal] Explicit metrics instance must match sessionManager.metrics');
  }
  const terminalMetrics = explicitTerminalMetrics || managerMetrics || new TerminalMetrics();
  ensureNodePtySpawnHelperExecutable(logger);

  const app = express();
  const server = http.createServer(app);

  app.set('trust proxy', trustLoopbackProxy);
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
  app.use('/api/auth', createAuthRouter({
    config,
    logger,
    terminalAudit,
    terminalMetrics,
  }));

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

  setupSignaling(io, { config, logger, recentEventStore, structuredLogger });
  const terminal = setupTerminal(io, {
    config,
    logger,
    audit: terminalAudit,
    ...terminalOptions,
    metrics: terminalMetrics,
  });

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
    const capabilities = getMediaModeCapabilities(config);
    const publicEntry = getPublicEntryConfig(config);
    const hostCaps = getHostCapabilities();

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
      turnSource: turnState.turnSource || config.turnSource || 'none',
      turnFingerprint: turnState.turnConfigured
        ? (turnState.turnFingerprint || config.turnFingerprint || '')
        : '',
      turnUrls: turnState.turnConfigured ? config.turnUrls : [],
      hostTurnReady: Boolean(hostCaps.turnReady),
      hostTurnFingerprint: hostCaps.turnFingerprint || '',
      hostSupportsSessionTurn: Boolean(hostCaps.supportsSessionTurn),
      iceServers,
      ...capabilities,
      publicEntry,
    });
  });

  const turnSelfTestRunner = options.turnSelfTestRunner || createTurnSelfTestRunner();
  const turnSelfTestLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 6,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'turn-selftest-rate-limited' },
  });

  app.post('/api/turn-selftest', requireAccessToken, turnSelfTestLimiter, async (req, res) => {
    try {
      const timeoutMs = Math.min(15000, Math.max(1000, Number(req.body?.timeoutMs) || 10000));
      const result = await turnSelfTestRunner.runFromConfig(config, { timeoutMs });
      const hostCaps = getHostCapabilities();
      return res.status(result.ok ? 200 : 422).json({
        ...result,
        hostTurnReady: Boolean(hostCaps.turnReady),
        hostTurnFingerprint: hostCaps.turnFingerprint || '',
        fingerprintMatch: Boolean(
          result.turnFingerprint
          && hostCaps.turnFingerprint
          && result.turnFingerprint === hostCaps.turnFingerprint,
        ),
      });
    } catch (error) {
      logger.error?.('[turn-selftest] failed', error);
      return res.status(500).json({
        ok: false,
        code: 'turn-selftest-error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/diagnostics', requireAccessToken, (req, res) => {
    const result = ingestDiagnosticPayload({
      role: req.user.role,
      viewerId: `http-${req.user.sub}`,
      userAgent: req.headers['user-agent'] || 'unknown',
      data: req.body,
      config,
      logger,
    });

    if (!result.accepted) {
      return res.status(result.error === 'viewer-only' ? 403 : 400).json({
        accepted: false,
        error: result.error,
      });
    }
    recentEventStore.append(result.summaryEvent);
    structuredLogger.info(result.summaryEvent);

    if (connections.host) {
      connections.host.emit('diagnostic', result.report);
    }

    return res.status(202).json({
      accepted: true,
      connectionAttemptId: result.connectionAttemptId,
    });
  });

  app.get('/api/admin/connection-summary', requireAccessToken, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const items = loadRecentDiagnostics(200, { logger });
    return res.json({
      ...buildConnectionSummary(items),
      hostOnline: Boolean(connections.host),
      viewerCount: connections.viewers.size,
    });
  });

  app.get('/api/admin/connection-attempts', requireAccessToken, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }

    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(100, requestedLimit))
      : 50;
    const items = loadRecentDiagnostics(Math.max(limit * 4, 50), { logger });
    return res.json({
      items: dedupeDiagnosticsByAttempt(items).slice(0, limit),
    });
  });

  app.get('/api/admin/observability/summary', requireAccessToken, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    return res.json(recentEventStore.summary());
  });

  app.get('/api/admin/observability/recent', requireAccessToken, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(200, requestedLimit))
      : 50;
    const domain = String(req.query.domain || '').trim();
    return res.json({
      items: recentEventStore.recent({ domain, limit }),
    });
  });

  app.get('/api/terminal/bootstrap', requireAccessToken, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    return res.json({
      enabled: config.enableTerminal,
      softWarnSessionCount: config.terminalSoftWarnSessionCount,
      allowPolling: Boolean(config.terminalAllowPolling ?? config.allowPolling ?? false),
      pool: terminal.sessionManager.getPoolSnapshot(),
    });
  });

  app.get('/api/admin/terminal/metrics', requireAccessToken, (req, res) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required' });
    }
    return res.json({
      metrics: terminalMetrics.snapshot(),
      pool: terminal.sessionManager.getPoolSnapshot(),
    });
  });

  return {
    app,
    server,
    io,
    config,
    terminal,
    terminalMetrics,
    terminalAudit,
    recentEventStore,
    structuredLogger,
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
