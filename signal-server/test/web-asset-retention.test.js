'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildWebClient } = require('../scripts/build-web-client');
const { loadWebAssetManifest, cachePolicyForAsset, edgeCachePolicyForAsset, buildIdentity } = require('../lib/web-assets');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wrd-retention-'));
  const source = path.resolve(__dirname, '../../web-client');
  const sourceDir = path.join(root, 'source');
  const outDir = path.join(root, 'dist');
  fs.cpSync(source, sourceDir, { recursive: true,
    filter: (src) => !path.relative(source, src).split(path.sep).includes('dist') });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { sourceDir, outDir, release(value, options = {}) {
    fs.appendFileSync(path.join(sourceDir, 'js/terminal.js'), `\nglobalThis.__fixtureRelease = ${value};\n`);
    return buildWebClient({ sourceDir, outDir, ...options });
  } };
}

test('real A→B builds keep the uncached previous lazy hash beside current assets', async (t) => {
  const f = fixture(t);
  const a = await f.release(1);
  const b = await f.release(2);
  assert.notEqual(a.assets.terminalJs, b.assets.terminalJs);
  assert.equal(fs.existsSync(path.join(f.outDir, a.assets.terminalJs)), true);
  assert.equal(fs.existsSync(path.join(f.outDir, b.assets.terminalJs)), true);
  assert.equal(b.schemaVersion, 2);
  assert.deepEqual(b.retainedReleases.map((release) => release.buildId), [a.buildId]);
  const loaded = loadWebAssetManifest({ distDir: f.outDir });
  assert.equal(cachePolicyForAsset(`/${a.assets.terminalJs}`, loaded), 'public, max-age=31536000, immutable');
  for (const page of ['viewer.html', 'index.html']) {
    const html = fs.readFileSync(path.join(f.outDir, page), 'utf8');
    assert.ok(html.includes(`window.__WRD_BUILD__=${JSON.stringify({ id: b.buildId, builtAt: b.builtAt })}`));
    assert.ok(!html.includes(a.buildId));
    assert.equal(cachePolicyForAsset(`/${page}`, loaded), 'no-cache, max-age=0, must-revalidate');
    assert.equal(edgeCachePolicyForAsset(`/${page}`, loaded), null);
  }
});

function allBytes(dir) {
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => {
      const file = path.join(entry.parentPath || entry.path, entry.name);
      return [path.relative(dir, file), fs.readFileSync(file).toString('hex')];
    }).sort(([a], [b]) => a < b ? -1 : 1));
}

function assertExactAssets(outDir, releases) {
  const expected = [...new Set(releases.flatMap((release) => Object.values(release.assets)))].sort();
  assert.deepEqual(fs.readdirSync(path.join(outDir, 'assets')).map((name) => `assets/${name}`).sort(), expected);
}

test('real A→B→C→D evicts oldest release and copies only manifest referenced hashes', async (t) => {
  const f = fixture(t);
  const a = await f.release(1, { now: () => 1000 });
  const b = await f.release(2, { now: () => 2000 });
  fs.writeFileSync(path.join(f.outDir, 'assets/stray.js'), 'not a release asset');
  const c = await f.release(3, { now: () => 3000 });
  assert.deepEqual(c.retainedReleases.map((release) => release.buildId), [b.buildId, a.buildId]);
  assertExactAssets(f.outDir, [c, ...c.retainedReleases]);
  const d = await f.release(4, { now: () => 4000 });
  assert.deepEqual(d.retainedReleases.map((release) => release.buildId), [c.buildId, b.buildId]);
  assert.equal(fs.existsSync(path.join(f.outDir, a.assets.terminalJs)), false);
  assert.equal(fs.existsSync(path.join(f.outDir, b.assets.terminalJs)), true);
  assertExactAssets(f.outDir, [d, ...d.retainedReleases]);
  assert.equal(buildIdentity(Object.fromEntries(Object.entries(d.assets).reverse())), d.buildId);
  const two = await f.release(5, { now: () => 5000, retention: { maxReleases: 2 } });
  assert.deepEqual(two.retainedReleases.map((release) => release.buildId), [d.buildId]);
  assertExactAssets(f.outDir, [two, ...two.retainedReleases]);
});

test('TTL never removes the required previous release, but expired optional history is removed', async (t) => {
  const f = fixture(t);
  const a = await f.release(1, { now: () => 1000 });
  const b = await f.release(2, { now: () => 2000 });
  const c = await f.release(3, { now: () => 5000, retention: { maxAgeMs: 100 } });
  assert.deepEqual(c.retainedReleases.map((release) => release.buildId), [b.buildId]);
  assert.equal(fs.existsSync(path.join(f.outDir, a.assets.terminalJs)), false);
  assert.equal(fs.existsSync(path.join(f.outDir, b.assets.terminalJs)), true);
  const same = await buildWebClient({ sourceDir: f.sourceDir, outDir: f.outDir, now: () => 9000, retention: { maxAgeMs: 0 } });
  assert.equal(same.buildId, c.buildId);
  assert.deepEqual(same.retainedReleases.map((release) => release.buildId), [b.buildId]);
});

