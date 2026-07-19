const path = require('node:path');

const COPIED_ENVIRONMENT_KEYS = new Set([
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'COLORTERM',
  'LANG',
]);
const SYSTEM_PATH_ENTRIES = [
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

function getTerminalShellArgs(shell) {
  if (shell === '/bin/zsh') return ['-f', '-i'];
  if (shell === '/bin/bash') return ['--noprofile', '--norc', '-i'];
  throw new Error(`[terminal] unsupported shell: ${shell}`);
}

function normalizeExplicitPathEntries(pathEntries) {
  if (pathEntries === undefined) return [];
  if (!Array.isArray(pathEntries)) {
    throw new Error('[terminal] pathEntries must be an array of absolute non-empty directories');
  }

  return pathEntries.map((entry) => {
    const normalized = String(entry || '').trim();
    if (!normalized || !path.isAbsolute(normalized)) {
      throw new Error('[terminal] pathEntries must contain absolute non-empty directories');
    }
    return path.normalize(normalized);
  });
}

function buildTerminalEnvironment(baseEnv = process.env, options = {}) {
  const source = baseEnv || {};
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if ((COPIED_ENVIRONMENT_KEYS.has(key) || key.startsWith('LC_')) && value !== undefined) {
      env[key] = String(value);
    }
  }

  const home = String(source.HOME || '').trim();
  const originalPathEntries = String(source.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => path.isAbsolute(entry));
  const userPathEntries = path.isAbsolute(home) ? [
    path.join(home, '.homebrew', 'bin'),
    path.join(home, '.homebrew', 'sbin'),
    path.join(home, '.homebrew', 'opt', 'python@3.11', 'libexec', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
  ] : [];
  const systemPathEntries = SYSTEM_PATH_ENTRIES.filter((entry) => originalPathEntries.includes(entry));
  const explicitPathEntries = normalizeExplicitPathEntries(options.pathEntries);
  const pathEntries = [];
  for (const entry of [
    path.dirname(process.execPath),
    ...userPathEntries,
    ...systemPathEntries,
    ...explicitPathEntries,
  ]) {
    if (!pathEntries.includes(entry)) pathEntries.push(entry);
  }

  if (options.shell !== undefined) {
    getTerminalShellArgs(options.shell);
    env.SHELL = options.shell;
  }
  env.TERM = 'xterm-256color';
  env.PATH = pathEntries.join(path.delimiter);
  return env;
}

module.exports = {
  buildTerminalEnvironment,
  getTerminalShellArgs,
};
