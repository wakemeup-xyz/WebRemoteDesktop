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
  assert.ok(graph.desktopScripts.includes('js/chrome-layout.js'));
  assert.ok(
    graph.desktopScripts.indexOf('js/chrome-layout.js') < graph.desktopScripts.indexOf('js/ui.js'),
    'chrome-layout.js must load before ui.js',
  );
  assert.ok(!graph.desktopScripts.includes('js/terminal.js'));
  assert.deepEqual(graph.terminalScripts, [
    'js/terminal-echo-controller.js',
    'js/terminal-composer.js',
    'js/terminal-input-gate.js',
    'js/terminal-turn-transport.js',
    'js/terminal-session-fsm.js',
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
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|cdn\.socket\.io|fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.equal((html.match(/<script[^>]+src=/g) || []).length, 1);
  assert.equal((html.match(/<link[^>]+rel=["']stylesheet["']/g) || []).length, 1);
  assert.match(html, /rel="preload"[^>]+as="script"/);
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
  assert.ok(a.assets.terminalJs);
  assert.ok(a.assets.terminalCss);
  assert.ok(a.assets.desktopDeferredJs, 'deferred operator tools must be emitted');
  const desktopBundle = fs.readFileSync(path.join(outA, a.assets.desktopJs), 'utf8');
  const deferredBundle = fs.readFileSync(path.join(outA, a.assets.desktopDeferredJs), 'utf8');
  assert.match(desktopBundle, /createTerminalLoader/);
  assert.doesNotMatch(desktopBundle, /const TerminalPanel\s*=/);
  // Deferred tools implementations must not bloat the critical desktop path.
  // (webrtc may still reference optional globals via typeof guards.)
  // diagnostic-core collector stays critical; full panel stays deferred.
  assert.match(desktopBundle, /core collector ready|diagnostic-core/);
  assert.doesNotMatch(desktopBundle, /LatencyMonitor=\{|\[LatencyMonitor\] initialized/);
  assert.doesNotMatch(desktopBundle, /Log collector initialized/);
  assert.match(deferredBundle, /StunPortSearchController|TurnSelfTest|LatencyMonitor=\{|Log collector initialized/);
  assert.doesNotMatch(
    html,
    /<(?:script[^>]+src|link[^>]+href)="[^"]*(?:xterm|addon-fit|terminal\.[a-f0-9]+\.(?:js|css)|desktop-deferred)/i,
  );
  const viewerCss = fs.readFileSync(path.join(outA, a.assets.viewerCss), 'utf8');
  assert.match(viewerCss, /--chrome-top/);
  assert.match(viewerCss, /--text-secondary/);
});

test('build keeps previous dist when a subsequent build fails', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-build-keep-'));
  const sourceDir = path.join(__dirname, '..', '..', 'web-client');
  const first = await buildWebClient({ sourceDir, outDir });
  assert.equal(fs.existsSync(path.join(outDir, 'asset-manifest.json')), true);
  const firstHtml = fs.readFileSync(path.join(outDir, 'viewer.html'), 'utf8');
  await assert.rejects(
    buildWebClient({ sourceDir: '/missing/web-client-after-success', outDir }),
    /missing|ENOENT/i,
  );
  assert.equal(fs.existsSync(path.join(outDir, 'asset-manifest.json')), true);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(outDir, 'asset-manifest.json'), 'utf8')),
    first,
  );
  assert.equal(fs.readFileSync(path.join(outDir, 'viewer.html'), 'utf8'), firstHtml);
});

test('build does not publish a manifest when an input is missing on empty outDir', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-build-fail-'));
  fs.rmSync(outDir, { recursive: true, force: true });
  await assert.rejects(
    buildWebClient({ sourceDir: '/missing/web-client', outDir }),
    /missing|ENOENT/i,
  );
  assert.equal(fs.existsSync(path.join(outDir, 'asset-manifest.json')), false);
});
