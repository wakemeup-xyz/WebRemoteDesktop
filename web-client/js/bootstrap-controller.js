function createViewerBootstrap(options = {}) {
  const fetchSnapshot = options.fetchSnapshot;
  const fallbackFactory = options.fallbackFactory || (() => null);
  const timeoutMs = Number(options.timeoutMs || 3000);
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const AbortControllerCtor = options.AbortController || globalThis.AbortController;
  const now = options.now || (() => globalThis.performance?.now?.());
  const getScope = options.getScope || (() => null);
  const cacheMaxAgeMs = options.cacheMaxAgeMs === undefined ? 3000 : options.cacheMaxAgeMs;
  if (!Number.isFinite(cacheMaxAgeMs) || cacheMaxAgeMs < 0 || cacheMaxAgeMs > 3000) {
    throw new RangeError('cacheMaxAgeMs must be between 0 and 3000');
  }
  let generation = 0;
  let inflight = null;
  let readySlot = null;
  let snapshot = { state: 'idle', generation: 0, value: null, error: null };
  const listeners = new Set();

  function publish(next) {
    snapshot = Object.freeze({ ...next });
    listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }

  function readNow() {
    try {
      const value = now();
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch (_) { return null; }
  }

  function matches(request, entry) {
    return entry.mode === request.mode && entry.turnServerId === request.turnServerId
      && entry.scope === request.scope;
  }

  function superseded() {
    return Object.assign(new Error('superseded'), { code: 'superseded' });
  }

  async function execute({ mode, turnServerId, scope }, currentGeneration, controller) {
    publish({ state: 'loading', generation: currentGeneration, value: null, error: null });
    let timer;
    try {
      const value = await Promise.race([
        fetchSnapshot({
          mode,
          turnServerId,
          generation: currentGeneration,
          signal: controller?.signal,
        }),
        new Promise((_, reject) => {
          timer = setTimer(() => {
            controller?.abort();
            reject(Object.assign(new Error('Viewer bootstrap timed out'), { code: 'bootstrap-timeout' }));
          }, timeoutMs);
        }),
      ]);
      if (currentGeneration !== generation) return snapshot.value;
      if (getScope() !== scope) throw superseded();
      const completedAt = readNow();
      readySlot = cacheMaxAgeMs > 0 && completedAt !== null && !value?.degraded
        ? { mode, turnServerId, scope, completedAt, value } : null;
      publish({ state: 'ready', generation: currentGeneration, value, error: null });
      return value;
    } catch (error) {
      if (currentGeneration !== generation) throw error;
      if (getScope() !== scope) throw superseded();
      readySlot = null;
      if (error.code === 'auth-invalid' && (error.status === 401 || error.status === 403)) {
        publish({ state: 'auth-required', generation: currentGeneration, value: null, error });
        throw error;
      }
      if (mode !== 'relay') {
        const value = fallbackFactory({ mode, error, generation: currentGeneration });
        publish({ state: 'degraded', generation: currentGeneration, value, error });
        return value;
      }
      publish({ state: 'failed', generation: currentGeneration, value: null, error });
      throw error;
    } finally {
      if (timer) clearTimer(timer);
      if (inflight?.generation === currentGeneration) inflight = null;
    }
  }

  function load(options = {}) {
    const request = {
      mode: options.mode || 'auto',
      turnServerId: options.turnServerId || '',
      force: options.force === true,
      scope: getScope(),
    };
    if (inflight && !request.force && matches(request, inflight)) {
      return inflight.promise;
    }
    if (!request.force && readySlot && matches(request, readySlot)) {
      const currentTime = readNow();
      const age = currentTime === null ? NaN : currentTime - readySlot.completedAt;
      if (Number.isFinite(age) && age >= 0 && age < cacheMaxAgeMs) {
        return Promise.resolve(readySlot.value);
      }
    }
    readySlot = null;
    inflight?.controller?.abort();
    const currentGeneration = ++generation;
    const controller = AbortControllerCtor ? new AbortControllerCtor() : null;
    const promise = execute(request, currentGeneration, controller);
    inflight = {
      mode: request.mode,
      turnServerId: request.turnServerId,
      scope: request.scope,
      generation: currentGeneration,
      controller,
      promise,
    };
    return promise;
  }

  return {
    load,
    retry(options = {}) { return load({ ...options, force: true }); },
    getSnapshot() { return snapshot; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    cancel() {
      generation += 1;
      readySlot = null;
      inflight?.controller?.abort();
      inflight = null;
    },
  };
}

if (typeof globalThis !== 'undefined') globalThis.createViewerBootstrap = createViewerBootstrap;
if (typeof module !== 'undefined' && module.exports) module.exports = { createViewerBootstrap };
