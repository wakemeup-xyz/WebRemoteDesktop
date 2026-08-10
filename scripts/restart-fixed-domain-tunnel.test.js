'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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
  assert.doesNotMatch(all, /--token/);
});

test('lib exposes stop/start/wait helpers without token argv', () => {
  const lib = fs.readFileSync(libPath, 'utf8');
  assert.match(lib, /wrd_fixed_stop_connector\s*\(/);
  assert.match(lib, /wrd_fixed_start_connector\s*\(/);
  assert.match(lib, /wrd_fixed_wait_formal_health\s*\(/);
  assert.doesNotMatch(lib, /TUNNEL_TOKEN=| --token/);
});
