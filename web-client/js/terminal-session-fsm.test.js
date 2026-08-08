const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createTerminalState,
  createTerminalSessionFsm,
  makeTerminalOperationId,
  clearPendingOperation,
} = require('./terminal-session-fsm');

test('createTerminalState is the single session projection owner', () => {
  const state = createTerminalState({ softWarnCount: 2 });
  state.upsertSession({ sessionId: 'a', processStatus: 'starting' }, { activate: true });
  state.upsertSession({ sessionId: 'b', processStatus: 'running' });
  assert.equal(state.activeSessionId(), 'a');
  assert.equal(state.getSession('a').processStatus, 'starting');
  state.updateSession('a', { processStatus: 'running' });
  assert.equal(state.getSession('a').processStatus, 'running');
  state.closeTab('a');
  assert.equal(state.activeSessionId(), 'b');
});

test('createTerminalSessionFsm owns attached and pending operation maps', () => {
  const fsm = createTerminalSessionFsm();
  fsm.upsertSession({ sessionId: 's1', processStatus: 'running' }, { activate: true });

  const attachOp = fsm.beginAttach('s1');
  assert.equal(typeof attachOp, 'string');
  assert.ok(attachOp.length <= 128);
  assert.equal(fsm.pendingAttachSessionIds.get('s1'), attachOp);
  assert.equal(fsm.hasPendingAttach('s1'), true);

  fsm.completeAttach({
    action: 'attach',
    sessionId: 's1',
    operationId: 'stale',
  });
  assert.equal(fsm.pendingAttachSessionIds.get('s1'), attachOp);
  assert.equal(fsm.isAttached('s1'), true);

  fsm.completeAttach({
    action: 'attach',
    sessionId: 's1',
    operationId: attachOp,
  });
  assert.equal(fsm.hasPendingAttach('s1'), false);

  const closeOp = fsm.beginClose('s1');
  fsm.releasePendingForTerminalError({
    action: 'close',
    sessionId: 's1',
    operationId: 'stale-close',
    code: 'terminal_session_not_attached',
  });
  assert.equal(fsm.pendingCloseSessionIds.get('s1'), closeOp);

  fsm.releasePendingForTerminalError({
    action: 'attach',
    sessionId: 's1',
    operationId: attachOp,
    code: 'terminal_attach_failed',
  });
  assert.equal(fsm.pendingCloseSessionIds.get('s1'), closeOp);

  fsm.completeClose({
    action: 'close',
    sessionId: 's1',
    operationId: closeOp,
  });
  assert.equal(fsm.hasPendingClose('s1'), false);
  assert.equal(fsm.isAttached('s1'), false);
});

test('clearPendingOperation rejects stale ids and accepts legacy empty operationId', () => {
  const pending = new Map([['s1', 'op-current']]);
  assert.equal(clearPendingOperation(pending, 's1', 'op-stale'), false);
  assert.equal(pending.get('s1'), 'op-current');
  assert.equal(clearPendingOperation(pending, 's1', 'op-current'), true);
  assert.equal(pending.has('s1'), false);

  pending.set('s2', makeTerminalOperationId('close'));
  assert.equal(clearPendingOperation(pending, 's2', null), true);
  assert.equal(pending.has('s2'), false);
});
