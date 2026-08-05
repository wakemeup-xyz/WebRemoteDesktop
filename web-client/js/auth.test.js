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
    fetch: async () => ({ ok: true }),
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
    `${fs.readFileSync(path.join(__dirname, 'auth.js'), 'utf8')}\nglobalThis.__Auth = Auth;`,
    context,
  );
  return { Auth: context.__Auth, context, storage };
}

test('Auth reports logged-in state from session token', async () => {
  const { Auth, storage } = loadAuth();
  assert.equal(Auth.isLoggedIn(), false);
  storage.set('wrd_token', 'viewer-token');
  assert.equal(Auth.isLoggedIn(), true);
  assert.equal(await Auth.verifyToken(), true);
});
