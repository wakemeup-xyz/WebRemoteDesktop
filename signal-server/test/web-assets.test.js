'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  loadWebAssetManifest,
  cachePolicyForAsset,
  edgeCachePolicyForAsset,
  createWebAssetMiddleware,
  HTML_EDGE_POLICY,
} = require('../lib/web-assets');

function fixture() {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-assets-'));
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'assets/app.0123456789abcdef.js'), 'ok');
  fs.writeFileSync(path.join(distDir, 'viewer.html'), '<!doctype html>');
  fs.writeFileSync(path.join(distDir, 'asset-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    assets: { desktopJs: 'assets/app.0123456789abcdef.js' },
  }));
  return distDir;
}

test('manifest-listed hashed assets are immutable while HTML revalidates', () => {
  const distDir = fixture();
  const manifest = loadWebAssetManifest({ distDir });
  assert.equal(
    cachePolicyForAsset('/assets/app.0123456789abcdef.js', manifest),
    'public, max-age=31536000, immutable',
  );
  assert.equal(
    cachePolicyForAsset('/viewer.html', manifest),
    'no-cache, max-age=0, must-revalidate',
  );
  assert.equal(edgeCachePolicyForAsset('/viewer.html', manifest), HTML_EDGE_POLICY);
  assert.equal(cachePolicyForAsset('/assets/unknown.js', manifest), 'no-cache');
});

test('manifest rejects traversal and missing files', () => {
  const distDir = fixture();
  fs.writeFileSync(path.join(distDir, 'asset-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    assets: { desktopJs: '../secret.js' },
  }));
  assert.throws(() => loadWebAssetManifest({ distDir }), /unsafe asset path/);
});

test('generated HTML revalidates and hashed assets are immutable', async () => {
  const express = require('express');
  const fixtureDir = fixture();
  const manifest = loadWebAssetManifest({ distDir: fixtureDir });
  const app = express();
  app.use(createWebAssetMiddleware({ express, distDir: fixtureDir, manifest }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = await fetch(`${origin}/viewer.html`);
  const asset = await fetch(`${origin}/assets/app.0123456789abcdef.js`);
  assert.equal(html.headers.get('cache-control'), 'no-cache, max-age=0, must-revalidate');
  assert.equal(html.headers.get('cdn-cache-control'), HTML_EDGE_POLICY);
  assert.equal(html.headers.get('cloudflare-cdn-cache-control'), HTML_EDGE_POLICY);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(asset.headers.get('cdn-cache-control'), 'public, max-age=31536000, immutable');
  await new Promise((resolve) => server.close(resolve));
});

test('executable startup builds assets before creating the listening server', async () => {
  const { startServerFromSource } = require('../server');
  const calls = [];
  await startServerFromSource({
    buildWebClient: async () => { calls.push('build'); },
    startServer: () => { calls.push('listen'); return {}; },
  });
  assert.deepEqual(calls, ['build', 'listen']);
});

test('createServerApp fails fast without a valid dist unless source fallback is explicit', () => {
  const { createServerApp } = require('../server');
  const missingDist = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-missing-dist-'));
  assert.throws(
    () => createServerApp({
      webClientDistPath: missingDist,
      config: {
        port: 0,
        nodeEnv: 'production',
        jwtSecret: process.env.JWT_SECRET || '12345678',
        viewerAccessPassword: process.env.VIEWER_ACCESS_PASSWORD || 'x',
        hostSharedSecret: process.env.HOST_SHARED_SECRET || 'y',
        corsOrigins: [],
        stunUrls: [],
        turnUrls: [],
        turnUsername: '',
        turnCredential: '',
        enableDiagPersist: false,
        enableTerminal: false,
      },
      logger: { log() {}, info() {}, warn() {}, error() {} },
    }),
    /valid dist manifest|missing web asset manifest/i,
  );
});
