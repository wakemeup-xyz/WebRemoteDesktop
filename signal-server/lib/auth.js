const jwt = require('jsonwebtoken');
const { loadConfig } = require('./config');

function signAccessToken(role, subject) {
  const config = loadConfig();
  const expiresIn = role === 'host' ? '15m' : role === 'admin' ? '2h' : '24h';
  return jwt.sign(
    {
      role,
      aud: 'web-remote-desktop',
      sub: subject,
    },
    config.jwtSecret,
    { expiresIn },
  );
}

function verifyAccessToken(token) {
  const config = loadConfig();
  return jwt.verify(token, config.jwtSecret, { audience: 'web-remote-desktop' });
}

function readBearerToken(headerValue) {
  if (!headerValue || !headerValue.startsWith('Bearer ')) {
    return null;
  }
  return headerValue.slice(7);
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  readBearerToken,
};
