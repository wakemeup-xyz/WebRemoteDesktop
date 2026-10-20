'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const graph = require('./web-asset-graph');
const { buildIdentity, loadWebAssetManifest, readVerifiedAsset } = require('../lib/web-assets');

const DEFAULT_RETENTION = Object.freeze({ maxReleases: 3, maxAgeMs: 259200000, maxBytes: 67108864 });

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function readJoined(sourceDir, files) {
  return files.map((file) => fs.readFileSync(path.join(sourceDir, file), 'utf8')).join('\n;\n');
}

async function compileClassic(source, sourcefile) {
  const result = await esbuild.transform(source, {
    loader: 'js',
    minify: true,
    target: 'es2020',
    legalComments: 'inline',
    sourcefile,
  });
  return result.code;
}

function writeHashed(assetDir, stem, extension, bytes) {
  const name = `${stem}.${digest(bytes)}.${extension}`;
  fs.writeFileSync(path.join(assetDir, name), bytes);
  return `assets/${name}`;
}

function replaceBlock(html, start, end, replacement) {
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(html)) throw new Error(`missing build markers: ${start}`);
  return html.replace(pattern, replacement);
}

function uniqueAssetBytes(releases, readAsset) {
  const hashes = new Set();
  let bytes = 0;
  for (const release of releases) {
    for (const relative of Object.values(release.assets)) {
      const hash = relative.split('.')[1];
      if (!hashes.has(hash)) { hashes.add(hash); bytes += readAsset(relative).length; }
    }
  }
  return bytes;
}

function selectOptionalHistory(required, history, retention, at, readAsset) {
  const releases = [...required];
  const ids = new Set(required.map((release) => release.buildId));
  for (const release of [...history].sort((a, b) => b.builtAt - a.builtAt)) {
    if (releases.length >= retention.maxReleases) break;
    if (ids.has(release.buildId) || at - release.builtAt > retention.maxAgeMs) continue;
    if (uniqueAssetBytes([...releases, release], readAsset) > retention.maxBytes) continue;
    releases.push(release);
    ids.add(release.buildId);
  }
  return releases;
}

function copyVerifiedAssets(releases, staging, readAsset) {
  for (const relative of new Set(releases.flatMap((release) => Object.values(release.assets)))) {
    const target = path.join(staging, relative);
    // A fresh build can share bytes with historical releases; always verify source.
    const bytes = readAsset(relative);
    if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
    readVerifiedAsset(staging, relative);
  }
}

