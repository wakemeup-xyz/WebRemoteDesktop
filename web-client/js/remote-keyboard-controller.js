(function attachRemoteKeyboardController(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = { RemoteKeyboardController: api };
  root.RemoteKeyboardController = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createRemoteKeyboardControllerApi() {
  const MODIFIER_ORDER = ['ctrl', 'shift', 'alt', 'meta'];
  const MODE_VALUES = new Set(['mac', 'windows']);

  function create(options) {
    const config = options || {};
    const transport = config.transport;
    const now = typeof config.now === 'function' ? config.now : Date.now;
    const onStateChange = typeof config.onStateChange === 'function' ? config.onStateChange : () => {};
    const pressed = new Map();
    let mode = MODE_VALUES.has(config.mode) ? config.mode : 'mac';
    let leaseActive = false;
    let resetRequired = false;
    let pendingMode = null;
    let downSequence = 0;
    let altGrArmedUntil = 0;

    function accepted(result) {
      return result !== null && result !== false
        && !(result && typeof result === 'object' && result.accepted === false);
    }

    function transportReady() {
      return Boolean(leaseActive && transport && typeof transport.canSendNewInput === 'function'
        && transport.canSendNewInput());
    }

    function reconcilePendingMode() {
      if (pendingMode && transportReady()) {
        mode = pendingMode;
        pendingMode = null;
        resetRequired = false;
      }
    }

    function state() {
      reconcilePendingMode();
      if (!leaseActive) return 'INACTIVE';
      if (resetRequired || pendingMode) return 'RESET_REQUIRED';
      return transportReady() ? 'READY' : 'BLOCKED';
    }

    function notify() {
      try {
        onStateChange(getSnapshot());
      } catch (_) {
        // State listeners are diagnostics/UI adapters and cannot change keyboard delivery.
      }
    }

    function stableCode(event) {
      return typeof event.code === 'string' && event.code.length > 0 && event.code !== 'Unidentified';
    }

    function isModifierCode(code) {
      return /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code);
    }

    function modifierFlagsFromCodes(codes) {
      const flags = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
      for (const code of codes) {
        if (code.startsWith('Control')) flags.ctrlKey = true;
        if (code.startsWith('Shift')) flags.shiftKey = true;
        if (code.startsWith('Alt')) flags.altKey = true;
        if (code.startsWith('Meta')) flags.metaKey = true;
      }
      return flags;
    }

    function domModifiers(event) {
      const flags = {
        altKey: Boolean(event.altKey),
        ctrlKey: Boolean(event.ctrlKey),
        metaKey: Boolean(event.metaKey),
        shiftKey: Boolean(event.shiftKey),
      };
      if (mode === 'windows' && flags.ctrlKey) {
        flags.metaKey = true;
        flags.ctrlKey = false;
      }
      return flags;
    }

    function lockSnapshot(event) {
      try {
        return { capsLock: Boolean(event.getModifierState && event.getModifierState('CapsLock')) };
      } catch (_) {
        return { capsLock: false };
      }
    }

    function normalizeDown(event) {
      let code = event.code;
      const flags = domModifiers(event);
      const isWindowsControl = mode === 'windows' && (code === 'ControlLeft' || code === 'ControlRight');
      if (isWindowsControl) {
        code = code === 'ControlRight' ? 'MetaRight' : 'MetaLeft';
        flags.ctrlKey = false;
        flags.metaKey = Boolean(event.ctrlKey);
      }
      const altGr = mode === 'windows' && code === 'AltRight'
        && (event.key === 'AltGraph' || (Boolean(event.altKey) && Boolean(event.ctrlKey) && now() <= altGrArmedUntil));
      if (altGr) {
        flags.altKey = true;
        flags.ctrlKey = false;
        flags.metaKey = false;
      }
      if (mode === 'windows' && event.code === 'ControlLeft') altGrArmedUntil = now() + 250;
      return {
        code,
        location: Number.isInteger(event.location) ? event.location : 0,
        modifiers: flags,
        locks: lockSnapshot(event),
        altGr,
      };
    }

    function shouldIgnoreNewKeydown(event) {
      if (!stableCode(event) || event.isComposing || event.key === 'Process') return true;
      const target = event.target;
      if (!target) return false;
      if (typeof target.closest === 'function' && target.closest('.modal')) return true;
      const tag = String(target.tagName || '').toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target.isContentEditable);
    }

    function payload(record, phase, repeat) {
      return {
        phase,
        code: record.code,
        location: record.location,
        repeat: Boolean(repeat),
        modifiers: { ...record.modifiers },
        locks: { ...record.locks },
      };
    }

    function send(action, actionPayload) {
      if (!transportReady() || resetRequired || !transport || typeof transport.send !== 'function') return null;
      return transport.send({ type: 'keyboard', action, payload: actionPayload });
    }

    function beginReset(reason) {
      pressed.clear();
      resetRequired = true;
      if (!leaseActive || !transport || typeof transport.resetBarrier !== 'function') {
        notify();
        return null;
      }
      const result = transport.resetBarrier(reason || 'manual');
      reconcilePendingMode();
      notify();
      return result;
    }

    function trackedKeyup(event) {
      const record = pressed.get(event.code);
      if (!record) return false;
      const modifiers = isModifierCode(record.code) && !record.altGr
        ? modifierFlagsFromCodes([...pressed.values()].map((item) => item.code))
        : record.modifiers;
      const result = send('key', payload({ ...record, modifiers }, 'up', false));
      pressed.delete(event.code);
      if (!accepted(result)) beginReset('transport-change');

      if (mode === 'windows' && /^Shift(Left|Right)$/.test(record.code)
          && typeof event.getModifierState === 'function') {
        const remainingShift = [...pressed.values()].some((item) => /^Shift(Left|Right)$/.test(item.code));
        if (Boolean(event.getModifierState('Shift')) !== remainingShift) beginReset('transport-change');
      }
      notify();
      return true;
    }

    function handleDomEvent(event) {
      if (!event || (event.type !== 'keydown' && event.type !== 'keyup')) return false;
      reconcilePendingMode();
      if (event.type === 'keyup') {
        if (trackedKeyup(event)) {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          return true;
        }
        return false;
      }
      if (shouldIgnoreNewKeydown(event) || !transportReady() || resetRequired) return false;
      const existing = pressed.get(event.code);
      if (existing) {
        if (!event.repeat || isModifierCode(existing.code)) return false;
        const result = send('key', payload(existing, 'down', true));
        return accepted(result);
      }

      const normalized = normalizeDown(event);
      if (normalized.code === 'CapsLock') {
        const capsSteps = [
          { ...payload(normalized, 'down', false) },
          { ...payload(normalized, 'up', false) },
        ];
        const result = send('batch', { steps: capsSteps });
        if (!accepted(result)) beginReset('batch-failed');
        return accepted(result);
      }

      const physicalMetaHeld = mode === 'mac'
        && Boolean(event.metaKey)
        && !isModifierCode(normalized.code)
        && [...pressed.values()].some((item) => /^Meta(Left|Right)$/.test(item.code));
      if (physicalMetaHeld) {
        const steps = [payload(normalized, 'down', false), payload(normalized, 'up', false)];
        const result = send('batch', { steps });
        if (!accepted(result)) beginReset('batch-failed');
        return accepted(result);
      }

      const record = {
        ...normalized,
        downSeq: ++downSequence,
        adapter: null,
      };
      if (isModifierCode(record.code) && !record.altGr) {
        record.modifiers = modifierFlagsFromCodes([...pressed.values()].map((item) => item.code));
      }
      const result = send('key', payload(record, 'down', false));
      if (!accepted(result)) return false;
      record.adapter = result && typeof result === 'object' ? result.adapter || null : null;
      pressed.set(event.code, record);
      if (typeof event.preventDefault === 'function') event.preventDefault();
      notify();
      return true;
    }

    function setLease(leaseOrNull) {
      if (transport && typeof transport.setLease === 'function') transport.setLease(leaseOrNull || null);
      leaseActive = Boolean(leaseOrNull && typeof leaseOrNull === 'object');
      if (!leaseActive) {
        pressed.clear();
        resetRequired = false;
        pendingMode = null;
      }
      reconcilePendingMode();
      notify();
    }

    function setMode(nextMode) {
      if (!MODE_VALUES.has(nextMode)) return false;
      reconcilePendingMode();
      if (nextMode === mode && !pendingMode) return true;
      pendingMode = nextMode;
      beginReset('keyboard-mode-change');
      return true;
    }

    function chordModifierCode(name) {
      if (name === 'ctrl') return mode === 'windows' ? 'MetaLeft' : 'ControlLeft';
      if (name === 'shift') return 'ShiftLeft';
      if (name === 'alt') return 'AltLeft';
      return 'MetaLeft';
    }

    function modifierFamily(code) {
      if (code.startsWith('Control')) return 'ctrl';
      if (code.startsWith('Shift')) return 'shift';
      if (code.startsWith('Alt')) return 'alt';
      if (code.startsWith('Meta')) return 'meta';
      return null;
    }

    function chordModifiers(value) {
      const source = value || {};
      return MODIFIER_ORDER.filter((name) => Boolean(source[name]
        || (name === 'ctrl' && source.control)
        || (name === 'meta' && (source.command || source.cmd))));
    }

    function sendChord(chord) {
      reconcilePendingMode();
      if (!chord || !stableCode(chord) || !transportReady() || resetRequired) return false;
      const physicalCodes = new Set([...pressed.values()].map((item) => item.code));
      const owned = chordModifiers(chord.modifiers).filter((name) => {
        const family = modifierFamily(chordModifierCode(name));
        return ![...physicalCodes].some((code) => modifierFamily(code) === family);
      });
      const virtualCodes = new Set(physicalCodes);
      const steps = [];
      const locks = { capsLock: false };
      const makeStep = (phase, code) => ({
        phase,
        code,
        location: 0,
        repeat: false,
        modifiers: modifierFlagsFromCodes(virtualCodes),
        locks,
      });
      for (const name of owned) {
        const code = chordModifierCode(name);
        virtualCodes.add(code);
        steps.push(makeStep('down', code));
      }
      const mainCode = chord.code;
      virtualCodes.add(mainCode);
      steps.push(makeStep('down', mainCode));
      steps.push(makeStep('up', mainCode));
      virtualCodes.delete(mainCode);
      for (const name of owned.slice().reverse()) {
        const code = chordModifierCode(name);
        steps.push(makeStep('up', code));
        virtualCodes.delete(code);
      }
      const result = send('batch', { steps });
      if (!accepted(result)) beginReset('batch-failed');
      notify();
      return accepted(result);
    }

    function sendText(text) {
      reconcilePendingMode();
      if (typeof text !== 'string' || text.length === 0 || pressed.size > 0 || !transportReady() || resetRequired) return false;
      const result = send('text', { text });
      notify();
      return accepted(result);
    }

    function reset(reason) {
      pendingMode = null;
      return Boolean(beginReset(reason || 'manual'));
    }

    function getSnapshot() {
      return {
        state: state(),
        mode,
        pressedKeyCount: pressed.size,
        pendingMode: Boolean(pendingMode),
      };
    }

    return { setLease, setMode, handleDomEvent, sendChord, sendText, reset, getSnapshot };
  }

  return { create };
}));
