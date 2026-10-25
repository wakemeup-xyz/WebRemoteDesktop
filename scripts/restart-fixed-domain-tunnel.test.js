'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const restartPath = path.join(__dirname, 'restart-fixed-domain-tunnel.sh');
const libPath = path.join(__dirname, 'lib-fixed-domain.sh');

test('restart formal tunnel sources lib and never targets local app or quick tunnel', () => {
  const restart = fs.readFileSync(restartPath, 'utf8');
  const lib = fs.readFileSync(libPath, 'utf8');
  const all = restart + '\n' + lib;
  assert.match(restart, /lib-fixed-domain\.sh/);
  assert.match(all, /credentials-file/);
  assert.match(all, /unset\s+TUNNEL_TOKEN|wrd_fixed_unset_tunnel_token/);
  assert.match(all, /com\.webremotedesktop\.fixed-domain/);
  assert.match(all, /wrd-tunnel/);
  assert.doesNotMatch(all, /pkill\s+-f\s+'?node server\.js/);
  assert.doesNotMatch(all, /pkill\s+-f\s+'?python.*host\.py/);
  assert.doesNotMatch(all, /run-safe-quicktunnel|wrd-safe-quicktunnel|restart-safe-tunnel/);
  assert.match(all, /wrd_fixed_count_token_connectors/);
  assert.match(restart, /wrd_fixed_restart_connector/);
});

test('lib exposes persistent admission/restart/wait helpers without token argv', () => {
  const lib = fs.readFileSync(libPath, 'utf8');
  assert.match(lib, /wrd_fixed_validate_connector\s*\(/);
  assert.match(lib, /wrd_fixed_preflight_connector\s*\(/);
  assert.match(lib, /wrd_fixed_restart_connector\s*\(/);
  assert.match(lib, /wrd_fixed_wait_formal_health\s*\(/);
  assert.doesNotMatch(lib, /TUNNEL_TOKEN=| --token/);
  assert.doesNotMatch(lib, /\bpkill\b|launchctl submit|zsh -lc/);
  assert.match(lib, /wrd_fixed_launchagent\.py/);
});

test('read-only preflight never starts or stops a connector', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-preflight-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const marker = path.join(dir, 'unsafe');
    fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (const name of ['launchctl', 'cloudflared', 'pkill']) {
      fs.writeFileSync(path.join(bin, name), '#!/bin/sh\ntouch "$WRD_TEST_MARKER"\nexit 99\n', { mode: 0o755 });
    }
    const config = path.join(dir, 'config.yml');
    const credentials = path.join(dir, 'fixture.json');
    fs.writeFileSync(credentials, JSON.stringify({ AccountTag: 'fixture', TunnelID: 'fixture', TunnelSecret: 'test' }));
    fs.writeFileSync(config, `tunnel: fixture\ncredentials-file: ${credentials}\n`);
    fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/sh\n[ "$1" = print ] && exit 113\ntouch "$WRD_TEST_MARKER"\nexit 99\n', { mode: 0o755 });
    const result = spawnSync('bash', [restartPath, '--preflight'], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, WRD_TEST_MARKER: marker,
        CLOUDFLARED: path.join(bin, 'cloudflared'), CLOUDFLARED_CONFIG: config,
        WRD_FIXED_DOMAIN_LOG: path.join(dir, 'formal.log') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('formal health failure returns failure after one registration without another bounce', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-formal-health-'));
  try {
    const restart = path.join(dir, 'restart-fixed-domain-tunnel.sh');
    fs.copyFileSync(restartPath, restart);
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(path.join(dir, 'lib-fixed-domain.sh'), `
WRD_FIXED_TUNNEL_NAME=wrd-tunnel
WRD_FIXED_DOMAIN_LOG="$FIXTURE_CALLS.log"
WRD_FIXED_FORMAL_HEALTH_URL=https://fixture.invalid/health
wrd_fixed_count_token_connectors() { echo 0; }
wrd_fixed_count_formal_owners() { echo 0; }
wrd_fixed_require_credentials_file() { return 0; }
wrd_fixed_unset_tunnel_token() { unset TUNNEL_TOKEN; }
wrd_fixed_restart_connector() { echo registered >> "$FIXTURE_CALLS"; }
wrd_fixed_wait_formal_health() { echo health-failed >> "$FIXTURE_CALLS"; return 1; }
`);
    const result = spawnSync('bash', [restart], { encoding: 'utf8', timeout: 30000,
      env: { ...process.env, HOME: dir, FIXTURE_CALLS: calls, CLOUDFLARED_CONFIG: '/fixture/config' } });
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(fs.readFileSync(calls, 'utf8').trim().split('\n'), ['registered', 'health-failed']);
    assert.match(result.stderr, /formal health not deliverable after restart/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
