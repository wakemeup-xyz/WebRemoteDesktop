import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(import.meta.dirname, 'turn-runtime-controlled-producer.html'), 'utf8');
const script = source.match(/<script>([\s\S]*)<\/script>/)?.[1];

function api() {
  const context = { window: {}, BigInt, Uint8Array, ArrayBuffer, DataView, TextEncoder };
  vm.createContext(context);
  vm.runInContext(script, context);
  return context.window.WRDTurnControlledProducer;
}

test('controlled producer exports a fixed 32 by 16 marker with two equal 192-bit copies', () => {
  const producer = api();
  assert.ok(producer);
  const grid = producer.markerGrid({ runNonce: 42n, sceneId: 7, tick: 0, actionId: 0 });
  assert.equal(grid.length, 16);
  assert.equal(grid[0].length, 32);
  const interior = grid.slice(1, -1).flatMap((row) => row.slice(1, -1));
  assert.deepEqual(interior.slice(0, 192), interior.slice(192, 384));
});

test('controlled producer keeps the marker frozen until an explicit action', () => {
  const producer = api();
  const state = producer.createState({ runNonce: 42n, sceneId: 7 });
  const frozen = JSON.stringify(producer.markerGrid(state));
  assert.equal(JSON.stringify(producer.markerGrid(state)), frozen);
  producer.applyAction(state, 9);
  assert.notEqual(JSON.stringify(producer.markerGrid(state)), frozen);
  assert.equal(JSON.stringify(producer.markerGrid(state)), JSON.stringify(producer.markerGrid(state)));
});
