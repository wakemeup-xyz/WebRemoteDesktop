const { loadConfig } = require('../lib/config');
const { verifyAccessToken } = require('../lib/auth');
const { performance } = require('node:perf_hooks');
const { ingestDiagnosticPayload } = require('../lib/diagnostic');
const { normalizeDisconnectReason } = require('../lib/observability/runtime');
const { createResetAckObserver } = require('../lib/observability/reset-ack-observer');
const { DesktopControlLease } = require('../lib/desktop-control-lease');
const { ControlTransitionRetry } = require('../lib/control-transition-retry');
const { createRuntimeContext } = require('./runtime-context');
const { validateRemoteInput, summarizeRemoteInput } = require('../lib/remote-input-contract');
const {
  isHighFrequencyInput,
  summarizeHighFrequencyInput,
  summarizeInputEvent,
} = require('../lib/observability/input');
const {
  validateMediaActivityRequest,
  summarizeMediaActivity,
} = require('../lib/media-activity-contract');

function validRelayNonce(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !(/[^\x20-\x7e]/.test(value));
}

function validRelayScope(scope) {
  return scope && typeof scope === 'object' && !Array.isArray(scope)
    && Object.keys(scope).length === 5
    && ['producerId', 'productionGeneration', 'connectionAttemptId', 'mediaGeneration', 'leaseEpoch']
      .every(key => Object.prototype.hasOwnProperty.call(scope, key))
    && validRelayNonce(scope.producerId, 64) && validRelayNonce(scope.connectionAttemptId, 128)
    && Number.isSafeInteger(scope.productionGeneration) && scope.productionGeneration >= 1
    && Number.isSafeInteger(scope.mediaGeneration) && scope.mediaGeneration >= 0
    && Number.isSafeInteger(scope.leaseEpoch) && scope.leaseEpoch >= 1;
}

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

function validV2InputAckShape(data) {
  if (data.schemaVersion !== 2) return false;
  const independentAck = data.inputType === 'mouse';
  return Number.isSafeInteger(data.leaseEpoch) && data.leaseEpoch >= 0
    && ['keyboard', 'mouse', 'command'].includes(data.inputType)
    && (independentAck
      ? (data.appliedSeq === undefined || (Number.isSafeInteger(data.appliedSeq) && data.appliedSeq >= 0))
      : (Number.isSafeInteger(data.appliedSeq) && data.appliedSeq >= 0))
    && V2_INPUT_ACK_STATUSES.has(data.status)
    && (independentAck || (Number.isSafeInteger(data.pressedKeyCount) && data.pressedKeyCount >= 0))
    && (independentAck || (Number.isSafeInteger(data.modifierMask) && data.modifierMask >= 0));
}
const MEDIA_ACTIVITY_ACK_FAILURE_REASONS = new Set([
  'stale-generation',
  'closed',
  'fresh-capture-timeout',
  'execution-failed',
  'invalid-relay-start',
  'relay-start-failed',
]);

// The default context preserves the historical module exports. Each server
// instance created by setupSignaling receives its own context.
const runtime = createRuntimeContext();
const connections = runtime.connections;

function normalizeTurnServerIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    const id = String(item || '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function getHostCapabilities(context = runtime) {
  return context.getHostCapabilities();
}

function setHostCapabilities(payload = {}, context = runtime) {
  return context.setHostCapabilities(payload);
}

function clearHostCapabilities(context = runtime) {
  return context.clearHostCapabilities();
}

function getViewerSnapshot(context = runtime) {
  return context.getViewerSnapshot();
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
  return connections.viewers.get(socket.id) === socket && socket?._wrdDisconnected !== true;
}

function normalizeViewerSessionId(value) {
  const sessionId = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(sessionId) ? sessionId : null;
}

