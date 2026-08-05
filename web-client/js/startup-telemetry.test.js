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
    performance: { now: () => 0 },
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
  const values = [0, 10, 30, 80];
  const telemetry = loadTelemetry()({
    now: () => values.shift() ?? 80,
    origin: 'https://link.stockhub.wiki',
  });
  telemetry.mark('core-interactive');
  telemetry.mark('bootstrap-ready');
  telemetry.recordResources([
    { name: 'https://link.stockhub.wiki/js/app.js?token=secret', duration: 50 },
    { name: 'https://cdn.example/x.js?key=secret', duration: 90 },
  ]);
  const snapshot = telemetry.snapshot();
  assert.equal(
    snapshot.marks.map((mark) => mark.name).join(','),
    'core-interactive,bootstrap-ready',
  );
  assert.equal(snapshot.resources[0].path, '/js/app.js');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|cdn\.example/);
  assert.ok(snapshot.resources.length <= 10);
});
