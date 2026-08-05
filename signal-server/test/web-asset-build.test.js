'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildWebClient } = require('../scripts/build-web-client');

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

test('build emits deterministic first-party critical assets and lazy Terminal assets', async () => {
  const outA = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-build-a-'));
  const outB = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-build-b-'));
  const sourceDir = path.join(__dirname, '..', '..', 'web-client');
  const a = await buildWebClient({ sourceDir, outDir: outA });
  const b = await buildWebClient({ sourceDir, outDir: outB });

  assert.deepEqual(a, b);
  const html = fs.readFileSync(path.join(outA, 'viewer.html'), 'utf8');
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|cdn\.socket\.io/);
  assert.equal((html.match(/<script[^>]+src=/g) || []).length, 1);
  assert.equal((html.match(/<link[^>]+stylesheet/g) || []).length, 1);
  assert.match(html, new RegExp(a.assets.desktopJs.replaceAll('.', '\\.')));
  assert.doesNotMatch(
    html,
    new RegExp(`<script[^>]+src="[^"]*${a.assets.terminalJs.replaceAll('.', '\\.')}"`),
  );
  assert.doesNotMatch(
    html,
    new RegExp(`<link[^>]+href="[^"]*${a.assets.terminalCss.replaceAll('.', '\\.')}"`),
  );
  for (const relative of Object.values(a.assets)) {
    assert.equal(fs.existsSync(path.join(outA, relative)), true, relative);
  }
});

test('build does not publish a manifest when an input is missing', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-build-fail-'));
  await assert.rejects(
    buildWebClient({ sourceDir: '/missing/web-client', outDir }),
    /missing|ENOENT/i,
  );
  assert.equal(fs.existsSync(path.join(outDir, 'asset-manifest.json')), false);
});
