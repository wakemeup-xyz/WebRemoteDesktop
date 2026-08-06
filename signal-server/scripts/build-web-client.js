'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const graph = require('./web-asset-graph');

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

async function buildWebClient({ sourceDir, outDir }) {
  const staging = `${outDir}.tmp-${process.pid}-${Date.now()}`;
  const previousBackup = `${outDir}.prev-${process.pid}-${Date.now()}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, 'assets'), { recursive: true });

  try {
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
    const terminalSource = `${xtermJs}\n${fitJs}\n${readJoined(sourceDir, graph.terminalScripts)}`;
    const desktopJs = await compileClassic(desktopSource, 'desktop-core.js');
    const terminalJs = await compileClassic(terminalSource, 'terminal.js');
    const shellGuard = await compileClassic(
      fs.readFileSync(path.join(sourceDir, 'js/shell-guard.js'), 'utf8'),
      'shell-guard.js',
    );
    const viewerCss = fs.readFileSync(path.join(sourceDir, 'css/viewer.css'), 'utf8');

    const assets = {
      desktopJs: writeHashed(path.join(staging, 'assets'), 'desktop-core', 'js', desktopJs),
      viewerCss: writeHashed(path.join(staging, 'assets'), 'viewer', 'css', viewerCss),
      terminalJs: writeHashed(path.join(staging, 'assets'), 'terminal', 'js', terminalJs),
      terminalCss: writeHashed(path.join(staging, 'assets'), 'terminal', 'css', xtermCss),
    };

    const lazyAssets = {
      terminalJs: `/${assets.terminalJs}`,
      terminalCss: `/${assets.terminalCss}`,
    };

    let viewerHtml = fs.readFileSync(path.join(sourceDir, 'viewer.html'), 'utf8');
    viewerHtml = replaceBlock(
      viewerHtml,
      '<!-- WRD_BUILD_HEAD_START -->',
      '<!-- WRD_BUILD_HEAD_END -->',
      `<link rel="stylesheet" href="/${assets.viewerCss}">`,
    );
    viewerHtml = replaceBlock(
      viewerHtml,
      '<!-- WRD_BUILD_SCRIPTS_START -->',
      '<!-- WRD_BUILD_SCRIPTS_END -->',
      [
        `<script>${shellGuard}</script>`,
        `<script>window.__WRD_ASSETS__=${JSON.stringify(lazyAssets)}</script>`,
        `<script src="/${assets.desktopJs}" defer></script>`,
      ].join('\n'),
    );

    // Validate critical request graph before publish.
    if ((viewerHtml.match(/<script[^>]+src=/g) || []).length !== 1) {
      throw new Error('critical HTML must reference exactly one script src');
    }
    if ((viewerHtml.match(/<link[^>]+stylesheet/g) || []).length !== 1) {
      throw new Error('critical HTML must reference exactly one stylesheet');
    }
    if (/cdn\.jsdelivr\.net|cdn\.socket\.io|fonts\.googleapis\.com|fonts\.gstatic\.com/.test(viewerHtml)) {
      throw new Error('critical HTML must not reference runtime CDN hosts');
    }

    fs.writeFileSync(path.join(staging, 'viewer.html'), viewerHtml);
    fs.copyFileSync(path.join(sourceDir, 'index.html'), path.join(staging, 'index.html'));
    fs.mkdirSync(path.join(staging, 'css'));
    fs.copyFileSync(path.join(sourceDir, 'css/login.css'), path.join(staging, 'css/login.css'));
    const licenses = [
      ['socket.io', path.join(socketRoot, 'LICENSE')],
      ['@xterm/xterm', path.join(xtermRoot, 'LICENSE')],
      ['@xterm/addon-fit', path.join(fitRoot, 'LICENSE')],
    ].map(([name, licensePath]) => `===== ${name} =====\n${fs.readFileSync(licensePath, 'utf8').trim()}\n`);
    fs.writeFileSync(path.join(staging, 'THIRD_PARTY_LICENSES.txt'), `${licenses.join('\n')}\n`);

    const manifest = { schemaVersion: 1, assets };
    for (const relative of Object.values(assets)) {
      const absolute = path.join(staging, relative);
      if (!fs.existsSync(absolute)) {
        throw new Error(`missing staged asset before publish: ${relative}`);
      }
    }
    fs.writeFileSync(path.join(staging, 'asset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    // Atomic publish: keep previous dist until staging is fully valid.
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
