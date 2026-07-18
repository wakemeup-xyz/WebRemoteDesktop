const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ensureNodePtySpawnHelperExecutable } = require('./node-pty-setup');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('ensureNodePtySpawnHelperExecutable restores execute bit when it is missing', () => {
  const tempDir = makeTempDir('wrd-node-pty-');
  const helperPath = path.join(tempDir, 'prebuilds', 'darwin-x64', 'spawn-helper');
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  fs.writeFileSync(helperPath, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(helperPath, 0o644);

  const logger = {
    warnCalls: [],
    warn(message, meta) {
      this.warnCalls.push({ message, meta });
    },
  };

  const fakeResolve = (request) => {
    if (request === 'node-pty') {
      return path.join(tempDir, 'lib', 'index.js');
    }
    return require.resolve(request);
  };

  const fakeFs = {
    existsSync: fs.existsSync,
    statSync: fs.statSync,
    chmodSync(target, mode) {
      return fs.chmodSync(target, mode);
    },
  };

  const resolved = ensureNodePtySpawnHelperExecutable(logger, {
    resolveModule: fakeResolve,
    fs: fakeFs,
  });

  assert.equal(resolved, helperPath);
  assert.equal((fs.statSync(helperPath).mode & 0o111) > 0, true);
  assert.equal(logger.warnCalls.length, 1);
});