test('budget counts shared bytes once, drops optional history, and fails without changing current bytes', async (t) => {
  const f = fixture(t);
  await f.release(1);
  const b = await f.release(2);
  const c = await f.release(3);
  const unique = new Set([...Object.values(c.assets), ...Object.values(b.assets)]);
  const budget = [...unique].reduce((sum, asset) => sum + fs.statSync(path.join(f.outDir, asset)).size, 0);
  // The appended fixture statement grows D slightly; 1 KiB accommodates it,
  // while another historical terminal bundle is much larger than that slack.
  const d = await f.release(4, { retention: { maxBytes: budget + 1024 } });
  assert.deepEqual(d.retainedReleases.map((release) => release.buildId), [c.buildId]);
  assertExactAssets(f.outDir, [d, ...d.retainedReleases]);
  const before = allBytes(f.outDir);
  await assert.rejects(f.release(5, { retention: { maxBytes: 1 } }), /required asset retention exceeds budget/);
  assert.deepEqual(allBytes(f.outDir), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.outDir)).sort(), ['dist', 'source']);
});

test('schema-1 manifest migrates its verified current release without trusting unknown metadata', async (t) => {
  const f = fixture(t);
  const a = await f.release(1);
  fs.writeFileSync(path.join(f.outDir, 'asset-manifest.json'), JSON.stringify({ schemaVersion: 1, assets: a.assets, sourceDir: 'secret' }));
  const b = await f.release(2);
  assert.equal(b.schemaVersion, 2);
  assert.deepEqual(b.retainedReleases[0].assets, a.assets);
  assert.equal(b.retainedReleases[0].buildId, a.buildId);
  assert.ok(Number.isSafeInteger(b.retainedReleases[0].builtAt));
  assert.doesNotMatch(JSON.stringify(b), /secret|sourceDir/);
});

test('traversal, forged hashes and symlinks reject publication and leave existing bytes intact', async (t) => {
  const f = fixture(t);
  const a = await f.release(1);
  const manifestPath = path.join(f.outDir, 'asset-manifest.json');
  for (const value of ['../secret.js', '/assets/app.0123456789abcdef.js', 'assets/../app.0123456789abcdef.js',
    'assets/%2e%2e/app.0123456789abcdef.js', 'assets\\app.0123456789abcdef.js']) {
    fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: 1, assets: { desktopJs: value } }));
    const before = allBytes(f.outDir);
    await assert.rejects(f.release(2), /unsafe asset path/);
    assert.deepEqual(allBytes(f.outDir), before);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(a));
  fs.appendFileSync(path.join(f.outDir, a.assets.terminalJs), 'tampered');
  const before = allBytes(f.outDir);
  await assert.rejects(f.release(3), /hash mismatch/);
  assert.deepEqual(allBytes(f.outDir), before);
  // Rebuild an independent valid dist, then replace a hash with a symlink to
  // identical external bytes: content validation alone must not authorize it.
  fs.rmSync(f.outDir, { recursive: true });
  const valid = await f.release(4);
  const target = path.join(f.outDir, valid.assets.terminalJs);
  const outside = path.join(path.dirname(f.outDir), 'outside.js');
  fs.renameSync(target, outside);
  fs.symlinkSync(outside, target);
  const manifestBytes = fs.readFileSync(manifestPath);
  await assert.rejects(f.release(5), /symlink/);
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  fs.unlinkSync(target);
  fs.renameSync(outside, target);
  fs.renameSync(path.join(f.outDir, 'assets'), path.join(path.dirname(f.outDir), 'outside-assets'));
  fs.symlinkSync(path.join(path.dirname(f.outDir), 'outside-assets'), path.join(f.outDir, 'assets'));
  await assert.rejects(f.release(6), /symlink/);
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBytes);
});

test('schema-2 historical references, identity and metadata bounds are validated before publishing', async (t) => {
  const f = fixture(t);
  await f.release(1);
  const b = await f.release(2);
  const manifestPath = path.join(f.outDir, 'asset-manifest.json');
  const invalid = [
    { ...b, retainedReleases: [{ ...b.retainedReleases[0], assets: { terminalJs: '../escape.js' } }] },
    { ...b, buildId: '0000000000000000' },
    { ...b, retainedReleases: Array(3).fill(b.retainedReleases[0]) },
    { ...b, retainedReleases: [{ buildId: b.buildId, builtAt: b.builtAt, assets: b.assets }] },
  ];
  for (const manifest of invalid) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const before = allBytes(f.outDir);
    await assert.rejects(f.release(3), /unsafe|identity|retained/);
    assert.deepEqual(allBytes(f.outDir), before);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(b));
  const outside = path.join(path.dirname(f.outDir), 'outside-manifest.json');
  fs.renameSync(manifestPath, outside);
  fs.symlinkSync(outside, manifestPath);
  await assert.rejects(f.release(4), /symlink/);
  assert.equal(fs.lstatSync(manifestPath).isSymbolicLink(), true);
});
