'use strict';

/**
 * Per-server signaling state.  Keeping this state in an explicit object makes
 * tests and embedded servers independent without changing the legacy facade.
 */
function createRuntimeContext(options = {}) {
  const initialCapabilities = options.hostCapabilities || {};
  let hostCapabilities = normalizeCapabilities(initialCapabilities, false);
  const connections = {
    host: null,
    viewers: new Map(),
    relayViewers: new Map(),
  };

  return {
    connections,
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
    getViewerSnapshot() {
      return Array.from(connections.viewers.values()).map((socket) => ({
        id: socket.id,
        ip: socket.handshake?.address || 'unknown',
        userAgent: socket.handshake?.headers?.['user-agent'] || 'unknown',
      }));
    },
  };
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
