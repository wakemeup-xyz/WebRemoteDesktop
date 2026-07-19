const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { loadConfig } = require('../lib/config');
const { signAccessToken, verifyAccessToken, readBearerToken } = require('../lib/auth');
const { createTerminalAudit } = require('../lib/terminal/audit');
const { TerminalMetrics } = require('../lib/terminal/metrics');

const AUTH_WINDOW_MS = 15 * 60 * 1000;

function createLimiter(max, options = {}) {
  return rateLimit({
    windowMs: AUTH_WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler(_req, res) {
      return res.status(429).json({ error: 'Too many requests' });
    },
    ...options,
  });
}

function createAuthLimiters() {
  return {
    viewer: createLimiter(20),
    host: createLimiter(60),
    admin: createLimiter(5),
    adminGlobal: createLimiter(100, {
      keyGenerator: () => 'terminal-admin-global',
      validate: false,
    }),
    verify: createLimiter(120),
  };
}

async function verifyPassword(input, expected) {
  const hash = bcrypt.hashSync(expected, 10);
  return bcrypt.compare(String(input || ''), hash);
}

function createAuthRouter(options = {}) {
  const router = express.Router();
  const terminalAudit = options.terminalAudit || createTerminalAudit(options.logger || console);
  const terminalMetrics = options.terminalMetrics || new TerminalMetrics();
  const limiters = options.authLimiters || createAuthLimiters();

  function getConfig() {
    return {
      ...loadConfig(),
      ...(options.config || {}),
    };
  }

  async function loginViewer(req, res) {
    const { viewerAccessPassword } = getConfig();
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ error: 'Password required' });
    }

    const valid = await verifyPassword(password, viewerAccessPassword);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    return res.json({
      token: signAccessToken('viewer', 'viewer-password-login'),
      role: 'viewer',
      expiresIn: '24h',
    });
  }

  router.post('/login', limiters.viewer, loginViewer);
  router.post('/login/viewer', limiters.viewer, loginViewer);

  router.post('/login/host', limiters.host, (req, res) => {
    const { hostSharedSecret } = getConfig();
    const secret = String(req.body?.secret || '');

    if (!secret) {
      return res.status(400).json({ error: 'Host secret required' });
    }
    if (secret !== hostSharedSecret) {
      return res.status(401).json({ error: 'Invalid host secret' });
    }

    return res.json({
      token: signAccessToken('host', 'host-daemon'),
      role: 'host',
      expiresIn: '15m',
    });
  });

  router.post('/login/admin', limiters.adminGlobal, limiters.admin, (req, res) => {
    const { enableTerminal, terminalAdminPassword } = getConfig();
    const password = String(req.body?.password || '');
    const meta = {
      authRoute: '/api/auth/login/admin',
      remoteAddress: req.ip || req.socket?.remoteAddress || null,
    };

    if (!enableTerminal) {
      terminalMetrics.recordCounter('auth_rejected');
      terminalAudit.warn('terminal_admin_auth_disabled', meta);
      return res.status(403).json({ error: 'Terminal disabled' });
    }
    if (!terminalAdminPassword) {
      terminalMetrics.recordCounter('auth_rejected');
      terminalAudit.error('terminal_admin_auth_misconfigured', meta);
      return res.status(500).json({ error: 'Terminal admin password not configured' });
    }
    if (!password) {
      terminalMetrics.recordCounter('auth_rejected');
      terminalAudit.warn('terminal_admin_auth_failed', {
        ...meta,
        reason: 'password_required',
      });
      return res.status(400).json({ error: 'Password required' });
    }
    if (password !== terminalAdminPassword) {
      terminalMetrics.recordCounter('auth_rejected');
      terminalAudit.warn('terminal_admin_auth_failed', {
        ...meta,
        reason: 'invalid_password',
      });
      return res.status(401).json({ error: 'Invalid password' });
    }

    terminalMetrics.recordCounter('auth_success');
    terminalAudit.info('terminal_admin_authorized', {
      ...meta,
      subject: 'terminal-admin-login',
    });
    return res.json({
      token: signAccessToken('admin', 'terminal-admin-login'),
      role: 'admin',
      expiresIn: '2h',
    });
  });

  router.get('/verify', limiters.verify, (req, res) => {
    try {
      const token = readBearerToken(req.headers.authorization);
      if (!token) {
        return res.status(401).json({ valid: false, error: 'No token provided' });
      }
      const decoded = verifyAccessToken(token);
      return res.json({ valid: true, role: decoded.role });
    } catch (_err) {
      return res.status(401).json({ valid: false, error: 'Invalid token' });
    }
  });

  return router;
}

const defaultRouter = createAuthRouter();

module.exports = defaultRouter;
module.exports.createAuthLimiters = createAuthLimiters;
module.exports.createAuthRouter = createAuthRouter;
