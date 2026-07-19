(function registerMediaActivityController(globalObject) {
  const REASON_ORDER = [
    'manual-pause',
    'terminal-active',
    'page-hidden',
    'page-hide',
  ];
  const ALLOWED_REASONS = new Set(REASON_ORDER);

  function validateReason(reason) {
      if (!ALLOWED_REASONS.has(reason)) {
        throw new Error(`Unknown media suspension reason: ${reason}`);
      }
  }

  const MediaActivityController = {
    create(options = {}) {
      const onChange = typeof options.onChange === 'function' ? options.onChange : null;
      const reasons = new Set();
      let generation = 0;

      function snapshot() {
        const orderedReasons = REASON_ORDER.filter((reason) => reasons.has(reason));
        return {
          state: orderedReasons.length === 0 ? 'active' : 'suspended',
          reasons: orderedReasons,
          generation,
        };
      }

      function notifyChange() {
        generation += 1;
        const currentSnapshot = snapshot();
        if (onChange) {
          onChange(currentSnapshot);
        }
        return currentSnapshot;
      }

      return {
        setReason(reason, enabled) {
          validateReason(reason);
          const shouldEnable = Boolean(enabled);
          if (reasons.has(reason) === shouldEnable) {
            return snapshot();
          }
          if (shouldEnable) {
            reasons.add(reason);
          } else {
            reasons.delete(reason);
          }
          return notifyChange();
        },

        hasReason(reason) {
          validateReason(reason);
          return reasons.has(reason);
        },

        snapshot,
      };
    },
  };

  const api = { MediaActivityController };
  globalObject.MediaActivityController = MediaActivityController;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
