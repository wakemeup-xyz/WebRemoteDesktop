const assert = require('node:assert/strict');
const test = require('node:test');

const { InputGeometry } = require('./input-geometry');


function map(overrides = {}) {
  return InputGeometry.mapClientPoint({
    clientX: 50,
    clientY: 50,
    rect: { left: 0, top: 0, width: 100, height: 100 },
    sourceWidth: 100,
    sourceHeight: 100,
    objectFit: 'contain',
    ...overrides,
  });
}


test('fill maps the display rectangle directly into source coordinates', () => {
  assert.deepEqual(map({
    clientX: 25,
    clientY: 75,
    sourceWidth: 200,
    sourceHeight: 100,
    objectFit: 'fill',
  }), { relX: 0.25, relY: 0.75, inside: true });
});


test('contain rejects letterbox points and maps content corners', () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 };
  assert.deepEqual(map({ clientX: 25, clientY: 50, rect }), {
    relX: 0,
    relY: 0.5,
    inside: false,
  });
  assert.deepEqual(map({ clientX: 50, clientY: 0, rect }), {
    relX: 0,
    relY: 0,
    inside: true,
  });
  assert.deepEqual(map({ clientX: 150, clientY: 100, rect }), {
    relX: 1,
    relY: 1,
    inside: true,
  });
});


test('cover maps visible crop back into the complete source', () => {
  const rect = { left: 0, top: 0, width: 200, height: 100 };
  assert.deepEqual(map({ clientX: 0, clientY: 0, rect, objectFit: 'cover' }), {
    relX: 0,
    relY: 0.25,
    inside: true,
  });
  assert.deepEqual(map({ clientX: 100, clientY: 50, rect, objectFit: 'cover' }), {
    relX: 0.5,
    relY: 0.5,
    inside: true,
  });
  assert.deepEqual(map({ clientX: 200, clientY: 100, rect, objectFit: 'cover' }), {
    relX: 1,
    relY: 0.75,
    inside: true,
  });
});


test('invalid dimensions return an outside result instead of NaN', () => {
  assert.deepEqual(map({ sourceWidth: 0 }), { relX: 0, relY: 0, inside: false });
});
