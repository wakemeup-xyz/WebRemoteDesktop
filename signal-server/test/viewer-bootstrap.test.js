'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildViewerBootstrapSnapshot } = require('../lib/viewer-bootstrap');

test('snapshot combines Host truth and selected WebRTC config without probing externally', () => {
  const snapshot = buildViewerBootstrapSnapshot({
    config: {
      stunUrls: ['stun:example.test:3478'],
      turnUrls: [],
      turnUsername: '',
      turnCredential: '',
      turnSource: 'none',
      turnServers: [],
      publicEntryUrl: 'https://link.stockhub.wiki',
    },
    hostCapabilities: { turnReady: false, supportsSessionTurn: true },
    hostOnline: true,
    turnServerId: '',
    now: () => '2026-08-06T00:00:00.000Z',
  });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.generatedAt, '2026-08-06T00:00:00.000Z');
  assert.equal(snapshot.host.online, true);
  assert.equal(snapshot.webrtc.turnConfigured, false);
  assert.deepEqual(snapshot.webrtc.iceServers, [{ urls: ['stun:example.test:3478'] }]);
});
