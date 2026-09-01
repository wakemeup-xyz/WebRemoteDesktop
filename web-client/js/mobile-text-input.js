(function attachMobileTextInput(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = { MobileTextInput: api };
  root.MobileTextInput = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createMobileTextInputApi() {
  const MAX_BACKSPACE_STEPS = 16;
  const CONTROL_KEYS = new Set(['Backspace', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

  function create(options) {
    const config = options || {};
    const element = config.element;
    const sendText = typeof config.sendText === 'function' ? config.sendText : () => false;
    const sendKey = typeof config.sendKey === 'function' ? config.sendKey : () => false;
    const isEnabled = typeof config.isEnabled === 'function' ? config.isEnabled : () => false;
    let attached = false;
    let shown = false;
    let composing = false;
    let lastValue = String(element?.value || '');
    let observedValue = lastValue;
    let compositionBaseValue = '';
    let lastResetReason = null;
    const listeners = [];

    function accepted(result) {
      return result !== null && result !== false;
    }

    function getValue() {
      return String(element?.value || '');
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
      const deleteCount = Math.min(diff.deleted.length, MAX_BACKSPACE_STEPS);
      let sentDeletes = 0;
      for (; sentDeletes < deleteCount; sentDeletes += 1) {
        if (!accepted(sendKey('Backspace'))) {
          lastValue = valueAfterDeletes(diff, sentDeletes);
          return false;
        }
      }
      if (diff.deleted.length > sentDeletes) {
        lastValue = valueAfterDeletes(diff, sentDeletes);
        return false;
      }
      const inserted = diff.inserted.join('');
      if (inserted && !accepted(sendText(inserted))) {
        lastValue = valueAfterDeletes(diff, sentDeletes);
        return false;
      }
      lastValue = observedValue;
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
      if (!event || event.target !== element || composing || !CONTROL_KEYS.has(event.key)) return;
      event.preventDefault?.();
      if (isEnabled()) sendKey(event.key);
    }

    function rootElement() {
      return typeof document !== 'undefined' ? document.documentElement : null;
    }

    function setKeyboardBottom(value) {
      rootElement()?.style?.setProperty?.('--mobile-keyboard-bottom', `${Math.max(0, Math.round(value || 0))}px`);
    }

    function viewportBottom() {
      if (typeof window === 'undefined') return 0;
      const viewport = window.visualViewport;
      if (!viewport) return 0;
      const height = Number(window.innerHeight) || Number(rootElement()?.clientHeight) || 0;
      return height - Number(viewport.height || height) - Number(viewport.offsetTop || 0);
    }

    function updateKeyboardBottom() {
      const keyboard = typeof navigator !== 'undefined' ? navigator.virtualKeyboard : null;
      const keyboardHeight = Number(keyboard?.boundingRect?.height) || 0;
      setKeyboardBottom(keyboardHeight || viewportBottom());
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
      addListener(element, 'beforeinput', onCompositionUpdate);
      addListener(element, 'input', onInput);
      addListener(element, 'compositionstart', onCompositionStart);
      addListener(element, 'compositionupdate', onCompositionUpdate);
      addListener(element, 'compositionend', onCompositionEnd);
      addListener(element, 'keydown', onKeydown);
      if (typeof navigator !== 'undefined' && navigator.virtualKeyboard) {
        navigator.virtualKeyboard.overlaysContent = true;
        addListener(navigator.virtualKeyboard, 'geometrychange', updateKeyboardBottom);
      }
      if (typeof window !== 'undefined') {
        addListener(window.visualViewport, 'resize', updateKeyboardBottom);
        addListener(window.visualViewport, 'scroll', updateKeyboardBottom);
        addListener(window, 'resize', updateKeyboardBottom);
      }
      updateKeyboardBottom();
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
      updateKeyboardBottom();
    }

    function hide() {
      shown = false;
      element?.blur?.();
      setKeyboardBottom(0);
    }

    function reset(reason) {
      lastResetReason = reason || 'reset';
      composing = false;
      compositionBaseValue = '';
      if (element) element.value = '';
      lastValue = '';
      observedValue = '';
      hide();
    }

    function getSnapshot() {
      return { attached, shown, composing, enabled: Boolean(isEnabled()), lastResetReason };
    }

    return { attach, detach, show, hide, reset, getSnapshot };
  }

  return { create };
}));
