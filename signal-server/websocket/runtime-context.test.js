'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { signAccessToken } = require('../lib/auth');
const { createRuntimeContext } = require('./runtime-context');
const { setupSignaling } = require('./signaling');

process.env.JWT_SECRET = process.env.JWT_SECRET || '12345678';
process.env.ACCESS_PASSWORD = process.env.ACCESS_PASSWORD || 'test-viewer-password';
process.env.HOST_PASSWORD = process.env.HOST_PASSWORD || 'test-host-password';

class Socket extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.handshake = {
      auth: { role: 'viewer', token: signAccessToken('viewer', id) },
      address: '127.0.0.1',
      headers: {},
    };
    this.sent = [];
  }

  emit(event, data) {
    this.sent.push({ event, data });
    return true;
  }

  trigger(event, data) {
    return super.emit(event, data);
  }
}

function ioHarness() {
  return {
    middleware: null,
    connectionHandler: null,
    use(handler) { this.middleware = handler; },
    on(event, handler) { if (event === 'connection') this.connectionHandler = handler; },
    of() { return { use() {}, on() {} }; },
    connect(socket) {
      this.middleware(socket, (error) => { if (error) throw error; });
      this.connectionHandler(socket);
    },
  };
}

test('runtime contexts isolate registries and host capabilities', () => {
  const first = createRuntimeContext();
  const second = createRuntimeContext();
  const socket = { id: 'viewer-a', handshake: { address: '127.0.0.1', headers: {} } };
  first.connections.viewers.set(socket.id, socket);
  first.setHostCapabilities({ turnReady: true, turnServerIds: ['turn-a'] });
  assert.equal(second.connections.viewers.size, 0);
  assert.equal(second.getHostCapabilities().turnReady, false);
  assert.deepEqual(first.getViewerSnapshot()[0], { id: 'viewer-a', ip: '127.0.0.1', userAgent: 'unknown' });
});

test('capability snapshots do not expose mutable arrays', () => {
  const context = createRuntimeContext();
  context.setHostCapabilities({ turnServerIds: ['a', 'a', ' b '] });
  const snapshot = context.getHostCapabilities();
  snapshot.turnServerIds.push('c');
  assert.deepEqual(context.getHostCapabilities().turnServerIds, ['a', 'b']);
});

test('setupSignaling accepts isolated contexts without cross-instance viewers', () => {
  const first = createRuntimeContext();
  const second = createRuntimeContext();
  const ioA = ioHarness();
  const ioB = ioHarness();
  setupSignaling(ioA, { runtimeContext: first, scheduler: { setInterval: () => ({ unref() {} }) } });
  setupSignaling(ioB, { runtimeContext: second, scheduler: { setInterval: () => ({ unref() {} }) } });
  ioA.connect(new Socket('viewer-a'));
  ioB.connect(new Socket('viewer-b'));
  assert.equal(first.connections.viewers.size, 1);
  assert.equal(second.connections.viewers.size, 1);
  assert.equal(first.connections.viewers.has('viewer-b'), false);
  assert.equal(second.connections.viewers.has('viewer-a'), false);
});
