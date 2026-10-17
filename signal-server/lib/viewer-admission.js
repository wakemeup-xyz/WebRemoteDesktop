'use strict';
const { randomUUID } = require('node:crypto');

function validSession(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value);
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
  function cleanup() {
    for (const [key, record] of tickets) if (record.expiresAt <= now()) tickets.delete(key);
  }
  function sameOwner(subject, session) {
    return owner && owner.subject === subject && owner.session === session;
  }
  function accepted() { return { ok: true, generation: owner.generation }; }
  return {
    issue(subject, session) {
      cleanup();
      if (!subject || !validSession(session)) return { error: 'invalid-session' };
      if (tickets.size >= capacity) return { error: 'admission-capacity' };
      const ticket = randomUUID();
      const record = { subject, session, sequence: ++sequence, generation: randomUUID(), expiresAt: now() + ttlMs, consumed: false };
      tickets.set(ticket, record);
      return { ticket, expiresAt: record.expiresAt };
    },
    admit({ subject, session, admission, occupied = false, sameSessionOccupancy = false }) {
      cleanup();
      const reject = () => ({ ok: false, reason: 'explicit-reconnect-required' });
      if (!subject) return reject();
      if (admission?.mode === 'explicit') {
        const record = tickets.get(admission.ticket);
        if (!record || record.subject !== subject || record.session !== session) return reject();
        if (record.consumed) {
          // Lost welcome can retry only its original current generation.
          return sameOwner(subject, session) && owner.generation === record.generation ? accepted() : reject();
        }
        // Issuance order prevents a slow older Start overtaking a later Start.
        if (record.sequence !== sequence) return reject();
        record.consumed = true;
        pristine = false;
        owner = { subject, session, generation: record.generation, legacy: false };
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
        owner = { subject, session: validSession(session) ? session : null, generation: randomUUID(), legacy: true };
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
