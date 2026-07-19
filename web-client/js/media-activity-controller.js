(function registerMediaActivityController(globalObject) {
  const REASON_ORDER = [
    'manual-pause',
    'terminal-active',
    'page-hidden',
    'page-hide',
  ];
  const ALLOWED_REASONS = new Set(REASON_ORDER);

  class MediaActivityController {
    constructor(options = {}) {
      this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
      this.reasons = new Set();
      this.generation = 0;
    }

    suspend(reason) {
      this.validateReason(reason);
      if (this.reasons.has(reason)) {
        return false;
      }
      this.reasons.add(reason);
      this.notifyChange();
      return true;
    }

    resume(reason) {
      this.validateReason(reason);
      if (!this.reasons.has(reason)) {
        return false;
      }
      this.reasons.delete(reason);
      this.notifyChange();
      return true;
    }

    getSnapshot() {
      const reasons = REASON_ORDER.filter((reason) => this.reasons.has(reason));
      return {
        active: reasons.length === 0,
        suspended: reasons.length > 0,
        reasons,
        generation: this.generation,
      };
    }

    validateReason(reason) {
      if (!ALLOWED_REASONS.has(reason)) {
        throw new Error(`Unknown media suspension reason: ${reason}`);
      }
    }

    notifyChange() {
      this.generation += 1;
      if (this.onChange) {
        this.onChange(this.getSnapshot());
      }
    }
  }

  const api = { MediaActivityController };
  globalObject.MediaActivityController = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
