const { loadConfig } = require('../lib/config');
const { verifyAccessToken } = require('../lib/auth');
const { ingestDiagnosticPayload } = require('../lib/diagnostic');
const { DesktopControlLease } = require('../lib/desktop-control-lease');
const { validateRemoteInput, summarizeRemoteInput } = require('../lib/remote-input-contract');

// Kept deliberately static during the protocol migration. Do not add an
// environment override: deployment must not silently re-enable v1 after its
// documented removal criteria are met.
const LEGACY_INPUT_COMPAT_ENABLED = true;

// Store connections
const connections = {
  host: null,
  viewers: new Map(),
  relayViewers: new Map()
};

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

  function clearPendingInputs(viewerId = null) {
    if (viewerId === null) pendingInputs.clear();
    else pendingInputs.delete(viewerId);
  }

  const intervalFactory = options.scheduler?.setInterval || options.setInterval || setInterval;
  const interval = intervalFactory(() => {
    const result = desktopLease.expire();
    if (result?.reason) {
      if (result.state === 'FREE') {
        pendingInputs.clear();
        pendingControllerProtocolVersion = null;
        legacyControllerViewerId = null;
        clearAllLegacyRelayCompanions({ stop: true });
      }
      broadcastControlState(result.reason);
    }
  }, 1000);
  interval?.unref?.();

  function controlSnapshot() {
    return desktopLease.snapshot();
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

  function sendControlTransition(effect) {
    if (!effect || !connections.host || !effect.transition) return false;
    connections.host.emit('control-transition', effect.transition);
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
      return desktopLease.authorize({
        viewerId: socket.id,
        leaseId: data.leaseId,
        leaseEpoch: data.leaseEpoch,
      });
    }
    if (!legacy) {
      const snapshot = desktopLease.snapshot();
      return snapshot.state === 'ACTIVE' && snapshot.controllerViewerId === socket.id;
    }
    return legacy;
  }
  function forwardOffer(socket, data) {
    if (!connections.host) return false;
    const forwarded = {
      offer: data.offer,
      viewerId: socket.id,
      epoch: data.epoch,
      leaseEpoch: data.schemaVersion === 2 ? data.leaseEpoch : desktopLease.snapshot().leaseEpoch,
    };
    // v2 offers have already passed authorizeViewer(), so this opaque token
    // is safe to forward solely to the Host for its direct DataChannel binding.
    if (data.schemaVersion === 2) forwarded.leaseId = data.leaseId;
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
        desktopLease.hostDisconnected();
        clearPendingInputs();
        pendingControllerProtocolVersion = null;
        legacyControllerViewerId = null;
        clearAllLegacyRelayCompanions({ stop: true });
        broadcastControlState('host-replaced');
      }
      socket.emit('connected', { role: 'host', status: 'ok', inputProtocolVersion: socket.inputProtocolVersion });
      emitViewerStatus('host-connected');
      // Notify all viewers that host is online
      connections.viewers.forEach((viewerSocket) => {
        viewerSocket.emit('host-status', { online: true, inputProtocolVersion: hostInputProtocolVersion() });
      });
    } else if (role === 'viewer') {
      connections.viewers.set(socket.id, socket);
      socket.emit('connected', {
        role: 'viewer',
        status: 'ok',
        hostOnline: connections.host !== null,
        inputProtocolVersion: socket.inputProtocolVersion,
        hostInputProtocolVersion: hostInputProtocolVersion(),
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
      const previousController = desktopLease.snapshot().controllerViewerId;
      const result = desktopLease.requestControl({ viewerId: socket.id, takeover: data.takeover === true });
      if (result.transition) {
        rememberPendingController(socket.inputProtocolVersion);
        annotateLegacyTakeover(result, previousController);
        if (result.transition.reason === 'legacy-takeover') {
          clearLegacyRelayCompanion(previousController, { stop: true });
        }
        if (data.takeover === true && previousController && previousController !== socket.id) {
          connections.viewers.get(previousController)?.emit('control-revoked', { reason: 'takeover' });
        }
        socket.emit('control-acquire-result', { state: result.state, requestId: data.requestId || null });
        broadcastControlState('transition');
        sendControlTransition(result);
      } else {
        socket.emit('control-acquire-result', { ...result, requestId: data.requestId || null });
      }
    });

    socket.on('control-heartbeat', (data = {}) => {
      if (role !== 'viewer' || !isActiveViewerSocket(socket)) return;
      const result = desktopLease.heartbeat({ viewerId: socket.id, leaseId: data.leaseId, leaseEpoch: data.leaseEpoch });
      if (!result.ok) socket.emit('control-heartbeat-rejected', { reason: result.reason });
    });

    socket.on('control-release', (data = {}) => {
      if (role !== 'viewer' || !isActiveViewerSocket(socket)) return;
      const result = desktopLease.beginRelease({ viewerId: socket.id, reason: data.reason || 'released' });
      if (result.transition) {
        broadcastControlState('released');
        sendControlTransition(result);
      }
    });

    socket.on('control-transition-ack', (data = {}) => {
      if (role !== 'host' || connections.host !== socket) return;
      const result = data.status === 'applied'
        ? desktopLease.confirmTransition({ leaseEpoch: data.leaseEpoch })
        : desktopLease.rejectTransition({ leaseEpoch: data.leaseEpoch, reason: data.reason });
      if (result.state === 'FREE' && !result.lease) {
        clearPendingInputs();
        pendingControllerProtocolVersion = null;
        legacyControllerViewerId = null;
        clearAllLegacyRelayCompanions({ stop: true });
      }
      if (result.lease) {
        if (legacyControllerViewerId) clearLegacyRelayCompanion(legacyControllerViewerId, { stop: true });
        legacyControllerViewerId = pendingControllerProtocolVersion === 1
          ? desktopLease.snapshot().controllerViewerId
          : null;
        pendingControllerProtocolVersion = null;
        sendGrant(desktopLease.snapshot().controllerViewerId, result.lease);
      }
      broadcastControlState(result.reason || result.state.toLowerCase());
      if (result.lease) {
        const queued = pendingOffers.get(desktopLease.snapshot().controllerViewerId);
        if (queued) {
          pendingOffers.delete(desktopLease.snapshot().controllerViewerId);
          queued.forEach(({ socket: queuedSocket, data: queuedData }) => {
            if (isActiveViewerSocket(queuedSocket)) forwardOffer(queuedSocket, queuedData);
          });
        }
        const queuedInputs = pendingInputs.get(desktopLease.snapshot().controllerViewerId);
        if (queuedInputs) {
          pendingInputs.delete(desktopLease.snapshot().controllerViewerId);
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
        const snapshot = desktopLease.snapshot();
        if (snapshot.state !== 'ACTIVE' || snapshot.controllerViewerId !== socket.id) {
          if (snapshot.state === 'FREE' && connections.host) {
            const result = desktopLease.requestControl({ viewerId: socket.id });
            if (result.transition) {
              rememberPendingController(1);
              pendingOffers.set(socket.id, [{ socket, data }]);
              broadcastControlState('transition');
              sendControlTransition(result);
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
        const snapshot = desktopLease.snapshot();
        if (!authorizeViewer(socket, data, { legacy: false })) {
          if (snapshot.state === 'FREE' && connections.host) {
            const result = desktopLease.requestControl({ viewerId: socket.id });
            if (result.transition) {
              rememberPendingController(1);
              pendingInputs.set(socket.id, [{ socket, data }]);
              broadcastControlState('transition');
              sendControlTransition(result);
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
        if (!validation.ok || !authorizeViewer(socket, data, { legacy: false })) {
          logger.warn?.(`[INPUT] rejected viewer=${socket.id} ${validation.ok ? 'unauthorized' : validation.code}`);
          return;
        }
        logger.log?.(`[INPUT] relay viewer=${socket.id} ${JSON.stringify(summarizeRemoteInput(data))}`);
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
        const validStatus = ['applied', 'duplicate', 'resync-required'].includes(data.status);
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
      };
      if (connections.host) {
        connections.host.emit('media-profile-change', sanitized);
      }
    });

    socket.on('relay-stream-control', (data) => {
      if (role !== 'viewer' && role !== 'relay-viewer') {
        console.warn(`Relay stream control rejected: role=${role} from ${socket.id}`);
        return;
      }
      if (role === 'viewer' && !isActiveViewerSocket(socket)) {
        console.warn(`Relay stream control rejected: disconnected viewer ${socket.id}`);
        return;
      }
      if (role === 'viewer' && data?.schemaVersion === 2 && !authorizeViewer(socket, data, { legacy: false })) return;
      let viewerId = socket.id;
      if (role === 'relay-viewer') {
        const boundOwnerId = legacyRelayOwnerForCompanion(socket.id);
        if (boundOwnerId && !hasActiveLegacyRelayOwner(boundOwnerId)) {
          clearLegacyRelayCompanion(boundOwnerId);
        }
        viewerId = hasActiveLegacyRelayOwner(boundOwnerId)
          ? boundOwnerId
          : bindLegacyRelayCompanion(socket.id);
        if (!viewerId) return;
      }
      if (connections.host) {
        connections.host.emit('relay-stream-control', {
          ...data,
          viewerId,
        });
      }
    });

    socket.on('relay-frame', (data) => {
      if (role !== 'host') {
        console.warn(`Relay frame rejected: role=${role} from ${socket.id}`);
        return;
      }
      const companionId = hasActiveLegacyRelayOwner(data.viewerId)
        ? legacyRelayCompanionByOwner.get(data.viewerId)
        : null;
      const viewerSocket = (companionId && connections.relayViewers.get(companionId))
        || connections.relayViewers.get(data.viewerId)
        || connections.viewers.get(data.viewerId);
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

    socket.on('disconnect', () => {
      console.log(`Disconnected: ${role} - ${socket.id}`);
      if (role === 'host') {
        if (connections.host && connections.host.id === socket.id) {
          connections.host = null;
          const leaseResult = desktopLease.hostDisconnected();
          clearPendingInputs();
          pendingControllerProtocolVersion = null;
          legacyControllerViewerId = null;
          clearAllLegacyRelayCompanions();
          broadcastControlState(leaseResult.reason);
          connections.viewers.forEach((viewerSocket) => {
            viewerSocket.emit('host-status', { online: false });
          });
          emitViewerStatus('host-disconnected');
        } else {
          console.log(`Ignoring stale host disconnect: ${socket.id}`);
        }
      } else if (role === 'viewer') {
        clearPendingInputs(socket.id);
        const priorControl = controlSnapshot();
        const leaseResult = desktopLease.viewerDisconnected(socket.id);
        clearLegacyRelayCompanion(socket.id, { stop: true });
        if (legacyControllerViewerId === socket.id) legacyControllerViewerId = null;
        if (leaseResult.state === 'FREE') pendingControllerProtocolVersion = null;
        if (leaseResult.transition) {
          sendControlTransition(leaseResult);
        } else if (priorControl.controllerViewerId === socket.id
          && Number.isSafeInteger(priorControl.leaseEpoch)) {
          // Active disconnects free the Signal lease immediately. The Host
          // still needs a same-epoch reset barrier before its pressed state
          // may be reused by a subsequent controller.
          sendControlTransition({
            transition: {
              type: 'control-transition',
              leaseEpoch: priorControl.leaseEpoch,
              reason: leaseResult.reason || 'controller-disconnect',
            },
          });
        }
        broadcastControlState(leaseResult.reason || 'viewer-disconnected');
        connections.viewers.delete(socket.id);
        emitViewerStatus('viewer-disconnected', socket);
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

module.exports = { setupSignaling, connections, getConnectionStatus, ingestDiagnosticPayload };
