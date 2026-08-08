'use strict';

const { makeTerminalError } = require('./lifecycle');

const COLS_LIMIT = Object.freeze({ min: 10, max: 300 });
const ROWS_LIMIT = Object.freeze({ min: 5, max: 100 });

function asInt(value) {
  if (typeof value === 'boolean') return NaN;
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

function assertTerminalSize(cols, rows) {
  const c = asInt(cols);
  const r = asInt(rows);
  if (
    !Number.isInteger(c) || c < COLS_LIMIT.min || c > COLS_LIMIT.max
    || !Number.isInteger(r) || r < ROWS_LIMIT.min || r > ROWS_LIMIT.max
  ) {
    throw makeTerminalError('terminal_invalid_size', 'Invalid terminal size', { cols, rows });
  }
  return { cols: c, rows: r };
}

function fieldPresent(input, key) {
  // undefined means "not provided" even if the key exists (common adapter spread).
  // null / '' are explicit and must reject when paired into normalize.
  return Object.hasOwn(input, key) && input[key] !== undefined;
}

function normalizeTerminalSize(input = {}, fallback = { cols: 80, rows: 24 }) {
  const source = input && typeof input === 'object' ? input : {};
  const hasCols = fieldPresent(source, 'cols');
  const hasRows = fieldPresent(source, 'rows');
  if (hasCols !== hasRows) {
    throw makeTerminalError('terminal_invalid_size', 'cols and rows must be provided together', {
      cols: source.cols,
      rows: source.rows,
    });
  }
  if (!hasCols) {
    return assertTerminalSize(fallback.cols, fallback.rows);
  }
  return assertTerminalSize(source.cols, source.rows);
}

module.exports = {
  COLS_LIMIT,
  ROWS_LIMIT,
  assertTerminalSize,
  normalizeTerminalSize,
};
