const express = require('express');
const bcrypt = require('bcryptjs');
const { loadConfig } = require('../lib/config');
const { signAccessToken, verifyAccessToken, readBearerToken } = require('../lib/auth');

const router = express.Router();

async function verifyPassword(input, expected) {
  const hash = bcrypt.hashSync(expected, 10);
  return bcrypt.compare(String(input || ''), hash);
}

async function loginViewer(req, res) {
  const { viewerAccessPassword } = loadConfig();
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

router.post('/login', loginViewer);
router.post('/login/viewer', loginViewer);

router.post('/login/host', (req, res) => {
  const { hostSharedSecret } = loadConfig();
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

router.get('/verify', (req, res) => {
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

module.exports = router;
