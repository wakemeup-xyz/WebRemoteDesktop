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
    const acknowledged = new Set();
    const invalidatedInputIds = new Set();
    const pressed = new Set();
    let lease = null;
    let epoch = 0;
    let lastSent = 0;
    let lastApplied = 0;
    let pinnedAdapter = null;
    let barrier = null;

    function adapterAvailable(name) {
      return Boolean(adapters[name]) && !unavailable.has(name);
    }

    function state() {
      expireBarrier();
      if (!lease) return 'revoked';
      return barrier ? 'blocked' : 'ready';
    }

    function expireBarrier() {
      if (barrier && now() > barrier.deadline) barrier = null;
    }

    function clearSession() {
      pending.clear();
      acknowledged.clear();
      invalidatedInputIds.clear();
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
        acknowledged.delete(record.seq);
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
        lease,
        epoch,
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
        invalidatedInputIds.add(record.inputId);
      }
      while (invalidatedInputIds.size > MAX_PENDING) invalidatedInputIds.delete(invalidatedInputIds.values().next().value);
      pending.clear();
      acknowledged.clear();
      pressed.clear();
      pinnedAdapter = null;
    }

    function sendReset(reason) {
      if (!lease) return null;
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

    function advanceApplied() {
      let advanced = false;
      while (acknowledged.has(lastApplied + 1)) {
        acknowledged.delete(lastApplied + 1);
        lastApplied += 1;
        advanced = true;
      }
      return advanced;
    }

    function setLease(nextLease) {
      const normalized = typeof nextLease === 'string' && nextLease ? nextLease : null;
      if (normalized === lease) return;
      lease = normalized;
      clearSession();
      if (lease) epoch += 1;
    }

    function send(message) {
      expireBarrier();
      if (!lease || barrier || !message || !message.action) return null;
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
      if (!lease || payload.epoch !== epoch) return { status: 'stale' };
      const ids = Array.isArray(payload.inputIds) ? payload.inputIds : [];
      const resetDuplicate = barrier && payload.seq === barrier.seq;
      let found = false;
      let stale = false;
      for (const id of ids) {
        const record = pending.get(id);
        if (record) {
          found = true;
          pending.delete(id);
          if (record.seq <= lastApplied) stale = true;
          else acknowledged.add(record.seq);
        } else if (invalidatedInputIds.has(id)) {
          stale = true;
        }
      }
      if (resetDuplicate) {
        pending.delete(barrier.inputId);
        acknowledged.delete(barrier.seq);
        lastApplied = Math.max(lastApplied, barrier.seq);
        barrier = null;
        return { status: found ? 'applied' : 'duplicate' };
      }
      if (Number.isFinite(payload.seq) && payload.seq > lastSent) {
        sendReset('sequence-gap');
        return { status: 'gap' };
      }
      const advanced = advanceApplied();
      if (advanced) return { status: 'applied' };
      if (stale) return { status: 'stale' };
      if (found) return { status: 'pending-gap' };
      return { status: 'duplicate' };
    }

    function markAdapterUnavailable(name) {
      const adapterName = name === 'dc' ? 'dataChannel' : name;
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
        epoch,
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
