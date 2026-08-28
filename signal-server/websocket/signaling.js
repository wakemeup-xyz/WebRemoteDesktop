const { loadConfig } = require('../lib/config');
const { verifyAccessToken } = require('../lib/auth');
const { ingestDiagnosticPayload } = require('../lib/diagnostic');
const { DesktopControlLease } = require('../lib/desktop-control-lease');
const { ControlTransitionRetry } = require('../lib/control-transition-retry');
const { validateRemoteInput, summarizeRemoteInput } = require('../lib/remote-input-contract');
const {
  validateMediaActivityRequest,
  summarizeMediaActivity,
} = require('../lib/media-activity-contract');

// Kept deliberately static during the protocol migration. Do not add an
// environment override: deployment must not silently re-enable v1 after its
// documented removal criteria are met.
const LEGACY_INPUT_COMPAT_ENABLED = true;
const V2_INPUT_ACK_STATUSES = new Set([
  'applied',
  'duplicate',
  'stale-lease',
  'sequence-gap',
  'resync-required',
  'invalid-input',
  'unsupported-code',
  'execution-failed',
]);

// Store connections
const connections = {
  host: null,
  viewers: new Map(),
  relayViewers: new Map()
};

// Last host-reported TURN/media capability snapshot (no secrets).
let hostCapabilities = {
  turnReady: false,
  turnFingerprint: '',
  supportsSessionTurn: false,
  supportsMultiTurn: false,
  turnServerId: '',
  defaultTurnServerId: '',
  turnServerIds: [],
  updatedAt: null,
};

function normalizeTurnServerIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    const id = String(item || '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function getHostCapabilities() {
  return {
    turnReady: Boolean(hostCapabilities.turnReady),
    turnFingerprint: String(hostCapabilities.turnFingerprint || ''),
    supportsSessionTurn: Boolean(hostCapabilities.supportsSessionTurn),
    supportsMultiTurn: Boolean(hostCapabilities.supportsMultiTurn),
    turnServerId: String(hostCapabilities.turnServerId || ''),
    defaultTurnServerId: String(hostCapabilities.defaultTurnServerId || ''),
    turnServerIds: Array.isArray(hostCapabilities.turnServerIds)
      ? hostCapabilities.turnServerIds.slice()
      : [],
    updatedAt: hostCapabilities.updatedAt,
  };
}

function setHostCapabilities(payload = {}) {
  hostCapabilities = {
    turnReady: Boolean(payload.turnReady),
    turnFingerprint: String(payload.turnFingerprint || '').trim(),
    supportsSessionTurn: Boolean(payload.supportsSessionTurn),
    supportsMultiTurn: Boolean(payload.supportsMultiTurn),
    turnServerId: String(payload.turnServerId || payload.selectedTurnServerId || '').trim(),
    defaultTurnServerId: String(payload.defaultTurnServerId || '').trim(),
    turnServerIds: normalizeTurnServerIds(payload.turnServerIds),
    updatedAt: new Date().toISOString(),
  };
  return getHostCapabilities();
}

function clearHostCapabilities() {
  hostCapabilities = {
    turnReady: false,
    turnFingerprint: '',
    supportsSessionTurn: false,
    supportsMultiTurn: false,
    turnServerId: '',
    defaultTurnServerId: '',
    turnServerIds: [],
    updatedAt: null,
  };
  return getHostCapabilities();
}

function getViewerSnapshot() {
  return Array.from(connections.viewers.values()).map((viewerSocket) => ({
    id: viewerSocket.id,
    ip: viewerSocket.handshake.address || 'unknown',
    userAgent: viewerSocket.handshake.headers['user-agent'] || 'unknown'
  }));
}

function emitViewerStatus(reason, viewerSocket = null) {
  const payload = {
    reason,
    onlineCount: connections.viewers.size,
    viewers: getViewerSnapshot(),
    changedViewer: viewerSocket ? {
      id: viewerSocket.id,
      ip: viewerSocket.handshake.address || 'unknown',
      userAgent: viewerSocket.handshake.headers['user-agent'] || 'unknown'
    } : null
  };

  if (connections.host) {
    connections.host.emit('viewer-status', payload);
  }
}

function verifyToken(token) {
  try {
    return verifyAccessToken(token);
  } catch {
    return null;
  }
}

