'use strict';

const { performance } = require('node:perf_hooks');
const { hashInputIds, validInputIds } = require('./input');
const crypto = require('node:crypto');

const MAX_ENTRIES = 32;
const TTL_MS = 10000;
const ACK_STATUSES = new Set([
  'applied', 'duplicate', 'stale-lease', 'sequence-gap', 'resync-required',
  'invalid-input', 'unsupported-code', 'execution-failed',
]);
const DURATION_SCOPE = 'signal-forward-to-host-ack-including-host';

function validViewer(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function hashAttempt(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128
    ? crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
    : null;
}

// Diagnostic correlation only. Call noteForwarded after the actual Host emit;
// neither observations nor failures here can authorize or route input.
function createResetAckObserver({
  now = () => performance.now(), onObservation, maxEntries = MAX_ENTRIES, ttlMs = TTL_MS,
} = {}) {
  const capacity = Number.isSafeInteger(maxEntries) && maxEntries > 0
    ? Math.min(MAX_ENTRIES, maxEntries) : MAX_ENTRIES;
  const lifetime = typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0
    ? Math.min(TTL_MS, ttlMs) : TTL_MS;
  const pending = new Map();

  function clockAndPrune() {
    let at;
    try { at = now(); } catch { pending.clear(); return null; }
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
      pending.clear();
      return null;
    }
    for (const [key, entry] of pending) {
      if (at < entry.startedAt || at - entry.startedAt >= lifetime) pending.delete(key);
    }
    return at;
  }

  function keyFor(viewer, id) {
    return JSON.stringify([viewer, id]);
  }

  function noteForwarded(data) {
    try {
      if (!data) return;
      const { schemaVersion, type, action, leaseEpoch: epoch, viewerId: viewer } = data;
      if (schemaVersion !== 2 || action !== 'reset'
        || !['keyboard', 'mouse'].includes(type)
        || !Number.isSafeInteger(epoch) || epoch < 1
        || !validViewer(viewer)) return;
      const ids = validInputIds(data.inputIds);
      if (!ids) return;
      const at = clockAndPrune();
      if (at === null) return;
      for (const id of ids) {
        const key = keyFor(viewer, id);
        // A duplicated pending forward cannot renew its age or change owner.
        if (pending.has(key)) continue;
        if (pending.size >= capacity) pending.delete(pending.keys().next().value);
        pending.set(key, {
          type, epoch, id, viewer, attemptHash: hashAttempt(data.connectionAttemptId), startedAt: at,
        });
      }
    } catch { /* Optional evidence must never affect the input path. */ }
  }

  function observeAck(data, outcome = {}) {
    try {
      if (!data) return;
      const viewer = data.viewerId;
      if (!validViewer(viewer)) return;
      const ids = validInputIds(data.inputIds);
      if (!ids) return;
      const at = clockAndPrune();
      if (at === null) return;
      const status = ACK_STATUSES.has(data.status) ? data.status : 'unknown';
      const flags = {
        targetAvailable: outcome?.targetAvailable === true,
        shapeValid: outcome?.shapeValid === true,
        forwarded: outcome?.forwarded === true,
      };
      const matches = [];
      for (const id of ids) {
        const key = keyFor(viewer, id);
        const entry = pending.get(key);
        if (!entry) continue;
        pending.delete(key);
        matches.push(entry);
      }
      // The first matched ACK outcome consumes each record, even when its
      // shape is invalid. Later same-ID ACKs do not create more observations.
      // Consume before callbacks, including a throwing or reentrant observer.
      for (const entry of matches) {
        try {
          if (typeof onObservation === 'function') onObservation({
            inputIdHash: hashInputIds([entry.id]),
            inputType: entry.type,
            leaseEpoch: entry.epoch,
            ...(entry.attemptHash ? { attemptHash: entry.attemptHash } : {}),
            status,
            ...flags,
            ackLeaseMatchesRequest: data.leaseEpoch === entry.epoch,
            ackTypeMatchesRequest: data.inputType === entry.type,
            signalRequestToAckMs: at - entry.startedAt,
            durationScope: DURATION_SCOPE,
          });
        } catch { /* A failed sink cannot block another match or the ACK. */ }
      }
    } catch { /* Malformed diagnostic input cannot affect ACK delivery. */ }
  }

  function pendingCount() {
    clockAndPrune();
    return pending.size;
  }

  return { noteForwarded, observeAck, pendingCount };
}

module.exports = { createResetAckObserver };
