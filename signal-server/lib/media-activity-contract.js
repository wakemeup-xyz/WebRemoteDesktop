'use strict';

const ALLOWED_STATES = new Set(['active', 'suspended']);
const ALLOWED_REASONS = new Set([
  'manual-pause',
  'terminal-active',
  'page-hidden',
  'page-hide',
  'page-freeze',
  'disconnected',
]);
const ALLOWED_FIELDS = new Set([
  'schemaVersion',
  'state',
  'reasons',
  'generation',
  'connectionAttemptId',
  'leaseId',
  'leaseEpoch',
]);
const MAX_REASONS = 8;
const MAX_REASON_LENGTH = 32;
const MAX_ATTEMPT_ID_LENGTH = 128;
const MAX_LEASE_ID_LENGTH = 128;

function failed(code) {
  return { ok: false, code };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateMediaActivityRequest(data) {
  try {
    if (!isRecord(data)) return failed('INVALID_ENVELOPE');
    const keys = Object.keys(data);
    if (keys.length === 0) return failed('INVALID_ENVELOPE');
    if (!keys.every((field) => ALLOWED_FIELDS.has(field))) return failed('UNKNOWN_FIELD');
    if (data.schemaVersion !== 1) return failed('INVALID_SCHEMA_VERSION');
    if (!ALLOWED_STATES.has(data.state)) return failed('INVALID_STATE');
    if (!Array.isArray(data.reasons) || data.reasons.length > MAX_REASONS) {
      return failed('INVALID_REASONS');
    }
    for (const reason of data.reasons) {
      if (typeof reason !== 'string'
        || reason.length === 0
        || reason.length > MAX_REASON_LENGTH
        || !ALLOWED_REASONS.has(reason)) {
        return failed('INVALID_REASONS');
      }
    }
    // Deduplicate while preserving order.
    const reasons = [];
    for (const reason of data.reasons) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
    if (!Number.isSafeInteger(data.generation) || data.generation < 1) {
      return failed('INVALID_GENERATION');
    }
    if (typeof data.connectionAttemptId !== 'string'
      || data.connectionAttemptId.length < 1
      || data.connectionAttemptId.length > MAX_ATTEMPT_ID_LENGTH
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(data.connectionAttemptId)) {
      return failed('INVALID_CONNECTION_ATTEMPT_ID');
    }
    if (typeof data.leaseId !== 'string'
      || data.leaseId.length < 16
      || data.leaseId.length > MAX_LEASE_ID_LENGTH) {
      return failed('INVALID_LEASE_ID');
    }
    if (!Number.isSafeInteger(data.leaseEpoch) || data.leaseEpoch < 1) {
      return failed('INVALID_LEASE_EPOCH');
    }

    return {
      ok: true,
      value: {
        schemaVersion: 1,
        state: data.state,
        reasons,
        generation: data.generation,
        connectionAttemptId: data.connectionAttemptId,
        leaseId: data.leaseId,
        leaseEpoch: data.leaseEpoch,
      },
    };
  } catch {
    return failed('INVALID_ENVELOPE');
  }
}

function summarizeMediaActivity(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    schemaVersion: value.schemaVersion,
    state: value.state,
    reasons: Array.isArray(value.reasons) ? value.reasons.slice(0, MAX_REASONS) : [],
    generation: value.generation,
    connectionAttemptId: value.connectionAttemptId,
    leaseEpoch: value.leaseEpoch,
    // leaseId intentionally omitted from summaries/logs
  };
}

module.exports = {
  validateMediaActivityRequest,
  summarizeMediaActivity,
  ALLOWED_STATES,
  ALLOWED_REASONS,
};
