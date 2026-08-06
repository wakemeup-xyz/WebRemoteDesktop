'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadTelemetry() {
  const context = {
    globalThis: null,
    URL,
    location: { origin: 'https://link.stockhub.wiki' },
    performance: { now: () => 999 },
    __WRD_SHELL__: {
      snapshot() {
        return {
          marks: [
            { name: 'html-shell', atMs: 12.5, detail: null },
            { name: 'core-interactive', atMs: 88.25, detail: null },
          ],
        };
      },
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    `${fs.readFileSync(path.join(__dirname, 'startup-telemetry.js'), 'utf8')}\n` +
    'globalThis.__factory = createStartupTelemetry;',
    context,
  );
  return context.__factory;
}

test('startup telemetry keeps bounded monotonic marks and redacted resource paths', () => {
  const values = [100, 110, 130, 180];
  const telemetry = loadTelemetry()({
    now: () => values.shift() ?? 180,
    origin: 'https://link.stockhub.wiki',
  });
  telemetry.mark('bootstrap-ready');
  telemetry.recordResources([
    { name: 'https://link.stockhub.wiki/js/app.js?token=secret', duration: 50 },
    { name: 'https://cdn.example/x.js?key=secret', duration: 90 },
  ]);
  const snapshot = telemetry.snapshot();
  // Shell marks (12.5, 88.25) merge with telemetry marks; order by original atMs.
  assert.equal(
    snapshot.marks.map((mark) => mark.name).join(','),
    'html-shell,core-interactive,bootstrap-ready',
  );
  assert.equal(snapshot.marks.find((mark) => mark.name === 'html-shell').atMs, 12.5);
  assert.equal(snapshot.marks.find((mark) => mark.name === 'bootstrap-ready').atMs, 100);
  assert.equal(snapshot.resources[0].path, '/js/app.js');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|cdn\.example/);
  assert.ok(snapshot.resources.length <= 10);
});

test('importMarks preserves original shell timestamps and never overwrites', () => {
  const telemetry = loadTelemetry()({ now: () => 5000 });
  telemetry.importMarks([
    { name: 'start-click', atMs: 44 },
    { name: 'bootstrap-start', atMs: 45 },
  ]);
  telemetry.importMarks([{ name: 'start-click', atMs: 999 }]);
  const snap = telemetry.snapshot();
  // html-shell still comes from live ShellGuard snapshot truth.
  assert.equal(snap.marks.find((m) => m.name === 'html-shell').atMs, 12.5);
  assert.equal(snap.marks.find((m) => m.name === 'start-click').atMs, 44);
  assert.equal(snap.marks.find((m) => m.name === 'bootstrap-start').atMs, 45);
});