async function buildWebClient({ sourceDir, outDir, now = Date.now, retention = DEFAULT_RETENTION }) {
  retention = { ...DEFAULT_RETENTION, ...retention };
  if (!Number.isSafeInteger(retention.maxReleases) || retention.maxReleases < 2 || retention.maxReleases > 3
    || !Number.isSafeInteger(retention.maxAgeMs) || retention.maxAgeMs < 0
    || !Number.isSafeInteger(retention.maxBytes) || retention.maxBytes < 0) throw new Error('invalid asset retention limits');
  const builtAt = now();
  if (!Number.isSafeInteger(builtAt) || builtAt < 0) throw new Error('invalid build time');
  const staging = `${outDir}.tmp-${process.pid}-${Date.now()}`;
  const previousBackup = `${outDir}.prev-${process.pid}-${Date.now()}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'assets'), { recursive: true });

  try {
    // Reject untrusted manifests before compiling or publishing. A schema-1 build
    // migrates to one verified previous release using the manifest mtime.
    if (fs.existsSync(outDir) && !fs.lstatSync(outDir).isDirectory()) throw new Error('dist directory must not be a symlink');
    const previous = fs.existsSync(outDir) && fs.readdirSync(outDir).length
      ? loadWebAssetManifest({ distDir: outDir }) : null;
    const socketRoot = path.dirname(require.resolve('socket.io/package.json'));
    const xtermEntry = require.resolve('@xterm/xterm');
    const xtermRoot = path.resolve(path.dirname(xtermEntry), '..');
    const fitEntry = require.resolve('@xterm/addon-fit');
    const fitRoot = path.resolve(path.dirname(fitEntry), '..');
    const socketClient = fs.readFileSync(path.join(socketRoot, 'client-dist/socket.io.min.js'), 'utf8');
    const xtermJs = fs.readFileSync(xtermEntry, 'utf8');
    const fitJs = fs.readFileSync(fitEntry, 'utf8');
    const xtermCss = fs.readFileSync(path.join(xtermRoot, 'css/xterm.css'), 'utf8');

    const desktopSource = `${socketClient}\n${readJoined(sourceDir, graph.desktopScripts)}`;
    const deferredSource = readJoined(sourceDir, graph.desktopDeferredScripts || []);
    const terminalSource = `${xtermJs}\n${fitJs}\n${readJoined(sourceDir, graph.terminalScripts)}`;
    const loginJs = await compileClassic(readJoined(sourceDir, graph.loginScripts), 'login.js');
    const desktopJs = await compileClassic(desktopSource, 'desktop-core.js');
    const deferredJs = deferredSource
      ? await compileClassic(deferredSource, 'desktop-deferred.js')
      : '';
    const terminalJs = await compileClassic(terminalSource, 'terminal.js');
    const shellGuard = await compileClassic(
      fs.readFileSync(path.join(sourceDir, 'js/shell-guard.js'), 'utf8'),
      'shell-guard.js',
    );
    const tokenCss = fs.readFileSync(path.join(sourceDir, 'css/tokens.css'), 'utf8');
    const viewerCss = `${tokenCss}\n${fs.readFileSync(path.join(sourceDir, 'css/viewer.css'), 'utf8')}`;

    const assets = {
      loginJs: writeHashed(path.join(staging, 'assets'), 'login', 'js', loginJs),
      desktopJs: writeHashed(path.join(staging, 'assets'), 'desktop-core', 'js', desktopJs),
      viewerCss: writeHashed(path.join(staging, 'assets'), 'viewer', 'css', viewerCss),
      terminalJs: writeHashed(path.join(staging, 'assets'), 'terminal', 'js', terminalJs),
      terminalCss: writeHashed(path.join(staging, 'assets'), 'terminal', 'css', xtermCss),
    };
    if (deferredJs) {
      assets.desktopDeferredJs = writeHashed(
        path.join(staging, 'assets'),
        'desktop-deferred',
        'js',
        deferredJs,
      );
    }
    const nextRelease = { buildId: buildIdentity(assets), builtAt, assets };
    const buildInfo = { id: nextRelease.buildId, builtAt };

    const lazyAssets = {
      terminalJs: `/${assets.terminalJs}`,
      terminalCss: `/${assets.terminalCss}`,
    };
    if (assets.desktopDeferredJs) {
      lazyAssets.desktopDeferredJs = `/${assets.desktopDeferredJs}`;
    }

    let viewerHtml = fs.readFileSync(path.join(sourceDir, 'viewer.html'), 'utf8');
    viewerHtml = replaceBlock(
      viewerHtml,
      '<!-- WRD_BUILD_HEAD_START -->',
      '<!-- WRD_BUILD_HEAD_END -->',
      [
        `<link rel="preload" href="/${assets.desktopJs}" as="script" fetchpriority="high">`,
        `<link rel="preload" href="/${assets.viewerCss}" as="style">`,
        `<link rel="stylesheet" href="/${assets.viewerCss}">`,
      ].join('\n'),
    );
    viewerHtml = replaceBlock(
      viewerHtml,
      '<!-- WRD_BUILD_SCRIPTS_START -->',
      '<!-- WRD_BUILD_SCRIPTS_END -->',
      [
        `<script>${shellGuard}</script>`,
        `<script>window.__WRD_BUILD__=${JSON.stringify(buildInfo)}</script>`,
        `<script>window.__WRD_ASSETS__=${JSON.stringify(lazyAssets)}</script>`,
        `<script src="/${assets.desktopJs}" defer></script>`,
      ].join('\n'),
    );

    // Validate critical request graph before publish.
    // Allow one stylesheet and optional preload link; exactly one script src.
    if ((viewerHtml.match(/<script[^>]+src=/g) || []).length !== 1) {
      throw new Error('critical HTML must reference exactly one script src');
    }
    const stylesheetCount = (viewerHtml.match(/<link[^>]+rel=["']stylesheet["']/g) || []).length;
    if (stylesheetCount !== 1) {
      throw new Error('critical HTML must reference exactly one stylesheet');
    }
    if (/cdn\.jsdelivr\.net|cdn\.socket\.io|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(viewerHtml)) {
      throw new Error('critical HTML must not reference runtime CDN hosts');
    }

    fs.writeFileSync(path.join(staging, 'viewer.html'), viewerHtml);
    const loginHtml = replaceBlock(
      fs.readFileSync(path.join(sourceDir, 'index.html'), 'utf8'),
      '<!-- WRD_BUILD_LOGIN_SCRIPTS_START -->',
      '<!-- WRD_BUILD_LOGIN_SCRIPTS_END -->',
      `<script>window.__WRD_BUILD__=${JSON.stringify(buildInfo)}</script>\n<script src="/${assets.loginJs}" defer></script>`,
    );
    fs.writeFileSync(path.join(staging, 'index.html'), loginHtml);
    fs.mkdirSync(path.join(staging, 'css'));
    fs.copyFileSync(path.join(sourceDir, 'css/login.css'), path.join(staging, 'css/login.css'));
    fs.copyFileSync(path.join(sourceDir, 'css/tokens.css'), path.join(staging, 'css/tokens.css'));
    const licenses = [
      ['socket.io', path.join(socketRoot, 'LICENSE')],
      ['@xterm/xterm', path.join(xtermRoot, 'LICENSE')],
      ['@xterm/addon-fit', path.join(fitRoot, 'LICENSE')],
    ].map(([name, licensePath]) => `===== ${name} =====\n${fs.readFileSync(licensePath, 'utf8').trim()}\n`);
    fs.writeFileSync(path.join(staging, 'THIRD_PARTY_LICENSES.txt'), `${licenses.join('\n')}\n`);

    const previousRelease = previous && { buildId: previous.buildId, builtAt: previous.builtAt, assets: previous.assets };
    // On a no-content-change rebuild, preserve the nearest distinct previous ID.
    const candidates = previous ? [previousRelease, ...previous.retainedReleases] : [];
    const nearestPrevious = candidates.find((release) => release.buildId !== nextRelease.buildId);
    const required = [nextRelease, nearestPrevious].filter(Boolean);
    const newPaths = new Set(Object.values(assets));
    const readAsset = (relative) => readVerifiedAsset(newPaths.has(relative) ? staging : outDir, relative);
    if (uniqueAssetBytes(required, readAsset) > retention.maxBytes) {
      throw new Error('required asset retention exceeds budget');
    }
    const retained = selectOptionalHistory(required, candidates, retention, builtAt, readAsset);
    copyVerifiedAssets(retained, staging, readAsset);
    const manifest = { schemaVersion: 2, ...nextRelease, retainedReleases: retained.slice(1) };
    fs.writeFileSync(path.join(staging, 'asset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    loadWebAssetManifest({ distDir: staging });

    // Validated staging + rollback. The two directory renames have a brief gap;
    // this is not a multi-file transaction or a zero-gap serving guarantee.
    const hadPrevious = fs.existsSync(outDir);
    if (hadPrevious) {
      fs.rmSync(previousBackup, { recursive: true, force: true });
      fs.renameSync(outDir, previousBackup);
    }
    try {
      fs.renameSync(staging, outDir);
    } catch (publishError) {
      if (hadPrevious && fs.existsSync(previousBackup)) {
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.renameSync(previousBackup, outDir);
      }
      throw publishError;
    }
    fs.rmSync(previousBackup, { recursive: true, force: true });
    return manifest;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  const projectRoot = path.join(__dirname, '..', '..');
  buildWebClient({
    sourceDir: path.join(projectRoot, 'web-client'),
    outDir: path.join(projectRoot, 'web-client', 'dist'),
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildWebClient, digest, replaceBlock };
