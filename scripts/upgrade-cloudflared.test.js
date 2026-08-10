'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const upgradePath = path.join(__dirname, 'upgrade-cloudflared.sh');
const libPath = path.join(__dirname, 'lib-fixed-domain.sh');

test('upgrade script gates on 2026.7.3 and calls formal restart once', () => {
  const src = fs.readFileSync(upgradePath, 'utf8');
  assert.match(src, /2026\.7\.3/);
  assert.match(src, /restart-fixed-domain-tunnel\.sh/);
  assert.doesNotMatch(src, /start-fixed-domain\.sh/);
  assert.doesNotMatch(src, /pkill\s+-f\s+'?node server\.js/);
  assert.doesNotMatch(src, /restart-host\.sh/);
});

test('lib version compare treats 2026.7.3 as meeting floor', () => {
  const result = spawnSync('bash', ['-c', `
    source "${libPath}"
    wrd_fixed_version_ge 2026.7.3 2026.7.3 && \
    wrd_fixed_version_ge 2026.8.0 2026.7.3 && \
    ! wrd_fixed_version_ge 2026.3.0 2026.7.3
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
