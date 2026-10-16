// Keep the deadline outside both fetch and body parsing: abort alone may not settle either.
async function fetchJsonWithin(url, init = {}, {
  timeoutMs = 8000,
  fetchImpl = fetch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const controller = new AbortController();
  const callerSignal = init.signal;
  const abort = () => controller.abort();
  if (callerSignal?.aborted) abort();
  else callerSignal?.addEventListener('abort', abort, { once: true });
  let timer;
  const failure = (code) => Object.assign(new Error(code), { code });
  const operation = Promise.resolve().then(async () => {
    if (controller.signal.aborted) throw failure('network');
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch {
      throw failure('network');
    }
    try {
      return { status: response.status, ok: response.ok, data: await response.json() };
    } catch {
      throw failure('invalid-response');
    }
  });
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimer(() => {
          reject(failure('timeout'));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimer(timer);
    callerSignal?.removeEventListener('abort', abort);
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { fetchJsonWithin };
