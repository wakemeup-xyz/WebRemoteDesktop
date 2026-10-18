'use strict';
const { randomUUID } = require('node:crypto');

const VACANT_ONLY = 'vacant-only-v1';
function validSession(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value);
}

function contextError(context) {
  if (!context || !Number.isSafeInteger(context.viewerEpoch) || context.viewerEpoch < 0
      || typeof context.occupied !== 'boolean' || typeof context.relayOccupied !== 'boolean'
      || typeof context.hostOnline !== 'boolean') return 'admission-unavailable';
  if (context.occupied) return 'viewer-occupied';
  if (context.relayOccupied) return 'relay-occupied';
  if (!context.hostOnline) return 'host-unavailable';
  return null;
}

// One pinned owner/high-water mark survives socket removal and ticket expiry.
// Only expiring tickets occupy the bounded map; never evict live replay evidence.
function createViewerAdmission(options = {}) {
  const now = options.now || Date.now;
  const ttlMs = Math.max(1, Math.min(120000, Number(options.viewerAdmissionTtlMs) || 30000));
  const capacity = Math.max(1, Math.min(256, Number(options.maxViewerAdmissions) || 128));
  const tickets = new Map();
  let sequence = 0;
  let owner = null;
  let pristine = true;
  const isLive = (record, at) => record.expiresAt > at;
  const isPendingHuman = (record, at) => isLive(record, at) && !record.consumed && record.initialPolicy === null;
  const isRevocableGuard = (record, at) => isLive(record, at) && !record.consumed && record.initialPolicy === VACANT_ONLY;
  function cleanup(at) {
    for (const [key, record] of tickets) if (!isLive(record, at)) tickets.delete(key);
  }
  function guardError(context, at) {
    const error = contextError(context);
    if (error) return error;
    if (owner && owner.initialPolicy !== VACANT_ONLY) return 'human-owner-retained';
    for (const record of tickets.values()) if (isPendingHuman(record, at)) return 'human-intent-pending';
    return null;
  }
  function sameOwner(subject, session) {
    return owner && owner.subject === subject && owner.session === session;
  }
  function accepted() { return { ok: true, generation: owner.generation }; }
  return {
    issue(subject, session, { initialPolicy = null, context = null } = {}) {
      const at = now();
      if (!subject || !validSession(session)) return { error: 'invalid-session' };
      if (initialPolicy !== null && initialPolicy !== VACANT_ONLY) return { error: 'invalid-initial-policy' };
      const guarded = initialPolicy === VACANT_ONLY;
      if (guarded) {
        const error = guardError(context, at);
        if (error) return { error };
      }
      let liveSize = 0;
      for (const record of tickets.values()) {
        if (isLive(record, at) && (guarded || !isRevocableGuard(record, at))) liveSize += 1;
      }
      if (liveSize >= capacity) return { error: 'admission-capacity' };
      // No rejection below this point: human Start can revoke pending guards,
      // but live consumed records remain evidence even when capacity is full.
      cleanup(at);
      if (!guarded) {
        for (const [key, record] of tickets) if (isRevocableGuard(record, at)) tickets.delete(key);
        sequence += 1;
      }
      const ticket = randomUUID();
      const record = { subject, session, sequence, generation: randomUUID(), expiresAt: at + ttlMs,
        consumed: false, initialPolicy, viewerEpoch: guarded ? context.viewerEpoch : null };
      tickets.set(ticket, record);
      return { ticket, expiresAt: record.expiresAt };
    },
    admit({ subject, session, admission, occupied = false, sameSessionOccupancy = false, initialContext = null }) {
      const at = now();
      const reject = () => ({ ok: false, reason: 'explicit-reconnect-required' });
      if (!subject) return reject();
      if (admission?.mode === 'explicit') {
        const record = tickets.get(admission.ticket);
        if (!record || !isLive(record, at) || record.subject !== subject || record.session !== session) return reject();
        if (record.consumed) {
          // Lost welcome can retry only its original current generation. Its
          // initial vacancy gate was already spent; keep the recorded policy.
          return sameOwner(subject, session) && owner.generation === record.generation ? accepted() : reject();
        }
        // Only human issuance advances this high-water fence.
        if (record.sequence !== sequence) return reject();
        if (record.initialPolicy === VACANT_ONLY
            && (guardError(initialContext, at) || initialContext.viewerEpoch !== record.viewerEpoch)) return reject();
        record.consumed = true;
        pristine = false;
        owner = { subject, session, generation: record.generation, legacy: false, initialPolicy: record.initialPolicy };
        return accepted();
      }
      if (admission != null && admission.mode !== 'resume') return reject();
      if (sameOwner(subject, session) && validSession(session)
          && (!occupied || sameSessionOccupancy)
          && (admission == null ? owner.legacy : admission.generation === owner.generation)) return accepted();
      // Legacy compatibility: only the first unknown client of this server
      // lifetime, at zero Viewers. No history eviction can revive this branch.
      if (admission == null && pristine && !occupied) {
        pristine = false;
        owner = { subject, session: validSession(session) ? session : null, generation: randomUUID(),
          legacy: true, initialPolicy: null };
        return accepted();
      }
      return reject();
    },
    noteProofAdmission() {
      pristine = false;
      owner = null;
      sequence += 1;
      // Proofs remain separate one-use leases; old ordinary tickets/resumes
      // cannot follow a proof admission. A new human Start can still supersede.
      tickets.clear();
    },
  };
}
module.exports = { createViewerAdmission, validSession };
