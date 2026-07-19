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
const ASCII_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function getTerminalShellArgs(shell) {
  if (shell === '/bin/zsh') return ['-f', '-i'];
  if (shell === '/bin/bash') return ['--noprofile', '--norc', '-i'];
  throw new Error(`[terminal] unsupported shell: ${shell}`);
}

function validateSafePathValue(fieldName, rawValue, allowEmpty = false) {
  const value = String(rawValue ?? '');
  const isUnsafe = (
    (!value && !allowEmpty) ||
    (value && !path.isAbsolute(value)) ||
    value.includes(path.delimiter) ||
    ASCII_CONTROL_CHARACTER.test(value)
  );
  if (isUnsafe) {
    const message = fieldName === 'HOME'
      ? '[terminal] HOME must be an absolute path without delimiters or control characters'
      : '[terminal] pathEntries must contain absolute paths without delimiters or control characters';
    throw new Error(message);
  }
  return value;
}

function normalizeExplicitPathEntries(pathEntries) {
  if (pathEntries === undefined) return [];
  if (!Array.isArray(pathEntries)) {
    throw new Error('[terminal] pathEntries must be an array of absolute non-empty directories');
  }

  return pathEntries.map((entry) => {
    const validated = validateSafePathValue('pathEntries', entry);
    return path.normalize(validated);
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

  const home = validateSafePathValue('HOME', source.HOME, true);
  const originalPathEntries = String(source.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => path.isAbsolute(entry));
  const userPathEntries = home ? [
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