function clampInt(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function setupSignaling(io, options = {}) {
  const instanceRuntime = options.runtimeContext || runtime;
  const connections = instanceRuntime.connections;
  const getHostCapabilities = () => instanceRuntime.getHostCapabilities();
  const setHostCapabilities = (payload = {}) => instanceRuntime.setHostCapabilities(payload);
  const clearHostCapabilities = () => instanceRuntime.clearHostCapabilities();
  const getViewerSnapshot = () => instanceRuntime.getViewerSnapshot();
  const isActiveViewerSocket = (socket) => Boolean(socket
    && connections.viewers.get(socket.id) === socket
    && socket._wrdDisconnected !== true
    && socket._wrdRebindPending !== true);
  const issueProofAdmission = () => instanceRuntime.issueProofAdmission();
  const admitProofViewer = (admission, socketId) => instanceRuntime.admitProofViewer(admission, socketId);
  const noteHumanViewerAdmission = () => instanceRuntime.noteHumanViewerAdmission();
  const requiresViewerProof = () => typeof instanceRuntime.requiresViewerProof === 'function'
    && instanceRuntime.requiresViewerProof() === true;
  const emitViewerStatus = (reason, viewerSocket = null) => {
    const payload = {
      reason,
      onlineCount: connections.viewers.size,
      viewers: getViewerSnapshot(),
      changedViewer: viewerSocket ? {
        id: viewerSocket.id,
        ip: viewerSocket.handshake?.address || 'unknown',
        userAgent: viewerSocket.handshake?.headers?.['user-agent'] || 'unknown',
      } : null,
    };
    if (connections.host) connections.host.emit('viewer-status', payload);
  };
  const config = options.config || loadConfig();
  const verifyRuntimeToken = options.verifyAccessToken || verifyAccessToken;
  const logger = options.logger || console;
  const recentEventStore = options.recentEventStore || null;
  const structuredLogger = options.structuredLogger || null;
  const heartbeatNow = typeof options.controlHeartbeatNow === 'function'
    ? options.controlHeartbeatNow : () => performance.now();
  const heartbeatCount = value => Math.min(999999999, Math.max(0, Math.floor(value)));
  function controlHeartbeatObservation(socket) {
    return socket._wrdControlHeartbeatObservation ||= {
      received: 0, accepted: 0, rejected: 0, ackRequested: 0, ackEnqueued: 0,
      lastReceivedAt: null, lastAcceptedAt: null, lastGrantAt: null, maxReceiveGapMs: 0, leaseEpoch: null,
      scopeAttemptSequence: null, lastAcceptedHeartbeatSeq: null, lastAckEnqueuedHeartbeatSeq: null,
    };
  }
  function observeControlHeartbeat(socket, data, result, ackScopeMatches = false) {
    const now = heartbeatNow();
    const observation = controlHeartbeatObservation(socket);
    if (observation.lastReceivedAt !== null) {
      observation.maxReceiveGapMs = Math.max(observation.maxReceiveGapMs,
        heartbeatCount(now - observation.lastReceivedAt));
    }
    observation.lastReceivedAt = now;
    observation.received = heartbeatCount(observation.received + 1);
    const counter = result.ok ? 'accepted' : 'rejected';
    observation[counter] = heartbeatCount(observation[counter] + 1);
    if (data.heartbeatAckVersion === 1) observation.ackRequested = heartbeatCount(observation.ackRequested + 1);
    if (result.ok) {
      const attemptSequence = ackScopeMatches ? data.connectionAttemptSequence : null;
      if (observation.leaseEpoch !== data.leaseEpoch || observation.scopeAttemptSequence !== attemptSequence) {
        observation.lastAcceptedHeartbeatSeq = null;
        observation.lastAckEnqueuedHeartbeatSeq = null;
      }
      observation.lastAcceptedAt = now;
      observation.leaseEpoch = data.leaseEpoch;
      observation.scopeAttemptSequence = attemptSequence;
      observation.lastAcceptedHeartbeatSeq = ackScopeMatches ? data.heartbeatSeq : null;
    }
    return observation;
  }
  function summarizeControlHeartbeat(socket, reason) {
    const observation = socket?._wrdControlHeartbeatObservation;
    if (!observation) return;
    const now = heartbeatNow();
    const payload = { domain: 'control', event: 'control_heartbeat_observed',
      message: 'Bounded control heartbeat receive and renewal summary', meta: {
        reason, received: observation.received, accepted: observation.accepted, rejected: observation.rejected,
        ackRequested: observation.ackRequested, ackEnqueued: observation.ackEnqueued,
        leaseEpoch: Number.isSafeInteger(observation.leaseEpoch) ? observation.leaseEpoch : null,
        scopeAttemptSequence: observation.scopeAttemptSequence,
        lastAcceptedHeartbeatSeq: observation.lastAcceptedHeartbeatSeq,
        lastAckEnqueuedHeartbeatSeq: observation.lastAckEnqueuedHeartbeatSeq,
        lastReceivedAgeMs: observation.lastReceivedAt === null ? null : heartbeatCount(now - observation.lastReceivedAt),
        lastAcceptedAgeMs: observation.lastAcceptedAt === null ? null : heartbeatCount(now - observation.lastAcceptedAt),
        lastGrantAgeMs: observation.lastGrantAt === null ? null : heartbeatCount(now - observation.lastGrantAt),
        maxReceiveGapMs: observation.maxReceiveGapMs,
      } };
    try { structuredLogger?.info?.(payload); } catch (_error) {}
    try { recentEventStore?.append?.(payload); } catch (_error) {}
  }
  // Observation only: each server instance retains at most 32 reset IDs for
  // ten seconds. No lease token, input payload, socket, or timer is retained.
  const resetAckObserver = createResetAckObserver({
    now: options.resetAckNow,
    onObservation(meta) {
      const payload = {
        domain: 'input',
        event: 'signal_reset_ack_observed',
        message: 'Signal reset request to ACK outcome (includes Host processing)',
        meta,
      };
      // Each sink is optional and must never become part of ACK delivery.
      try { structuredLogger?.info?.(payload); } catch (_error) {}
      try { recentEventStore?.append?.(payload); } catch (_error) {}
    },
  });
  const desktopLease = options.desktopControlLease || new DesktopControlLease({
    now: options.now || Date.now,
    makeLeaseId: options.makeLeaseId || (() => `lease-${require('node:crypto').randomUUID()}`),
  });
  const pendingOffers = new Map();
  const pendingInputs = new Map();
  // A transient transport loss must not immediately revoke the desktop lease.
  // Keep only the authenticated session key and socket reference here; the
  // socket itself is marked inactive while it waits for a replacement.
  const viewerSessionBindings = new Map();
  const inputAggregateCounts = new Map();
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
  const viewerDisconnectGraceMs = Number.isFinite(Number(options.viewerDisconnectGraceMs))
    ? Math.max(0, Math.min(30_000, Math.floor(Number(options.viewerDisconnectGraceMs))))
    : 30_000;
  const configuredRebindAckTimeoutsMs = Array.isArray(options.rebindAckTimeoutsMs)
    ? options.rebindAckTimeoutsMs
      .map(value => Number.isFinite(Number(value))
        ? Math.max(250, Math.min(10_000, Math.floor(Number(value)))) : null)
      .filter(value => value !== null)
      .slice(0, 3)
    : [];
  let configuredRebindBudgetMs = 0;
  const boundedRebindAckTimeoutsMs = configuredRebindAckTimeoutsMs.filter(value => {
    if (configuredRebindBudgetMs + value > 24_000) return false;
    configuredRebindBudgetMs += value;
    return true;
  });
  // Keep the total rebind wait bounded (1.5s + 3s + 6s by default) while
  // leaving the 30s lease grace window for a fresh Viewer socket to arrive.
  const rebindAckTimeoutsMs = boundedRebindAckTimeoutsMs.length > 0
    ? boundedRebindAckTimeoutsMs : [1_500, 3_000, 6_000];
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
    // Match the production logger contract: unknown top-level fields are
    // discarded by normalizeEvent(). Keep an explicit allowlist so adding
    // credentials or input to an effect cannot accidentally persist them.
    const correlation = {};
    for (const key of ['viewerId', 'previousViewerId', 'connectionAttemptId']) {
      if (typeof fields[key] === 'string') correlation[key] = fields[key];
    }
    if (typeof fields.sessionId === 'string') correlation.browserSessionId = fields.sessionId;
    const meta = {};
    for (const key of [
      'reason', 'leaseEpoch', 'attempt', 'graceMs', 'connectionAttemptSequence',
      'rebound', 'schemaVersion', 'state', 'reasons', 'generation', 'status',
    ]) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) meta[key] = fields[key];
    }
    const payload = {
      domain: 'control',
      event: type,
      message: type,
      correlation,
      meta,
    };
    // Bounded non-secret fields only — never lease tokens, input, SDP, candidates.
    if (structuredLogger && typeof structuredLogger.info === 'function') {
      structuredLogger.info(payload);
    }
    recentEventStore?.append?.(payload);
  }

  function emitInputEvent(event, socket, data = {}, overrides = {}) {
    const observedData = data && typeof data === 'object' && !Array.isArray(data)
      ? { ...data, transport: 'socket' }
      : { transport: 'socket' };
    if (isHighFrequencyInput(data)) {
      // Move/wheel traffic is count-only. Do not inspect payload or input IDs
      // before the aggregate threshold, and never compute a correlation hash.
      const summary = summarizeHighFrequencyInput(observedData, overrides);
      const key = `${socket?.id || ''}:${summary.inputType}:${summary.action}:${summary.status}`;
      if (!inputAggregateCounts.has(key) && inputAggregateCounts.size >= 256) {
        inputAggregateCounts.delete(inputAggregateCounts.keys().next().value);
      }
      const count = (inputAggregateCounts.get(key) || 0) + 1;
      inputAggregateCounts.set(key, count);
      // Mouse move/wheel traffic is deliberately aggregated. A periodic
      // sample remains useful while preventing diagnostics from becoming the
      // high-frequency path themselves.
      if (count % 100 !== 0) return null;
      summary.count = count;
      summary.aggregated = true;
      const aggregate = {
        domain: 'input',
        event: 'signal_input_aggregate',
        message: 'Aggregated high-frequency input outcome',
        correlation: { viewerId: socket?.id || null },
        meta: summary,
      };
      recentEventStore?.append?.(aggregate);
      structuredLogger?.info?.(aggregate);
      return aggregate;
    }
    const payload = {
      domain: 'input',
      event,
      message: event === 'signal_input_relayed'
        ? 'Signal relayed remote input'
        : 'Signal rejected remote input',
      correlation: { viewerId: socket?.id || null },
      meta: summarizeInputEvent(observedData, overrides),
    };
    recentEventStore?.append?.(payload);
    structuredLogger?.info?.(payload);
    return payload;
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
    // Historical event name: this records entry into the fail-closed reset
    // barrier (including normal release), not proof of failure or timeout.
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
      && isActiveViewerSocket(connections.viewers.get(ownerId)));
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
    const operation = connections.viewers.get(ownerId)?._wrdRebindOperation;
    const producerOwnerId = operation?.producerOwnerId || ownerId;
    connections.host.emit('relay-stream-control', { enabled: false, viewerId: producerOwnerId });
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

  function clearViewerSessionBinding(socket) {
    const sessionId = socket?._wrdViewerSessionId;
    if (!sessionId) return;
    const binding = viewerSessionBindings.get(sessionId);
    if (binding?.socket === socket) {
      if (binding.timer) clearTimeoutFn(binding.timer);
      viewerSessionBindings.delete(sessionId);
    }
    socket._wrdViewerSessionTimer = null;
  }

  function rebindDisconnectedViewer(socket) {
    const sessionId = socket?._wrdViewerSessionId;
    if (!sessionId) return false;
    const binding = viewerSessionBindings.get(sessionId);
    const previous = binding?.socket;
    if (!previous || previous === socket
      || previous._wrdDisconnected !== true
      || connections.viewers.get(previous.id) !== previous) {
      return false;
    }
    // An in-flight grant still belongs to the old Host transition. Only an
    // already active lease can migrate without another reset barrier.
    const previousLease = withLeaseExpiry(() => desktopLease.getActiveLease(previous.id));
    if (!previousLease || !connections.host) return false;

    if (binding.timer) clearTimeoutFn(binding.timer);
    viewerSessionBindings.delete(sessionId);
    socket._wrdDisconnected = false;
    socket._wrdViewerSessionTimer = null;

    const previousId = previous.id;
    const nextId = socket.id;
    const reboundLease = desktopLease.rebindViewer(previousId, nextId);
    connections.viewers.delete(previousId);
    connections.viewers.set(nextId, socket);

    const priorProgress = mediaActivityProgress.get(previousId);
    if (priorProgress) {
      mediaActivityProgress.delete(previousId);
      mediaActivityProgress.set(nextId, priorProgress);
    }
    const pendingOfferQueue = pendingOffers.get(previousId);
    if (pendingOfferQueue) {
      pendingOffers.delete(previousId);
      pendingOffers.set(nextId, pendingOfferQueue.map((entry) => ({ ...entry, socket })));
    }
    const pendingInputQueue = pendingInputs.get(previousId);
    if (pendingInputQueue) {
      pendingInputs.delete(previousId);
      pendingInputs.set(nextId, pendingInputQueue.map((entry) => ({ ...entry, socket })));
    }
    if (legacyControllerViewerId === previousId) legacyControllerViewerId = nextId;
    if (legacyRelayOwnerIds.delete(previousId)) legacyRelayOwnerIds.add(nextId);
    const companionId = legacyRelayCompanionByOwner.get(previousId);
    if (companionId) {
      legacyRelayCompanionByOwner.delete(previousId);
      legacyRelayCompanionByOwner.set(nextId, companionId);
    }
    if (reboundLease) {
      // Host may still be finishing an asynchronous offer. Keep the new socket
      // input-inactive until Host confirms it migrated the same authority.
      socket._wrdRebindPending = true;
      const operation = {
        socket, host: connections.host, lease: previousLease, attempt: priorProgress, settled: false,
        rebindAttempt: 0, activeRebindAttempt: 0,
        // The index has moved, but Host's actual producer remains with the old
        // owner until its rebind ACK. This snapshot belongs only to this operation.
        producerOwnerId: previous._wrdRebindOperation?.producerOwnerId || previousId,
      };
      socket._wrdRebindOperation = operation;
      const clearRebind = () => {
        // Never release a newer operation's input gate from an old callback.
        if (socket._wrdRebindOperation !== operation) return;
        socket._wrdRebindOperation = null;
        socket._wrdRebindPending = false;
      };
      const sendRebind = () => {
        if (operation.settled || socket._wrdRebindOperation !== operation
          || connections.host !== operation.host) return;
        operation.rebindAttempt += 1;
        const attempt = operation.rebindAttempt;
        operation.activeRebindAttempt = attempt;
        operation.host.timeout(rebindAckTimeoutsMs[attempt - 1]).emit('viewer-session-rebind', {
          previousViewerId: previousId,
          viewerId: nextId,
          ...previousLease,
          ...(priorProgress ? {
            connectionAttemptId: priorProgress.connectionAttemptId,
            connectionAttemptSequence: priorProgress.connectionAttemptSequence,
          } : {}),
        }, (error, ack) => finishRebind(error
          ? { status: 'rejected', reason: 'rebind-timeout' }
          : ack, attempt));
      };
      const finishRebind = (ack, attempt) => {
        if (operation.settled) return;
        if (attempt !== operation.activeRebindAttempt) return;
        if (socket._wrdRebindOperation !== operation
          || connections.viewers.get(nextId) !== operation.socket
          || socket._wrdDisconnected === true) {
          operation.settled = true;
          if (socket._wrdRebindOperation === operation
            && connections.viewers.get(nextId) === socket) {
            clearLegacyRelayCompanion(nextId, { stop: true });
          }
          clearRebind();
          return;
        }
        const activeLease = withLeaseExpiry(() => desktopLease.getActiveLease(nextId));
        if (!activeLease || activeLease.leaseId !== operation.lease.leaseId
          || activeLease.leaseEpoch !== operation.lease.leaseEpoch) {
          operation.settled = true;
          clearRebind();
          return;
        }
        const currentProgress = mediaActivityProgress.get(nextId);
        const progressMatches = operation.attempt == null
          ? currentProgress == null
          : currentProgress === operation.attempt;
        if (connections.host !== operation.host || !progressMatches) {
          operation.settled = true;
          // A cancelled migration must revoke its still-current authority before
          // reopening the pending gate, even if a replacement Host reused its ID.
          const reason = 'rebind-cancelled';
          clearLegacyRelayCompanion(nextId, { stop: true });
          const result = desktopLease.beginRelease({ viewerId: nextId, reason });
          dispatchLeaseEffect(result, reason);
          clearRebind();
          emitControlEvent('viewer_rebind_failed', { viewerId: nextId, previousViewerId: previousId, sessionId, reason });
          return;
        }
        if (ack?.status === 'applied') {
          operation.settled = true;
          const renewed = withLeaseExpiry(() => desktopLease.heartbeat({ viewerId: nextId, ...activeLease }));
          if (!renewed.ok) {
            clearRebind();
            return;
          }
          clearRebind();
          sendGrant(nextId, activeLease);
          emitControlEvent('viewer_rebind_confirmed', { viewerId: nextId, previousViewerId: previousId, sessionId, leaseEpoch: activeLease.leaseEpoch });
          return;
        }
        if (ack?.reason === 'rebind-timeout'
          && operation.rebindAttempt < rebindAckTimeoutsMs.length) {
          emitControlEvent('viewer_rebind_retry', {
            viewerId: nextId,
            previousViewerId: previousId,
            sessionId,
            leaseEpoch: activeLease.leaseEpoch,
            attempt: operation.rebindAttempt,
            reason: 'rebind-timeout',
          });
          sendRebind();
          return;
        }
        operation.settled = true;
        clearLegacyRelayCompanion(nextId, { stop: true });
        clearRebind();
        const reason = ack?.reason === 'rebind-timeout' ? 'rebind-timeout' : 'rebind-rejected';
        const result = desktopLease.beginRelease({ viewerId: nextId, reason });
        dispatchLeaseEffect(result, reason);
        emitControlEvent('viewer_rebind_failed', { viewerId: nextId, previousViewerId: previousId, sessionId, reason });
      };
      sendRebind();
    }
    previous._wrdRemoved = true;
    emitControlEvent('viewer_reconnected', {
      viewerId: nextId,
      previousViewerId: previousId,
      sessionId,
    });
    emitViewerStatus('viewer-reconnected', socket);
    broadcastControlState('viewer-reconnected');
    return true;
  }

  function scheduleDesktopViewerGrace(socket) {
    const sessionId = socket?._wrdViewerSessionId;
    if (!sessionId || viewerDisconnectGraceMs <= 0) return false;
    if (connections.viewers.get(socket.id) !== socket) return false;
    const existing = viewerSessionBindings.get(sessionId);
    if (existing?.timer) clearTimeoutFn(existing.timer);
    const timer = setTimeoutFn(() => {
      const binding = viewerSessionBindings.get(sessionId);
      if (!binding || binding.socket !== socket) return;
      viewerSessionBindings.delete(sessionId);
      socket._wrdViewerSessionTimer = null;
      const removed = removeDesktopViewer(socket, 'viewer-disconnect-timeout');
      // Observation follows the identity-checked authority operation. A sink
      // failure must not change removal or the reset-only barrier.
      if (removed) {
        try {
          const snapshot = desktopLease.snapshot();
          emitControlEvent('viewer_disconnect_grace_expired', {
            viewerId: socket.id, sessionId, reason: 'viewer-disconnect-timeout',
            leaseEpoch: snapshot.leaseEpoch, state: snapshot.state,
          });
        } catch (_error) { /* best effort */ }
      }
    }, viewerDisconnectGraceMs);
    timer?.unref?.();
    viewerSessionBindings.set(sessionId, { socket, timer });
    socket._wrdViewerSessionTimer = timer;
    emitControlEvent('viewer_disconnect_grace_started', {
      viewerId: socket.id,
      sessionId,
      graceMs: viewerDisconnectGraceMs,
    });
    return true;
  }

  // Single cleanup entry for desktop viewers. Map identity guard is the only
  // idempotency latch (compatible with FakeSocket; no socket.data required).
  function removeDesktopViewer(socket, reason = 'viewer-disconnected') {
    if (!socket) return null;
    if (connections.viewers.get(socket.id) !== socket) return null;
    clearViewerSessionBinding(socket);
    clearLegacyRelayCompanion(socket.id, { stop: true });
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
    if (reason === 'lease-expired') {
      for (const viewer of connections.viewers.values()) summarizeControlHeartbeat(viewer, 'lease-expired');
    }
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
    const observation = controlHeartbeatObservation(viewerSocket);
    if (observation.leaseEpoch !== lease.leaseEpoch) {
      observation.scopeAttemptSequence = null;
      observation.lastAcceptedHeartbeatSeq = null;
      observation.lastAckEnqueuedHeartbeatSeq = null;
    }
    observation.leaseEpoch = lease.leaseEpoch;
    observation.lastGrantAt = heartbeatNow();
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
      profileSequence: 0,
      profileFingerprint: null,
      profile: null,
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

  function relayScopeHasCurrentOwner(viewerId, scope) {
    const current = controlSnapshot();
    return validRelayScope(scope) && current.state === 'ACTIVE'
      && current.controllerViewerId === viewerId && current.leaseEpoch === scope.leaseEpoch
      && currentViewerConnectionAttempt(viewerId) === scope.connectionAttemptId;
  }

  function resolveViewerRecoveryKey(viewerId, data = {}) {
    const prior = mediaActivityProgress.get(viewerId);
    if (!prior
      || !isValidConnectionAttemptId(prior.connectionAttemptId)
      || !isValidConnectionAttemptSequence(prior.connectionAttemptSequence)) {
      return null;
    }
    // Recovery telemetry is an epoch-scoped envelope. Never infer a missing
    // correlation from the socket's latest binding: a delayed legacy event
    // from A could otherwise be relabeled as the current B episode.
    if (!isValidConnectionAttemptId(data.connectionAttemptId)
      || !isValidConnectionAttemptSequence(data.connectionAttemptSequence)
      || !isValidConnectionAttemptSequence(data.generation)) {
      return null;
    }
    if (data.connectionAttemptId !== prior.connectionAttemptId
      || data.connectionAttemptSequence !== prior.connectionAttemptSequence
      || data.generation !== prior.connectionAttemptSequence) {
      return null;
    }
    return {
      connectionAttemptId: prior.connectionAttemptId,
      connectionAttemptSequence: prior.connectionAttemptSequence,
      generation: prior.connectionAttemptSequence,
    };
  }

  function resolveProfileWrite(viewerId, data, sanitized) {
    const prior = mediaActivityProgress.get(viewerId);
    if (!prior || !isValidConnectionAttemptId(prior.connectionAttemptId)) {
      return { ok: false, reason: 'no-active-attempt' };
    }
    // The client can only assert that it still believes this is current. Signal
    // remains the authority and derives the identity forwarded to Host.
    if (data.connectionAttemptId !== undefined && data.connectionAttemptId !== prior.connectionAttemptId) {
      return { ok: false, reason: 'wrong-attempt' };
    }
    const suppliedSequence = data.profileSequence;
    if (suppliedSequence !== undefined
      && (!Number.isSafeInteger(suppliedSequence) || suppliedSequence < 1)) {
      return { ok: false, reason: 'invalid-profile-sequence' };
    }
    const fingerprint = JSON.stringify(sanitized);
    const priorSequence = Number.isSafeInteger(prior.profileSequence) ? prior.profileSequence : 0;
    // Legacy payloads carry neither field. Signal derives a strictly advancing
    // profile generation from the current authoritative attempt binding.
    const sequence = suppliedSequence === undefined ? priorSequence + 1 : suppliedSequence;
    if (!Number.isSafeInteger(sequence)) {
      return {
        ok: false,
        reason: suppliedSequence === undefined ? 'profile-sequence-exhausted' : 'invalid-profile-sequence',
      };
    }
    if (sequence < priorSequence) {
      return { ok: false, reason: 'stale-profile-sequence' };
    }
    if (sequence === priorSequence) {
      return prior.profileFingerprint === fingerprint
        ? {
            ok: true,
            idempotent: true,
            connectionAttemptId: prior.connectionAttemptId,
            generation: prior.connectionAttemptSequence,
            profileSequence: sequence,
            profileGeneration: sequence,
          }
        : { ok: false, reason: 'conflicting-profile-sequence' };
    }
    prior.profileSequence = sequence;
    prior.profileFingerprint = fingerprint;
    prior.profile = { ...sanitized };
    return {
      ok: true,
      idempotent: false,
      connectionAttemptId: prior.connectionAttemptId,
      generation: prior.connectionAttemptSequence,
      profileSequence: sequence,
      profileGeneration: sequence,
    };
  }

  function forwardSanitizedMediaProfile(socket, data, sanitized) {
    const resolved = resolveProfileWrite(socket.id, data, sanitized);
    if (!resolved.ok) {
      emitControlEvent('media_profile_rejected', {
        viewerId: socket.id,
        reason: resolved.reason || 'profile-rejected',
      });
      socket.emit('media-profile-rejected', { reason: resolved.reason });
      return false;
    }
    sanitized.connectionAttemptId = resolved.connectionAttemptId;
    sanitized.generation = resolved.generation;
    sanitized.profileSequence = resolved.profileSequence;
    sanitized.profileGeneration = resolved.profileGeneration;
    if (connections.host) {
      connections.host.emit('media-profile-change', sanitized);
    }
    return true;
  }

  function legacyResolutionProfile(viewerId, width, height) {
    const previous = mediaActivityProgress.get(viewerId)?.profile || {};
    const is1080 = height >= 1000 || width * height >= 1920 * 1080;
    const is720 = height >= 700 || width * height >= 1152 * 720;
    const defaultBitrateKbps = is1080 ? 2500 : is720 ? 1800 : 1200;
    return {
      viewerId,
      profile: ['high', 'medium', 'low', 'survival'].includes(previous.profile)
        ? previous.profile
        : 'high',
      width,
      height,
      targetFps: clampInt(previous.targetFps, 5, 30, 20),
      videoBitrateKbps: clampInt(previous.videoBitrateKbps, 250, 5000, defaultBitrateKbps),
      reason: 'legacy-resolution-change',
      mediaPolicy: previous.mediaPolicy === 'strict-stun' ? 'strict-stun' : 'unknown',
      adaptiveResolution: false,
      continuityAction: 'none',
    };
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

  function rejectMediaActivity(socket, event, reason, value) {
    // Correlate only validated request fields. A delayed rejection must retain
    // the rejected request's identity, and must never echo its lease token.
    const scoped = value && ['active', 'suspended'].includes(value.state)
      && Number.isSafeInteger(value.generation) && value.generation >= 1
      && isValidConnectionAttemptId(value.connectionAttemptId);
    socket.emit(event, {
      reason,
      ...(scoped ? { schemaVersion: 1, state: value.state, generation: value.generation,
        connectionAttemptId: value.connectionAttemptId } : {}),
    });
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
  function observeNamespaceOutcome(outcome) {
    try { options.observeNamespaceOutcome?.(outcome); } catch { /* Observation must not affect authentication. */ }
  }

  // Use default namespace for all connections
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      observeNamespaceOutcome('missing_auth');
      return next(new Error('Authentication required'));
    }
    let decoded = null;
    try { decoded = verifyRuntimeToken(token); } catch (_error) { decoded = null; }
    if (!decoded) {
      observeNamespaceOutcome('invalid_auth');
      return next(new Error('Invalid token'));
    }
    socket.user = decoded;
    socket.inputProtocolVersion = Number.parseInt(socket.handshake.auth?.inputProtocolVersion, 10) === 2 ? 2 : 1;
    const claimedRole = socket.handshake.auth?.role;
    socket.userRole = decoded.role === 'viewer' && claimedRole === 'relay-viewer'
      ? 'relay-viewer'
      : decoded.role;
    observeNamespaceOutcome('accepted');
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
      const proofAdmission = socket.handshake.auth?.proofAdmission;
      const isProofViewer = Boolean(proofAdmission);
      if (requiresViewerProof() && !isProofViewer) {
        socket.emit('proof-admission-rejected', { reason: 'viewer-proof-required' });
        socket.disconnect(true);
        return;
      }
      if (isProofViewer && !admitProofViewer(proofAdmission, socket.id)) {
        socket.emit('proof-admission-rejected', { reason: 'viewer-epoch-changed' });
        socket.disconnect(true);
        return;
      }
      let humanAdmission = null;
      if (!isProofViewer) {
        const session = normalizeViewerSessionId(socket.handshake.auth?.viewerSessionId);
        humanAdmission = instanceRuntime.viewerAdmission.admit({
          subject: socket.user?.sub,
          session,
          admission: socket.handshake.auth?.viewerAdmission,
          initialContext: instanceRuntime.viewerAdmissionContext(),
          occupied: connections.viewers.size > 0,
          sameSessionOccupancy: [...connections.viewers.values()].every(other =>
            !other._wrdProofViewer && other._wrdViewerSessionId === session
            && other.user?.sub === socket.user?.sub),
        });
        if (!humanAdmission.ok) {
          socket.emit('viewer-admission-rejected', { reason: humanAdmission.reason });
          socket.disconnect(true);
          return;
        }
        noteHumanViewerAdmission();
      }
      socket._wrdProofViewer = isProofViewer;
      socket._wrdDisconnected = false;
      socket._wrdViewerSessionId = normalizeViewerSessionId(socket.handshake?.auth?.viewerSessionId);
      // Hard order: claim map slot → supersede others → only then welcome incoming.
      // New desktop viewers never auto-acquire control.
      const rebound = rebindDisconnectedViewer(socket);
      if (!rebound) {
        connections.viewers.set(socket.id, socket);
        supersedeOtherDesktopViewers(socket);
      }
      if (connections.viewers.size > 1) clearAllLegacyRelayCompanions({ stop: true });
      try {
        options.observeViewerHeartbeat?.(socket, () => connections.viewers.get(socket.id) === socket);
      } catch { /* Diagnostics cannot affect Viewer admission or welcome. */ }
      socket.emit('connected', {
        role: 'viewer',
        status: 'ok',
        controlHeartbeatAckVersion: 1,
        ...(humanAdmission ? { viewerAdmission: { mode: 'resume', generation: humanAdmission.generation } } : {}),
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
      if (requiresViewerProof()) {
        socket.emit('proof-admission-rejected', { reason: 'relay-viewer-disabled' });
        socket.disconnect(true);
        return;
      }
      connections.relayViewers.set(socket.id, socket);
      socket.emit('connected', {
        role: 'relay-viewer',
        status: 'ok',
        hostOnline: connections.host !== null
      });
    }

    socket.on('control-acquire', (data = {}) => {
      if (role !== 'viewer' || connections.viewers.get(socket.id) !== socket || socket._wrdDisconnected) return;
      if (socket._wrdRebindPending) {
        const snapshot = controlSnapshot();
        socket.emit('control-acquire-result', {
          state: snapshot.state, reason: 'reset-in-progress', leaseEpoch: snapshot.leaseEpoch,
          requestId: data.requestId || null,
        });
        return;
      }
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

    socket.on('control-heartbeat', (data = {}, acknowledge) => {
      if (role !== 'viewer' || !isActiveViewerSocket(socket)) return;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      const progress = mediaActivityProgress.get(socket.id);
      const ackScopeMatches = Boolean(progress && data.heartbeatAckVersion === 1
        && Number.isSafeInteger(data.heartbeatSeq) && data.heartbeatSeq >= 1
        && progress?.connectionAttemptId === data.connectionAttemptId
        && progress?.connectionAttemptSequence === data.connectionAttemptSequence);
      const result = withLeaseExpiry(() => desktopLease.heartbeat({
        viewerId: socket.id,
        leaseId: data.leaseId,
        leaseEpoch: data.leaseEpoch,
      }));
      const observation = observeControlHeartbeat(socket, data, result, ackScopeMatches);
      if (!result.ok && observation.rejected === 1) summarizeControlHeartbeat(socket, 'rejected');
      if (!result.ok) socket.emit('control-heartbeat-rejected', { reason: result.reason });
      if (result.ok && ackScopeMatches && typeof acknowledge === 'function') {
        try {
          acknowledge({ schemaVersion: 1, status: 'accepted', heartbeatSeq: data.heartbeatSeq,
            leaseEpoch: data.leaseEpoch, connectionAttemptId: progress.connectionAttemptId,
            connectionAttemptSequence: progress.connectionAttemptSequence });
          observation.ackEnqueued = heartbeatCount(observation.ackEnqueued + 1);
          observation.lastAckEnqueuedHeartbeatSeq = data.heartbeatSeq;
        } catch (_error) { /* Renewal is already committed; ACK enqueue is best effort. */ }
      }
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
      let completedResetEpoch = null;
      const result = withLeaseExpiry(() => {
        // Expiry may replace a candidate with a reset-only barrier. Inspect the
        // actual pending transition after expiry, immediately before the ACK.
        const pending = desktopLease.snapshot();
        const effect = status === 'applied'
          ? desktopLease.confirmTransition({ leaseEpoch: data.leaseEpoch })
          : desktopLease.failTransition({
            leaseEpoch: data.leaseEpoch,
            reason: data.reason || 'transition-failed',
          });
        if (status === 'applied' && isResetOnlyPending(pending)
          && pending.leaseEpoch === data.leaseEpoch && effect.state === 'FREE') {
          completedResetEpoch = pending.leaseEpoch;
        }
        return effect;
      });
      if (status === 'applied' && result.state === 'FREE') {
        cancelResetRetry();
      } else if (status === 'applied' && result.lease) {
        cancelResetRetry();
      }
      if (completedResetEpoch !== null) {
        emitControlEvent('control_reset_completed', {
          leaseEpoch: completedResetEpoch,
          status: 'applied',
          state: 'FREE',
        });
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
        && (socket.inputProtocolVersion !== 2 || (connections.host && !hostSupportsV2Input()))) {
        socket.emit('input-protocol-error', { reason: v2ProtocolError(socket) });
        return;
      }
      if (data?.schemaVersion === 2 && !connections.host) {
        console.warn(`[OFFER] No host connected, dropping offer from ${socket.id} epoch=${data.epoch}`);
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
        emitInputEvent('signal_input_rejected', socket, data, { status: 'rejected', reason: 'role-rejected' });
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Input rejected: disconnected viewer ${socket.id}`);
        emitInputEvent('signal_input_rejected', socket, data, { status: 'rejected', reason: 'inactive-viewer' });
        return;
      }
      if (data?.schemaVersion === 2
        && (socket.inputProtocolVersion !== 2 || (connections.host && !hostSupportsV2Input()))) {
        socket.emit('input-protocol-error', { reason: v2ProtocolError(socket) });
        emitInputEvent('signal_input_rejected', socket, data, { status: 'rejected', reason: 'protocol-too-old' });
        return;
      }
      if (data?.schemaVersion === 2 && !connections.host) {
        emitInputEvent('signal_input_rejected', socket, data, { status: 'rejected', reason: 'host-unavailable' });
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
        const validation = validateRemoteInput(data);
        const authorized = validation.ok && authorizeViewer(socket, data, { legacy: false });
        if (!validation.ok || !authorized) {
          const reason = validation.ok ? 'unauthorized' : validation.code;
          logger.warn?.(`[INPUT] rejected viewer=${socket.id} ${reason}`);
          emitInputEvent('signal_input_rejected', socket, data, { status: 'rejected', reason });
          return;
        }
        if (!['keyboard', 'mouse', 'command'].includes(data.type)) {
          logger.warn?.(`[INPUT] rejected viewer=${socket.id} INVALID_TYPE`);
          emitInputEvent('signal_input_rejected', socket, data, { status: 'rejected', reason: 'INVALID_TYPE' });
          return;
        }
      }
      const highFrequency = isHighFrequencyInput(data);
      if (!highFrequency) {
        const summary = summarizeInputEvent(data, { status: 'accepted' });
        logger.log?.(`[INPUT] relay viewer=${socket.id} type=${summary.inputType} action=${summary.action} transport=${summary.transport} payloadBytes=${summary.payloadBytes} inputIdHash=${summary.inputIdHash || '-'}`);
      }
      if (connections.host) {
        connections.host.emit('input', {
          ...data,
          transport: 'socket',
          viewerId: socket.id
        });
        if (data?.schemaVersion === 2 && data.action === 'reset'
          && ['keyboard', 'mouse'].includes(data.type)) {
          resetAckObserver.noteForwarded({
            schemaVersion: data.schemaVersion, type: data.type, action: data.action,
            leaseEpoch: data.leaseEpoch, inputIds: data.inputIds, viewerId: socket.id,
          });
        }
        emitInputEvent('signal_input_relayed', socket, data, { status: 'accepted' });
      } else {
        console.warn('[INPUT] No host connected, dropping input');
        emitInputEvent('signal_input_rejected', socket, data, { status: 'rejected', reason: 'host-unavailable' });
      }
    });

    socket.on('input-ack', (data = {}) => {
      if (role !== 'host' || connections.host !== socket) {
        logger.warn?.(`[INPUT] ack rejected role=${role}`);
        return;
      }
      const viewerSocket = connections.viewers.get(String(data.viewerId || ''));
      const shapeValid = validV2InputAckShape(data);
      const observeAck = forwarded => resetAckObserver.observeAck(data, {
        targetAvailable: Boolean(viewerSocket), shapeValid, forwarded,
      });
      if (!viewerSocket) { observeAck(false); return; }
      const inputIds = Array.isArray(data.inputIds) ? data.inputIds.slice(0, 64) : [];
      const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
      const hostExecuteMs = duration(data.hostExecuteMs);
      const timing = data.timingSchemaVersion === 1 ? {
        timingSchemaVersion: 1,
        hostAdapterAwaitMs: duration(data.hostAdapterAwaitMs),
        hostQueueMs: duration(data.hostQueueMs),
        hostApplyMs: duration(data.hostApplyMs),
      } : {};
      if (data.schemaVersion === 2) {
        const inputType = data.inputType;
        const independentAck = inputType === 'mouse';
        if (!shapeValid) {
          observeAck(false);
          logger.warn?.('[INPUT] invalid v2 ack');
          return;
        }
        viewerSocket.emit('input-ack', {
          type: 'input_ack',
          schemaVersion: 2,
          inputType,
          leaseEpoch: data.leaseEpoch,
          ...((independentAck && data.appliedSeq === undefined) ? {} : { appliedSeq: data.appliedSeq }),
          status: data.status,
          ...(independentAck ? {} : { pressedKeyCount: data.pressedKeyCount, modifierMask: data.modifierMask }),
          inputIds,
          hostExecuteMs,
          ...timing,
          transport: 'socket',
        });
        observeAck(true);
        return;
      }
      viewerSocket.emit('input-ack', {
        type: 'input_ack',
        schemaVersion: 1,
        inputIds,
        hostExecuteMs,
        ...timing,
        transport: 'socket',
      });
      observeAck(true);
    });

    // Diagnostic logs relay (viewer -> host) + persist to disk
    socket.on('diagnostic', (data, acknowledge) => {
      const rejectDiagnostic = () => {
        if (typeof acknowledge === 'function') acknowledge({ accepted: false, diagnosticId: null, eventIdHashes: [] });
      };
      if (role !== 'viewer') {
        console.warn(`Diagnostic rejected: role=${role} from ${socket.id}`);
        rejectDiagnostic(); return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Diagnostic rejected: disconnected viewer ${socket.id}`);
        rejectDiagnostic(); return;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) { rejectDiagnostic(); return; }
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
      if (result.accepted && !result.duplicate) {
        try { options.observeDiagnostic?.(result.report); } catch { /* Evidence is best effort. */ }
      }
      if (result.accepted && result.summaryEvent) {
        recentEventStore?.append(result.summaryEvent);
        structuredLogger?.info(result.summaryEvent);
      }

      if (typeof acknowledge === 'function') acknowledge(result.receipt || { accepted: false, diagnosticId: null, eventIdHashes: [] });

      // Also relay to host for real-time analysis
      if (result.accepted && !result.duplicate && connections.host) {
        connections.host.emit('diagnostic', result.report);
      }
    });

    socket.on('viewer-stats', (data = {}) => {
      if (role !== 'viewer') {
        console.warn(`Viewer stats rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (!isActiveViewerSocket(socket)) {
        console.warn(`Viewer stats rejected: disconnected viewer ${socket.id}`);
        return;
      }
      const recoveryKey = resolveViewerRecoveryKey(socket.id, data);
      if (!recoveryKey) return;
      const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
      if (connections.host) {
        connections.host.emit('viewer-stats', {
          ...data,
          rttMs: duration(data.rttMs),
          jitterBufferMs: duration(data.jitterBufferMs),
          ...recoveryKey,
          viewerId: socket.id,
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
      // Every profile write derives its identity at Signal. Legacy payloads
      // receive the current binding and next profile generation; no binding is
      // rejected before anything reaches Host.
      forwardSanitizedMediaProfile(socket, data, sanitized);
    });

    socket.on('request-keyframe', (data = {}) => {
      if (role !== 'viewer') return;
      if (!isActiveViewerSocket(socket)) return;
      if (socket.inputProtocolVersion === 2) {
        if (data?.schemaVersion !== 2 || !authorizeViewer(socket, data, { legacy: false })) return;
      } else if (data?.schemaVersion === 2 && !authorizeViewer(socket, data, { legacy: false })) {
        return;
      }
      const recoveryKey = resolveViewerRecoveryKey(socket.id, data);
      if (!recoveryKey) return;
      if (!Number.isSafeInteger(data.requestSequence) || data.requestSequence < 1) return;
      if (!connections.host) return;
      connections.host.emit('request-keyframe', {
        viewerId: socket.id,
        reason: String(data.reason || 'media-stalled').slice(0, 80),
        schemaVersion: data.schemaVersion === 2 ? 2 : undefined,
        leaseId: typeof data.leaseId === 'string' ? data.leaseId : undefined,
        leaseEpoch: Number.isSafeInteger(data.leaseEpoch) ? data.leaseEpoch : undefined,
        ...recoveryKey,
        requestSequence: data.requestSequence,
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
        rejectMediaActivity(socket, 'media-activity-rejected', validated.code);
        return;
      }
      const value = validated.value;
      if (!authorizeViewer(socket, {
        schemaVersion: 2,
        leaseId: value.leaseId,
        leaseEpoch: value.leaseEpoch,
      }, { legacy: false })) {
        rejectMediaActivity(socket, 'media-activity-rejected', 'unauthorized', value);
        return;
      }
      const currentAttempt = currentViewerConnectionAttempt(socket.id);
      // Media control never establishes attempt authority. Only offer or explicit
      // connection-attempt-bind may bind; then only the active attempt may write.
      if (!currentAttempt || value.connectionAttemptId !== currentAttempt) {
        rejectMediaActivity(socket, 'media-activity-rejected', 'wrong-attempt', value);
        return;
      }
      const prior = mediaActivityProgress.get(socket.id);
      if (prior
        && prior.connectionAttemptId === value.connectionAttemptId
        && value.generation <= prior.generation) {
        rejectMediaActivity(socket, 'media-activity-rejected', 'stale-generation', value);
        return;
      }
      noteMediaGenerationProgress(socket.id, value.connectionAttemptId, value.generation);
      const summary = summarizeMediaActivity(value);
      emitControlEvent('media_activity_requested', {
        ...summary,
        viewerId: socket.id,
      });
      if (!connections.host) {
        rejectMediaActivity(socket, 'media-activity-rejected', 'host-offline', value);
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
      if (!isActiveViewerSocket(viewerSocket)) return;
      releaseRejectedMediaProgress(viewerId, data);
      viewerSocket.emit('media-activity-ack', {
        schemaVersion: 1,
        state: data.state === 'active' ? 'active' : 'suspended',
        generation: Number.isSafeInteger(data.generation) ? data.generation : null,
        connectionAttemptId: typeof data.connectionAttemptId === 'string' ? data.connectionAttemptId : null,
        applied: data.applied === true,
        keyframeRequested: data.keyframeRequested === true,
        ...(data.applied !== true && MEDIA_ACTIVITY_ACK_FAILURE_REASONS.has(data.reason)
          ? { reason: data.reason } : {}),
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
          rejectMediaActivity(socket, 'relay-stream-control-rejected', 'unauthorized', data);
          return;
        }
        if (!isValidConnectionAttemptId(data.connectionAttemptId)
          || !Number.isSafeInteger(data.generation) || data.generation < 1) {
          rejectMediaActivity(socket, 'relay-stream-control-rejected', 'invalid-media-control');
          return;
        }
        const currentAttempt = currentViewerConnectionAttempt(socket.id);
        // Tunnel media control must not invent attempt authority. Bind first via
        // connection-attempt-bind (or a WebRTC offer that shares the same record).
        if (!currentAttempt || data.connectionAttemptId !== currentAttempt) {
          rejectMediaActivity(socket, 'relay-stream-control-rejected', 'wrong-attempt', data);
          return;
        }
        const prior = mediaActivityProgress.get(socket.id);
        if (prior
          && prior.connectionAttemptId === data.connectionAttemptId
          && data.generation <= prior.generation) {
          rejectMediaActivity(socket, 'relay-stream-control-rejected', 'stale-generation', data);
          return;
        }
        noteMediaGenerationProgress(socket.id, data.connectionAttemptId, data.generation);
      } else if (role === 'viewer' && data?.schemaVersion === 2
        && !authorizeViewer(socket, data, { legacy: false })) {
        return;
      }
      if (role === 'viewer' && !isMediaControl && data.enabled && 'relayFrameSchemaVersion' in data) {
        if (data.schemaVersion !== 2 || !authorizeViewer(socket, data, { legacy: false })
          || data.relayFrameSchemaVersion !== 1 || !validRelayNonce(data.relayStartRequestId, 64)
          || !isValidConnectionAttemptId(data.connectionAttemptId) || !validRelayNonce(data.connectionAttemptId, 128)
          || currentViewerConnectionAttempt(socket.id) !== data.connectionAttemptId
          || !Number.isSafeInteger(data.relayMediaGeneration) || data.relayMediaGeneration < 0) {
          socket.emit('relay-stream-control-rejected', { reason: 'invalid-relay-start' });
          return;
        }
      }
      let viewerId = socket.id;
      if (role === 'relay-viewer') {
        if (connections.relayViewers.get(socket.id) !== socket) return;
        const boundOwnerId = legacyRelayOwnerForCompanion(socket.id);
        if (boundOwnerId && !hasActiveLegacyRelayOwner(boundOwnerId)) return;
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
      if (!isActiveViewerSocket(viewerSocket)) return;
      releaseRejectedMediaProgress(viewerId, data);
      const ack = {
        schemaVersion: 1,
        state: data.state === 'active' ? 'active' : 'suspended',
        generation: Number.isSafeInteger(data.generation) ? data.generation : null,
        connectionAttemptId: typeof data.connectionAttemptId === 'string' ? data.connectionAttemptId : null,
        applied: data.applied === true,
      };
      if ('relayFrameSchemaVersion' in data) {
        if (data.relayFrameSchemaVersion !== 1 || !relayScopeHasCurrentOwner(viewerId, data.relayScope)) return;
        ack.relayFrameSchemaVersion = 1;
        ack.relayScope = { ...data.relayScope };
      }
      if (data.relayControlKind === 'start') {
        if (!validRelayNonce(data.relayStartRequestId, 64)) return;
        ack.relayControlKind = 'start';
        ack.relayStartRequestId = data.relayStartRequestId;
      }
      if (data.applied !== true && MEDIA_ACTIVITY_ACK_FAILURE_REASONS.has(data.reason)) {
        ack.reason = data.reason;
      }
      // Dual-route: media runtime listens on media-activity-ack; keep explicit tunnel event too.
      viewerSocket.emit('relay-stream-control-ack', ack);
      viewerSocket.emit('media-activity-ack', ack);
    });

    socket.on('relay-frame', (data) => {
      if (role !== 'host' || connections.host !== socket) {
        console.warn(`Relay frame rejected: role=${role} from ${socket.id}`);
        return;
      }
      if ('relayFrameSchemaVersion' in data
        && (data.relayFrameSchemaVersion !== 1 || !relayScopeHasCurrentOwner(data.viewerId, data.relayScope))) return;
      if (legacyRelayOwnerIds.has(data.viewerId)) {
        const companionId = hasActiveLegacyRelayOwner(data.viewerId)
          ? legacyRelayCompanionByOwner.get(data.viewerId)
          : null;
        const companionSocket = companionId && connections.relayViewers.get(companionId);
        if (companionSocket) companionSocket.volatile.emit('relay-frame', data);
        return;
      }
      const viewerSocket = connections.viewers.get(data.viewerId);
      if (isActiveViewerSocket(viewerSocket)) {
        viewerSocket.volatile.emit('relay-frame', data);
      }
    });

    socket.on('relay-frame-feedback', (data = {}) => {
      if (role !== 'host' || connections.host !== socket || data.relayFrameSchemaVersion !== 1
        || !relayScopeHasCurrentOwner(data.viewerId, data.relayScope)) return;
      const viewer = connections.viewers.get(data.viewerId);
      if (!isActiveViewerSocket(viewer)) return;
      const counters = ['feedbackSequence', 'pendingCount', 'expiredCount', 'unmatchedAckCount', 'timeoutCount', 'coalescedCount'];
      if (!counters.every(k => Number.isSafeInteger(data[k]) && data[k] >= (k === 'feedbackSequence' ? 1 : 0))) return;
      const ages = ['oldestPendingAgeMs', 'lastSentAgeMs', 'lastAckAgeMs'];
      if (!ages.every(k => data[k] === null || (typeof data[k] === 'number' && Number.isFinite(data[k]) && data[k] >= 0))) return;
      const sample = data.sample;
      if (sample !== null && (!sample || !Number.isSafeInteger(sample.sampleSequence) || sample.sampleSequence < 1
        || typeof sample.relayFrameAckRttMs !== 'number' || !Number.isFinite(sample.relayFrameAckRttMs)
        || sample.relayFrameAckRttMs < 0 || sample.relayFrameAckRttMs >= 2000)) return;
      const forwarded = { relayFrameSchemaVersion: 1, relayScope: { ...data.relayScope }, viewerId: data.viewerId,
        sample: sample === null ? null : { sampleSequence: sample.sampleSequence, relayFrameAckRttMs: sample.relayFrameAckRttMs } };
      for (const key of [...counters, ...ages]) forwarded[key] = data[key];
      viewer.emit('relay-frame-feedback', forwarded);
    });

    socket.on('relay-frame-ack', (data) => {
      if (role !== 'viewer' && role !== 'relay-viewer') {
        return;
      }
      if (connections.host) {
        if (role === 'relay-viewer' && connections.relayViewers.get(socket.id) !== socket) return;
        if (role === 'viewer' && !isActiveViewerSocket(socket)) return;
        if (role === 'viewer' && data?.schemaVersion === 2 && !authorizeViewer(socket, data, { legacy: false })) return;
        if ('relayFrameSchemaVersion' in data && (role !== 'viewer' || data.schemaVersion !== 2
          || data.relayFrameSchemaVersion !== 1 || !authorizeViewer(socket, data, { legacy: false })
          || !relayScopeHasCurrentOwner(socket.id, data.relayScope))) return;
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
      // Older cached Viewers use resolution-change. Convert it at Signal to
      // the authoritative profile channel; resolveProfileWrite owns the next
      // sequence and validates the current attempt instead of Host inventing
      // a profile generation from an unsequenced size write.
      forwardSanitizedMediaProfile(
        socket,
        data,
        legacyResolutionProfile(socket.id, width, height),
      );
    });

    socket.on('host-capabilities', (data = {}) => {
      if (role !== 'host' || connections.host !== socket) return;
      const snapshot = setHostCapabilities(data);
      connections.viewers.forEach((viewerSocket) => {
        viewerSocket.emit('host-capabilities', snapshot);
      });
    });

    socket.on('disconnect', (reason) => {
      if (role === 'viewer') summarizeControlHeartbeat(socket, 'socket-disconnected');
      const disconnectEvent = {
        domain: 'signaling', event: 'signal_socket_disconnected',
        message: 'Signaling socket disconnected',
        meta: { role, reason: normalizeDisconnectReason(reason) },
      };
      // Observability failures must never interrupt the existing authority cleanup.
      try { structuredLogger?.info?.(disconnectEvent); } catch (_error) { /* best effort */ }
      try { recentEventStore?.append?.(disconnectEvent); } catch (_error) { /* best effort */ }
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
        // Socket.IO assigns a new id after a transport reconnect. Keep the
        // authoritative viewer/lease for a short authenticated grace window,
        // while marking the old socket inactive so delayed packets cannot
        // write through the preserved context.
        socket._wrdDisconnected = true;
        if (!scheduleDesktopViewerGrace(socket)) {
          removeDesktopViewer(socket, 'viewer-disconnected');
        }
      } else if (role === 'relay-viewer') {
        connections.relayViewers.delete(socket.id);
        const ownerId = legacyRelayOwnerForCompanion(socket.id);
        if (ownerId) clearLegacyRelayCompanion(ownerId, { stop: true });
      }
    });
  });

  return connections;
}

function getConnectionStatus(context = runtime) {
  return {
    hostOnline: Boolean(context.connections.host),
    hostId: context.connections.host ? context.connections.host.id : null,
    viewerCount: context.connections.viewers.size,
    relayViewerCount: context.connections.relayViewers.size,
    viewers: getViewerSnapshot(context),
    viewerEpoch: context.viewerEpoch(),
  };
}

function issueProofAdmission(context = runtime) {
  return context.issueProofAdmission();
}

module.exports = {
  setupSignaling,
  connections,
  runtimeContext: runtime,
  createRuntimeContext,
  getConnectionStatus,
  getHostCapabilities,
  setHostCapabilities,
  clearHostCapabilities,
  ingestDiagnosticPayload,
  issueProofAdmission,
};
