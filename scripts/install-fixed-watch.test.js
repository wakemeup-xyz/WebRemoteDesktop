'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('fixed-watch plist points at watch script and tmp logs only', () => {
  const plist = fs.readFileSync(
    path.join(__dirname, '..', 'launchd', 'com.webremotedesktop.fixed-watch.plist'),
    'utf8',
  );
  assert.match(plist, /com\.webremotedesktop\.fixed-watch/);
  assert.match(plist, /scripts\/watch-fixed-domain\.sh/);
  assert.match(plist, /\/tmp\/wrd-fixed-watch\.(launch\.)?log|\/tmp\/wrd-fixed-watch-launch\.log/);
  assert.match(plist, /KeepAlive/);
  assert.doesNotMatch(plist, /run-safe-quicktunnel|start-fixed-domain/);
});

test('install-fixed-watch bootstraps label without touching formal connector scripts beyond watch', () => {
  const src = fs.readFileSync(path.join(__dirname, 'install-fixed-watch.sh'), 'utf8');
  assert.match(src, /com\.webremotedesktop\.fixed-watch/);
  assert.match(src, /bootstrap|kickstart/);
  assert.doesNotMatch(src, /restart-fixed-domain-tunnel|brew upgrade|run-safe-quicktunnel/);
});
