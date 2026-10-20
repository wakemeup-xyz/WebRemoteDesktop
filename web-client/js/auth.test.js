'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadAuth(overrides = {}) {
  const storage = new Map();
  const context = {
    console,
    AbortController, setTimeout, clearTimeout,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ valid: true }) }),
    sessionStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    window: {
      location: { href: 'viewer.html', origin: 'http://127.0.0.1:8080' },
    },
    document: {
      addEventListener() {},
    },
    RuntimeConfig: {
      getApiBase() { return 'http://127.0.0.1:8080'; },
    },
  };
  Object.assign(context, overrides);
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    `${fs.readFileSync(path.join(__dirname, 'bounded-request.js'), 'utf8')}\n${fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8')}\nglobalThis.__Auth = Auth;`,
    context,
  );
  return { Auth: context.__Auth, context, storage };
}

test('Auth reports logged-in state from session token', async () => {
  const { Auth, storage } = loadAuth();
  assert.equal(Auth.isLoggedIn(), false);
  storage.set('wrd_token', 'viewer-token');
  assert.equal(Auth.isLoggedIn(), true);
  assert.equal((await Auth.verifyToken()).state, 'verified');
});


test('503 preserves the current token without redirect', async () => {
  const { Auth, storage, context } = loadAuth({
    fetch: async () => ({ ok: false, status: 503,
      json: async () => ({ error: 'unavailable' }) })
  });
  storage.set('wrd_token', 'fixture-token');
  assert.equal(await Auth.init(), false);
  assert.equal(storage.get('wrd_token'), 'fixture-token');
  assert.equal(context.window.location.href, 'viewer.html');
});

test('definitive application 401 clears the current token', async () => {
  const { Auth, storage, context } = loadAuth({
    fetch: async () => ({ ok: false, status: 401,
      json: async () => ({ valid: false, error: 'Invalid token' }) })
  });
  storage.set('wrd_token', 'fixture-token');
  await Auth.init();
  assert.equal(storage.has('wrd_token'), false);
  assert.equal(context.window.location.href, 'index.html');
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function response(status, data) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

test('missing token is an explicit unauthorized result and init keeps its boolean contract', async () => {
  let calls = 0;
  const { Auth, context } = loadAuth({ fetch: async () => { calls++; } });
  const check = await Auth.verifyToken();
  assert.equal(check.state, 'unauthorized');
  assert.equal(check.reason, 'missing-token');
  assert.equal(check.httpStatus, null);
  assert.equal(await Auth.init(), false);
  assert.equal(context.window.location.href, 'index.html');
  assert.equal(calls, 0);
});

test('known application failures require status, valid=false and a recognized error together', async () => {
  for (const [status, data, expected] of [
    [403, { valid: false, error: 'Invalid token' }, 'unauthorized'],
    [401, { error: 'Invalid token' }, 'unavailable'],
    [401, { valid: false, error: 'proxy' }, 'unavailable'],
    [200, { valid: false, error: 'Invalid token' }, 'unavailable'],
    [429, { valid: false, error: 'Invalid token' }, 'unavailable'],
    [503, { valid: false, error: 'Invalid token' }, 'unavailable'],
  ]) {
    const { Auth, storage } = loadAuth({ fetch: async () => response(status, data) });
    storage.set('wrd_token', 'fixture-token');
    const check = await Auth.verifyToken();
    assert.equal(check.state, expected);
    assert.equal(check.httpStatus, status);
    assert.equal(storage.get('wrd_token'), 'fixture-token', 'verification itself does not delete storage');
  }
});

test('proxy HTML, bad JSON, and network failure preserve credentials', async () => {
  for (const [fetch, expectedReason] of [
    [async () => ({ ok: false, status: 403, json: async () => { throw new SyntaxError('raw HTML'); } }), 'invalid-response'],
    [async () => { throw new Error('offline'); }, 'network'],
    [async () => response(200, {}), 'invalid-response'],
    [async () => response(429, {}), 'server'],
  ]) {
    const { Auth, storage, context } = loadAuth({ fetch });
    storage.set('wrd_token', 'fixture-token');
    assert.equal((await Auth.verifyToken()).reason, expectedReason);
    assert.equal(await Auth.init(), false);
    assert.equal(storage.get('wrd_token'), 'fixture-token');
    assert.equal(context.window.location.href, 'viewer.html');
  }
});

test('deadline preserves token when JSON body never settles', async () => {
  let fire;
  const { Auth, storage, context } = loadAuth({
    fetch: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }),
    setTimeout(fn, ms) { fire = fn; assert.equal(ms, 8000); return 1; }, clearTimeout() {},
  });
  storage.set('wrd_token', 'fixture-token');
  const pending = Auth.init();
  await Promise.resolve();
  fire();
  assert.equal(await pending, false);
  assert.equal(storage.get('wrd_token'), 'fixture-token');
  assert.equal(context.window.location.href, 'viewer.html');
});

test('late 401 cannot clear a token installed by a later login', async () => {
  const old = deferred();
  const { Auth, storage, context } = loadAuth({ fetch: () => old.promise });
  storage.set('wrd_token', 'old-token');
  const pending = Auth.init();
  Auth.setToken('new-token');
  old.resolve(response(401, { valid: false, error: 'Invalid token' }));
  assert.equal(await pending, false);
  assert.equal(storage.get('wrd_token'), 'new-token');
  assert.equal(context.window.location.href, 'viewer.html');
});

test('only the current verification generation may report verified or unauthorized', async () => {
  const old = deferred();
  let calls = 0;
  const { Auth, storage } = loadAuth({ fetch: () => calls++ === 0 ? old.promise : Promise.resolve(response(200, { valid: true })) });
  storage.set('wrd_token', 'fixture-token');
  const pending = Auth.verifyToken();
  await Promise.resolve();
  assert.equal(await Auth.init(), true);
  old.resolve(response(401, { valid: false, error: 'Invalid token' }));
  assert.equal((await pending).reason, 'superseded');
  assert.equal(storage.get('wrd_token'), 'fixture-token');
});

test('transient auth retry remains visible, rechecks explicitly, and disappears on success', async () => {
  const elements = new Map();
  function element() {
    return {
      style: {}, children: [], listeners: {}, setAttribute() {},
      addEventListener(name, listener) { this.listeners[name] = listener; },
      appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); },
      remove() { elements.delete(this.id); },
    };
  }
  const document = { addEventListener() {}, createElement: element, getElementById(id) { return elements.get(id); }, body: element() };
  let calls = 0;
  const { Auth, storage, context } = loadAuth({ document,
    fetch: async () => response(++calls === 1 ? 503 : 200, { valid: true }),
  });
  storage.set('wrd_token', 'fixture-token');
  assert.equal(await Auth.init(), false);
  const notice = elements.get('auth-retry');
  assert.ok(notice);
  assert.match(notice.style.cssText, /position:fixed/);
  Auth.showRetry(true);
  assert.equal(document.body.children.length, 1, 'one retry control for repeated failures');
  const button = notice.children[0];
  const pending = button.listeners.click();
  assert.equal(button.disabled, true);
  await pending;
  assert.equal(button.disabled, false);
  assert.equal(elements.has('auth-retry'), false);
  assert.equal(storage.get('wrd_token'), 'fixture-token');
  assert.equal(context.window.location.href, 'viewer.html');
  assert.equal(calls, 2);
});
