'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HTML_POLICY = 'no-cache, max-age=0, must-revalidate';
const IMMUTABLE_POLICY = 'public, max-age=31536000, immutable';

function normalizeAssetPath(value) {
  const normalized = String(value || '').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || path.isAbsolute(normalized)) {
    throw new Error(`unsafe asset path: ${value}`);
  }
  return normalized;
}

function loadWebAssetManifest({ distDir }) {
  const manifestPath = path.join(distDir, 'asset-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.assets) throw new Error('invalid asset manifest');
  const immutablePaths = new Set();
  for (const value of Object.values(manifest.assets)) {
    const relative = normalizeAssetPath(value);
    const absolute = path.resolve(distDir, relative);
    if (!absolute.startsWith(`${path.resolve(distDir)}${path.sep}`) || !fs.statSync(absolute).isFile()) {
      throw new Error(`missing manifest asset: ${relative}`);
    }
    immutablePaths.add(`/${relative}`);
  }
  return Object.freeze({ ...manifest, immutablePaths });
}

function cachePolicyForAsset(pathname, manifest) {
  if (manifest.immutablePaths.has(pathname)) return IMMUTABLE_POLICY;
  if (pathname === '/' || pathname.endsWith('.html') || pathname === '/asset-manifest.json') {
    return HTML_POLICY;
  }
  return 'no-cache';
}

function createWebAssetMiddleware({ express, distDir, manifest }) {
  return express.static(distDir, {
    index: 'index.html',
    setHeaders(res, filePath) {
      const relative = `/${path.relative(distDir, filePath).split(path.sep).join('/')}`;
      res.setHeader('Cache-Control', cachePolicyForAsset(relative, manifest));
    },
  });
}

module.exports = {
  loadWebAssetManifest,
  cachePolicyForAsset,
  createWebAssetMiddleware,
};
