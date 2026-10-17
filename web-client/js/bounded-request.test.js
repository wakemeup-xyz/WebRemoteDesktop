'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchJsonWithin } = require('./bounded-request');

function clock() {
  let fire;
  const cleared = [];
  return {
    setTimer(fn, ms) { fire = fn; assert.equal(ms, 8000); return 1; },
    clearTimer(id) { cleared.push(id); },
    fire() { fire(); }, cleared,
  };
}

test('deadline settles a hanging fetch even when abort is ignored', async () => {
  const timer = clock();
  let signal;
  const pending = fetchJsonWithin('/fixture', {}, {
    ...timer, fetchImpl: async (_url, init) => { signal = init.signal; return new Promise(() => {}); },
  });
  await Promise.resolve();
  timer.fire();
  await assert.rejects(pending, { code: 'timeout' });
  assert.equal(signal.aborted, true);
  assert.deepEqual(timer.cleared, [1]);
});

test('deadline covers body parsing and ignores a late body result', async () => {
  const timer = clock();
  let resolveBody;
  let signal;
  const pending = fetchJsonWithin('/fixture', {}, {
    ...timer, fetchImpl: async (_url, init) => {
      signal = init.signal;
      return { ok: true, status: 200, json: () => new Promise((resolve) => { resolveBody = resolve; }) };
    },
  });
  await Promise.resolve(); await Promise.resolve();
  timer.fire();
  await assert.rejects(pending, { code: 'timeout' });
  resolveBody({ token: 'late' });
  assert.equal(signal.aborted, true);
});

test('network and parse errors have finite codes without exposing exception contents', async () => {
  for (const [fetchImpl, code] of [
    [async () => { throw new Error('sensitive raw network detail'); }, 'network'],
    [async () => ({ status: 403, ok: false, json: async () => { throw new Error('raw proxy body'); } }), 'invalid-response'],
  ]) {
    await assert.rejects(fetchJsonWithin('/fixture', {}, { fetchImpl }), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message, code);
      return true;
    });
  }
});

test('success preserves HTTP status and clears the deadline', async () => {
  const timer = clock();
  assert.deepEqual(await fetchJsonWithin('/fixture', {}, {
    ...timer, fetchImpl: async () => ({ status: 429, ok: false, json: async () => ({ error: 'limited' }) }),
  }), { status: 429, ok: false, data: { error: 'limited' } });
  assert.deepEqual(timer.cleared, [1]);
});

test('caller cancellation reaches the fetch signal and removes its listener', async () => {
  const controller = new AbortController();
  let resolveFetch;
  let signal;
  const pending = fetchJsonWithin('/fixture', { signal: controller.signal }, {
    fetchImpl: (_url, init) => { signal = init.signal; return new Promise((resolve) => { resolveFetch = resolve; }); },
  });
  await Promise.resolve();
  controller.abort();
  assert.equal(signal.aborted, true);
  resolveFetch({ ok: true, status: 200, json: async () => ({}) });
  await pending;
});

test('already cancelled callers do not start a fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(fetchJsonWithin('/fixture', { signal: controller.signal }, {
    fetchImpl: async () => { calls++; },
  }), { code: 'network' });
  assert.equal(calls, 0);
});

test('requiring helper and login modules has no timer, DOM, or network side effects', () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  for (const file of ['./bounded-request', './login']) {
    const context = { module: { exports: {} } };
    for (const name of ['fetch', 'setTimeout', 'document', 'window']) {
      Object.defineProperty(context, name, { get() { throw new Error(`unexpected import access: ${name}`); } });
    }
    vm.runInNewContext(fs.readFileSync(require.resolve(file), 'utf8'), context);
    assert.ok(Object.keys(context.module.exports).length);
  }
});

function cappedResponse(chunks, extras = {}) {
  let cancelled = 0;
  const queue = [...chunks];
  return { ok: true, status: 200, ...extras,
    body: { getReader: () => ({ read: async () => queue.length ? { done: false, value: queue.shift() } : { done: true },
      cancel() { cancelled++; } }) },
    json() { throw Error('unbounded json must not run'); }, text() { throw Error('unbounded text must not run'); },
    cancelled: () => cancelled,
  };
}

test('capped responses count streamed bytes, parse JSON, and reject header or chunk overrun', async () => {
  const good = cappedResponse([Buffer.from('{"ok":'), Buffer.from('true}')]);
  assert.deepEqual((await fetchJsonWithin('/', {}, { maxResponseBytes: 12, fetchImpl: async () => good })).data, { ok: true });
  for (const extra of [null, { headers: { get: () => '4097' } }]) {
    const body = cappedResponse([Buffer.alloc(4096), Buffer.from('x')], extra || {});
    let signal;
    await assert.rejects(fetchJsonWithin('/', {}, { maxResponseBytes: 4096, fetchImpl: async (_url, init) => { signal = init.signal; return body; } }), { code: 'invalid-response' });
    assert.equal(signal.aborted, true); assert.equal(body.cancelled(), 1);
  }
});

test('capped response requires reader and deadline cancels an infinite body', async () => {
  await assert.rejects(fetchJsonWithin('/', {}, { maxResponseBytes: 4096,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) }), { code: 'invalid-response' });
  const timer = clock(); let cancelled = 0; let signal;
  const pending = fetchJsonWithin('/', {}, { ...timer, maxResponseBytes: 4096,
    fetchImpl: async (_url, init) => { signal = init.signal; return { ok: true, status: 200,
      body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => { cancelled++; } }) } }; },
  });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  timer.fire(); await assert.rejects(pending, { code: 'timeout' });
  assert.equal(signal.aborted, true); assert.equal(cancelled, 1);
});
