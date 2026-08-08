'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createTerminalInputGate } = require('./terminal-input-gate');

test('rejects when session is missing', () => {
  const gate = createTerminalInputGate({
    isConnected: () => true,
    isAttached: () => true,
    processStatus: () => 'running',
    transportCanSend: () => true,
  });
  assert.deepEqual(gate.decide(null), { allowed: false, reason: 'session_missing' });
  assert.deepEqual(gate.decide(''), { allowed: false, reason: 'session_missing' });
});

test('rejects when socket is disconnected', () => {
  const gate = createTerminalInputGate({
    isConnected: () => false,
    isAttached: () => true,
    processStatus: () => 'running',
    transportCanSend: () => true,
  });
  assert.deepEqual(gate.decide('s1'), { allowed: false, reason: 'socket_disconnected' });
});

test('rejects when not attached or not running', () => {
  const gate = createTerminalInputGate({
    isConnected: () => true,
    isAttached: (id) => id === 's1',
    processStatus: (id) => (id === 's1' ? 'exited' : 'running'),
    transportCanSend: () => true,
  });
  assert.deepEqual(gate.decide('s1'), { allowed: false, reason: 'process_not_running' });
  assert.deepEqual(gate.decide('s2'), { allowed: false, reason: 'session_not_attached' });
});

test('rejects when process is starting', () => {
  const gate = createTerminalInputGate({
    isConnected: () => true,
    isAttached: () => true,
    processStatus: () => 'starting',
    transportCanSend: () => true,
  });
  assert.deepEqual(gate.decide('s1'), { allowed: false, reason: 'process_not_running' });
});

test('rejects when transport cannot send', () => {
  const gate = createTerminalInputGate({
    isConnected: () => true,
    isAttached: () => true,
    processStatus: () => 'running',
    transportCanSend: () => false,
  });
  assert.deepEqual(gate.decide('s1'), { allowed: false, reason: 'transport_not_ready' });
});

test('allows only attached running with transport ok', () => {
  const gate = createTerminalInputGate({
    isConnected: () => true,
    isAttached: (id) => id === 's1',
    processStatus: () => 'running',
    transportCanSend: () => true,
  });
  assert.deepEqual(gate.decide('s1'), { allowed: true, reason: null });
});
