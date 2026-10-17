// Keep the deadline outside both fetch and body parsing: abort alone may not settle either.
async function fetchJsonWithin(url, init = {}, {
  timeoutMs = 8000,
  maxResponseBytes,
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
  let reader;
  let readerCancelled = false;
  const cancelReader = () => {
    if (!reader || readerCancelled) return;
    readerCancelled = true;
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch (_) { /* best effort */ }
  };
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
      let data;
      if (maxResponseBytes === undefined) {
        data = await response.json();
      } else {
        if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0
          || typeof response.body?.getReader !== 'function') throw failure('invalid-response');
        reader = response.body.getReader();
        if (controller.signal.aborted) { cancelReader(); throw failure('invalid-response'); }
        const declared = response.headers?.get?.('content-length');
        if (declared !== null && declared !== undefined && /^\d+$/.test(declared)
          && Number(declared) > maxResponseBytes) throw failure('invalid-response');
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let length = 0; let text = '';
        for (;;) {
          const chunk = await reader.read();
          if (controller.signal.aborted) throw failure('invalid-response');
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) throw failure('invalid-response');
          length += chunk.value.byteLength;
          if (length > maxResponseBytes) throw failure('invalid-response');
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        data = JSON.parse(text);
      }
      return { status: response.status, ok: response.ok, data };
    } catch {
      if (maxResponseBytes !== undefined) { cancelReader(); controller.abort(); }
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
          cancelReader();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimer(timer);
    callerSignal?.removeEventListener('abort', abort);
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { fetchJsonWithin };
