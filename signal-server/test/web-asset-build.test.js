'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('asset graph keeps desktop critical and Terminal optional sources separate', () => {
  const graph = require('../scripts/web-asset-graph');
  assert.ok(graph.desktopScripts.includes('js/webrtc.js'));
  assert.ok(!graph.desktopScripts.includes('js/terminal.js'));
  assert.deepEqual(graph.terminalScripts, [
    'js/terminal-echo-controller.js',
    'js/terminal-composer.js',
    'js/terminal.js',
  ]);
  assert.equal(new Set(graph.desktopScripts).size, graph.desktopScripts.length);
  assert.equal(new Set(graph.terminalScripts).size, graph.terminalScripts.length);
});
