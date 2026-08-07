'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Browsers always revalidate HTML. Do not set a positive max-age/edge TTL for HTML:
// a short edge cache without N-1 asset retention can pair old HTML with missing
// new hashed assets after deploy. Hashed assets stay long-immutable.
const HTML_POLICY = 'no-cache, max-age=0, must-revalidate';
const HTML_EDGE_POLICY = null;
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

function isHtmlLikePath(pathname) {
  return pathname === '/' || pathname.endsWith('.html') || pathname === '/asset-manifest.json';
}

function cachePolicyForAsset(pathname, manifest) {
  if (manifest.immutablePaths.has(pathname)) return IMMUTABLE_POLICY;
  if (isHtmlLikePath(pathname)) return HTML_POLICY;
  return 'no-cache';
}

function edgeCachePolicyForAsset(pathname, manifest) {
  if (manifest.immutablePaths.has(pathname)) return IMMUTABLE_POLICY;
  // HTML deliberately has no edge TTL (see HTML_EDGE_POLICY).
  if (isHtmlLikePath(pathname)) return HTML_EDGE_POLICY;
  return null;
}

function applyAssetCacheHeaders(res, pathname, manifest) {
  res.setHeader('Cache-Control', cachePolicyForAsset(pathname, manifest));
  const edge = edgeCachePolicyForAsset(pathname, manifest);
  if (edge) {
    // Cloudflare respects CDN-Cache-Control / Cloudflare-CDN-Cache-Control over Cache-Control.
    res.setHeader('CDN-Cache-Control', edge);
    res.setHeader('Cloudflare-CDN-Cache-Control', edge);
  } else if (isHtmlLikePath(pathname)) {
    // Explicitly disable shared caches for HTML when no edge policy is set.
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  }
}

function createWebAssetMiddleware({ express, distDir, manifest }) {
  return express.static(distDir, {
    index: 'index.html',
    setHeaders(res, filePath) {
      const relative = `/${path.relative(distDir, filePath).split(path.sep).join('/')}`;
      applyAssetCacheHeaders(res, relative, manifest);
    },
  });
}

module.exports = {
  HTML_EDGE_POLICY,
  HTML_POLICY,
  IMMUTABLE_POLICY,
  applyAssetCacheHeaders,
  cachePolicyForAsset,
  createWebAssetMiddleware,
  edgeCachePolicyForAsset,
  loadWebAssetManifest,
};
