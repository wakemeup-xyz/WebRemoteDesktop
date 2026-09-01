'use strict';

const MAX_TEXT_SCALARS = 4096;
const MAX_BATCH_STEPS = 16;
const MAX_INPUT_IDS = 64;
const MAX_INPUT_ID_LENGTH = 128;

const ENVELOPE_FIELDS = new Set([
  'schemaVersion', 'type', 'action', 'leaseId', 'leaseEpoch', 'seq', 'inputIds', 'payload',
]);
const KEY_FIELDS = new Set(['phase', 'code', 'location', 'repeat', 'modifiers', 'locks']);
const MODIFIER_FIELDS = new Set(['altKey', 'ctrlKey', 'metaKey', 'shiftKey']);
const LOCK_FIELDS = new Set(['capsLock']);
const ACTIONS = new Set(['key', 'text', 'batch', 'reset']);
const MOUSE_ACTIONS = new Set(['down', 'up', 'move', 'wheel', 'reset']);
const COMMAND_ACTIONS = new Set(['showDock', 'switchInputMethod']);
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

function validateInputIds(inputIds) {
  if (inputIds === undefined) return 'MISSING_INPUT_IDS';
  if (!Array.isArray(inputIds) || inputIds.length < 1 || inputIds.length > MAX_INPUT_IDS) {
    return 'INVALID_INPUT_IDS';
  }
  return inputIds.every((inputId) => typeof inputId === 'string'
    && inputId.length > 0
    && inputId.length <= MAX_INPUT_ID_LENGTH
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(inputId))
    ? null
    : 'INVALID_INPUT_IDS';
}

function accepted(data) {
  const inputIdError = validateInputIds(data.inputIds);
  return inputIdError ? failed(inputIdError) : { ok: true, value: data };
}

function validateDesktopEnvelope(data) {
  if (!isRecord(data)) return failed('INVALID_ENVELOPE');
  if (!hasOnlyFields(data, ENVELOPE_FIELDS)) return failed('UNKNOWN_FIELD');
  if (data.schemaVersion !== 2) return failed('INVALID_SCHEMA_VERSION');
  if (!['mouse', 'command'].includes(data.type)) return failed('INVALID_TYPE');
  if (typeof data.leaseId !== 'string' || data.leaseId.length < 16) return failed('INVALID_LEASE_ID');
  if (!Number.isSafeInteger(data.leaseEpoch) || data.leaseEpoch < 1) return failed('INVALID_LEASE_EPOCH');
  if (!isRecord(data.payload)) return failed('INVALID_PAYLOAD');
  const inputIdError = validateInputIds(data.inputIds);
  return inputIdError ? failed(inputIdError) : null;
}

function isPoint(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateDesktopWrite(data) {
  try {
    const envelope = validateDesktopEnvelope(data);
    if (envelope) return envelope;
    const unorderedMove = data.type === 'mouse' && data.action === 'move';
    if (unorderedMove ? data.seq !== undefined : !Number.isSafeInteger(data.seq) || data.seq < 1) {
      return failed(unorderedMove ? 'UNEXPECTED_SEQ' : 'INVALID_SEQ');
    }
    if (data.type === 'command') {
      if (!COMMAND_ACTIONS.has(data.action)) return failed('UNKNOWN_ACTION');
      return Object.keys(data.payload).length === 0 ? { ok: true, value: data } : failed('UNKNOWN_FIELD');
    }
    if (!MOUSE_ACTIONS.has(data.action)) return failed('UNKNOWN_ACTION');
    const payload = data.payload;
    const allowed = data.action === 'reset' ? new Set(['reason'])
      : data.action === 'wheel' ? new Set(['relX', 'relY', 'deltaX', 'deltaY'])
        : data.action === 'move' ? new Set(['relX', 'relY', 'buttons'])
          : new Set(['relX', 'relY', 'button', 'clickCount', 'buttons']);
    if (!hasOnlyFields(payload, allowed)) {
      return failed('INVALID_PAYLOAD');
    }
    if (data.action === 'reset') {
      return typeof payload.reason === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(payload.reason)
        ? { ok: true, value: data } : failed('INVALID_RESET_REASON');
    }
    if (!isPoint(payload.relX) || !isPoint(payload.relY)) return failed('INVALID_PAYLOAD');
    if (data.action === 'wheel') {
      return Number.isFinite(payload.deltaX) && Number.isFinite(payload.deltaY)
        ? { ok: true, value: data } : failed('INVALID_PAYLOAD');
    }
    if (data.action === 'move') {
      return Number.isInteger(payload.buttons) && payload.buttons >= 0 && payload.buttons <= 7
        ? { ok: true, value: data } : failed('INVALID_PAYLOAD');
    }
    return ['left', 'middle', 'right'].includes(payload.button)
      && Number.isInteger(payload.clickCount) && payload.clickCount >= 1 && payload.clickCount <= 3
      && Number.isInteger(payload.buttons) && payload.buttons >= 0 && payload.buttons <= 7
      ? { ok: true, value: data } : failed('INVALID_PAYLOAD');
  } catch (_error) {
    return failed('INVALID_ENVELOPE');
  }
}

function validateRemoteInput(data) {
  try {
    if (data?.type === 'mouse' || data?.type === 'command') return validateDesktopWrite(data);
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
      return code ? failed(code) : accepted(data);
    }
    if (data.action === 'text') {
      if (!hasOnlyFields(data.payload, new Set(['text']))) return failed('UNKNOWN_FIELD');
      if (typeof data.payload.text !== 'string') return failed('INVALID_TEXT');
      return [...data.payload.text].length > MAX_TEXT_SCALARS ? failed('TEXT_TOO_LONG') : accepted(data);
    }
    if (data.action === 'batch') {
      if (!hasOnlyFields(data.payload, new Set(['steps']))) return failed('UNKNOWN_FIELD');
      if (!Array.isArray(data.payload.steps) || data.payload.steps.length < 1) return failed('INVALID_BATCH');
      if (data.payload.steps.length > MAX_BATCH_STEPS) return failed('BATCH_TOO_LARGE');
      for (const step of data.payload.steps) {
        const code = validateKeyPayload(step);
        if (code) return failed(code);
      }
      return accepted(data);
    }

    if (!hasOnlyFields(data.payload, new Set(['reason']))) return failed('UNKNOWN_FIELD');
    return RESET_REASONS.has(data.payload.reason) ? accepted(data) : failed('INVALID_RESET_REASON');
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
  validateDesktopWrite,
  summarizeRemoteInput,
  MAX_TEXT_SCALARS,
  MAX_BATCH_STEPS,
  MAX_INPUT_IDS,
};
