'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const production = [
  'web-client/js/webrtc.js',
  'web-client/viewer.html',
  'signal-server/scripts/web-asset-graph.js',
];
const forbidden = [
  'sessionCoordinator', 'DesktopSessionCoordinator', 'initializeSessionCoordinator',
  'ControlLeaseView', 'MediaPaintGate', 'ConnectionSession',
];

test('production uses DesktopSessionState as the only session owner', () => {
  for (const file of production) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const token of forbidden) assert.equal(source.includes(token), false, `${file} contains ${token}`);
  }
});

test('asset graph contains one state owner and no coordinator', () => {
  const source = fs.readFileSync(path.join(root, 'signal-server/scripts/web-asset-graph.js'), 'utf8');
  assert.equal((source.match(/js\/desktop-session-state\.js/g) || []).length, 1);
  assert.equal((source.match(/js\/desktop-session-coordinator\.js/g) || []).length, 0);
});
