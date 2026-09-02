(function attachMobileTextInput(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = { MobileTextInput: api };
  root.MobileTextInput = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createMobileTextInputApi() {
  const MAX_BACKSPACE_STEPS = 16;
  const SENTINEL = '\u200B';
  const CONTROL_KEYS = new Set(['Backspace', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  function create(options) {
    const config = options || {};
    const element = config.element;
    const sendText = typeof config.sendText === 'function' ? config.sendText : () => false;
    const sendKey = typeof config.sendKey === 'function' ? config.sendKey : () => false;
    const isEnabled = typeof config.isEnabled === 'function' ? config.isEnabled : () => false;
    const refreshViewport = typeof config.refreshViewport === 'function' ? config.refreshViewport : () => {};
    let attached = false;
    let shown = false;
    let composing = false;
    let lastValue = SENTINEL;
    let observedValue = lastValue;
    let remoteCursor = 0;
    let compositionBaseValue = '';
    let lastResetReason = null;
    const listeners = [];

    function accepted(result) {
      return result !== null && result !== false;
    }

    function rawValue() {
      return String(element?.value || '');
    }

    function getValue() {
      const raw = rawValue();
      return raw.endsWith(SENTINEL) ? raw : `${raw.replaceAll(SENTINEL, '')}${SENTINEL}`;
    }

    function contentPoints(value = lastValue) {
      const points = Array.from(value);
      if (points.at(-1) === SENTINEL) points.pop();
      return points;
    }

    function setCursorSelection() {
      const points = contentPoints();
      const cursor = Math.max(0, Math.min(remoteCursor, points.length));
      const end = points.slice(0, cursor).join('').length;
      if (!element) return;
      element.selectionStart = end;
      element.selectionEnd = end;
    }

    function restoreBuffer() {
      if (element) element.value = lastValue;
      observedValue = lastValue;
      setCursorSelection();
    }

    function hasCursorSelection() {
      const raw = rawValue();
      const end = contentPoints().slice(0, remoteCursor).join('').length;
      return raw === lastValue && element?.selectionStart === end && element?.selectionEnd === end;
    }

    function safeDiff(previous, next) {
      const from = Array.from(previous);
      const to = Array.from(next);
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
      return [...diff.prefix, ...diff.deleted.slice(0, diff.deleted.length - sentCount), ...diff.suffix].join('');
    }

    function flushDiff() {
      if (composing || observedValue === lastValue || !isEnabled()) return false;
      const diff = safeDiff(lastValue, observedValue);
      const isAtRemoteCursor = diff.deleted.length > 0
        ? diff.prefix.length + diff.deleted.length === remoteCursor
        : diff.prefix.length === remoteCursor;
      if (!isAtRemoteCursor) {
        restoreBuffer();
        return false;
      }
      const deleteCount = Math.min(diff.deleted.length, MAX_BACKSPACE_STEPS);
      let sentDeletes = 0;
      for (; sentDeletes < deleteCount; sentDeletes += 1) {
        if (!accepted(sendKey('Backspace'))) {
          lastValue = valueAfterDeletes(diff, sentDeletes);
          remoteCursor = diff.prefix.length + diff.deleted.length - sentDeletes;
          return false;
        }
      }
      if (diff.deleted.length > sentDeletes) {
        lastValue = valueAfterDeletes(diff, sentDeletes);
        remoteCursor = diff.prefix.length + diff.deleted.length - sentDeletes;
        return false;
      }
      const inserted = diff.inserted.join('');
      if (inserted && !accepted(sendText(inserted))) {
        lastValue = valueAfterDeletes(diff, sentDeletes);
        remoteCursor = diff.prefix.length;
        return false;
      }
      lastValue = observedValue;
      remoteCursor = diff.prefix.length + diff.inserted.length;
      restoreBuffer();
      return true;
    }

    function onCompositionStart() {
      composing = true;
      compositionBaseValue = lastValue;
      observedValue = getValue();
    }

    function onCompositionUpdate() {
      observedValue = getValue();
    }

    function onBeforeInput(event) {
      if (!event || event.target !== element || composing) return;
      if (!rawValue().endsWith(SENTINEL)) return;
      if (!hasCursorSelection()) {
        event.preventDefault?.();
        restoreBuffer();
        return;
      }
      if (event.inputType === 'deleteContentBackward' && lastValue === SENTINEL) {
        event.preventDefault?.();
        sendControlKey('Backspace');
      }
    }

    function onCompositionEnd() {
      observedValue = getValue();
      composing = false;
      flushDiff();
      compositionBaseValue = '';
    }

    function onInput() {
      observedValue = getValue();
      if (!composing) flushDiff();
    }

    function onKeydown(event) {
      if (!event || event.target !== element) return;
      event.stopPropagation?.();
      if (composing || !CONTROL_KEYS.has(event.key)) return;
      event.preventDefault?.();
      sendControlKey(event.key);
    }

    function onKeyup(event) {
      if (event?.target === element) event.stopPropagation?.();
    }

    function onSelect() {
      if (!composing) setCursorSelection();
    }

    function resetHistory() {
      lastValue = SENTINEL;
      observedValue = SENTINEL;
      remoteCursor = 0;
      restoreBuffer();
    }

    function sendControlKey(key) {
      if (!isEnabled() || !accepted(sendKey(key))) return false;
      const content = contentPoints();
      if (key === 'Backspace') {
        if (remoteCursor > 0) {
          content.splice(remoteCursor - 1, 1);
          remoteCursor -= 1;
          lastValue = `${content.join('')}${SENTINEL}`;
          observedValue = lastValue;
          restoreBuffer();
        } else {
          resetHistory();
        }
      } else if (key === 'ArrowLeft') {
        if (remoteCursor > 0) {
          remoteCursor -= 1;
          setCursorSelection();
        } else {
          resetHistory();
        }
      } else if (key === 'ArrowRight') {
        if (remoteCursor < content.length) {
          remoteCursor += 1;
          setCursorSelection();
        } else {
          resetHistory();
        }
      } else if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Enter' || key === 'Escape') {
        resetHistory();
      }
      return true;
    }

    function addListener(target, type, handler) {
      if (!target?.addEventListener) return;
      target.addEventListener(type, handler);
      listeners.push([target, type, handler]);
    }

    function attach() {
      if (attached || !element) return;
      attached = true;
      lastValue = getValue();
      observedValue = lastValue;
      remoteCursor = contentPoints().length;
      if (element) element.value = lastValue;
      setCursorSelection();
      addListener(element, 'beforeinput', onBeforeInput);
      addListener(element, 'input', onInput);
      addListener(element, 'compositionstart', onCompositionStart);
      addListener(element, 'compositionupdate', onCompositionUpdate);
      addListener(element, 'compositionend', onCompositionEnd);
      addListener(element, 'keydown', onKeydown);
      addListener(element, 'keyup', onKeyup);
      addListener(element, 'select', onSelect);
      refreshViewport();
    }

    function detach() {
      while (listeners.length) {
        const [target, type, handler] = listeners.pop();
        target?.removeEventListener?.(type, handler);
      }
      attached = false;
      shown = false;
    }

    function show() {
      shown = true;
      element?.focus?.();
      observedValue = getValue();
      flushDiff();
      refreshViewport();
    }

    function hide() {
      shown = false;
      element?.blur?.();
      refreshViewport();
    }

    function reset(reason) {
      lastResetReason = reason || 'reset';
      composing = false;
      compositionBaseValue = '';
      if (element) element.value = SENTINEL;
      lastValue = SENTINEL;
      observedValue = SENTINEL;
      remoteCursor = 0;
      setCursorSelection();
      hide();
    }

    function getSnapshot() {
      return { attached, shown, composing, enabled: Boolean(isEnabled()), lastResetReason };
    }

    return { attach, detach, show, hide, reset, getSnapshot };
  }

  return { create };
}));
