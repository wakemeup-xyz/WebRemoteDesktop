'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Browsers always revalidate HTML. Do not set a positive max-age/edge TTL for HTML:
// a short edge cache without N-1 asset retention can pair old HTML with missing
// new hashed assets after deploy. Hashed assets stay long-immutable.
const HTML_POLICY = 'no-cache, max-age=0, must-revalidate';
const HTML_EDGE_POLICY = null;
const IMMUTABLE_POLICY = 'public, max-age=31536000, immutable';

function normalizeAssetPath(value) {
  if (typeof value !== 'string' || !/^assets\/[a-z0-9-]+\.[a-f0-9]{16}\.(js|css)$/.test(value)) {
    throw new Error('unsafe asset path');
  }
  return value;
}

function assetDigest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function buildIdentity(assets) {
  return assetDigest(JSON.stringify(Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
}

function requirePlainFile(filePath) {
  if (!fs.lstatSync(filePath).isFile()) throw new Error('manifest asset must be a regular file (no symlink)');
}

function readVerifiedAsset(distDir, value) {
  const relative = normalizeAssetPath(value);
  // Every path component is checked: stat alone follows links outside the dist.
  for (const dir of [distDir, path.join(distDir, 'assets')]) {
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('asset directory must not be a symlink');
  }
  const absolute = path.join(distDir, relative);
  requirePlainFile(absolute);
  const bytes = fs.readFileSync(absolute);
  if (assetDigest(bytes) !== relative.split('.')[1]) throw new Error('manifest asset hash mismatch');
  return bytes;
}

function loadWebAssetManifest({ distDir }) {
  const manifestPath = path.join(distDir, 'asset-manifest.json');
  requirePlainFile(manifestPath);
  if (fs.statSync(manifestPath).size > 65536) throw new Error('asset manifest exceeds metadata limit');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (![1, 2].includes(manifest.schemaVersion) || !manifest.assets) throw new Error('invalid asset manifest');
  const immutablePaths = new Set();
  function verifyRelease(release, legacy = false) {
    if (!release?.assets || typeof release.assets !== 'object' || Array.isArray(release.assets)
      || Object.keys(release.assets).length === 0 || Object.keys(release.assets).length > 32) {
      throw new Error('invalid release assets');
    }
    for (const [key, value] of Object.entries(release.assets)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(key)) throw new Error('invalid asset key');
      readVerifiedAsset(distDir, value);
      immutablePaths.add(`/${value}`);
    }
    const buildId = buildIdentity(release.assets);
    const builtAt = legacy ? Math.floor(fs.statSync(manifestPath).mtimeMs) : release.builtAt;
    if (!legacy && (release.buildId !== buildId || !Number.isSafeInteger(builtAt) || builtAt < 0)) {
      throw new Error('invalid release build identity');
    }
    return { buildId, builtAt, assets: { ...release.assets } };
  }
  const current = verifyRelease(manifest, manifest.schemaVersion === 1);
  const history = manifest.schemaVersion === 1 ? [] : manifest.retainedReleases;
  if (!Array.isArray(history) || history.length > 2) throw new Error('invalid retained releases');
  const retainedReleases = history.map((release) => verifyRelease(release));
  const ids = [current, ...retainedReleases].map((release) => release.buildId);
  if (new Set(ids).size !== ids.length) throw new Error('duplicate release identity');
  return Object.freeze({ schemaVersion: manifest.schemaVersion, ...current, retainedReleases, immutablePaths });
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
  assetDigest,
  buildIdentity,
  readVerifiedAsset,
};
