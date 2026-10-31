(function attachKeyboardTransport(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KeyboardTransport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createKeyboardTransportApi() {
  const MAX_PENDING = 32;

  function isResetAckMirror(ack, inputType, inputId) {
    return Boolean(['mouse', 'keyboard'].includes(inputType)
      && typeof inputId === 'string' && inputId.length > 0
      && ack?.resetAckMirrorVersion === 1 && ack.schemaVersion === 2
      && ack.inputType === inputType && ['applied', 'duplicate'].includes(ack.status)
      && Array.isArray(ack.inputIds) && ack.inputIds.length === 1
      && ack.inputIds[0] === inputId);
  }

  function localBudget() {
    const entries = new Map(); let total = 0;
    return {
      reserve(id, bytes) {
        if (bytes > 65536 || total + bytes > 131072 || entries.size >= MAX_PENDING) return false;
        entries.set(id, bytes); total += bytes; return true;
      },
      release(id) { if (entries.has(id)) { total -= entries.get(id); entries.delete(id); } },
    };
  }
  function serializedBytes(data) {
    let bytes = 0;
    for (const char of JSON.stringify(data)) {
      const code = char.codePointAt(0);
      bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    }
    return bytes;
  }

  function create(options) {
    const config = options || {};
    const budget = config.inputBudget || localBudget();
    const reservations = new Map();
    let capacityRejected = false;
    const now = typeof config.now === 'function' ? config.now
      : () => typeof performance !== 'undefined' ? performance.now() : 0;
    const makeInputId = typeof config.makeInputId === 'function'
      ? config.makeInputId
      : () => `kbd_${now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ackTimeoutMs = Number.isFinite(config.ackTimeoutMs) ? config.ackTimeoutMs : 3000;
    const getConnectionAttemptId = typeof config.getConnectionAttemptId === 'function'
      ? config.getConnectionAttemptId
      : () => null;
    const adapters = {
      dataChannel: typeof config.sendDataChannel === 'function' ? config.sendDataChannel : null,
      socket: typeof config.sendSocket === 'function' ? config.sendSocket : null,
    };
    const setTimer = config.setTimeoutFn || setTimeout;
    const clearTimer = config.clearTimeoutFn || clearTimeout;
    const getSocket = config.getSocket || (() => null);
    const getDataChannel = config.getDataChannel || (() => null);
    const getResetAckDataChannel = config.getResetAckDataChannel || (() => null);
    const onTimeout = config.onReliableAckTimeout || (() => {});
    const unavailable = new Set();
    const pending = new Map();
    const pressed = new Set();
    const stateListeners = new Set();
    let leaseId = null;
    let leaseEpoch = 0;
    let lastSent = 0;
    let lastApplied = 0;
    let pinnedAdapter = null;
    let barrier = null;
    let reacquireRequired = false;
    let frozen = false;
    let deadlineTimer = null;

    function currentResetAckDataChannel() {
      try { return getResetAckDataChannel() || null; }
      catch (_) { return null; }
    }

    function cancelDeadline() {
      if (deadlineTimer !== null) clearTimer(deadlineTimer);
      deadlineTimer = null;
    }

    function scheduleDeadline() {
      cancelDeadline();
      if (reacquireRequired || (frozen && !barrier)) return;
      const record = pending.values().next().value;
      if (!record) return;
      deadlineTimer = setTimer(() => {
        deadlineTimer = null;
        if (pending.get(record.inputId) !== record || record.leaseId !== leaseId
          || record.leaseEpoch !== leaseEpoch) return;
        if (record.connectionAttemptId !== getConnectionAttemptId()) {
          pending.clear();
          frozen = true;
          notifyState();
          return;
        }
        frozen = true;
        if (record.reset) requireReacquire();
        else notifyState();
        onTimeout(record);
      }, Math.max(0, record.sentAt + ackTimeoutMs - now()));
      deadlineTimer?.unref?.();
    }


    function adapterAvailable(name) {
      return Boolean(adapters[name]) && !unavailable.has(name);
    }

    function state() {
      expireBarrier();
      if (reacquireRequired) return 'reacquire-required';
      if (!leaseId) return 'revoked';
      return barrier || frozen ? 'blocked' : 'ready';
    }

    function notifyState() {
      const snapshot = getSnapshot();
      for (const listener of stateListeners) {
        try {
          listener(snapshot);
        } catch (_) {
          // State observers cannot interfere with transport delivery.
        }
      }
    }

    function subscribeState(listener) {
      if (typeof listener !== 'function') return () => {};
      stateListeners.add(listener);
      listener(getSnapshot());
      return () => stateListeners.delete(listener);
    }

    function expireBarrier() {
      if (!barrier || now() < barrier.deadline) return;
      // Keep the failed identity in memory.  Clearing it here would make a
      // same-lease `setLease()` look like a new session and could wash away an
      // expired reset without a real control re-acquire.
      const record = pending.get(barrier.inputId);
      requireReacquire();
      if (record) onTimeout(record);
    }

    function releaseReservation(id) { budget.release(id); reservations.delete(id); }
    function releaseAllReservations() { for (const id of reservations.keys()) releaseReservation(id); }

    function clearSession() {
      releaseAllReservations();
      cancelDeadline();
      frozen = false;
      pending.clear();
      pressed.clear();
      pinnedAdapter = null;
      barrier = null;
      lastSent = 0;
      lastApplied = 0;
    }

    function requireReacquire() {
      // Uncertain submitted writes retain the shared budget until lease change.
      cancelDeadline();
      pending.clear();
      // Preserve the identity internally so the caller cannot turn the same
      // lease/epoch into a fresh sequence merely by rebinding it.  The lease
      // never appears in a public snapshot and all sends remain blocked until
      // a different lease or epoch is installed.
      pressed.clear();
      pinnedAdapter = null;
      barrier = null;
      reacquireRequired = true;
      notifyState();
    }

    function chooseAdapter(forceSocket) {
      if (forceSocket && adapterAvailable('socket')) return 'socket';
      if (pinnedAdapter && adapterAvailable(pinnedAdapter)) return pinnedAdapter;
      if (adapterAvailable('dataChannel')) return 'dataChannel';
      if (adapterAvailable('socket')) return 'socket';
      return null;
    }

    function keyIdentity(message) {
      const payload = message && message.payload ? message.payload : {};
      return payload.code || payload.key || payload.keyCode || null;
    }

    function isKeyDown(message) {
      return message.action === 'keydown' || message.action === 'down'
        || (message.action === 'key' && message.payload && message.payload.phase === 'down');
    }

    function isKeyUp(message) {
      return message.action === 'keyup' || message.action === 'up'
        || (message.action === 'key' && message.payload && message.payload.phase === 'up');
    }

    function booleanValue(primary, fallback) {
      const value = typeof primary === 'boolean' || primary === 0 || primary === 1
        ? primary
        : fallback;
      return value === true || value === 1;
    }

    function normalizeLegacyKey(message) {
      if (message.action !== 'keydown' && message.action !== 'keyup') return message;
      const payload = message.payload || {};
      const modifiers = payload.modifiers || {};
      const locks = payload.locks || {};
      return {
        type: message.type || 'keyboard',
        action: 'key',
        payload: {
          phase: message.action === 'keydown' ? 'down' : 'up',
          code: payload.code,
          location: Number.isInteger(payload.location) ? payload.location : 0,
          repeat: booleanValue(payload.repeat),
          modifiers: {
            altKey: booleanValue(modifiers.altKey, modifiers.alt),
            ctrlKey: booleanValue(modifiers.ctrlKey, modifiers.ctrl),
            metaKey: booleanValue(modifiers.metaKey, modifiers.meta),
            shiftKey: booleanValue(modifiers.shiftKey, modifiers.shift),
          },
          locks: { capsLock: booleanValue(locks.capsLock) },
        },
      };
    }

    function sendThrough(adapterName, message, isReset) {
      const inputId = makeInputId();
      const seq = lastSent + 1;
      let connectionAttemptId = null;
      try {
        connectionAttemptId = getConnectionAttemptId() || null;
      } catch (_) {
        connectionAttemptId = null;
      }
      const payload = {
        type: message.type || 'keyboard',
        action: message.action,
        payload: message.payload || {},
        schemaVersion: 2,
        leaseId,
        leaseEpoch,
        seq,
        inputIds: [inputId],
        ...(connectionAttemptId ? { connectionAttemptId } : {}),
      };
      capacityRejected = false;
      if (!budget.reserve(inputId, serializedBytes(payload))) {
        capacityRejected = true;
        frozen = true;
        cancelDeadline();
        notifyState();
        onTimeout({leaseId, leaseEpoch, connectionAttemptId, reset: Boolean(isReset)});
        return null;
      }
      const record = {
        inputId,
        seq,
        adapter: adapterName,
        reset: Boolean(isReset),
        action: message.action,
        connectionAttemptId,
        leaseId, leaseEpoch,
        socket: getSocket(),
        socketId: getSocket()?.id || null,
        dataChannel: adapterName === 'dataChannel' ? getDataChannel() : null,
        ...(isReset && adapterName === 'socket'
          ? { resetAckDataChannel: currentResetAckDataChannel() } : {}),
        sentAt: now(),
      };
      lastSent = seq;
      let delivered = false;
      try {
        delivered = adapters[adapterName](payload) === true;
      } catch (_) {
        delivered = false;
      }
      if (!delivered) { budget.release(inputId); return null; }
      reservations.set(inputId, seq);
      pending.set(inputId, record);
      scheduleDeadline();
      return record;
    }

    function invalidateBeforeReset() {
      cancelDeadline();
      pending.clear();
      pressed.clear();
      pinnedAdapter = null;
    }

    function sendReset(reason) {
      expireBarrier();
      if (!leaseId || reacquireRequired) return null;
      invalidateBeforeReset();
      const adapterName = chooseAdapter(true);
      if (!adapterName) {
        requireReacquire();
        return null;
      }
      const record = sendThrough(adapterName, {
        type: 'keyboard',
        action: 'reset',
        payload: { reason },
      }, true);
      if (!record) {
        requireReacquire();
        return null;
      }
      frozen = false;
      barrier = {
        socket: record.socket,
        socketId: record.socketId,
        inputId: record.inputId,
        seq: record.seq,
        deadline: now() + ackTimeoutMs,
        connectionAttemptId: record.connectionAttemptId,
      };
      scheduleDeadline();
      notifyState();
      return record.inputId;
    }

    function setLease(nextLease) {
      const validLease = nextLease
        && typeof nextLease === 'object'
        && typeof nextLease.leaseId === 'string'
        && nextLease.leaseId
        && Number.isInteger(nextLease.leaseEpoch)
        && nextLease.leaseEpoch >= 0;
      const nextLeaseId = validLease ? nextLease.leaseId : null;
      const nextLeaseEpoch = validLease ? nextLease.leaseEpoch : 0;
      if (nextLeaseId === leaseId && nextLeaseEpoch === leaseEpoch) {
        // A failed/expired transport identity is intentionally sticky.  Only a
        // genuinely different lease/epoch may establish a new sequence.
        return;
      }
      leaseId = nextLeaseId;
      leaseEpoch = nextLeaseEpoch;
      reacquireRequired = false;
      clearSession();
      notifyState();
    }

    function send(message) {
      expireBarrier();
      if (!leaseId || reacquireRequired || frozen || barrier || !message || !message.action) return null;
      if (pending.size >= MAX_PENDING) {
        frozen = true;
        cancelDeadline();
        notifyState();
        onTimeout(pending.values().next().value);
        return null;
      }
      const adapterName = chooseAdapter(false);
      if (!adapterName) return null;
      const identity = keyIdentity(message);
      const record = sendThrough(adapterName, normalizeLegacyKey(message), false);
      if (!record) {
        if (capacityRejected) return null;
        markAdapterUnavailable(adapterName);
        return null;
      }
      if (isKeyDown(message) && identity) {
        pressed.add(identity);
        pinnedAdapter = adapterName;
      } else if (isKeyUp(message) && identity) {
        pressed.delete(identity);
        if (pressed.size === 0) pinnedAdapter = null;
      }
      return record.inputId;
    }

    function resetBarrier(reason) {
      expireBarrier();
      if (barrier) {
        let currentAttemptId = null;
        try {
          currentAttemptId = getConnectionAttemptId() || null;
        } catch (_) {
          currentAttemptId = null;
        }
        // A barrier sent on a prior WebRTC attempt cannot be claimed by a new
        // recovery cycle. Drop only that stale barrier and emit a fresh reset
        // under the current attempt; the next positive ACK owns the new ID.
        if (barrier.connectionAttemptId !== currentAttemptId
          || barrier.socket !== getSocket() || barrier.socketId !== (getSocket()?.id || null)) {
          invalidateBeforeReset();
          barrier = null;
          notifyState();
        }
      }
      if (barrier) return barrier.inputId;
      if (reacquireRequired) return null;
      return sendReset(reason || 'unspecified');
    }

    function acceptAck(ack) {
      expireBarrier();
      const payload = ack || {};
      if (!leaseId || payload.schemaVersion !== 2 || payload.leaseEpoch !== leaseEpoch) {
        return { status: 'stale' };
      }
      const ackInputIds = Array.isArray(payload.inputIds)
        ? payload.inputIds
        : (payload.inputId ? [payload.inputId] : null);
      // Ordinary cumulative ACKs remain supported. A reset always requires its
      // exact ID: an older cumulative prefix cannot own a new safety barrier.
      if (barrier && (!ackInputIds || !ackInputIds.includes(barrier.inputId)
        || barrier.socket !== getSocket() || barrier.socketId !== (getSocket()?.id || null))) {
        return { status: 'stale' };
      }
      if (barrier && Object.prototype.hasOwnProperty.call(payload, 'inputType')
        && payload.inputType !== 'keyboard') {
        return { status: 'stale' };
      }
      if (payload.status === 'resync-required' || payload.status === 'sequence-gap') {
        const record = ackInputIds?.map(id => pending.get(id)).find(Boolean);
        if (payload.status === 'resync-required' && record && config.onReliableAckTimeout) {
          frozen = true;
          cancelDeadline();
          notifyState();
          onTimeout({leaseId, leaseEpoch, connectionAttemptId: record.connectionAttemptId, reset: record.reset});
        } else if (!barrier) sendReset('transport-change');
        return { status: 'resync-required' };
      }
      if (['stale-lease', 'invalid-input', 'unsupported-code', 'execution-failed'].includes(payload.status)) {
        requireReacquire();
        return { status: 'reacquire-required' };
      }
      if ((payload.status !== 'applied' && payload.status !== 'duplicate')
          || !Number.isInteger(payload.appliedSeq)
          || payload.appliedSeq < 0) {
        return { status: 'stale' };
      }
      if (ackInputIds && !ackInputIds.some((id) => {
        const record = pending.get(id);
        return record && record.connectionAttemptId === getConnectionAttemptId()
          && (record.adapter !== 'socket'
            || (record.socket === getSocket() && record.socketId === (getSocket()?.id || null)));
      })) return { status: 'stale' };
      if (payload.appliedSeq < lastApplied) return { status: 'stale' };
      if (payload.appliedSeq > lastSent) {
        if (!barrier) sendReset('transport-change');
        return { status: 'resync-required' };
      }
      if (barrier && payload.appliedSeq < barrier.seq) return { status: 'resync-required' };
      if (payload.appliedSeq > lastApplied && ![...pending.values()].some(record =>
        record.seq <= payload.appliedSeq && record.connectionAttemptId === getConnectionAttemptId()
        && (record.adapter !== 'socket'
          || (record.socket === getSocket() && record.socketId === (getSocket()?.id || null))))) {
        return { status: 'stale' };
      }
      for (const [inputId, seq] of reservations) {
        if (seq <= payload.appliedSeq) releaseReservation(inputId);
      }
      for (const [inputId, record] of pending) {
        if (record.seq <= payload.appliedSeq && record.connectionAttemptId === getConnectionAttemptId()
          && (record.adapter !== 'socket'
            || (record.socket === getSocket() && record.socketId === (getSocket()?.id || null)))) pending.delete(inputId);
      }
      lastApplied = Math.max(lastApplied, payload.appliedSeq);
      if (barrier && payload.appliedSeq >= barrier.seq) {
        barrier = null;
        notifyState();
      }
      scheduleDeadline();
      return { status: payload.status };
    }

    function markAdapterUnavailable(name) {
      const adapterName = name;
      if (!adapters[adapterName]) return;
      const wasAvailable = !unavailable.has(adapterName);
      unavailable.add(adapterName);
      if (wasAvailable && !barrier && (adapterName === pinnedAdapter || adapterName === 'dataChannel')) {
        sendReset('transport-change');
      }
    }

    function markAdapterAvailable(name) {
      const adapterName = name;
      if (!adapters[adapterName]) return;
      unavailable.delete(adapterName);
    }

    function connectionScopeChanged() {
      cancelDeadline();
      // Retain a failed barrier's latch. A live old reset can be replaced only
      // by resetBarrier(), which allocates a fresh ID under the current scope.
      if (!pending.size && !barrier) return false;
      frozen = true;
      notifyState();
      return true;
    }

    function ownsAckSource(ack, source) {
      const ids = ack?.inputIds || (ack?.inputId ? [ack.inputId] : []);
      const records = ids.length ? ids.map(id => pending.get(id)).filter(Boolean) : [...pending.values()];
      return records.some(record => record.connectionAttemptId === getConnectionAttemptId()
        && (source.transport === 'socket'
          ? record.adapter === 'socket' && record.socket === source.socket
            && record.socketId === (source.socket?.id || null)
          : (record.adapter === 'dataChannel' && record.dataChannel === source.dataChannel)
            || (source.transport === 'datachannel' && record.reset && record.adapter === 'socket'
              && isResetAckMirror(ack, 'keyboard', record.inputId)
              && ack.leaseEpoch === record.leaseEpoch && ack.appliedSeq === record.seq
              && record.leaseId === leaseId && record.leaseEpoch === leaseEpoch
              && record.socket != null && typeof record.socketId === 'string' && record.socketId.length > 0
              && record.socket === getSocket() && record.socketId === (getSocket()?.id || null)
              && record.resetAckDataChannel != null
              && record.resetAckDataChannel === source.dataChannel
              && currentResetAckDataChannel() === source.dataChannel)));
    }

    // Observation only: no deadline expiry, ACK acceptance or pending mutation.
    function peekAckMetadata(ack) {
      const ids = Array.isArray(ack?.inputIds) ? ack.inputIds.slice(0, 64)
        : (ack?.inputId ? [ack.inputId] : []);
      const record = ids.map(id => pending.get(id)).find(Boolean);
      if (!record) return null;
      return { action: record.reset ? 'reset' : record.action,
        reliable: true, matchedReliablePending: true,
        connectionAttemptId: record.connectionAttemptId };
    }

    function canSendNewInput() {
      return state() === 'ready';
    }

    function getSnapshot() {
      return {
        state: state(),
        epoch: leaseEpoch,
        lastSent,
        lastApplied,
        pendingCount: pending.size,
        adapter: pinnedAdapter,
      };
    }

    function getPendingReset() {
      expireBarrier();
      if (!barrier) return null;
      return {
        inputId: barrier.inputId,
        seq: barrier.seq,
        leaseEpoch,
        connectionAttemptId: barrier.connectionAttemptId,
        socket: barrier.socket,
        socketId: barrier.socketId,
      };
    }

    return {
      setLease,
      connectionScopeChanged,
      ownsAckSource,
      peekAckMetadata,
      send,
      resetBarrier,
      acceptAck,
      markAdapterUnavailable,
      markAdapterAvailable,
      canSendNewInput,
      getSnapshot,
      getPendingReset,
      subscribeState,
    };
  }

  return { create, isResetAckMirror };
}));
