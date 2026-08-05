'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const preflightPath = path.join(__dirname, 'fixed-tunnel-preflight.sh');
const startFixedPath = path.join(__dirname, 'start-fixed-domain.sh');

test('fixed tunnel preflight reports token/multiple owners without mutation or secret output', () => {
  const source = fs.readFileSync(preflightPath, 'utf8');
  assert.doesNotMatch(source, /\b(kill|pkill|launchctl\s+remove|start-fixed-domain|cloudflared\s+tunnel\s+run)\b/);
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-fixed-preflight-'));
  const fixturePath = path.join(fixtureDir, 'processes.txt');
  const configPath = path.join(fixtureDir, 'config.yml');
  fs.writeFileSync(configPath, 'tunnel: fixture\ncredentials-file: /tmp/fixture.json\n');
  fs.writeFileSync(fixturePath, [
    '101 cloudflared tunnel --config /tmp/config.yml run wrd-tunnel',
    '102 cloudflared tunnel --config /tmp/config.yml run wrd-tunnel',
    '103 cloudflared tunnel run --token SUPER-SECRET-TOKEN',
  ].join('\n'));
  const result = spawnSync('bash', [preflightPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WRD_PREFLIGHT_PROCESS_FIXTURE: fixturePath,
      WRD_PREFLIGHT_SKIP_NETWORK: '1',
      WRD_PREFLIGHT_SKIP_LOCAL: '1',
      CLOUDFLARED_CONFIG: configPath,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /token-argv|multiple-formal-owners/);
  assert.doesNotMatch(result.stdout + result.stderr, /SUPER-SECRET-TOKEN/);
});

test('fixed-domain managed command defaults to http2 and permits explicit quic override', () => {
  const source = fs.readFileSync(startFixedPath, 'utf8');
  assert.match(source, /WRD_FIXED_TUNNEL_PROTOCOL="\$\{WRD_FIXED_TUNNEL_PROTOCOL:-http2\}"/);
  assert.match(source, /--protocol "\$WRD_FIXED_TUNNEL_PROTOCOL"/);
  assert.match(source, /http2\|quic/);
});
