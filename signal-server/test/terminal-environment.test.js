const assert = require('node:assert/strict');
const test = require('node:test');

const path = require('node:path');

const { buildTerminalEnvironment, getTerminalShellArgs } = require('../lib/terminal/environment');

test('buildTerminalEnvironment keeps only terminal-safe values and builds a deterministic PATH', () => {
  assert.equal(typeof buildTerminalEnvironment, 'function');

  const env = buildTerminalEnvironment({
    HOME: '/Users/tester',
    USER: 'tester',
    LOGNAME: 'tester',
    SHELL: '/bin/bash',
    TERM: 'vt100',
    COLORTERM: 'truecolor',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    PATH: '/untrusted/bin:/sbin:/usr/bin:/usr/local/bin:/bin:/usr/sbin:/usr/bin',
    JWT_SECRET: 'jwt-secret',
    WRD_TERMINAL_ADMIN_PASSWORD: 'terminal-password',
    HTTPS_PROXY: 'http://proxy.test',
    ANTHROPIC_AUTH_TOKEN: 'anthropic-token',
    OPENAI_API_KEY: 'openai-key',
    SSL_CERT_FILE: '/tmp/certificate.pem',
    REQUESTS_CA_BUNDLE: '/tmp/requests.pem',
    WRD_UNSAFE_FLAG: 'unsafe',
  }, {
    shell: '/bin/zsh',
    pathEntries: ['/opt/wrd-tools', '/usr/local/bin'],
  });

  assert.deepEqual(env, {
    HOME: '/Users/tester',
    USER: 'tester',
    LOGNAME: 'tester',
    SHELL: '/bin/zsh',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    PATH: [
      path.dirname(process.execPath),
      '/Users/tester/.homebrew/bin',
      '/Users/tester/.homebrew/sbin',
      '/Users/tester/.homebrew/opt/python@3.11/libexec/bin',
      '/Users/tester/.local/bin',
      '/Users/tester/.bun/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
      '/opt/wrd-tools',
    ].join(path.delimiter),
  });
});

test('buildTerminalEnvironment rejects invalid explicit PATH entries', () => {
  assert.equal(typeof buildTerminalEnvironment, 'function');

  for (const entry of ['', 'relative/bin']) {
    assert.throws(
      () => buildTerminalEnvironment({ HOME: '/Users/tester' }, { pathEntries: [entry] }),
      /absolute non-empty directories/,
    );
  }
});

test('buildTerminalEnvironment ignores relative inherited PATH sources', () => {
  const env = buildTerminalEnvironment({
    HOME: 'relative/home',
    PATH: 'relative/bin:/usr/bin',
  });

  assert.deepEqual(env.PATH.split(path.delimiter), [
    path.dirname(process.execPath),
    '/usr/bin',
  ]);
});

test('getTerminalShellArgs disables startup files for supported interactive shells', () => {
  assert.equal(typeof getTerminalShellArgs, 'function');
  assert.deepEqual(getTerminalShellArgs('/bin/zsh'), ['-f', '-i']);
  assert.deepEqual(getTerminalShellArgs('/bin/bash'), ['--noprofile', '--norc', '-i']);
  assert.throws(() => getTerminalShellArgs('/bin/fish'), /unsupported shell/);
});
