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
  assert.match(restart, /refusing restart:[^\n]*token/i);
});

test('lib exposes stop/start/wait helpers without token argv', () => {
  const lib = fs.readFileSync(libPath, 'utf8');
  assert.match(lib, /wrd_fixed_stop_connector\s*\(/);
  assert.match(lib, /wrd_fixed_start_connector\s*\(/);
  assert.match(lib, /wrd_fixed_wait_formal_health\s*\(/);
  assert.doesNotMatch(lib, /TUNNEL_TOKEN=| --token/);
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
    fs.writeFileSync(config, 'tunnel: fixture\ncredentials-file: fixture.json\n');
    const result = spawnSync('bash', [restartPath, '--preflight'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WRD_TEST_MARKER: marker,
        CLOUDFLARED: path.join(bin, 'cloudflared'), CLOUDFLARED_CONFIG: config },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
