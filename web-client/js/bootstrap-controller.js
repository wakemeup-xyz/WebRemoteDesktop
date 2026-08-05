function createViewerBootstrap(options = {}) {
  const fetchSnapshot = options.fetchSnapshot;
  const fallbackFactory = options.fallbackFactory || (() => null);
  const timeoutMs = Number(options.timeoutMs || 3000);
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const AbortControllerCtor = options.AbortController || globalThis.AbortController;
  let generation = 0;
  let inflight = null;
  let snapshot = { state: 'idle', generation: 0, value: null, error: null };
  const listeners = new Set();

  function publish(next) {
    snapshot = Object.freeze({ ...next });
    listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }

  async function execute({ mode, turnServerId }, currentGeneration, controller) {
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
      publish({ state: 'ready', generation: currentGeneration, value, error: null });
      return value;
    } catch (error) {
      if (currentGeneration !== generation) throw error;
      if (error.status === 401 || error.status === 403) {
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
    };
    if (inflight && !request.force && inflight.key === `${request.mode}:${request.turnServerId}`) {
      return inflight.promise;
    }
    inflight?.controller?.abort();
    const currentGeneration = ++generation;
    const controller = AbortControllerCtor ? new AbortControllerCtor() : null;
    const promise = execute(request, currentGeneration, controller);
    inflight = {
      key: `${request.mode}:${request.turnServerId}`,
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
      inflight?.controller?.abort();
      inflight = null;
    },
  };
}

if (typeof globalThis !== 'undefined') globalThis.createViewerBootstrap = createViewerBootstrap;
if (typeof module !== 'undefined' && module.exports) module.exports = { createViewerBootstrap };
