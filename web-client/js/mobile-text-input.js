(function attachMobileTextInput(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = { MobileTextInput: api };
  root.MobileTextInput = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createMobileTextInputApi() {
  const MAX_BACKSPACE_STEPS = 16;
  const MAX_UNICODE_SCALARS = 4096;
  const SENTINEL = '\u200B';
  const CONTROL_KEYS = new Set(['Backspace', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  const TRANSPORT_STATES = new Set(['ready', 'blocked', 'revoked', 'reacquire-required']);

  function create(options) {
    const config = options || {};
    const element = config.element;
    const sendText = typeof config.sendText === 'function' ? config.sendText : () => false;
    const sendKey = typeof config.sendKey === 'function' ? config.sendKey : () => false;
    const isEnabled = typeof config.isEnabled === 'function' ? config.isEnabled : () => false;
    const isDeliverySettled = typeof config.isDeliverySettled === 'function'
      ? config.isDeliverySettled
      : () => true;
    const onStateChange = typeof config.onStateChange === 'function' ? config.onStateChange : () => {};
    const refreshViewport = typeof config.refreshViewport === 'function' ? config.refreshViewport : () => {};

    let attached = false;
    let shown = false;
    let composing = false;
    let acceptedValue = SENTINEL;
    let draftValue = SENTINEL;
    let observedValue = SENTINEL;
    let remoteCursor = 0;
    let compositionBaseValue = '';
    let lastResetReason = null;
    let generation = 0;
    let contextValid = true;
    let deliveryUncertain = false;
    let transportState = 'ready';
    let retryRequired = false;
    let pendingGeneration = null;
    let drainActive = false;
    let drainTimer = null;
    const listeners = [];

    function accepted(result) {
      return result !== null && result !== false
        && !(result && typeof result === 'object' && result.accepted === false);
    }

    function rawValue() {
      return String(element?.value || '');
    }

    function normalizeValue(value) {
      const raw = String(value || '');
      const withoutSentinel = raw.endsWith(SENTINEL)
        ? raw.slice(0, -SENTINEL.length)
        : raw.replaceAll(SENTINEL, '');
      return `${Array.from(withoutSentinel).slice(0, MAX_UNICODE_SCALARS).join('')}${SENTINEL}`;
    }

    function getValue() {
      return normalizeValue(rawValue());
    }

    function contentPoints(value = acceptedValue) {
      const points = Array.from(String(value || ''));
      if (points.at(-1) === SENTINEL) points.pop();
      return points;
    }

    function withSentinel(points) {
      return `${points.join('')}${SENTINEL}`;
    }

    function setCursorSelection(value = acceptedValue) {
      const points = contentPoints(value);
      const cursor = Math.max(0, Math.min(remoteCursor, points.length));
      const end = points.slice(0, cursor).join('').length;
      if (!element) return;
      element.selectionStart = end;
      element.selectionEnd = end;
    }

    function restoreAcceptedBuffer() {
      if (element) element.value = acceptedValue;
      observedValue = acceptedValue;
      if (!hasPending()) draftValue = acceptedValue;
      setCursorSelection(acceptedValue);
    }

    function hasCursorSelection() {
      const raw = rawValue();
      const points = contentPoints(acceptedValue);
      const end = points.slice(0, remoteCursor).join('').length;
      return raw === acceptedValue && element?.selectionStart === end && element?.selectionEnd === end;
    }

    function safeDiff(previous, next) {
      const from = contentPoints(previous);
      const to = contentPoints(next);
      let prefix = 0;
      while (prefix < from.length && prefix < to.length && from[prefix] === to[prefix]) prefix += 1;
      let suffix = 0;
      while (suffix < from.length - prefix && suffix < to.length - prefix
        && from[from.length - 1 - suffix] === to[to.length - 1 - suffix]) suffix += 1;
      return {
        prefix: from.slice(0, prefix),
        deleted: from.slice(prefix, from.length - suffix),
        inserted: to.slice(prefix, to.length - suffix),
        suffix: from.slice(from.length - suffix),
      };
    }

    function valueAfterDeletes(diff, sentCount) {
      return withSentinel([
        ...diff.prefix,
        ...diff.deleted.slice(0, diff.deleted.length - sentCount),
        ...diff.suffix,
      ]);
    }

    function hasUnpairedSurrogate(value) {
      const source = String(value || '');
      for (let index = 0; index < source.length; index += 1) {
        const code = source.charCodeAt(index);
        if (code >= 0xD800 && code <= 0xDBFF) {
          const next = source.charCodeAt(index + 1);
          if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
          index += 1;
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
          return true;
        }
      }
      return false;
    }

    function clearDrainTimer() {
      if (drainTimer !== null) clearTimeout(drainTimer);
      drainTimer = null;
    }

    function cancelDrain() {
      clearDrainTimer();
      drainActive = false;
    }

    function hasPending() {
      return draftValue !== acceptedValue || drainActive || retryRequired;
    }

    function deliverySettled() {
      try {
        return isDeliverySettled() === true;
      } catch (_) {
        return false;
      }
    }

    function retryable() {
      return hasPending()
        && retryRequired
        && pendingGeneration === generation
        && contextValid
        && !deliveryUncertain
        && !composing
        && transportState === 'ready'
        && Boolean(isEnabled())
        && deliverySettled();
    }

    function status() {
      if (transportState === 'blocked') return 'blocked';
      if (deliveryUncertain || !contextValid
        || transportState === 'revoked' || transportState === 'reacquire-required') return 'uncertain';
      if (composing) return 'composing';
      if (hasPending()) return 'pending';
      return 'idle';
    }

    function getSnapshot() {
      return {
        attached,
        shown,
        composing,
        enabled: Boolean(isEnabled()),
        hasPending: hasPending(),
        retryable: retryable(),
        deliveryUncertain: Boolean(deliveryUncertain || !contextValid),
        status: status(),
        lastResetReason,
      };
    }

    function notifyState() {
      const snapshot = getSnapshot();
      try {
        onStateChange(snapshot);
      } catch (_) {
        // UI observers cannot interfere with text delivery.
      }
    }

    function markPending({ uncertain = false } = {}) {
      retryRequired = true;
      pendingGeneration = generation;
      if (uncertain) {
        contextValid = false;
        deliveryUncertain = true;
      }
      notifyState();
    }

    function markAccepted(nextValue, cursor) {
      acceptedValue = nextValue;
      draftValue = nextValue;
      observedValue = nextValue;
      remoteCursor = cursor;
      retryRequired = false;
      pendingGeneration = null;
      restoreAcceptedBuffer();
      notifyState();
    }

    function stopDiffAt(diff, sentDeletes, { uncertain = false } = {}) {
      acceptedValue = valueAfterDeletes(diff, sentDeletes);
      remoteCursor = diff.prefix.length + diff.deleted.length - sentDeletes;
      cancelDrain();
      markPending({ uncertain });
      return false;
    }

    function scheduleDrain() {
      if (drainTimer !== null || !drainActive) return;
      const scheduledGeneration = generation;
      drainTimer = setTimeout(() => {
        drainTimer = null;
        if (scheduledGeneration !== generation || !drainActive) return;
        processDiff({ fromDrain: true });
      }, 0);
    }

    function processDiff({ force = false, fromDrain = false } = {}) {
      if (composing) {
        if (fromDrain || drainActive) {
          cancelDrain();
          markPending();
        } else {
          notifyState();
        }
        return false;
      }
      if (!fromDrain && drainActive) return false;
      if (draftValue === acceptedValue) {
        cancelDrain();
        retryRequired = false;
        pendingGeneration = null;
        notifyState();
        return true;
      }
      if (retryRequired && !force && !fromDrain) {
        notifyState();
        return false;
      }
      if (!contextValid || deliveryUncertain) {
        if (fromDrain || drainActive) cancelDrain();
        markPending({ uncertain: true });
        return false;
      }
      if (!isEnabled() || transportState !== 'ready') {
        if (fromDrain || drainActive) cancelDrain();
        markPending();
        return false;
      }

      const diff = safeDiff(acceptedValue, draftValue);
      const expectedCursor = diff.deleted.length > 0
        ? diff.prefix.length + diff.deleted.length
        : diff.prefix.length;
      if (expectedCursor !== remoteCursor) {
        // Only edits against the accepted history are fail-closed. A rejected
        // draft remains editable and is never replaced by the accepted buffer.
        if (fromDrain || drainActive) {
          cancelDrain();
          markPending({ uncertain: !contextValid || deliveryUncertain });
          return false;
        }
        if (!retryRequired) {
          draftValue = acceptedValue;
          restoreAcceptedBuffer();
        }
        notifyState();
        return false;
      }

      drainActive = true;
      let sentDeletes = 0;
      const deleteLimit = Math.min(MAX_BACKSPACE_STEPS, diff.deleted.length);
      for (; sentDeletes < deleteLimit; sentDeletes += 1) {
        const beforeStepGeneration = generation;
        const stepReady = contextValid && !deliveryUncertain
          && transportState === 'ready' && Boolean(isEnabled());
        if (beforeStepGeneration !== generation || !stepReady) {
          return stopDiffAt(diff, sentDeletes, { uncertain: !contextValid || deliveryUncertain });
        }
        const stepGeneration = generation;
        const result = sendKey('Backspace');
        if (stepGeneration !== generation) {
          drainActive = false;
          return false;
        }
        if (!accepted(result)) {
          return stopDiffAt(diff, sentDeletes);
        }
        const afterKeyReady = contextValid && !deliveryUncertain
          && transportState === 'ready' && Boolean(isEnabled());
        if (!afterKeyReady) {
          return stopDiffAt(diff, sentDeletes + 1, { uncertain: !contextValid || deliveryUncertain });
        }
      }

      acceptedValue = valueAfterDeletes(diff, sentDeletes);
      remoteCursor = diff.prefix.length + diff.deleted.length - sentDeletes;

      if (diff.deleted.length > sentDeletes) {
        drainActive = true;
        scheduleDrain();
        notifyState();
        return false;
      }

      const inserted = diff.inserted.join('');
      if (inserted && hasUnpairedSurrogate(inserted)) {
        cancelDrain();
        markPending();
        return false;
      }
      if (inserted) {
        const beforeInsertGeneration = generation;
        const insertReady = contextValid && !deliveryUncertain
          && transportState === 'ready' && Boolean(isEnabled());
        if (beforeInsertGeneration !== generation || !insertReady) {
          return stopDiffAt(diff, sentDeletes, { uncertain: !contextValid || deliveryUncertain });
        }
        const stepGeneration = generation;
        const result = sendText(inserted);
        if (stepGeneration !== generation) {
          drainActive = false;
          return false;
        }
        if (!accepted(result)) {
          // The accepted delete prefix is kept, while the editable draft is
          // deliberately retained for a later explicit retry.
          cancelDrain();
          markPending();
          return false;
        }
        const afterTextReady = contextValid && !deliveryUncertain
          && transportState === 'ready' && Boolean(isEnabled());
        if (!afterTextReady) {
          cancelDrain();
          markPending({ uncertain: !contextValid || deliveryUncertain });
          return false;
        }
      }

      const target = draftValue;
      const targetCursor = diff.prefix.length + diff.inserted.length;
      drainActive = false;
      markAccepted(target, targetCursor);
      return true;
    }

    function flushDiff(options = {}) {
      return processDiff(options);
    }

    function captureObservedValue() {
      const next = getValue();
      // Bound the in-memory draft independently of the DOM maxlength (which is
      // measured in UTF-16 code units by browsers).
      if (element && rawValue() !== next && contentPoints(next).length <= MAX_UNICODE_SCALARS) {
        const rawPoints = Array.from(rawValue().replaceAll(SENTINEL, ''));
        if (rawPoints.length > MAX_UNICODE_SCALARS) element.value = next;
      }
      observedValue = next;
      draftValue = next;
      return next;
    }

    function onCompositionStart() {
      if (drainActive) {
        cancelDrain();
        markPending();
      }
      composing = true;
      compositionBaseValue = acceptedValue;
      observedValue = getValue();
      draftValue = observedValue;
      notifyState();
    }

    function onCompositionUpdate() {
      observedValue = getValue();
      draftValue = observedValue;
      notifyState();
    }

    function onBeforeInput(event) {
      if (!event || event.target !== element || composing) return;
      if (!rawValue().endsWith(SENTINEL)) return;
      // Failed text is an editable local draft. Do not restore the accepted
      // prefix while the user is appending or correcting it.
      if (hasPending()) return;
      if (!hasCursorSelection()) {
        event.preventDefault?.();
        restoreAcceptedBuffer();
        notifyState();
        return;
      }
      if (event.inputType === 'deleteContentBackward' && acceptedValue === SENTINEL) {
        event.preventDefault?.();
        sendControlKey('Backspace');
      }
    }

    function onCompositionEnd() {
      observedValue = getValue();
      draftValue = observedValue;
      composing = false;
      if (!retryRequired) flushDiff();
      compositionBaseValue = '';
      notifyState();
    }

    function onInput() {
      const hadDrainTimer = drainTimer !== null;
      captureObservedValue();
      if (composing) {
        notifyState();
        return;
      }
      if (hadDrainTimer) {
        // A new edit supersedes the old target, but the current serial
        // transaction is allowed to finish one batch before recalculating.
        clearDrainTimer();
        processDiff({ fromDrain: true });
        return;
      }
      if (!drainActive) flushDiff();
      else notifyState();
    }

    function onKeydown(event) {
      if (!event || event.target !== element) return;
      event.stopPropagation?.();
      if (composing || !CONTROL_KEYS.has(event.key)) return;
      // A rejected draft remains a normal local editing surface. In
      // particular, let the browser's Backspace/default selection behavior
      // edit the draft instead of sending a remote control key or restoring
      // the accepted prefix.
      if (hasPending()) return;
      event.preventDefault?.();
      sendControlKey(event.key);
    }

    function onKeyup(event) {
      if (event?.target === element) event.stopPropagation?.();
    }

    function onSelect() {
      if (!composing && !hasPending()) setCursorSelection(acceptedValue);
    }

    function resetHistory() {
      acceptedValue = SENTINEL;
      draftValue = SENTINEL;
      observedValue = SENTINEL;
      remoteCursor = 0;
      retryRequired = false;
      pendingGeneration = null;
      restoreAcceptedBuffer();
    }

    function sendControlKey(key) {
      if (hasPending()) return false;
      if (!isEnabled() || !accepted(sendKey(key))) return false;
      const content = contentPoints(acceptedValue);
      if (key === 'Backspace') {
        if (remoteCursor > 0) {
          content.splice(remoteCursor - 1, 1);
          remoteCursor -= 1;
          acceptedValue = withSentinel(content);
          draftValue = acceptedValue;
          observedValue = acceptedValue;
          restoreAcceptedBuffer();
        } else {
          resetHistory();
        }
      } else if (key === 'ArrowLeft') {
        if (remoteCursor > 0) {
          remoteCursor -= 1;
          setCursorSelection(acceptedValue);
        } else {
          resetHistory();
        }
      } else if (key === 'ArrowRight') {
        if (remoteCursor < content.length) {
          remoteCursor += 1;
          setCursorSelection(acceptedValue);
        } else {
          resetHistory();
        }
      } else if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Enter' || key === 'Escape') {
        resetHistory();
      }
      notifyState();
      return true;
    }

    function retryPending() {
      if (!retryable() || drainActive) return false;
      return flushDiff({ force: true });
    }

    function discardPending() {
      cancelDrain();
      generation += 1;
      resetHistory();
      contextValid = true;
      deliveryUncertain = false;
      notifyState();
    }

    function onTransportState(state) {
      const next = String(state || '').toLowerCase();
      if (!TRANSPORT_STATES.has(next)) return;
      transportState = next;
      if (next === 'blocked' && drainActive) {
        cancelDrain();
        markPending();
        return;
      }
      if (next === 'reacquire-required' || next === 'revoked') {
        cancelDrain();
        generation += 1;
        contextValid = false;
        deliveryUncertain = true;
        if (hasPending()) {
          retryRequired = true;
          pendingGeneration = generation;
        }
      }
      notifyState();
    }

    function refreshDeliveryState() {
      notifyState();
    }

    function addListener(target, type, handler) {
      if (!target?.addEventListener) return;
      target.addEventListener(type, handler);
      listeners.push([target, type, handler]);
    }

    function attach() {
      if (attached || !element) return;
      attached = true;
      acceptedValue = getValue();
      draftValue = acceptedValue;
      observedValue = acceptedValue;
      remoteCursor = contentPoints(acceptedValue).length;
      element.value = acceptedValue;
      setCursorSelection(acceptedValue);
      addListener(element, 'beforeinput', onBeforeInput);
      addListener(element, 'input', onInput);
      addListener(element, 'compositionstart', onCompositionStart);
      addListener(element, 'compositionupdate', onCompositionUpdate);
      addListener(element, 'compositionend', onCompositionEnd);
      addListener(element, 'keydown', onKeydown);
      addListener(element, 'keyup', onKeyup);
      addListener(element, 'select', onSelect);
      refreshViewport();
      notifyState();
    }

    function detach() {
      cancelDrain();
      generation += 1;
      while (listeners.length) {
        const [target, type, handler] = listeners.pop();
        target?.removeEventListener?.(type, handler);
      }
      attached = false;
      shown = false;
      notifyState();
    }

    function show() {
      shown = true;
      element?.focus?.();
      observedValue = getValue();
      draftValue = observedValue;
      if (!retryRequired && !drainActive) flushDiff();
      refreshViewport();
      notifyState();
    }

    function hide() {
      shown = false;
      element?.blur?.();
      refreshViewport();
      notifyState();
    }

    function reset(reason) {
      lastResetReason = reason || 'reset';
      cancelDrain();
      generation += 1;
      composing = false;
      compositionBaseValue = '';
      acceptedValue = SENTINEL;
      draftValue = SENTINEL;
      observedValue = SENTINEL;
      remoteCursor = 0;
      retryRequired = false;
      pendingGeneration = null;
      contextValid = true;
      deliveryUncertain = false;
      if (element) element.value = SENTINEL;
      setCursorSelection(SENTINEL);
      hide();
      notifyState();
    }

    return {
      attach,
      detach,
      show,
      hide,
      reset,
      getSnapshot,
      retryPending,
      discardPending,
      onTransportState,
      refreshDeliveryState,
      sendControlKey,
    };
  }

  return { create };
}));
