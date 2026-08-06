require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const proxyaddr = require('proxy-addr');
const { Server } = require('socket.io');
const { createAuthRouter } = require('./routes/auth');
const {
  loadConfig,
  getTurnStatus,
} = require('./lib/config');
const {
  buildViewerBootstrapSnapshot,
  projectLegacyWebrtcConfig,
} = require('./lib/viewer-bootstrap');
const {
  loadWebAssetManifest,
  createWebAssetMiddleware,
} = require('./lib/web-assets');
const { buildWebClient } = require('./scripts/build-web-client');
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
  app.use(compression({
    // Compress HTML/JS/CSS; skip already-tiny or precompressed payloads.
    threshold: 1024,
  }));
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
  const webClientDistPath = options.webClientDistPath
    || path.join(webClientPath, 'dist');
  const allowSourceFallback = options.allowSourceFallback === true
    || String((options.config && options.config.nodeEnv) || process.env.NODE_ENV || '') === 'test';
  let webAssetManifest = options.webAssetManifest || null;
  if (!webAssetManifest) {
    try {
      webAssetManifest = loadWebAssetManifest({ distDir: webClientDistPath });
    } catch (error) {
      if (!allowSourceFallback) {
        throw new Error(
          `[web-assets] production requires a valid dist manifest at ${webClientDistPath}: ${error.message}`,
        );
      }
      webAssetManifest = null;
    }
  }
  if (webAssetManifest) {
    app.use(createWebAssetMiddleware({
      express,
      distDir: webClientDistPath,
      manifest: webAssetManifest,
    }));
    logger.log?.('Serving generated web assets from:', webClientDistPath);
  } else if (allowSourceFallback) {
    app.use(express.static(webClientPath, {
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      },
    }));
    logger.log?.('Serving static files from source fallback:', webClientPath);
  } else {
    throw new Error('[web-assets] missing web asset manifest; refusing source/CDN fallback');
  }

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

  function buildSnapshotForRequest(req) {
    const requestedTurnServerId = String(
      req.query.turnServerId
      || req.get('x-wrd-turn-server-id')
      || '',
    ).trim();
    const connectionStatus = getConnectionStatus();
    return buildViewerBootstrapSnapshot({
      config,
      hostCapabilities: getHostCapabilities(),
      hostOnline: Boolean(connectionStatus.hostOnline),
      turnServerId: requestedTurnServerId,
    });
  }

  app.get('/api/webrtc-config', requireAccessToken, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(projectLegacyWebrtcConfig(buildSnapshotForRequest(req)));
  });

  app.get('/api/viewer-bootstrap', requireAccessToken, (req, res) => {
    const startedAt = performance.now();
    const snapshot = buildSnapshotForRequest(req);
    res.setHeader('Cache-Control', 'no-store');
    structuredLogger.info({
      domain: 'viewer-bootstrap',
      event: 'viewer_bootstrap_served',
      meta: {
        serverProcessMs: Math.round((performance.now() - startedAt) * 100) / 100,
        hostOnline: snapshot.host.online,
        turnServerId: snapshot.webrtc.selectedTurnServerId,
      },
    });
    res.json(snapshot);
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
      const turnServerId = String(req.body?.turnServerId || '').trim();
      const result = await turnSelfTestRunner.runFromConfig(config, { timeoutMs, turnServerId });
      const hostCaps = getHostCapabilities();
      const hostFp = hostCaps.turnFingerprint || '';
      const hostTurnServerId = hostCaps.turnServerId || hostCaps.defaultTurnServerId || '';
      // Prefer fingerprint equality: Host may label the same node as `env`
      // when LaunchAgent exported TURN_* from the preferred json entry.
      const fingerprintMatch = Boolean(
        result.turnFingerprint
        && hostFp
        && result.turnFingerprint === hostFp,
      );
      return res.status(result.ok ? 200 : 422).json({
        ...result,
        turnServerId: result.turnServerId || turnServerId || '',
        hostTurnReady: Boolean(hostCaps.turnReady),
        hostTurnFingerprint: hostFp,
        hostTurnServerId,
        fingerprintMatch,
        turnServerIdMatch: Boolean(
          !turnServerId
          || !hostTurnServerId
          || turnServerId === hostTurnServerId
          || fingerprintMatch,
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

async function startServerFromSource(options = {}) {
  const projectRoot = path.join(__dirname, '..');
  const build = options.buildWebClient || buildWebClient;
  const start = options.startServer || startServer;
  await build({
    sourceDir: path.join(projectRoot, 'web-client'),
    outDir: path.join(projectRoot, 'web-client', 'dist'),
  });
  return start(options.serverOptions || {});
}

if (require.main === module) {
  startServerFromSource().catch((error) => {
    console.error('[web-assets] build failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createServerApp,
  startServer,
  startServerFromSource,
  requireAccessToken,
};
