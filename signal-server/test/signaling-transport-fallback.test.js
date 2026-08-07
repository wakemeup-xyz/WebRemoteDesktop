'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { Server } = require('socket.io');
const { io } = require('socket.io-client');

/**
 * Real Socket.IO client integration: websocket-first + tryAllTransports must
 * land on polling when the server refuses websocket (not a pure model test).
 */
test('socket.io client falls back to polling when websocket is refused with tryAllTransports', async () => {
  const httpServer = http.createServer();
  // Server accepts polling only — websocket transport is refused.
  const ios = new Server(httpServer, {
    transports: ['polling'],
    cors: { origin: '*' },
    allowEIO3: true,
  });
  ios.on('connection', (socket) => {
    socket.emit('ready', { transport: socket.conn.transport.name });
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();

  const socket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    reconnection: false,
    timeout: 5000,
    forceNew: true,
  });

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('connect timeout waiting for polling fallback')), 8000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve({
        connected: socket.connected,
        transport: socket.io.engine?.transport?.name || null,
      });
    });
  });

  assert.equal(result.connected, true);
  assert.equal(result.transport, 'polling');

  socket.close();
  ios.close();
  await new Promise((resolve) => httpServer.close(resolve));
});

test('socket.io dual-transport connect fails within budget when server is down', async () => {
  // Bind then close so the port is unused — connection must error, not hang forever.
  const httpServer = http.createServer();
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address();
  await new Promise((resolve) => httpServer.close(resolve));

  const started = Date.now();
  const socket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    reconnection: false,
    timeout: 2000,
    forceNew: true,
  });

  const err = await new Promise((resolve) => {
    socket.on('connect_error', (error) => resolve(error));
    socket.on('connect', () => resolve(null));
    setTimeout(() => resolve(new Error('timed out without connect_error')), 6000);
  });

  const elapsed = Date.now() - started;
  assert.ok(err, 'expected connect_error when both transports fail');
  assert.ok(elapsed <= 5500, `dual-transport failure exceeded budget: ${elapsed}ms`);

  socket.close();
});
