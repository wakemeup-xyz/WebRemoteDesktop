(function attachKeyboardTransport(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KeyboardTransport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createKeyboardTransportApi() {
  const MAX_PENDING = 256;

  function create(options) {
    const config = options || {};
    const now = typeof config.now === 'function' ? config.now : Date.now;
    const makeInputId = typeof config.makeInputId === 'function'
      ? config.makeInputId
      : () => `kbd_${now()}_${Math.random().toString(36).slice(2, 8)}`;
    const ackTimeoutMs = Number.isFinite(config.ackTimeoutMs) ? config.ackTimeoutMs : 3000;
    const adapters = {
      dataChannel: typeof config.sendDataChannel === 'function' ? config.sendDataChannel : null,
      socket: typeof config.sendSocket === 'function' ? config.sendSocket : null,
    };
    const unavailable = new Set();
    const pending = new Map();
    const pressed = new Set();
    let leaseId = null;
    let leaseEpoch = 0;
    let lastSent = 0;
    let lastApplied = 0;
    let pinnedAdapter = null;
    let barrier = null;
    let reacquireRequired = false;

    function adapterAvailable(name) {
      return Boolean(adapters[name]) && !unavailable.has(name);
    }

    function state() {
      expireBarrier();
      if (reacquireRequired) return 'reacquire-required';
      if (!leaseId) return 'revoked';
      return barrier ? 'blocked' : 'ready';
    }

    function expireBarrier() {
      if (!barrier || now() <= barrier.deadline) return;
      leaseId = null;
      leaseEpoch = 0;
      pending.clear();
      pressed.clear();
      pinnedAdapter = null;
      reacquireRequired = true;
    }

    function clearSession() {
      pending.clear();
      pressed.clear();
      pinnedAdapter = null;
      barrier = null;
      lastSent = 0;
      lastApplied = 0;
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

    function isKeyDown(action) {
      return action === 'keydown' || action === 'down';
    }

    function isKeyUp(action) {
      return action === 'keyup' || action === 'up';
    }

    function trimPending() {
      while (pending.size > MAX_PENDING) {
        const oldest = pending.keys().next().value;
        const record = pending.get(oldest);
        pending.delete(oldest);
        if (record.seq === lastApplied + 1) lastApplied = record.seq;
      }
    }

    function sendThrough(adapterName, message, isReset) {
      const inputId = makeInputId();
      const seq = ++lastSent;
      const payload = {
        type: message.type || 'keyboard',
        action: message.action,
        payload: message.payload || {},
        schemaVersion: 2,
        leaseId,
        leaseEpoch,
        seq,
        inputIds: [inputId],
      };
      const record = { inputId, seq, adapter: adapterName, reset: Boolean(isReset) };
      pending.set(inputId, record);
      trimPending();
      try {
        adapters[adapterName](payload);
      } catch (_) {
        // Delivery feedback is asynchronous; a synchronous adapter failure does not reject input.
      }
      return record;
    }

    function invalidateBeforeReset() {
      for (const record of pending.values()) {
        if (record.seq > lastApplied) lastApplied = record.seq;
      }
      pending.clear();
      pressed.clear();
      pinnedAdapter = null;
    }

    function sendReset(reason) {
      expireBarrier();
      if (!leaseId) return null;
      invalidateBeforeReset();
      const adapterName = chooseAdapter(true);
      if (!adapterName) return null;
      const record = sendThrough(adapterName, {
        type: 'keyboard',
        action: 'reset',
        payload: { reason },
      }, true);
      barrier = { inputId: record.inputId, seq: record.seq, deadline: now() + ackTimeoutMs };
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
      if (nextLeaseId === leaseId && nextLeaseEpoch === leaseEpoch && !reacquireRequired) return;
      leaseId = nextLeaseId;
      leaseEpoch = nextLeaseEpoch;
      reacquireRequired = false;
      clearSession();
    }

    function send(message) {
      expireBarrier();
      if (!leaseId || barrier || !message || !message.action) return null;
      const adapterName = chooseAdapter(false);
      if (!adapterName) return null;
      const identity = keyIdentity(message);
      const record = sendThrough(adapterName, message, false);
      if (isKeyDown(message.action) && identity) {
        pressed.add(identity);
        pinnedAdapter = adapterName;
      } else if (isKeyUp(message.action) && identity) {
        pressed.delete(identity);
        if (pressed.size === 0) pinnedAdapter = null;
      }
      return record.inputId;
    }

    function resetBarrier(reason) {
      return sendReset(reason || 'reset');
    }

    function acceptAck(ack) {
      expireBarrier();
      const payload = ack || {};
      if (!leaseId || payload.schemaVersion !== 2 || payload.leaseEpoch !== leaseEpoch) {
        return { status: 'stale' };
      }
      if (payload.status === 'resync-required') {
        if (!barrier) sendReset('remote-resync-required');
        return { status: 'resync-required' };
      }
      if ((payload.status !== 'applied' && payload.status !== 'duplicate')
          || !Number.isInteger(payload.appliedSeq)
          || payload.appliedSeq < 0) {
        return { status: 'stale' };
      }
      if (payload.appliedSeq < lastApplied) return { status: 'stale' };
      if (payload.appliedSeq > lastSent) {
        if (!barrier) sendReset('sequence-gap');
        return { status: 'resync-required' };
      }
      if (barrier && payload.appliedSeq < barrier.seq) return { status: 'resync-required' };
      for (const [inputId, record] of pending) {
        if (record.seq <= payload.appliedSeq) pending.delete(inputId);
      }
      lastApplied = Math.max(lastApplied, payload.appliedSeq);
      if (barrier && payload.appliedSeq >= barrier.seq) barrier = null;
      return { status: payload.status };
    }

    function markAdapterUnavailable(name) {
      const adapterName = name;
      if (!adapters[adapterName]) return;
      unavailable.add(adapterName);
      if (adapterName === pinnedAdapter || adapterName === 'dataChannel') sendReset('adapter-unavailable');
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

    return {
      setLease,
      send,
      resetBarrier,
      acceptAck,
      markAdapterUnavailable,
      canSendNewInput,
      getSnapshot,
    };
  }

  return { create };
}));
