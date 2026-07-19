'use strict';

const MAX_TEXT_SCALARS = 4096;
const MAX_BATCH_STEPS = 16;

const ENVELOPE_FIELDS = new Set([
  'schemaVersion', 'type', 'action', 'leaseId', 'leaseEpoch', 'seq', 'payload',
]);
const KEY_FIELDS = new Set(['phase', 'code', 'location', 'repeat', 'modifiers', 'locks']);
const MODIFIER_FIELDS = new Set(['altKey', 'ctrlKey', 'metaKey', 'shiftKey']);
const LOCK_FIELDS = new Set(['capsLock']);
const ACTIONS = new Set(['key', 'text', 'batch', 'reset']);
const RESET_REASONS = new Set([
  'window-blur', 'visibility-hidden', 'deactivated', 'keyboard-mode-change',
  'transport-change', 'control-revoked', 'controller-disconnect', 'lease-expired',
  'signal-disconnect', 'webrtc-disconnected', 'datachannel-closed', 'viewer-disconnect',
  'host-reconnect', 'host-stop', 'batch-failed', 'pending-reset', 'manual', 'unspecified',
]);

function failed(code) {
  return { ok: false, code };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyFields(value, allowed) {
  return isRecord(value) && Object.keys(value).every((field) => allowed.has(field));
}

function isExactBooleanRecord(value, allowed) {
  if (!hasOnlyFields(value, allowed) || Object.keys(value).length !== allowed.size) return false;
  return Object.values(value).every((field) => typeof field === 'boolean');
}

function validateKeyPayload(payload) {
  if (!hasOnlyFields(payload, KEY_FIELDS)) return 'UNKNOWN_FIELD';
  if (payload.phase !== 'down' && payload.phase !== 'up') return 'INVALID_KEY_PHASE';
  if (typeof payload.code !== 'string' || payload.code.length === 0 || payload.code.length > 32
    || !/^[A-Z][A-Za-z0-9]+$/.test(payload.code)) return 'INVALID_PHYSICAL_CODE';
  if (!Number.isInteger(payload.location) || payload.location < 0 || payload.location > 3) return 'INVALID_LOCATION';
  if (typeof payload.repeat !== 'boolean') return 'INVALID_REPEAT';
  if (!isExactBooleanRecord(payload.modifiers, MODIFIER_FIELDS)) return 'INVALID_MODIFIERS';
  if (!isExactBooleanRecord(payload.locks, LOCK_FIELDS)) return 'INVALID_LOCKS';
  return null;
}

function validateRemoteInput(data) {
  try {
    if (!isRecord(data)) return failed('INVALID_ENVELOPE');
    if (!hasOnlyFields(data, ENVELOPE_FIELDS)) return failed('UNKNOWN_FIELD');
    if (data.schemaVersion !== 2) return failed('INVALID_SCHEMA_VERSION');
    if (data.type !== 'keyboard') return failed('INVALID_TYPE');
    if (!ACTIONS.has(data.action)) return failed('UNKNOWN_ACTION');
    if (data.leaseId === undefined) return failed('MISSING_LEASE_ID');
    if (typeof data.leaseId !== 'string' || data.leaseId.length < 16) return failed('INVALID_LEASE_ID');
    if (!Number.isSafeInteger(data.leaseEpoch) || data.leaseEpoch < 1) return failed('INVALID_LEASE_EPOCH');
    if (!Number.isSafeInteger(data.seq) || data.seq < 1) return failed('INVALID_SEQ');
    if (!isRecord(data.payload)) return failed('INVALID_PAYLOAD');

    if (data.action === 'key') {
      const code = validateKeyPayload(data.payload);
      return code ? failed(code) : { ok: true, value: data };
    }
    if (data.action === 'text') {
      if (!hasOnlyFields(data.payload, new Set(['text']))) return failed('UNKNOWN_FIELD');
      if (typeof data.payload.text !== 'string') return failed('INVALID_TEXT');
      return [...data.payload.text].length > MAX_TEXT_SCALARS
        ? failed('TEXT_TOO_LONG')
        : { ok: true, value: data };
    }
    if (data.action === 'batch') {
      if (!hasOnlyFields(data.payload, new Set(['steps']))) return failed('UNKNOWN_FIELD');
      if (!Array.isArray(data.payload.steps) || data.payload.steps.length < 1) return failed('INVALID_BATCH');
      if (data.payload.steps.length > MAX_BATCH_STEPS) return failed('BATCH_TOO_LARGE');
      for (const step of data.payload.steps) {
        const code = validateKeyPayload(step);
        if (code) return failed(code);
      }
      return { ok: true, value: data };
    }

    if (!hasOnlyFields(data.payload, new Set(['reason']))) return failed('UNKNOWN_FIELD');
    return RESET_REASONS.has(data.payload.reason)
      ? { ok: true, value: data }
      : failed('INVALID_RESET_REASON');
  } catch (_error) {
    return failed('INVALID_ENVELOPE');
  }
}

function payloadByteLength(data) {
  try {
    const payload = isRecord(data) && data.payload ? data.payload : {};
    return Buffer.byteLength(JSON.stringify(payload), 'utf8');
  } catch (_error) {
    return 0;
  }
}

function summarizeRemoteInput(data) {
  try {
    const input = isRecord(data) ? data : {};
    return {
      action: ACTIONS.has(input.action) ? input.action : 'unknown',
      leaseEpoch: Number.isSafeInteger(input.leaseEpoch) ? input.leaseEpoch : 0,
      payloadBytes: payloadByteLength(input),
      schemaVersion: Number.isSafeInteger(input.schemaVersion) ? input.schemaVersion : 0,
      seq: Number.isSafeInteger(input.seq) ? input.seq : 0,
      type: input.type === 'keyboard' ? 'keyboard' : 'unknown',
    };
  } catch (_error) {
    return { action: 'unknown', leaseEpoch: 0, payloadBytes: 0, schemaVersion: 0, seq: 0, type: 'unknown' };
  }
}

module.exports = {
  validateRemoteInput,
  summarizeRemoteInput,
  MAX_TEXT_SCALARS,
  MAX_BATCH_STEPS,
};
