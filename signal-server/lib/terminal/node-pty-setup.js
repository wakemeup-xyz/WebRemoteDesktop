const fs = require('node:fs');
const path = require('node:path');

function resolveNodePtyPaths(resolveModule = require.resolve) {
  const ptyModulePath = resolveModule('node-pty');
  const moduleDir = path.dirname(ptyModulePath);
  const rootDir = path.resolve(moduleDir, '..');
  const prebuildDir = path.join(rootDir, 'prebuilds', `${process.platform}-${process.arch}`);
  return {
    rootDir,
    prebuildDir,
    helperPath: path.join(prebuildDir, 'spawn-helper'),
  };
}

function ensureNodePtySpawnHelperExecutable(logger = console, options = {}) {
  const resolveModule = options.resolveModule || require.resolve;
  const fsImpl = options.fs || fs;
  const { helperPath } = resolveNodePtyPaths(resolveModule);

  if (!fsImpl.existsSync(helperPath)) {
    throw new Error(`node-pty spawn-helper not found: ${helperPath}`);
  }

  const mode = fsImpl.statSync(helperPath).mode & 0o777;
  if ((mode & 0o111) === 0) {
    fsImpl.chmodSync(helperPath, mode | 0o755);
    if (typeof logger.warn === 'function') {
      logger.warn('[terminal] fixed node-pty spawn-helper execute bit', { helperPath });
    }
  }

  return helperPath;
}

module.exports = {
  ensureNodePtySpawnHelperExecutable,
  resolveNodePtyPaths,
};
