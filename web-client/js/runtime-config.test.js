const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadRuntimeConfig(overrides = {}) {
  const storage = new Map();
  const context = {
    window: {
      location: { origin: 'http://localhost:5173' },
      __WRD_API_BASE__: undefined,
      ...(overrides.window || {}),
    },
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
      ...(overrides.localStorage || {}),
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'runtime-config.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__RuntimeConfig = RuntimeConfig;`, context);
  return { RuntimeConfig: context.__RuntimeConfig, storage, context };
}

test('RuntimeConfig uses injected API base for localhost:5173 mappings', () => {
  const { RuntimeConfig } = loadRuntimeConfig({
    window: { __WRD_API_BASE__: 'http://127.0.0.1:8080/' },
  });

  assert.equal(RuntimeConfig.getApiBase(), 'http://127.0.0.1:8080');
  assert.equal(RuntimeConfig.getSocketBase(), 'http://127.0.0.1:8080');
  assert.equal(RuntimeConfig.url('/api/auth/verify'), 'http://127.0.0.1:8080/api/auth/verify');
});

test('RuntimeConfig falls back to localStorage then current origin', () => {
  const { RuntimeConfig, storage } = loadRuntimeConfig();

  storage.set('wrdApiBase', 'https://example.trycloudflare.com/');
  assert.equal(RuntimeConfig.getApiBase(), 'https://example.trycloudflare.com');

  storage.delete('wrdApiBase');
  assert.equal(RuntimeConfig.getApiBase(), 'http://localhost:5173');
});
