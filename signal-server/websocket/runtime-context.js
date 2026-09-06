'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Per-server signaling state.  Keeping this state in an explicit object makes
 * tests and embedded servers independent without changing the legacy facade.
 */
function createRuntimeContext(options = {}) {
  const initialCapabilities = options.hostCapabilities || {};
  const now = options.now || Date.now;
  const proofAdmissionTtlMs = clampProofAdmissionTtl(options.proofAdmissionTtlMs);
  const maxProofAdmissions = clampProofAdmissionCapacity(options.maxProofAdmissions);
  const realm = String(options.realm || 'production');
  // Production preserves its existing human-first policy.  Disposable Lab
  // runtimes opt in and accept only the exact realm-bound one-use proof.
  const requireViewerProof = options.requireViewerProof === true;
  let hostCapabilities = normalizeCapabilities(initialCapabilities, false);
  let viewerEpoch = 0;
  const proofAdmissions = new Map();
  const connections = {
    host: null,
    viewers: new Map(),
    relayViewers: new Map(),
  };

  function cleanupExpiredProofAdmissions(timestamp = now()) {
    for (const [token, admission] of proofAdmissions) {
      if (admission.expiresAt <= timestamp) proofAdmissions.delete(token);
    }
  }

  function matchesProofAdmission(admission = {}) {
    const token = typeof admission.token === 'string' ? admission.token : '';
    const epoch = Number(admission.epoch);
    const issued = proofAdmissions.get(token);
    return Boolean(issued && Number.isSafeInteger(epoch) && epoch >= 0
      && issued.epoch === epoch && admission.realm === realm);
  }

  return {
    connections,
    requiresViewerProof() {
      return requireViewerProof;
    },
    getHostCapabilities() {
      return cloneCapabilities(hostCapabilities);
    },
    setHostCapabilities(payload = {}) {
      hostCapabilities = normalizeCapabilities(payload, true);
      return cloneCapabilities(hostCapabilities);
    },
    clearHostCapabilities() {
      hostCapabilities = normalizeCapabilities({}, false);
      return cloneCapabilities(hostCapabilities);
    },
    issueProofAdmission() {
      cleanupExpiredProofAdmissions();
      if (connections.viewers.size > 0) return null;
      if (proofAdmissions.size >= maxProofAdmissions) return null;
      const admission = { token: randomUUID(), epoch: viewerEpoch, expiresAt: now() + proofAdmissionTtlMs };
      proofAdmissions.set(admission.token, admission);
      return { token: admission.token, epoch: admission.epoch, realm };
    },
    hasProofAdmission(admission = {}) {
      cleanupExpiredProofAdmissions();
      return matchesProofAdmission(admission);
    },
    releaseProofAdmission(admission = {}) {
      cleanupExpiredProofAdmissions();
      if (!matchesProofAdmission(admission)) return false;
      proofAdmissions.delete(admission.token);
      return true;
    },
    admitProofViewer(admission = {}) {
      cleanupExpiredProofAdmissions();
      const token = String(admission.token || '');
      const epoch = Number(admission.epoch);
      const issued = proofAdmissions.get(token);
      // Realm is part of the proof identity for production and Lab alike.  A
      // swapped identity must not consume the original token; once identity
      // matches, consume before current-state checks to preserve one-use
      // semantics under a later human Viewer arrival.
      if (!issued || issued.epoch !== epoch || admission.realm !== realm) {
        return false;
      }
      proofAdmissions.delete(token);
      if (epoch !== viewerEpoch || connections.viewers.size > 0) return false;
      viewerEpoch += 1;
      return true;
    },
    noteHumanViewerAdmission() {
      viewerEpoch += 1;
      proofAdmissions.clear();
      return viewerEpoch;
    },
    viewerEpoch() {
      return viewerEpoch;
    },
    getViewerSnapshot() {
      return Array.from(connections.viewers.values()).map((socket) => ({
        id: socket.id,
        ip: socket.handshake?.address || 'unknown',
        userAgent: socket.handshake?.headers?.['user-agent'] || 'unknown',
      }));
    },
  };
}

function clampProofAdmissionTtl(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(120000, Math.floor(parsed))) : 30000;
}

function clampProofAdmissionCapacity(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(128, Math.floor(parsed))) : 32;
}

function normalizeTurnServerIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function normalizeCapabilities(payload = {}, timestamped) {
  return {
    turnReady: Boolean(payload.turnReady),
    turnFingerprint: String(payload.turnFingerprint || '').trim(),
    supportsSessionTurn: Boolean(payload.supportsSessionTurn),
    supportsMultiTurn: Boolean(payload.supportsMultiTurn),
    turnServerId: String(payload.turnServerId || payload.selectedTurnServerId || '').trim(),
    defaultTurnServerId: String(payload.defaultTurnServerId || '').trim(),
    turnServerIds: normalizeTurnServerIds(payload.turnServerIds),
    updatedAt: timestamped ? new Date().toISOString() : (payload.updatedAt || null),
  };
}

function cloneCapabilities(value) {
  return { ...value, turnServerIds: value.turnServerIds.slice() };
}

module.exports = { createRuntimeContext };
