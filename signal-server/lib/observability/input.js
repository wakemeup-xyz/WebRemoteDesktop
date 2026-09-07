'use strict';

const crypto = require('node:crypto');

const MAX_INPUT_IDS = 64;
const MAX_INPUT_ID_LENGTH = 128;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const SAFE_INPUT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const INPUT_TYPES = new Set(['keyboard', 'mouse', 'command']);
const INPUT_ACTIONS = new Set([
  'key', 'keydown', 'keyup', 'text', 'batch', 'down', 'up', 'move', 'wheel', 'reset', 'showDock', 'switchInputMethod',
]);
const INPUT_TRANSPORTS = new Set(['datachannel', 'socket', 'none']);
const INPUT_STATUSES = new Set([
  'applied', 'duplicate', 'stale', 'late', 'timeout', 'rejected', 'sequence-gap',
  'resync-required', 'stale-lease', 'invalid-input', 'unsupported-code', 'execution-failed',
  'unordered', 'unknown', 'accepted', 'failed', 'pending',
]);
const INPUT_REASONS = new Set([
  'UNKNOWN_FIELD', 'INVALID_ENVELOPE', 'INVALID_SCHEMA_VERSION', 'INVALID_TYPE', 'UNKNOWN_ACTION',
  'MISSING_LEASE_ID', 'MISSING_INPUT_IDS', 'INVALID_LEASE_ID', 'INVALID_LEASE_EPOCH', 'INVALID_SEQ', 'INVALID_PAYLOAD',
  'INVALID_KEY_PHASE', 'INVALID_PHYSICAL_CODE', 'INVALID_LOCATION', 'INVALID_REPEAT', 'INVALID_MODIFIERS',
  'INVALID_LOCKS', 'INVALID_TEXT', 'TEXT_TOO_LONG', 'INVALID_BATCH', 'BATCH_TOO_LARGE', 'INVALID_INPUT_IDS',
  'INVALID_RESET_REASON', 'UNEXPECTED_SEQ', 'role-rejected', 'inactive-viewer', 'protocol-too-old',
  'unauthorized', 'host-unavailable', 'stale-lease', 'invalid-input', 'invalid-envelope',
]);

function boundedInteger(value, maximum = 0x7fffffff) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function validInputIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_INPUT_IDS) return null;
  if (!value.every((item) => (
    typeof item === 'string'
    && item.length >= 1
    && item.length <= MAX_INPUT_ID_LENGTH
    && SAFE_INPUT_ID.test(item)
  ))) return null;
  return value.slice();
}

function hashInputIds(value) {
  const inputIds = validInputIds(value);
  if (!inputIds) return null;
  return crypto.createHash('sha256')
    .update(inputIds.join('\x1f'), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function payloadByteLength(value) {
  try {
    const encoded = JSON.stringify(value && typeof value === 'object' ? value : {});
    return Math.min(MAX_PAYLOAD_BYTES, Buffer.byteLength(encoded, 'utf8'));
  } catch (_error) {
    return 0;
  }
}

function summarizeInputEvent(data = {}, overrides = {}) {
  const input = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const inputType = INPUT_TYPES.has(input.type) ? input.type : 'unknown';
  const action = INPUT_ACTIONS.has(input.action) ? input.action : 'unknown';
  const transport = INPUT_TRANSPORTS.has(input.transport) ? input.transport : 'socket';
  const inputIds = validInputIds(input.inputIds);
  const summary = {
    inputType,
    action,
    transport,
    payloadBytes: payloadByteLength(input.payload),
    inputIdCount: inputIds ? inputIds.length : 0,
    inputIdHash: hashInputIds(inputIds),
  };
  const status = overrides.status ?? input.status;
  summary.status = INPUT_STATUSES.has(status) ? status : 'unknown';
  const reason = overrides.reason ?? input.reason;
  summary.reason = INPUT_REASONS.has(reason) ? reason : null;
  summary.seq = boundedInteger(overrides.seq ?? input.seq);
  summary.leaseEpoch = boundedInteger(overrides.leaseEpoch ?? input.leaseEpoch);
  summary.appliedSeq = boundedInteger(
    overrides.appliedSeq ?? input.appliedSeq,
  );
  if (overrides.ackAccepted !== undefined) summary.ackAccepted = overrides.ackAccepted === true;
  if (overrides.localExecuteMs !== undefined) {
    const duration = Number(overrides.localExecuteMs);
    if (Number.isFinite(duration) && duration >= 0) {
      summary.localExecuteMs = Math.round(Math.min(duration, MAX_PAYLOAD_BYTES) * 1000) / 1000;
    }
  }
  return summary;
}

function summarizeHighFrequencyInput(data = {}, overrides = {}) {
  const input = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const status = overrides.status ?? input.status;
  return {
    inputType: typeof input.type === 'string' && INPUT_TYPES.has(input.type) ? input.type : 'unknown',
    action: typeof input.action === 'string' && INPUT_ACTIONS.has(input.action) ? input.action : 'unknown',
    transport: typeof input.transport === 'string' && INPUT_TRANSPORTS.has(input.transport)
      ? input.transport : 'socket',
    status: typeof status === 'string' && INPUT_STATUSES.has(status) ? status : 'unknown',
  };
}

function isHighFrequencyInput(data = {}) {
  return data?.type === 'mouse' && ['move', 'wheel'].includes(data?.action);
}

module.exports = {
  INPUT_ACTIONS,
  INPUT_STATUSES,
  INPUT_TYPES,
  INPUT_TRANSPORTS,
  MAX_INPUT_IDS,
  MAX_INPUT_ID_LENGTH,
  hashInputIds,
  isHighFrequencyInput,
  payloadByteLength,
  summarizeHighFrequencyInput,
  summarizeInputEvent,
  validInputIds,
};
