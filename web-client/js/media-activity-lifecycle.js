(function registerMediaActivityLifecycle(globalObject) {
  const DEFAULT_HIDDEN_DELAY_MS = 750;

  function resolveTimer(options, name) {
    if (typeof options[name] === 'function') {
      return options[name];
    }
    if (options.timerLike && typeof options.timerLike[name] === 'function') {
      return options.timerLike[name].bind(options.timerLike);
    }
    if (typeof globalObject[name] === 'function') {
      return globalObject[name].bind(globalObject);
    }
    return null;
  }

  const MediaActivityLifecycle = {
    create(options = {}) {
      const documentLike = options.documentLike || globalObject.document || null;
      const windowLike = options.windowLike || globalObject.window || null;
      const setReason = typeof options.setReason === 'function' ? options.setReason : () => {};
      const setTimer = resolveTimer(options, 'setTimeout');
      const clearTimer = resolveTimer(options, 'clearTimeout');
      const hiddenDelayMs = Number.isFinite(options.hiddenDelayMs) && options.hiddenDelayMs >= 0
        ? options.hiddenDelayMs
        : DEFAULT_HIDDEN_DELAY_MS;
      let started = false;
      let hiddenTimer = null;

      function clearPendingHidden() {
        if (hiddenTimer === null) {
          return;
        }
        if (clearTimer) {
          clearTimer(hiddenTimer);
        }
        hiddenTimer = null;
      }

      function handleVisibilityChange() {
        if (!documentLike || !documentLike.hidden) {
          clearPendingHidden();
          setReason('page-hidden', false);
          return;
        }
        if (hiddenTimer !== null || !setTimer) {
          return;
        }
        hiddenTimer = setTimer(() => {
          hiddenTimer = null;
          setReason('page-hidden', true);
        }, hiddenDelayMs);
      }

      function handlePageHide() {
        setReason('page-hide', true);
      }

      function handlePageShow() {
        setReason('page-hide', false);
      }

      function addListener(target, type, listener) {
        if (target && typeof target.addEventListener === 'function') {
          target.addEventListener(type, listener);
        }
      }

      function removeListener(target, type, listener) {
        if (target && typeof target.removeEventListener === 'function') {
          target.removeEventListener(type, listener);
        }
      }

      return {
        start() {
          if (started) {
            return;
          }
          started = true;
          addListener(documentLike, 'visibilitychange', handleVisibilityChange);
          addListener(windowLike, 'pagehide', handlePageHide);
          addListener(windowLike, 'pageshow', handlePageShow);
        },

        stop() {
          if (!started) {
            return;
          }
          started = false;
          clearPendingHidden();
          removeListener(documentLike, 'visibilitychange', handleVisibilityChange);
          removeListener(windowLike, 'pagehide', handlePageHide);
          removeListener(windowLike, 'pageshow', handlePageShow);
        },
      };
    },
  };

  const api = { MediaActivityLifecycle };
  globalObject.MediaActivityLifecycle = MediaActivityLifecycle;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
