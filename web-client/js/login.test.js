'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLoginController } = require('./login');
const { fetchJsonWithin } = require('./bounded-request');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(fetchJson) {
  const tokens = [], navigations = [], errors = [], pending = [];
  const controller = createLoginController({
    fetchJson,
    storage: { setItem(key, value) { tokens.push([key, value]); } },
    view: { setPending(value) { pending.push(value); }, showError(reason) { errors.push(reason); } },
    navigate(url) { navigations.push(url); },
  });
  return { controller, tokens, navigations, errors, pending };
}
const success = (token) => ({ ok: true, status: 200, data: { token } });

test('duplicate submit reuses the active operation and posts the password once', async () => {
  const request = deferred();
  let calls = 0;
  const f = fixture((_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init.body), { password: 'fixture-password' });
    return request.promise;
  });
  const first = f.controller.submit('fixture-password');
  assert.equal(f.controller.submit('duplicate'), first);
  await Promise.resolve();
  request.resolve(success('current-token'));
  assert.equal(await first, true);
  assert.equal(calls, 1);
  assert.deepEqual(f.tokens, [['wrd_token', 'current-token']]);
  assert.deepEqual(f.navigations, ['viewer.html']);
  assert.deepEqual(f.pending, [true, false]);
});

test('timed-out old fetch cannot save its token, navigate, or unlock a newer submit', async () => {
  const requests = [deferred(), deferred()];
  const timers = [];
  let calls = 0;
  const signals = [];
  const f = fixture((url, init) => fetchJsonWithin(url, init, {
    fetchImpl: (_url, options) => { signals.push(options.signal); return requests[calls++].promise; },
    setTimer(fn) { timers.push(fn); return timers.length; }, clearTimer() {},
  }));
  const first = f.controller.submit('first');
  await Promise.resolve(); await Promise.resolve();
  timers[0]();
  assert.equal(await first, false);
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(f.errors, [null, 'timeout']);
  assert.equal(calls, 1, 'password is not automatically replayed');
  const second = f.controller.submit('second');
  await Promise.resolve(); await Promise.resolve();
  requests[0].resolve({ ok: true, status: 200, json: async () => ({ token: 'stale-token' }) });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.tokens, []);
  assert.deepEqual(f.pending, [true, false, true]);
  requests[1].resolve({ ok: true, status: 200, json: async () => ({ token: 'new-token' }) });
  assert.equal(await second, true);
  assert.deepEqual(f.tokens, [['wrd_token', 'new-token']]);
  assert.deepEqual(f.navigations, ['viewer.html']);
  assert.deepEqual(f.pending, [true, false, true, false]);
});

test('disposal aborts the active submit and ignores all of its late UI/storage effects', async () => {
  const request = deferred();
  let signal;
  const f = fixture((_url, init) => { signal = init.signal; return request.promise; });
  const pending = f.controller.submit('fixture');
  await Promise.resolve();
  f.controller.dispose();
  assert.equal(signal.aborted, true);
  request.resolve(success('stale-token'));
  assert.equal(await pending, false);
  assert.deepEqual(f.tokens, []);
  assert.deepEqual(f.navigations, []);
  assert.deepEqual(f.pending, [true]);
  assert.equal(await f.controller.submit('retry-after-dispose'), false);
});

test('login failures use finite reasons and always release the submit button', async () => {
  for (const [response, reason] of [
    [{ ok: false, status: 401, data: { error: 'Invalid password' } }, 'invalid-password'],
    [{ ok: false, status: 400, data: { error: 'Password required' } }, 'password-required'],
    [{ ok: false, status: 503, data: { error: 'raw proxy response' } }, 'server'],
    [{ ok: false, status: 429, data: {} }, 'server'],
    [{ ok: false, status: 403, data: { error: 'raw proxy response' } }, 'invalid-response'],
    [{ ok: true, status: 200, data: {} }, 'invalid-response'],
  ]) {
    const f = fixture(async () => response);
    assert.equal(await f.controller.submit('fixture'), false);
    assert.deepEqual(f.errors, [null, reason]);
    assert.deepEqual(f.pending, [true, false]);
    assert.deepEqual(f.tokens, []);
  }
});

test('bad JSON from a proxy 403 is recoverable without exposing its body', async () => {
  const f = fixture((url, init) => fetchJsonWithin(url, init, {
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => { throw new Error('<html>proxy body</html>'); } }),
  }));
  assert.equal(await f.controller.submit('fixture'), false);
  assert.deepEqual(f.errors, [null, 'invalid-response']);
  assert.deepEqual(f.pending, [true, false]);
});

test('a cached login page can accept an explicit new submit after pagehide disposal', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const elements = {
    password: { value: 'fixture', setAttribute() {}, removeAttribute() {} }, error: {},
  };
  const button = {};
  const listeners = {};
  let submit;
  elements.loginForm = {
    querySelector() { return button; }, addEventListener(_name, callback) { submit = callback; },
  };
  const requests = [deferred(), deferred()];
  let calls = 0;
  const tokens = [];
  const context = {
    AbortController,
    document: { getElementById(id) { return elements[id]; } },
    window: { location: {}, addEventListener(name, listener) { listeners[name] = listener; } },
    sessionStorage: { setItem(_key, value) { tokens.push(value); } },
    localStorage: { removeItem() {} },
    fetchJsonWithin: () => requests[calls++].promise,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('./login'), 'utf8'), context);
  submit({ preventDefault() {} });
  await Promise.resolve();
  listeners.pagehide();
  listeners.pageshow({ persisted: true });
  assert.equal(button.disabled, false);
  submit({ preventDefault() {} });
  await Promise.resolve();
  requests[0].resolve(success('stale-token'));
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(button.disabled, true, 'old finally cannot unlock the restored page submit');
  requests[1].resolve(success('new-token'));
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.deepEqual(tokens, ['new-token']);
  assert.equal(button.disabled, false);
  assert.equal(context.window.location.href, 'viewer.html');
});

test('disposing before the submit microtask does not send a password request', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return success('unused'); });
  const pending = f.controller.submit('fixture');
  f.controller.dispose();
  assert.equal(await pending, false);
  assert.equal(calls, 0);
  assert.deepEqual(f.tokens, []);
});
