'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTerminalSize,
  assertTerminalSize,
  COLS_LIMIT,
  ROWS_LIMIT,
} = require('../lib/terminal/geometry');

test('normalizeTerminalSize accepts boundaries and defaults', () => {
  assert.deepEqual(normalizeTerminalSize({}), { cols: 80, rows: 24 });
  assert.deepEqual(normalizeTerminalSize({ cols: 10, rows: 5 }), { cols: 10, rows: 5 });
  assert.deepEqual(normalizeTerminalSize({ cols: 300, rows: 100 }), { cols: 300, rows: 100 });
  assert.equal(COLS_LIMIT.min, 10);
  assert.equal(COLS_LIMIT.max, 300);
  assert.equal(ROWS_LIMIT.min, 5);
  assert.equal(ROWS_LIMIT.max, 100);
});

test('normalizeTerminalSize rejects out of range for create/attach', () => {
  assert.throws(
    () => normalizeTerminalSize({ cols: 999999, rows: 24 }),
    (err) => err.code === 'terminal_invalid_size',
  );
  assert.throws(
    () => normalizeTerminalSize({ cols: 80, rows: -5 }),
    (err) => err.code === 'terminal_invalid_size',
  );
  assert.throws(
    () => normalizeTerminalSize({ cols: '', rows: 24 }),
    (err) => err.code === 'terminal_invalid_size',
  );
  assert.throws(
    () => normalizeTerminalSize({ cols: 80 }),
    (err) => err.code === 'terminal_invalid_size',
  );
  assert.throws(
    () => normalizeTerminalSize({ rows: 24 }),
    (err) => err.code === 'terminal_invalid_size',
  );
  assert.throws(
    () => normalizeTerminalSize({ cols: null, rows: 24 }),
    (err) => err.code === 'terminal_invalid_size',
  );
});

test('normalizeTerminalSize treats undefined fields as omitted defaults', () => {
  assert.deepEqual(normalizeTerminalSize({ cols: undefined, rows: undefined }), { cols: 80, rows: 24 });
  assert.deepEqual(normalizeTerminalSize({ title: 'x' }), { cols: 80, rows: 24 });
});

test('assertTerminalSize matches resize contract 10-300 / 5-100', () => {
  assert.deepEqual(assertTerminalSize(80, 24), { cols: 80, rows: 24 });
  assert.throws(() => assertTerminalSize(9, 24), (err) => err.code === 'terminal_invalid_size');
  assert.throws(() => assertTerminalSize(80, 101), (err) => err.code === 'terminal_invalid_size');
  assert.throws(() => assertTerminalSize(1.5, 24), (err) => err.code === 'terminal_invalid_size');
});