function isActiveViewerSocket(socket) {
  return connections.viewers.get(socket.id) === socket;
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function setupSignaling(io, options = {}) {
  const config = options.config || loadConfig();
  const logger = options.logger || console;
  const recentEventStore = options.recentEventStore || null;
  const structuredLogger = options.structuredLogger || null;
  const desktopLease = options.desktopControlLease || new DesktopControlLease({
    now: options.now || Date.now,
    makeLeaseId: options.makeLeaseId || (() => `lease-${require('node:crypto').randomUUID()}`),
  });
  const pendingOffers = new Map();
  const pendingInputs = new Map();
  let pendingControllerProtocolVersion = null;
  let legacyControllerViewerId = null;
  const legacyRelayCompanionByOwner = new Map();
  const legacyRelayOwnerIds = new Set();

  function clearPendingInputs(viewerId = null) {
    if (viewerId === null) pendingInputs.clear();
    else pendingInputs.delete(viewerId);
  }

  const intervalFactory = options.scheduler?.setInterval || options.setInterval || setInterval;
  const setTimeoutFn = options.scheduler?.setTimeout || options.setTimeout || setTimeout;
  const clearTimeoutFn = options.scheduler?.clearTimeout || options.clearTimeout || clearTimeout;
  const interval = intervalFactory(() => {
    dispatchLeaseEffect(desktopLease.expire());
  }, 1000);
  interval?.unref?.();

  const resetRetry = options.controlTransitionRetry || new ControlTransitionRetry({
    setTimeoutFn,
    clearTimeoutFn,
  });
  // viewerId -> {
  //   connectionAttemptId,
  //   connectionAttemptSequence, // monotonic authority epoch for attempt rebinding
  //   generation,                // last accepted media generation for this attempt
  // }
  // Attempt binding and generation progress share one record, but applied:false only
  // releases generation progress — never deletes the authoritative attempt bind.
  const mediaActivityProgress = new Map();

  function emitControlEvent(type, fields = {}) {
    const payload = {
      type,
      ...fields,
    };
    // Bounded non-secret fields only — never lease tokens, input, SDP, candidates.
    if (structuredLogger && typeof structuredLogger.info === 'function') {
      structuredLogger.info(payload);
    }
    recentEventStore?.append?.(payload);
  }

  function isResetOnlyPending(snapshot = controlSnapshot()) {
    return snapshot.state === 'REVOKING' && snapshot.pendingViewerId === null
      && Number.isSafeInteger(snapshot.leaseEpoch);
  }

  function cancelResetRetry() {
    resetRetry.cancel();
  }

  function reemitResetOnlyTransition(leaseEpoch, attempt = 0) {
    if (!connections.host || !Number.isSafeInteger(leaseEpoch)) return false;
    const hostTransition = desktopLease.transitionForHost({ leaseEpoch });
    // Only re-emit tokenless reset-only barriers (no viewerId/leaseId).
    if (!hostTransition || hostTransition.viewerId != null || hostTransition.leaseId) return false;
    const reason = hostTransition.reason || 'reset-retry';
    connections.host.emit('control-transition', {
      type: 'control-transition',
      leaseEpoch,
      reason,
    });
    emitControlEvent('control_reset_retry', {
      leaseEpoch,
      attempt,
      reason,
    });
    return true;
  }

  function startResetRetry(leaseEpoch, reason = 'transition-failed') {
    if (!Number.isSafeInteger(leaseEpoch)) return;
    if (!isResetOnlyPending()) return;
    resetRetry.start({
      leaseEpoch,
      onRetry: ({ leaseEpoch: epoch, attempt }) => {
        const snapshot = desktopLease.snapshot();
        if (snapshot.state !== 'REVOKING' || snapshot.pendingViewerId !== null
          || snapshot.leaseEpoch !== epoch) {
          cancelResetRetry();
          return;
        }
        reemitResetOnlyTransition(epoch, attempt);
      },
      onBlocked: ({ leaseEpoch: epoch, attempt }) => {
        const snapshot = desktopLease.snapshot();
        if (snapshot.state !== 'REVOKING' || snapshot.pendingViewerId !== null
          || snapshot.leaseEpoch !== epoch) {
          return;
        }
        emitControlEvent('control_reset_blocked', {
          leaseEpoch: epoch,
          attempt,
          reason: 'reset-blocked',
        });
        broadcastControlState('reset-blocked');
      },
    });
    emitControlEvent('control_transition_failed_closed', {
      leaseEpoch,
      reason,
    });
  }

  function controlSnapshot() {
    return withLeaseExpiry(() => desktopLease.snapshot());
  }

  // Expiry is advanced only through this wrapper. Lease accessors themselves
  // never begin an unobservable reset transition, and every REVOKING effect
  // reaches the Host through dispatchLeaseEffect below.
  function withLeaseExpiry(operation) {
    dispatchLeaseEffect(desktopLease.expire());
    return operation();
  }

  function hostInputProtocolVersion() {
    return connections.host?.inputProtocolVersion === 2 ? 2 : 1;
  }

  function hostSupportsV2Input() {
    return connections.host !== null && hostInputProtocolVersion() === 2;
  }

  function v2ProtocolError(socket) {
    return socket.inputProtocolVersion === 2 ? 'host-protocol-too-old' : 'viewer-protocol-too-old';
  }

  function rememberPendingController(protocolVersion) {
    pendingControllerProtocolVersion = protocolVersion === 2 ? 2 : 1;
  }

  function annotateLegacyTakeover(effect, previousController) {
    if (effect?.transition
      && legacyControllerViewerId === previousController
      && pendingControllerProtocolVersion === 2) {
      effect.transition.reason = 'legacy-takeover';
    }
  }

  function legacyRelayOwnerForCompanion(companionId) {
    for (const [ownerId, boundCompanionId] of legacyRelayCompanionByOwner) {
      if (boundCompanionId === companionId) return ownerId;
    }
    return null;
  }

  function hasActiveLegacyRelayOwner(ownerId) {
    const snapshot = controlSnapshot();
    return Boolean(ownerId
      && connections.viewers.size === 1
      && legacyControllerViewerId === ownerId
      && snapshot.state === 'ACTIVE'
      && snapshot.controllerViewerId === ownerId
      && connections.viewers.has(ownerId));
  }

  function bindLegacyRelayCompanion(companionId) {
    const ownerId = legacyControllerViewerId;
    if (!hasActiveLegacyRelayOwner(ownerId)) return null;
    const existingCompanionId = legacyRelayCompanionByOwner.get(ownerId);
    if (existingCompanionId && existingCompanionId !== companionId) return null;
    legacyRelayCompanionByOwner.set(ownerId, companionId);
    return ownerId;
  }

  function clearLegacyRelayCompanion(ownerId, { stop = false } = {}) {
    if (!ownerId || !legacyRelayCompanionByOwner.delete(ownerId) || !stop || !connections.host) return;
    connections.host.emit('relay-stream-control', { enabled: false, viewerId: ownerId });
  }

  function clearAllLegacyRelayCompanions({ stop = false } = {}) {
    [...legacyRelayCompanionByOwner.keys()].forEach((ownerId) => {
      clearLegacyRelayCompanion(ownerId, { stop });
    });
  }

  function broadcastControlState(reason = null) {
    const snapshot = controlSnapshot();
    connections.viewers.forEach((viewerSocket) => {
      viewerSocket.emit('control-state', {
        ...snapshot,
        controller: snapshot.controllerViewerId === viewerSocket.id,
        reason,
      });
    });
  }

  // Single cleanup entry for desktop viewers. Map identity guard is the only
  // idempotency latch (compatible with FakeSocket; no socket.data required).
  function removeDesktopViewer(socket, reason = 'viewer-disconnected') {
    if (!socket) return null;
    if (connections.viewers.get(socket.id) !== socket) return null;
    connections.viewers.delete(socket.id);
    clearPendingInputs(socket.id);
    mediaActivityProgress.delete(socket.id);
    pendingOffers.delete(socket.id);
    const leaseResult = withLeaseExpiry(() => desktopLease.viewerDisconnected(socket.id));
    clearLegacyRelayCompanion(socket.id, { stop: true });
    legacyRelayOwnerIds.delete(socket.id);
    if (legacyControllerViewerId === socket.id) legacyControllerViewerId = null;
    if (leaseResult.state === 'FREE') pendingControllerProtocolVersion = null;
    // ACTIVE disconnect must go through the formal DesktopControlLease
    // reset-only barrier (dispatchLeaseEffect). Never bypass with a
    // side-channel sendControlTransition after FREE.
    if (leaseResult.transition) {
      dispatchLeaseEffect(leaseResult, leaseResult.reason || reason);
    } else {
      broadcastControlState(leaseResult.reason || reason);
    }
    emitViewerStatus('viewer-disconnected', socket);
    socket._wrdRemoved = true;
    return leaseResult;
  }

  function supersedeOtherDesktopViewers(incoming) {
    const others = [...connections.viewers.entries()].filter(([id]) => id !== incoming.id);
    for (const [id, other] of others) {
      try {
        other.emit('viewer-superseded', {
          reason: 'single-desktop-viewer',
          bySocketId: incoming.id,
          ts: Date.now(),
        });
      } catch (_e) {
        // Best-effort notify; transport close is the fallback.
      }
      console.log(`[VIEWER] supersede desktop viewer old=${id} by=${incoming.id}`);
      removeDesktopViewer(other, 'viewer-superseded');
      try {
        other.disconnect(true);
      } catch (_e) {
        // Ignore sockets that already closed.
      }
    }
  }

  function sendControlTransition(effect) {
    if (!effect || !connections.host || !effect.transition) return false;
    const hostTransition = desktopLease.transitionForHost({
      leaseEpoch: effect.transition.leaseEpoch,
    });
    connections.host.emit('control-transition', {
      ...hostTransition,
      ...effect.transition,
    });
    return true;
  }

  function dispatchLeaseEffect(effect, reason = effect?.reason) {
    if (!effect || (!effect.reason && !effect.transition)) return false;
    const snapshotAfter = (() => {
      // Prefer lease snapshot after the mutation that produced this effect.
      return desktopLease.snapshot();
    })();
    const resetOnlyBarrier = effect.state === 'REVOKING'
      && snapshotAfter.pendingViewerId === null;
    if (effect.state === 'FREE' || resetOnlyBarrier) {
      clearPendingInputs();
      pendingControllerProtocolVersion = null;
      legacyControllerViewerId = null;
      clearAllLegacyRelayCompanions({ stop: true });
    }
    if (effect.state === 'FREE') {
      cancelResetRetry();
    }
    broadcastControlState(reason);
    sendControlTransition(effect);
    if (resetOnlyBarrier && Number.isSafeInteger(snapshotAfter.leaseEpoch)) {
      // Candidate failures produce a fresh reset-only transition; reset-only
      // failures stay on the same epoch. Both need bounded recovery retries.
      startResetRetry(snapshotAfter.leaseEpoch, reason || effect.reason || 'transition-failed');
    }
    return true;
  }

  function sendGrant(viewerId, lease) {
    const viewerSocket = connections.viewers.get(viewerId);
    if (!viewerSocket || !lease) return;
    viewerSocket.emit('control-grant', { controller: true, ...lease });
    broadcastControlState('granted');
  }

  function authorizeViewer(socket, data = {}, { legacy = true } = {}) {
    if (data && data.schemaVersion === 2) {
      return withLeaseExpiry(() => desktopLease.authorize({
        viewerId: socket.id,
        leaseId: data.leaseId,
        leaseEpoch: data.leaseEpoch,
      }));
    }
    if (!legacy) {
      const snapshot = withLeaseExpiry(() => desktopLease.snapshot());
      return snapshot.state === 'ACTIVE' && snapshot.controllerViewerId === socket.id;
    }
    return legacy;
  }
  function isValidConnectionAttemptId(value) {
    return typeof value === 'string'
      && value.length >= 1
      && value.length <= 128
      && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
  }

  function isValidConnectionAttemptSequence(value) {
    return Number.isSafeInteger(value) && value >= 1;
  }

  function resolveConnectionAttemptSequence(viewerId, connectionAttemptId, requestedSequence) {
    const prior = mediaActivityProgress.get(viewerId);
    if (isValidConnectionAttemptSequence(requestedSequence)) {
      return requestedSequence;
    }
    // Legacy offer/media without sequence: same attempt keeps sequence; new attempt
    // advances monotonically so random attempt ids alone cannot rebind authority.
    if (prior && prior.connectionAttemptId === connectionAttemptId) {
      return isValidConnectionAttemptSequence(prior.connectionAttemptSequence)
        ? prior.connectionAttemptSequence
        : 1;
    }
    const priorSequence = isValidConnectionAttemptSequence(prior?.connectionAttemptSequence)
      ? prior.connectionAttemptSequence
      : 0;
    return priorSequence + 1;
  }

  function bindViewerConnectionAttempt(viewerId, connectionAttemptId, requestedSequence) {
    if (!viewerId || !isValidConnectionAttemptId(connectionAttemptId)) {
      return { ok: false, reason: 'invalid-attempt' };
    }
    const sequence = resolveConnectionAttemptSequence(
      viewerId,
      connectionAttemptId,
      requestedSequence,
    );
    if (!isValidConnectionAttemptSequence(sequence)) {
      return { ok: false, reason: 'invalid-sequence' };
    }
    const prior = mediaActivityProgress.get(viewerId);
    const priorSequence = isValidConnectionAttemptSequence(prior?.connectionAttemptSequence)
      ? prior.connectionAttemptSequence
      : 0;
    if (prior && sequence < priorSequence) {
      return { ok: false, reason: 'stale-sequence' };
    }
    if (prior && sequence === priorSequence) {
      if (prior.connectionAttemptId !== connectionAttemptId) {
        return { ok: false, reason: 'stale-sequence' };
      }
      // Idempotent same sequence + same attempt.
      return {
        ok: true,
        bound: false,
        connectionAttemptId,
        connectionAttemptSequence: sequence,
        generation: Number.isSafeInteger(prior.generation) ? prior.generation : 0,
      };
    }
    mediaActivityProgress.set(viewerId, {
      connectionAttemptId,
      connectionAttemptSequence: sequence,
      generation: 0,
    });
    return {
      ok: true,
      bound: true,
      connectionAttemptId,
      connectionAttemptSequence: sequence,
      generation: 0,
    };
  }

  function currentViewerConnectionAttempt(viewerId) {
    const prior = mediaActivityProgress.get(viewerId);
    return prior && isValidConnectionAttemptId(prior.connectionAttemptId)
      ? prior.connectionAttemptId
      : null;
  }

  function releaseRejectedMediaProgress(viewerId, data = {}) {
    if (data.applied === true || !viewerId) return;
    const prior = mediaActivityProgress.get(viewerId);
    if (!prior) return;
    if (prior.connectionAttemptId !== data.connectionAttemptId) return;
    if (!Number.isSafeInteger(data.generation) || prior.generation !== data.generation) return;
    // Host applied:false only reopens this generation for one bounded replay.
    // Never delete the authoritative attempt bind — otherwise the next arbitrary
    // attempt id would become truth.
    prior.generation = Math.max(0, data.generation - 1);
  }

  function noteMediaGenerationProgress(viewerId, connectionAttemptId, generation) {
    const prior = mediaActivityProgress.get(viewerId);
    if (!prior || prior.connectionAttemptId !== connectionAttemptId) return false;
    if (!Number.isSafeInteger(generation) || generation < 1) return false;
    prior.generation = generation;
    return true;
  }

  function emitHostConnectionAttemptBind(viewerId, bindResult, lease = {}) {
    if (!connections.host || !bindResult?.ok) return;
    connections.host.emit('connection-attempt-bind', {
      schemaVersion: 1,
      viewerId,
      connectionAttemptId: bindResult.connectionAttemptId,
      connectionAttemptSequence: bindResult.connectionAttemptSequence,
      leaseId: typeof lease.leaseId === 'string' ? lease.leaseId : undefined,
      leaseEpoch: Number.isSafeInteger(lease.leaseEpoch) ? lease.leaseEpoch : undefined,
      networkMode: typeof lease.networkMode === 'string' ? lease.networkMode : undefined,
    });
  }

  function forwardOffer(socket, data) {
    if (!connections.host) return false;
    const networkMode = String(data.networkMode || data.iceMode || '').trim();
    const turnServerId = String(data.turnServerId || data.turn_server_id || '').trim();
    const forwarded = {
      offer: data.offer,
      viewerId: socket.id,
      epoch: data.epoch,
      leaseEpoch: data.schemaVersion === 2 ? data.leaseEpoch : controlSnapshot().leaseEpoch,
    };
    // v2 offers have already passed authorizeViewer(), so this opaque token
    // is safe to forward solely to the Host for its direct DataChannel binding.
    if (data.schemaVersion === 2) {
      if (!isValidConnectionAttemptId(data.connectionAttemptId)) return false;
      const bindResult = bindViewerConnectionAttempt(
        socket.id,
        data.connectionAttemptId,
        data.connectionAttemptSequence,
      );
      if (!bindResult.ok) return false;
      forwarded.leaseId = data.leaseId;
      forwarded.connectionAttemptId = data.connectionAttemptId;
      forwarded.connectionAttemptSequence = bindResult.connectionAttemptSequence;
    }
    if (networkMode) {
      forwarded.networkMode = networkMode;
      forwarded.iceMode = networkMode;
    }
    if (turnServerId) {
      forwarded.turnServerId = turnServerId;
    }
    const width = Number(data.width);
    const height = Number(data.height);
    if (Number.isFinite(width) && width > 0) {
      forwarded.width = clampInt(width, 320, 1920, 1280);
    }
    if (Number.isFinite(height) && height > 0) {
      forwarded.height = clampInt(height, 180, 1080, 720);
    }
    connections.host.emit('offer', forwarded);
    return true;
  }
  // Use default namespace for all connections
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    const decoded = verifyToken(token);
    if (!decoded) {
      return next(new Error('Invalid token'));
    }
    socket.user = decoded;
    socket.inputProtocolVersion = Number.parseInt(socket.handshake.auth?.inputProtocolVersion, 10) === 2 ? 2 : 1;
    const claimedRole = socket.handshake.auth?.role;
    socket.userRole = decoded.role === 'viewer' && claimedRole === 'relay-viewer'
      ? 'relay-viewer'
      : decoded.role;
    next();
  });

  io.on('connection', (socket) => {
    const role = socket.userRole || socket.user?.role || socket.handshake.auth?.role;
    const claimedRole = socket.handshake.auth?.role;
    if (claimedRole && claimedRole !== role) {
      console.warn(`[AUTH] Ignoring client-declared role=${claimedRole}, using token role=${role}`);
    }
    console.log(`Connection: ${role} - ${socket.id}`);

    if (role === 'host') {
      const previousHost = connections.host;
      connections.host = socket;
      if (previousHost && previousHost.id !== socket.id) {
        console.warn(`Replacing stale host connection: ${previousHost.id} -> ${socket.id}`);
        previousHost.disconnect(true);
      }
      if (previousHost && previousHost.id !== socket.id) {
        cancelResetRetry();
        desktopLease.hostDisconnected();
        clearPendingInputs();
        pendingControllerProtocolVersion = null;
        legacyControllerViewerId = null;
        clearAllLegacyRelayCompanions({ stop: true });
        broadcastControlState('host-replaced');
      } else {
        // Fresh Host socket on an unresolved reset-only barrier: re-issue the
        // current tokenless reset before any controller can write.
        const snapshot = desktopLease.snapshot();
        if (snapshot.state === 'REVOKING' && snapshot.pendingViewerId === null
          && Number.isSafeInteger(snapshot.leaseEpoch)) {
          reemitResetOnlyTransition(snapshot.leaseEpoch, 0);
          startResetRetry(snapshot.leaseEpoch, snapshot.reason || 'host-reconnect');
        }
      }
      clearHostCapabilities();
      socket.emit('connected', { role: 'host', status: 'ok', inputProtocolVersion: socket.inputProtocolVersion });
      emitViewerStatus('host-connected');
      // Notify all viewers that host is online
      connections.viewers.forEach((viewerSocket) => {
        viewerSocket.emit('host-status', {
          online: true,
          inputProtocolVersion: hostInputProtocolVersion(),
          hostCapabilities: getHostCapabilities(),
        });
      });
    } else if (role === 'viewer') {
      // Hard order: claim map slot → supersede others → only then welcome incoming.
      // New desktop viewers never auto-acquire control.
      connections.viewers.set(socket.id, socket);
      supersedeOtherDesktopViewers(socket);
      if (connections.viewers.size > 1) clearAllLegacyRelayCompanions({ stop: true });
      socket.emit('connected', {
        role: 'viewer',
        status: 'ok',
        hostOnline: connections.host !== null,
        inputProtocolVersion: socket.inputProtocolVersion,
        hostInputProtocolVersion: hostInputProtocolVersion(),
        hostCapabilities: getHostCapabilities(),
      });
      emitViewerStatus('viewer-connected', socket);
      socket.emit('control-state', {
        ...controlSnapshot(),
        controller: controlSnapshot().controllerViewerId === socket.id,
        reason: 'viewer-connected',
      });
    } else if (role === 'relay-viewer') {
      connections.relayViewers.set(socket.id, socket);
      socket.emit('connected', {
        role: 'relay-viewer',
        status: 'ok',
        hostOnline: connections.host !== null
      });
    }

    socket.on('control-acquire', (data = {}) => {
      if (role !== 'viewer' || !isActiveViewerSocket(socket)) return;
      if (!connections.host) {
        socket.emit('control-acquire-result', { state: 'FREE', reason: 'host-offline', requestId: data.requestId || null });
        return;
      }
      if (socket.inputProtocolVersion === 2 && !hostSupportsV2Input()) {
        socket.emit('control-acquire-result', {
          state: controlSnapshot().state,
          reason: 'host-protocol-too-old',
          requestId: data.requestId || null,
        });
        return;
      }
      if (socket.inputProtocolVersion !== 2 && !LEGACY_INPUT_COMPAT_ENABLED) {
        socket.emit('control-acquire-result', {
          state: controlSnapshot().state,
          reason: 'legacy-input-disabled',
          requestId: data.requestId || null,
        });
        return;
      }
      const previousController = controlSnapshot().controllerViewerId;
      const result = withLeaseExpiry(() => desktopLease.requestControl({
        viewerId: socket.id,
        takeover: data.takeover === true,
      }));
      if (result.transition) {
        rememberPendingController(socket.inputProtocolVersion);
        annotateLegacyTakeover(result, previousController);
        if (result.transition.reason === 'legacy-takeover') {
          clearLegacyRelayCompanion(previousController, { stop: true });
        }
        if (data.takeover === true && previousController && previousController !== socket.id) {
          connections.viewers.get(previousController)?.emit('control-revoked', { reason: 'takeover' });
        }
        socket.emit('control-acquire-result', {
          state: result.state,
          reason: result.reason || 'transition',
          pendingViewerId: result.transition?.viewerId ?? controlSnapshot().pendingViewerId,
          leaseEpoch: result.transition?.leaseEpoch ?? controlSnapshot().leaseEpoch,
          requestId: data.requestId || null,
        });
        dispatchLeaseEffect(result, 'transition');
      } else {
        const snapshot = controlSnapshot();
        // Reset-only barrier blocks all acquires until Host acks. Nudge Host again
        // so a missed control-transition does not leave the UI stuck forever.
        if (snapshot.state === 'REVOKING' && snapshot.pendingViewerId === null
          && Number.isSafeInteger(snapshot.leaseEpoch)) {
          reemitResetOnlyTransition(snapshot.leaseEpoch, 0);
          socket.emit('control-acquire-result', {
            state: snapshot.state,
            reason: snapshot.reason || 'reset-in-progress',
            pendingViewerId: null,
            leaseEpoch: snapshot.leaseEpoch,
            requestId: data.requestId || null,
          });
          broadcastControlState(snapshot.reason || 'reset-in-progress');
          return;
        }
        socket.emit('control-acquire-result', {
          ...result,
          state: result.state || snapshot.state,
          pendingViewerId: result.pendingViewerId ?? snapshot.pendingViewerId,
          leaseEpoch: result.leaseEpoch ?? snapshot.leaseEpoch,
          requestId: data.requestId || null,
        });
        // Occupied/error paths previously emitted only to the requester, so the
        // sticky client label "控制权正在切换" never cleared. Broadcast truth.
        broadcastControlState(result.reason || result.state || 'acquire-rejected');
      }
    });

    socket.on('control-heartbeat', (data = {}) => {
      if (role !== 'viewer' || !isActiveViewerSocket(socket)) return;
      const result = withLeaseExpiry(() => desktopLease.heartbeat({
        viewerId: socket.id,
        leaseId: data.leaseId,
        leaseEpoch: data.leaseEpoch,
      }));
      if (!result.ok) socket.emit('control-heartbeat-rejected', { reason: result.reason });
    });

    socket.on('control-release', (data = {}) => {
      if (role !== 'viewer' || !isActiveViewerSocket(socket)) return;
      const result = withLeaseExpiry(() => desktopLease.beginRelease({
        viewerId: socket.id,
        reason: data.reason || 'released',
      }));
      if (result.transition) {
        dispatchLeaseEffect(result, 'released');
      }
    });

    socket.on('control-transition-ack', (data = {}) => {
      if (role !== 'host' || connections.host !== socket) return;
      const status = data.status === 'applied' ? 'applied' : 'rejected';
      const result = withLeaseExpiry(() => (status === 'applied'
        ? desktopLease.confirmTransition({ leaseEpoch: data.leaseEpoch })
        : desktopLease.failTransition({
          leaseEpoch: data.leaseEpoch,
          reason: data.reason || 'transition-failed',
        })));
      if (status === 'applied' && result.state === 'FREE') {
        cancelResetRetry();
      } else if (status === 'applied' && result.lease) {
        cancelResetRetry();
      }
      if (result.lease) {
        if (legacyControllerViewerId) clearLegacyRelayCompanion(legacyControllerViewerId, { stop: true });
        legacyControllerViewerId = pendingControllerProtocolVersion === 1
          ? controlSnapshot().controllerViewerId
          : null;
        if (legacyControllerViewerId) legacyRelayOwnerIds.add(legacyControllerViewerId);
        pendingControllerProtocolVersion = null;
        sendGrant(controlSnapshot().controllerViewerId, result.lease);
      }
      dispatchLeaseEffect(result, result.reason || result.state.toLowerCase());
      if (result.lease) {
        const queued = pendingOffers.get(controlSnapshot().controllerViewerId);
        if (queued) {
          pendingOffers.delete(controlSnapshot().controllerViewerId);
          queued.forEach(({ socket: queuedSocket, data: queuedData }) => {
            if (isActiveViewerSocket(queuedSocket)) forwardOffer(queuedSocket, queuedData);
          });
        }
        const queuedInputs = pendingInputs.get(controlSnapshot().controllerViewerId);
        if (queuedInputs) {
          pendingInputs.delete(controlSnapshot().controllerViewerId);
          queuedInputs.forEach(({ socket: queuedSocket, data: queuedData }) => {
            if (!isActiveViewerSocket(queuedSocket)) return;
            if (!authorizeViewer(queuedSocket, queuedData, { legacy: true })) return;
            if (connections.host) {
              connections.host.emit('input', { ...queuedData, viewerId: queuedSocket.id });
            }
          });
        }
      }
    });

    // WebRTC signaling
    socket.on('offer', (data) => {
      if (role !== 'viewer') {
        console.warn(`Offer rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Offer rejected: disconnected viewer ${socket.id}`);
        return;
      }
      if (data?.schemaVersion === 2
        && (socket.inputProtocolVersion !== 2 || !hostSupportsV2Input())) {
        socket.emit('input-protocol-error', { reason: v2ProtocolError(socket) });
        return;
      }
      if (data?.schemaVersion === 2 && !authorizeViewer(socket, data, { legacy: false })) return;
      if (data?.schemaVersion !== 2) {
        if (!LEGACY_INPUT_COMPAT_ENABLED) return;
        const snapshot = controlSnapshot();
        if (snapshot.state !== 'ACTIVE' || snapshot.controllerViewerId !== socket.id) {
          if (snapshot.state === 'FREE' && connections.host) {
            const result = withLeaseExpiry(() => desktopLease.requestControl({ viewerId: socket.id }));
            if (result.transition) {
              rememberPendingController(1);
              pendingOffers.set(socket.id, [{ socket, data }]);
              dispatchLeaseEffect(result, 'transition');
            }
          }
          return;
        }
      }
      console.log(`[OFFER] Received from ${role}=${socket.id} epoch=${data.epoch} hostConnected=${Boolean(connections.host)}`);
      if (connections.host) {
        console.log(`[OFFER] Forwarding to host ${connections.host.id} epoch=${data.epoch}`);
        forwardOffer(socket, data);
      } else {
        console.warn(`[OFFER] No host connected, dropping offer from ${socket.id} epoch=${data.epoch}`);
      }
    });

    socket.on('answer', (data) => {
      const viewerSocket = connections.viewers.get(data.viewerId);
      if (viewerSocket) {
        viewerSocket.emit('answer', { answer: data.answer });
      }
    });

    socket.on('ice-candidate', (data) => {
      if (data.target === 'host' && connections.host) {
        if (role !== 'viewer') {
          console.warn(`ICE candidate to host rejected: role=${role} from ${socket.id}`);
          return;
        }
        if (!isActiveViewerSocket(socket)) {
          console.warn(`ICE candidate to host rejected: disconnected viewer ${socket.id}`);
          return;
        }
        connections.host.emit('ice-candidate', {
          candidate: data.candidate,
          from: socket.id
        });
      } else if (data.target === 'viewer') {
        const viewerSocket = connections.viewers.get(data.viewerId);
        if (viewerSocket) {
          viewerSocket.emit('ice-candidate', {
            candidate: data.candidate,
            from: socket.id
          });
        }
      }
    });

    // Input relay (viewer -> host only)
    socket.on('input', (data) => {
      if (role !== 'viewer') {
        console.warn(`Input rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Input rejected: disconnected viewer ${socket.id}`);
        return;
      }
      if (data?.schemaVersion === 2
        && (socket.inputProtocolVersion !== 2 || !hostSupportsV2Input())) {
        socket.emit('input-protocol-error', { reason: v2ProtocolError(socket) });
        return;
      }
      if (data?.schemaVersion !== 2) {
        if (!LEGACY_INPUT_COMPAT_ENABLED) return;
        const snapshot = controlSnapshot();
        if (!authorizeViewer(socket, data, { legacy: false })) {
          if (snapshot.state === 'FREE' && connections.host) {
            const result = withLeaseExpiry(() => desktopLease.requestControl({ viewerId: socket.id }));
            if (result.transition) {
              rememberPendingController(1);
              pendingInputs.set(socket.id, [{ socket, data }]);
              dispatchLeaseEffect(result, 'transition');
            }
          } else if (snapshot.state === 'GRANTING' && snapshot.pendingViewerId === socket.id) {
            const queued = pendingInputs.get(socket.id) || [];
            if (queued.length === 0) queued.push({ socket, data });
            pendingInputs.set(socket.id, queued);
          }
          return;
        }
      }
      if (data?.schemaVersion === 2) {
        // Keyboard uses the strict remote-input contract (seq + physical key fields).
        // Mouse/command share lease authorize only — they are not keyboard envelopes
        // and may carry transport/timestamp metadata for Host logging. Running mouse
        // through validateRemoteInput rejects every socket fallback as UNKNOWN_FIELD
        // / INVALID_TYPE once DataChannel is closed (control appears totally dead).
        if (data.type === 'keyboard') {
          const validation = validateRemoteInput(data);
          if (!validation.ok || !authorizeViewer(socket, data, { legacy: false })) {
            logger.warn?.(`[INPUT] rejected viewer=${socket.id} ${validation.ok ? 'unauthorized' : validation.code}`);
            return;
          }
          logger.log?.(`[INPUT] relay viewer=${socket.id} ${JSON.stringify(summarizeRemoteInput(data))}`);
        } else if (data.type === 'mouse' || data.type === 'command') {
          if (!authorizeViewer(socket, data, { legacy: false })) {
            logger.warn?.(`[INPUT] rejected viewer=${socket.id} unauthorized`);
            return;
          }
          if (typeof data.action !== 'string'
            || data.action.length < 1
            || data.action.length > 32
            || !data.payload
            || typeof data.payload !== 'object'
            || Array.isArray(data.payload)) {
            logger.warn?.(`[INPUT] rejected viewer=${socket.id} INVALID_DESKTOP_WRITE`);
            return;
          }
        } else {
          logger.warn?.(`[INPUT] rejected viewer=${socket.id} INVALID_TYPE`);
          return;
        }
      }
      if (data.type !== 'mouse' || data.action !== 'move') {
        const inputType = ['mouse', 'keyboard', 'command'].includes(data.type) ? data.type : 'unknown';
        const action = /^[a-z-]{1,32}$/i.test(String(data.action || '')) ? String(data.action) : 'unknown';
        const transport = data.transport === 'datachannel' ? 'datachannel' : 'socket';
        const payloadBytes = Buffer.byteLength(JSON.stringify(data.payload || {}), 'utf8');
        logger.log?.(`[INPUT] relay viewer=${socket.id} type=${inputType} action=${action} transport=${transport} payloadBytes=${payloadBytes}`);
      }
      if (connections.host) {
        connections.host.emit('input', {
          ...data,
          viewerId: socket.id
        });
      } else {
        console.warn('[INPUT] No host connected, dropping input');
      }
    });

    socket.on('input-ack', (data = {}) => {
      if (role !== 'host' || connections.host !== socket) {
        logger.warn?.(`[INPUT] ack rejected role=${role}`);
        return;
      }
      const viewerSocket = connections.viewers.get(String(data.viewerId || ''));
      if (!viewerSocket) return;
      const inputIds = Array.isArray(data.inputIds) ? data.inputIds.slice(0, 64) : [];
      const hostExecuteMs = Math.max(0, Number(data.hostExecuteMs || 0));
      if (data.schemaVersion === 2) {
        const validEpoch = Number.isSafeInteger(data.leaseEpoch) && data.leaseEpoch >= 0;
        const validSeq = Number.isSafeInteger(data.appliedSeq) && data.appliedSeq >= 0;
        const validStatus = V2_INPUT_ACK_STATUSES.has(data.status);
        const validPressed = Number.isSafeInteger(data.pressedKeyCount) && data.pressedKeyCount >= 0;
        const validModifiers = Number.isSafeInteger(data.modifierMask) && data.modifierMask >= 0;
        if (!validEpoch || !validSeq || !validStatus || !validPressed || !validModifiers) {
          logger.warn?.('[INPUT] invalid v2 ack');
          return;
        }
        viewerSocket.emit('input-ack', {
          type: 'input_ack',
          schemaVersion: 2,
          leaseEpoch: data.leaseEpoch,
          appliedSeq: data.appliedSeq,
          status: data.status,
          pressedKeyCount: data.pressedKeyCount,
          modifierMask: data.modifierMask,
          inputIds,
          hostExecuteMs,
          transport: 'socket',
        });
        return;
      }
      viewerSocket.emit('input-ack', {
        type: 'input_ack',
        schemaVersion: 1,
        inputIds,
        hostExecuteMs,
        transport: 'socket',
      });
    });

    // Diagnostic logs relay (viewer -> host) + persist to disk
    socket.on('diagnostic', (data) => {
      if (role !== 'viewer') {
        console.warn(`Diagnostic rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Diagnostic rejected: disconnected viewer ${socket.id}`);
        return;
      }
      const logCount = data.logs?.length || 0;
      logger.log?.(`[DIAGNOSTIC] Received ${logCount} lines from viewer ${socket.id}`);
      const result = ingestDiagnosticPayload({
        role,
        viewerId: socket.id,
        socketId: socket.id,
        userAgent: socket.handshake.headers['user-agent'] || 'unknown',
        data,
        config,
        logger,
      });
      if (result.accepted && result.summaryEvent) {
        recentEventStore?.append(result.summaryEvent);
        structuredLogger?.info(result.summaryEvent);
      }

      // Also relay to host for real-time analysis
      if (result.accepted && connections.host) {
        connections.host.emit('diagnostic', result.report);
      }
    });

    socket.on('viewer-stats', (data) => {
      if (role !== 'viewer') {
        console.warn(`Viewer stats rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Viewer stats rejected: disconnected viewer ${socket.id}`);
        return;
      }
      if (connections.host) {
        connections.host.emit('viewer-stats', {
          ...data,
          viewerId: socket.id
        });
      }
    });

    socket.on('media-profile-change', (data = {}) => {
      if (role !== 'viewer') {
        console.warn(`Media profile change rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Media profile change rejected: disconnected viewer ${socket.id}`);
        return;
      }
      if (socket.inputProtocolVersion === 2) {
        if (data?.schemaVersion !== 2 || !authorizeViewer(socket, data, { legacy: false })) return;
      } else if (data?.schemaVersion === 2 && !authorizeViewer(socket, data, { legacy: false })) return;
      const allowedProfiles = new Set(['high', 'medium', 'low', 'survival']);
      const profile = allowedProfiles.has(data.profile) ? data.profile : 'medium';
      const sanitized = {
        viewerId: socket.id,
        profile,
        width: clampInt(data.width, 320, 1920, 960),
        height: clampInt(data.height, 180, 1080, 540),
        targetFps: clampInt(data.targetFps, 5, 30, 15),
        videoBitrateKbps: clampInt(data.videoBitrateKbps, 250, 5000, 1400),
        reason: String(data.reason || 'quality').slice(0, 80),
        mediaPolicy: data.mediaPolicy === 'strict-stun' ? 'strict-stun' : 'unknown',
        // Default Quality Lock when field absent (matches host/spec).
        adaptiveResolution: data.adaptiveResolution === true,
        continuityAction: data.continuityAction === 'keyframe' ? 'keyframe' : 'none',
      };
      if (connections.host) {
        connections.host.emit('media-profile-change', sanitized);
      }
    });

    socket.on('request-keyframe', (data = {}) => {
      if (role !== 'viewer') return;
      if (!isActiveViewerSocket(socket)) return;
      if (socket.inputProtocolVersion === 2) {
        if (data?.schemaVersion !== 2 || !authorizeViewer(socket, data, { legacy: false })) return;
      } else if (data?.schemaVersion === 2 && !authorizeViewer(socket, data, { legacy: false })) {
        return;
      }
      if (!connections.host) return;
      connections.host.emit('request-keyframe', {
        viewerId: socket.id,
        reason: String(data.reason || 'media-stalled').slice(0, 80),
        schemaVersion: data.schemaVersion === 2 ? 2 : undefined,
        leaseId: typeof data.leaseId === 'string' ? data.leaseId : undefined,
        leaseEpoch: Number.isSafeInteger(data.leaseEpoch) ? data.leaseEpoch : undefined,
      });
    });

    socket.on('connection-attempt-bind', (data = {}) => {
      if (role !== 'viewer' || !isActiveViewerSocket(socket)) {
        socket.emit('connection-attempt-bind-rejected', { reason: 'inactive-viewer' });
        return;
      }
      if (!authorizeViewer(socket, {
        schemaVersion: 2,
        leaseId: data.leaseId,
        leaseEpoch: data.leaseEpoch,
      }, { legacy: false })) {
        socket.emit('connection-attempt-bind-rejected', { reason: 'unauthorized' });
        return;
      }
      if (!isValidConnectionAttemptId(data.connectionAttemptId)) {
        socket.emit('connection-attempt-bind-rejected', { reason: 'invalid-attempt' });
        return;
      }
      if (!isValidConnectionAttemptSequence(data.connectionAttemptSequence)) {
        socket.emit('connection-attempt-bind-rejected', { reason: 'invalid-sequence' });
        return;
      }
      const bindResult = bindViewerConnectionAttempt(
        socket.id,
        data.connectionAttemptId,
        data.connectionAttemptSequence,
      );
      if (!bindResult.ok) {
        socket.emit('connection-attempt-bind-rejected', {
          reason: bindResult.reason || 'bind-rejected',
        });
        return;
      }
      // Always inform Host, including idempotent rebinds. A late WebRTC offer can
      // otherwise leave Host on a stale attempt after the Viewer already moved on.
      emitHostConnectionAttemptBind(socket.id, bindResult, {
        leaseId: data.leaseId,
        leaseEpoch: data.leaseEpoch,
        networkMode: data.networkMode,
      });
      socket.emit('connection-attempt-bound', {
        schemaVersion: 1,
        connectionAttemptId: bindResult.connectionAttemptId,
        connectionAttemptSequence: bindResult.connectionAttemptSequence,
      });
      emitControlEvent('connection_attempt_bound', {
        viewerId: socket.id,
        connectionAttemptId: bindResult.connectionAttemptId,
        connectionAttemptSequence: bindResult.connectionAttemptSequence,
        rebound: bindResult.bound,
      });
    });

    socket.on('media-activity-change', (data = {}) => {
      if (role !== 'viewer' || !isActiveViewerSocket(socket)) return;
      const validated = validateMediaActivityRequest(data);
      if (!validated.ok) {
        socket.emit('media-activity-rejected', { reason: validated.code });
        return;
      }
      const value = validated.value;
      if (!authorizeViewer(socket, {
        schemaVersion: 2,
        leaseId: value.leaseId,
        leaseEpoch: value.leaseEpoch,
      }, { legacy: false })) {
        socket.emit('media-activity-rejected', { reason: 'unauthorized' });
        return;
      }
      const currentAttempt = currentViewerConnectionAttempt(socket.id);
      // Media control never establishes attempt authority. Only offer or explicit
      // connection-attempt-bind may bind; then only the active attempt may write.
      if (!currentAttempt || value.connectionAttemptId !== currentAttempt) {
        socket.emit('media-activity-rejected', { reason: 'wrong-attempt' });
        return;
      }
      const prior = mediaActivityProgress.get(socket.id);
      if (prior
        && prior.connectionAttemptId === value.connectionAttemptId
        && value.generation <= prior.generation) {
        socket.emit('media-activity-rejected', { reason: 'stale-generation' });
        return;
      }
      noteMediaGenerationProgress(socket.id, value.connectionAttemptId, value.generation);
      const summary = summarizeMediaActivity(value);
      emitControlEvent('media_activity_requested', {
        ...summary,
        viewerId: socket.id,
      });
      if (!connections.host) {
        socket.emit('media-activity-rejected', { reason: 'host-offline' });
        return;
      }
      connections.host.emit('media-activity-change', {
        ...value,
        viewerId: socket.id,
      });
    });

    socket.on('media-activity-ack', (data = {}) => {
      if (role !== 'host' || connections.host !== socket) return;
      const viewerId = typeof data.viewerId === 'string' ? data.viewerId : null;
      if (!viewerId) return;
      const viewerSocket = connections.viewers.get(viewerId);
      if (!viewerSocket) return;
      releaseRejectedMediaProgress(viewerId, data);
      viewerSocket.emit('media-activity-ack', {
        schemaVersion: 1,
        state: data.state === 'active' ? 'active' : 'suspended',
        generation: Number.isSafeInteger(data.generation) ? data.generation : null,
        connectionAttemptId: typeof data.connectionAttemptId === 'string' ? data.connectionAttemptId : null,
        applied: data.applied === true,
        keyframeRequested: data.keyframeRequested === true,
      });
    });

    socket.on('relay-stream-control', (data = {}) => {
      if (role !== 'viewer' && role !== 'relay-viewer') {
        console.warn(`Relay stream control rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (role === 'viewer' && !isActiveViewerSocket(socket)) {
        console.warn(`Relay stream control rejected: disconnected viewer ${socket.id}`);
        return;
      }
      const isMediaControl = Number(data.mediaControlSchemaVersion) === 1
        || (data.schemaVersion === 2 && (data.state === 'active' || data.state === 'suspended')
          && Number.isSafeInteger(data.generation));
      if (role === 'viewer' && isMediaControl) {
        if (!authorizeViewer(socket, data, { legacy: false })) {
          socket.emit('relay-stream-control-rejected', { reason: 'unauthorized' });
          return;
        }
        if (!isValidConnectionAttemptId(data.connectionAttemptId)
          || !Number.isSafeInteger(data.generation) || data.generation < 1) {
          socket.emit('relay-stream-control-rejected', { reason: 'invalid-media-control' });
          return;
        }
        const currentAttempt = currentViewerConnectionAttempt(socket.id);
        // Tunnel media control must not invent attempt authority. Bind first via
        // connection-attempt-bind (or a WebRTC offer that shares the same record).
        if (!currentAttempt || data.connectionAttemptId !== currentAttempt) {
          socket.emit('relay-stream-control-rejected', { reason: 'wrong-attempt' });
          return;
        }
        const prior = mediaActivityProgress.get(socket.id);
        if (prior
          && prior.connectionAttemptId === data.connectionAttemptId
          && data.generation <= prior.generation) {
          socket.emit('relay-stream-control-rejected', { reason: 'stale-generation' });
          return;
        }
        noteMediaGenerationProgress(socket.id, data.connectionAttemptId, data.generation);
      } else if (role === 'viewer' && data?.schemaVersion === 2
        && !authorizeViewer(socket, data, { legacy: false })) {
        return;
      }
      let viewerId = socket.id;
      if (role === 'relay-viewer') {
        const boundOwnerId = legacyRelayOwnerForCompanion(socket.id);
        if (boundOwnerId && !hasActiveLegacyRelayOwner(boundOwnerId)) {
          clearLegacyRelayCompanion(boundOwnerId, { stop: true });
        }
        viewerId = hasActiveLegacyRelayOwner(boundOwnerId)
          ? boundOwnerId
          : bindLegacyRelayCompanion(socket.id);
        if (!viewerId) return;
      }
      if (connections.host) {
        const forwarded = {
          ...data,
          viewerId,
        };
        if (isMediaControl) {
          forwarded.state = data.state === 'active' ? 'active' : 'suspended';
          forwarded.enabled = data.state === 'active' || data.enabled === true;
          forwarded.generation = data.generation;
          forwarded.connectionAttemptId = data.connectionAttemptId;
          forwarded.mediaControlSchemaVersion = 1;
        }
        connections.host.emit('relay-stream-control', forwarded);
      }
    });


    socket.on('relay-stream-control-ack', (data = {}) => {
      if (role !== 'host' || connections.host !== socket) return;
      const viewerId = typeof data.viewerId === 'string' ? data.viewerId : null;
      if (!viewerId) return;
      const viewerSocket = connections.viewers.get(viewerId);
      if (!viewerSocket) return;
      releaseRejectedMediaProgress(viewerId, data);
      const ack = {
        schemaVersion: 1,
        state: data.state === 'active' ? 'active' : 'suspended',
        generation: Number.isSafeInteger(data.generation) ? data.generation : null,
        connectionAttemptId: typeof data.connectionAttemptId === 'string' ? data.connectionAttemptId : null,
        applied: data.applied === true,
      };
      if (typeof data.reason === 'string' && data.reason) {
        ack.reason = data.reason.slice(0, 64);
      }
      // Dual-route: media runtime listens on media-activity-ack; keep explicit tunnel event too.
      viewerSocket.emit('relay-stream-control-ack', ack);
      viewerSocket.emit('media-activity-ack', ack);
    });

    socket.on('relay-frame', (data) => {
      if (role !== 'host') {
        console.warn(`Relay frame rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (legacyRelayOwnerIds.has(data.viewerId)) {
        const companionId = hasActiveLegacyRelayOwner(data.viewerId)
          ? legacyRelayCompanionByOwner.get(data.viewerId)
          : null;
        const companionSocket = companionId && connections.relayViewers.get(companionId);
        if (companionSocket) companionSocket.volatile.emit('relay-frame', data);
        return;
      }
      const viewerSocket = connections.relayViewers.get(data.viewerId) || connections.viewers.get(data.viewerId);
      if (viewerSocket) {
        viewerSocket.volatile.emit('relay-frame', data);
      }
    });

    socket.on('relay-frame-ack', (data) => {
      if (role !== 'viewer' && role !== 'relay-viewer') {
        return;
      }
      if (connections.host) {
        if (role === 'viewer' && data?.schemaVersion === 2 && !authorizeViewer(socket, data, { legacy: false })) return;
        const boundOwnerId = legacyRelayOwnerForCompanion(socket.id);
        const viewerId = role === 'relay-viewer' && hasActiveLegacyRelayOwner(boundOwnerId)
          ? boundOwnerId
          : role === 'viewer' ? socket.id : null;
        if (!viewerId) return;
        connections.host.emit('relay-frame-ack', {
          ...data,
          viewerId,
        });
      }
    });

    socket.on('resolution-change', (data) => {
      if (role !== 'viewer') {
        console.warn(`Resolution change rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Resolution change rejected: disconnected viewer ${socket.id}`);
        return;
      }
      if (socket.inputProtocolVersion === 2) {
        if (data?.schemaVersion !== 2 || !authorizeViewer(socket, data, { legacy: false })) return;
      } else if (data?.schemaVersion === 2 && !authorizeViewer(socket, data, { legacy: false })) return;
      const requestedWidth = Number(data.width);
      const requestedHeight = Number(data.height);
      if (!Number.isFinite(requestedWidth) || !Number.isFinite(requestedHeight) || requestedWidth < 320 || requestedHeight < 180) {
        console.warn(`[RESOLUTION] Invalid request from ${socket.id}:`, data);
        return;
      }
      const width = clampInt(requestedWidth, 320, 1920, 960);
      const height = clampInt(requestedHeight, 180, 1080, 540);
      if (connections.host) {
        connections.host.emit('resolution-change', {
          width,
          height,
          viewerId: socket.id
        });
      }
    });

    socket.on('host-capabilities', (data = {}) => {
      if (role !== 'host' || connections.host !== socket) return;
      const snapshot = setHostCapabilities(data);
      connections.viewers.forEach((viewerSocket) => {
        viewerSocket.emit('host-capabilities', snapshot);
      });
    });

    socket.on('disconnect', () => {
      console.log(`Disconnected: ${role} - ${socket.id}`);
      if (role === 'host') {
        if (connections.host && connections.host.id === socket.id) {
          connections.host = null;
          clearHostCapabilities();
          cancelResetRetry();
          const leaseResult = desktopLease.hostDisconnected();
          clearPendingInputs();
          pendingControllerProtocolVersion = null;
          legacyControllerViewerId = null;
          clearAllLegacyRelayCompanions();
          broadcastControlState(leaseResult.reason);
          connections.viewers.forEach((viewerSocket) => {
            viewerSocket.emit('host-status', { online: false, hostCapabilities: getHostCapabilities() });
          });
          emitViewerStatus('host-disconnected');
        } else {
          console.log(`Ignoring stale host disconnect: ${socket.id}`);
        }
      } else if (role === 'viewer') {
        removeDesktopViewer(socket, 'viewer-disconnected');
      } else if (role === 'relay-viewer') {
        connections.relayViewers.delete(socket.id);
        const ownerId = legacyRelayOwnerForCompanion(socket.id);
        if (ownerId) clearLegacyRelayCompanion(ownerId, { stop: true });
      }
    });
  });

  return connections;
}

function getConnectionStatus() {
  return {
    hostOnline: Boolean(connections.host),
    hostId: connections.host ? connections.host.id : null,
    viewerCount: connections.viewers.size,
    relayViewerCount: connections.relayViewers.size,
    viewers: getViewerSnapshot()
  };
}

module.exports = {
  setupSignaling,
  connections,
  getConnectionStatus,
  getHostCapabilities,
  setHostCapabilities,
  clearHostCapabilities,
  ingestDiagnosticPayload,
};
