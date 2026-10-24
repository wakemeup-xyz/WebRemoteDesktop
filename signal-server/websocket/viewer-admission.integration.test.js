process.env.JWT_SECRET = 'fixture-jwt-secret';
process.env.ACCESS_PASSWORD = 'fixture-viewer-password';
process.env.HOST_PASSWORD = 'fixture-host-password';
const assert = require('node:assert/strict');
const test = require('node:test');
const { setupSignaling } = require('./signaling');
const { createRuntimeContext } = require('./runtime-context');
const { DesktopControlLease } = require('../lib/desktop-control-lease');
const { FakeSocket, makeIo } = require('./signaling-test-fixture');

function fixture(options = {}) {
  let now = 0;
  const timers = [];
  const runtime = createRuntimeContext({ now: () => now, ...options });
  const lease = new DesktopControlLease({ now: () => now, makeLeaseId: () => require("node:crypto").randomUUID() });
  const io = makeIo();
  setupSignaling(io, { runtimeContext: runtime, desktopControlLease: lease, now: () => now,
    // These admission fixtures intentionally drive one 8s grace/one ACK timer.
    // Production defaults (30s and bounded retries) have separate contract tests.
    viewerDisconnectGraceMs: 8000, rebindAckTimeoutsMs: [1500],
    structuredLogger: options.structuredLogger,
    scheduler: { setInterval: () => ({ unref() {} }), setTimeout(fn, ms) {
      const timer = { fn, ms, cancelled: false, unref() {} }; timers.push(timer); return timer;
    }, clearTimeout(timer) { if (timer) timer.cancelled = true; } } });
  const host = new FakeSocket('host', 'host'); io.connect(host);
  function viewer(id, session, admission) {
    const socket = new FakeSocket(id, 'viewer');
    socket.handshake.auth.token = require('../lib/auth').signAccessToken('viewer', 'viewer-password-login');
    socket.handshake.auth.viewerSessionId = session;
    if (admission) socket.handshake.auth.viewerAdmission = admission;
    io.connect(socket); return socket;
  }
  function manual(id, session) {
    const ticket = runtime.viewerAdmission?.issue('viewer-password-login', session);
    return viewer(id, session, ticket ? { mode: 'explicit', ticket: ticket.ticket } : undefined);
  }
  function guarded(id, session) {
    const ticket = runtime.viewerAdmission.issue('viewer-password-login', session,
      { initialPolicy: 'vacant-only-v1', context: runtime.viewerAdmissionContext() });
    assert.ok(ticket.ticket, ticket.error);
    return viewer(id, session, { mode: 'explicit', ticket: ticket.ticket });
  }
  function grant(socket) {
    socket.trigger('control-acquire', { requestId: 'acquire' });
    const event = host.sent.filter(e => e.event === 'control-transition').at(-1);
    host.trigger('control-transition-ack', { leaseEpoch: event.data.leaseEpoch, status: 'applied' });
  }
  return { runtime, lease, io, host, timers, viewer, manual, guarded, grant, advance: value => { now = value; } };
}
for (const expired of [false, true]) {
  test(`old disconnected page cannot supersede ACTIVE B ${expired ? 'after' : 'inside'} grace`, () => {
    const h = fixture();
    const a = h.manual('a', 'old-page-session'); a.disconnect();
    if (expired) {
      h.advance(8001);
      h.timers.filter(t => t.ms === 8000 && !t.cancelled).forEach(t => t.fn());
    }
    const b = h.manual('b', 'current-page-session'); h.grant(b);
    const before = h.lease.snapshot(); const events = h.host.sent.length; const epoch = h.runtime.viewerEpoch();
    const a2 = h.viewer('a2', 'old-page-session');
    assert.equal(b.disconnected, false);
    assert.deepEqual([...h.runtime.connections.viewers.keys()], ['b']);
    assert.deepEqual(h.lease.snapshot(), before);
    assert.equal(h.host.sent.length, events, 'no producer/reset/host status side effect');
    assert.equal(h.runtime.viewerEpoch(), epoch);
    assert.equal(a2.disconnected, true);
  });
}
function admissionOf(socket) { return socket.sent.find(e => e.event === 'connected')?.data.viewerAdmission; }
function expectRejectedWithoutMutation(h, connect, proof = null) {
  if (proof) assert.equal(h.runtime.hasProofAdmission(proof), true);
  const viewers = [...h.runtime.connections.viewers];
  const snapshot = h.lease.snapshot(), count = h.host.sent.length, epoch = h.runtime.viewerEpoch();
  const rejected = connect();
  assert.equal(rejected.disconnected, true);
  assert.ok(rejected.sent.some(e => e.event === 'viewer-admission-rejected'));
  assert.deepEqual([...h.runtime.connections.viewers], viewers);
  assert.deepEqual(h.lease.snapshot(), snapshot);
  assert.equal(h.host.sent.length, count);
  assert.equal(h.runtime.viewerEpoch(), epoch);
  if (proof) assert.equal(h.runtime.hasProofAdmission(proof), true, 'rejection must preserve the outstanding proof');
}

for (const guardedOwner of [false, true]) {
  test(`${guardedOwner ? 'guarded' : 'human'} current owner resumes inside grace only after Host ACK, and after grace requires reset/regrant`, () => {
    for (const expired of [false, true]) {
      const h = fixture();
      const a = h[guardedOwner ? 'guarded' : 'manual']('a', 'current-session'); h.grant(a);
      const identity = admissionOf(a); const prior = h.lease.snapshot(); a.disconnect();
      if (expired) {
        h.advance(8001); h.timers.filter(t => t.ms === 8000 && !t.cancelled).forEach(t => t.fn());
      }
      const a2 = h.viewer('a2', 'current-session', identity);
      assert.equal(a2.disconnected, false);
      assert.deepEqual([...h.runtime.connections.viewers.keys()], ['a2']);
      if (!expired) {
        const rebind = h.host.sent.find(e => e.event === 'viewer-session-rebind');
        assert.ok(rebind); assert.equal(a2._wrdRebindPending, true);
        assert.equal(a2.sent.some(e => e.event === 'control-grant'), false);
        rebind.ack(null, { status: 'applied' });
        assert.equal(h.lease.snapshot().leaseEpoch, prior.leaseEpoch);
        assert.equal(a2._wrdRebindPending, false);
      } else {
        assert.equal(h.host.sent.some(e => e.event === 'viewer-session-rebind'), false);
        assert.equal(a2.sent.some(e => e.event === 'control-grant'), false);
        const reset = h.host.sent.filter(e => e.event === 'control-transition').at(-1);
        a2.trigger('control-acquire', { requestId: 'before-reset-applied' });
        assert.equal(a2.sent.some(e => e.event === 'control-grant'), false);
        assert.equal(h.lease.snapshot().state, 'REVOKING');
        h.host.trigger('control-transition-ack', { leaseEpoch: reset.data.leaseEpoch, status: 'applied' });
        assert.equal(h.lease.snapshot().state, 'FREE');
        h.grant(a2); assert.equal(h.lease.snapshot().state, 'ACTIVE');
      }
    }
  });
}

test('explicit B replaces A but cannot acquire before the reset barrier', () => {
  const h = fixture(); const a = h.manual('a', 'session-alpha'); h.grant(a);
  const b = h.manual('b', 'session-bravo');
  assert.equal(a.disconnected, true);
  assert.equal(h.lease.snapshot().state, 'REVOKING');
  b.trigger('control-acquire', { requestId: 'early' });
  assert.equal(b.sent.some(e => e.event === 'control-grant'), false);
  const reset = h.host.sent.filter(e => e.event === 'control-transition').at(-1);
  h.host.trigger('control-transition-ack', { leaseEpoch: reset.data.leaseEpoch, status: 'applied' });
  h.grant(b); assert.equal(h.lease.snapshot().state, 'ACTIVE');
});

test('ticket replay is same generation only; late/expired/unknown/foreign tickets never mutate owner', () => {
  const h = fixture({ viewerAdmissionTtlMs: 100 });
  const issue = session => h.runtime.viewerAdmission.issue('viewer-password-login', session);
  const aTicket = issue('session-alpha');
  const a = h.viewer('a', 'session-alpha', { mode: 'explicit', ticket: aTicket.ticket });
  const generation = admissionOf(a).generation; a.disconnect();
  const retry = h.viewer('a2', 'session-alpha', { mode: 'explicit', ticket: aTicket.ticket });
  assert.equal(admissionOf(retry).generation, generation);
  const late = issue('session-late');
  const b = h.manual('b', 'session-bravo'); h.grant(b);
  for (const [session, ticket] of [['session-alpha', aTicket.ticket], ['session-late', late.ticket], ['session-bravo', 'unknown']]) {
    expectRejectedWithoutMutation(h, () => h.viewer('reject', session, { mode: 'explicit', ticket }));
  }
  const foreign = h.runtime.viewerAdmission.issue('different-subject', 'session-bravo');
  expectRejectedWithoutMutation(h, () => h.viewer('foreign', 'session-bravo', { mode: 'explicit', ticket: foreign.ticket }));
  const expired = issue('session-expired'); h.advance(101);
  expectRejectedWithoutMutation(h, () => h.viewer('expired', 'session-expired', { mode: 'explicit', ticket: expired.ticket }));
  expectRejectedWithoutMutation(h, () => h.viewer('wrong-generation', 'session-bravo', { mode: 'resume', generation: 'old-generation' }));
});

test('capacity preserves consumed evidence, TTL frees tickets but never the current owner or ordering fence', () => {
  const h = fixture({ viewerAdmissionTtlMs: 50, maxViewerAdmissions: 2 });
  const a = h.manual('a', 'session-alpha'); const identity = admissionOf(a);
  const pending = h.runtime.viewerAdmission.issue('viewer-password-login', 'session-pending');
  assert.ok(pending.ticket);
  assert.equal(h.runtime.viewerAdmission.issue('viewer-password-login', 'session-full').error, 'admission-capacity');
  h.advance(51); a.disconnect();
  const recovered = h.viewer('a2', 'session-alpha', identity);
  assert.equal(recovered.disconnected, false);
  expectRejectedWithoutMutation(h, () => h.viewer('unknown', 'unknown-session', { mode: 'resume', generation: null }));
  const b = h.manual('b', 'session-bravo'); assert.equal(b.disconnected, false);
  h.advance(1000000); b.disconnect();
  h.timers.filter(t => t.ms === 8000 && !t.cancelled).forEach(t => t.fn());
  expectRejectedWithoutMutation(h, () => h.viewer('old-legacy', 'session-alpha'));
  expectRejectedWithoutMutation(h, () => h.viewer('old-resume', 'session-alpha', identity));
});

test('legacy compatibility permits first zero-Viewer session and same current session only', () => {
  const h = fixture(); const a = h.viewer('legacy-a', 'legacy-session');
  assert.equal(a.disconnected, false);
  expectRejectedWithoutMutation(h, () => h.viewer('legacy-conflict', 'other-session'));
  a.disconnect();
  const a2 = h.viewer('legacy-a2', 'legacy-session'); assert.equal(a2.disconnected, false);
  h.manual('new', 'new-session');
  expectRejectedWithoutMutation(h, () => h.viewer('old-legacy', 'legacy-session'));
  const fresh = fixture();
  expectRejectedWithoutMutation(fresh, () => fresh.viewer('unknown-resume', 'unknown-session', { mode: 'resume', generation: 'prior-server' }));
});

test('strict one-use proof blocks prior ordinary recovery; fresh explicit human Start can supersede', () => {
  const h = fixture(); const a = h.manual('a', 'session-alpha'); const old = admissionOf(a); a.disconnect();
  h.advance(8001); h.timers.filter(t => t.ms === 8000 && !t.cancelled).forEach(t => t.fn());
  const proof = h.runtime.issueProofAdmission(); assert.ok(proof);
  const p = new FakeSocket('proof', 'viewer'); p.handshake.auth.proofAdmission = proof; h.io.connect(p);
  assert.equal(p.disconnected, false);
  expectRejectedWithoutMutation(h, () => h.viewer('old', 'session-alpha', old));
  assert.equal(h.runtime.getProofViewerConsumer(proof).socketId, 'proof');
  const replay = new FakeSocket('replay', 'viewer'); replay.handshake.auth.proofAdmission = proof; h.io.connect(replay);
  assert.equal(replay.disconnected, true); assert.equal(p.disconnected, false);
  assert.equal(h.runtime.issueProofAdmission(), null);
  const b = h.manual('b', 'session-bravo'); assert.equal(b.disconnected, false); assert.equal(p.disconnected, true);
});

for (const hostOutcome of ['missing', 'rejected', 'timeout']) {
  test(`admission does not bypass Host ${hostOutcome} barrier`, () => {
    const h = fixture(); const a = h.manual('a', 'session-alpha'); h.grant(a); const identity = admissionOf(a); a.disconnect();
    if (hostOutcome === 'missing') h.host.disconnect();
    const a2 = h.viewer('a2', 'session-alpha', identity);
    const rebind = h.host.sent.find(e => e.event === 'viewer-session-rebind');
    if (rebind) rebind.ack(hostOutcome === 'timeout' ? new Error('timeout') : null, { status: 'rejected' });
    assert.equal(a2.sent.some(e => e.event === 'control-grant'), false);
    assert.notEqual(h.lease.snapshot().state, 'ACTIVE');
  });
}

test('legacy same-session handshake cannot bypass a subsequent explicit generation', () => {
  const h = fixture(); const a = h.viewer('legacy', 'same-session'); a.disconnect();
  h.manual('explicit', 'same-session');
  expectRejectedWithoutMutation(h, () => h.viewer('legacy-old', 'same-session'));
});

test('rejected old resume preserves outstanding zero-Viewer proof and proof occupancy fences ordinary history', () => {
  const h = fixture(); const a = h.manual('a', 'session-alpha'); const identity = admissionOf(a); a.disconnect();
  h.advance(8001); h.timers.filter(t => t.ms === 8000 && !t.cancelled).forEach(t => t.fn());
  const b = h.manual('b', 'session-bravo'); b.disconnect();
  h.advance(16002); h.timers.filter(t => t.ms === 8000 && !t.cancelled).forEach(t => t.fn());
  const proof = h.runtime.issueProofAdmission();
  expectRejectedWithoutMutation(h, () => h.viewer('old', 'session-alpha', identity));
  assert.equal(h.runtime.hasProofAdmission(proof), true);
  const p = new FakeSocket('proof', 'viewer'); p.handshake.auth.proofAdmission = proof; h.io.connect(p); p.disconnect();
  expectRejectedWithoutMutation(h, () => h.viewer('old-b', 'session-bravo', admissionOf(b)));
});

function guardedTicket(h, session = 'session-guard') {
  const result = h.runtime.viewerAdmission.issue('viewer-password-login', session,
    { initialPolicy: 'vacant-only-v1', context: h.runtime.viewerAdmissionContext() });
  assert.ok(result.ticket, result.error);
  return { mode: 'explicit', ticket: result.ticket };
}
function expireGrace(h, at) {
  h.advance(at);
  h.timers.filter(t => t.ms === 8000 && !t.cancelled).forEach(t => t.fn());
}
function proofViewer(h, id, proof) {
  const socket = new FakeSocket(id, 'viewer'); socket.handshake.auth.proofAdmission = proof;
  h.io.connect(socket); return socket;
}

test('two guarded tickets race through real handlers; only the first can claim the vacant epoch', () => {
  const h = fixture();
  const first = guardedTicket(h, 'session-first');
  const second = guardedTicket(h, 'session-second');
  const a = h.viewer('first', 'session-first', first);
  assert.equal(a.disconnected, false);
  expectRejectedWithoutMutation(h, () => h.viewer('second', 'session-second', second));
  a.disconnect(); expireGrace(h, 8001);
  const proof = h.runtime.issueProofAdmission(); assert.ok(proof);
  expectRejectedWithoutMutation(h, () => h.viewer('second-vacant', 'session-second', second), proof);
});

test('guard rejected after human issue preserves outstanding proof and human Start', () => {
  const h = fixture(); const guard = guardedTicket(h);
  const proof = h.runtime.issueProofAdmission(); assert.ok(proof);
  const human = h.runtime.viewerAdmission.issue('viewer-password-login', 'session-human');
  expectRejectedWithoutMutation(h, () => h.viewer('guard', 'session-guard', guard), proof);
  const accepted = h.viewer('human', 'session-human', { mode: 'explicit', ticket: human.ticket });
  assert.equal(accepted.disconnected, false);
  assert.equal(h.runtime.hasProofAdmission(proof), false);
});

for (const changed of ['host', 'relay', 'epoch']) {
  test(`rejected guarded handler after ${changed} change preserves proof and can never grant`, () => {
    const h = fixture(); const guard = guardedTicket(h);
    if (changed === 'host') h.host.disconnect();
    if (changed === 'relay') h.runtime.connections.relayViewers.set('relay', new FakeSocket('relay', 'relay-viewer'));
    if (changed === 'epoch') h.runtime.noteHumanViewerAdmission();
    const proof = h.runtime.issueProofAdmission(); assert.ok(proof);
    expectRejectedWithoutMutation(h, () => h.viewer('guard', 'session-guard', guard), proof);
  });
}

test('guarded issue and first consume both reject grace-retained occupancy', () => {
  const h = fixture(); const guard = guardedTicket(h);
  const first = h.guarded('first', 'session-first'); first.disconnect();
  assert.equal(h.runtime.viewerAdmission.issue('viewer-password-login', 'session-newguard',
    { initialPolicy: 'vacant-only-v1', context: h.runtime.viewerAdmissionContext() }).error, 'viewer-occupied');
  expectRejectedWithoutMutation(h, () => h.viewer('guard', 'session-guard', guard));
});

test('retained human after grace and TTL blocks guard; retained guard allows new initial admission', () => {
  for (const human of [true, false]) {
    const h = fixture({ viewerAdmissionTtlMs: 100 });
    const owner = h[human ? 'manual' : 'guarded']('owner', 'session-owner');
    const identity = admissionOf(owner); owner.disconnect(); expireGrace(h, 120001);
    const result = h.runtime.viewerAdmission.issue('viewer-password-login', 'session-nextguard',
      { initialPolicy: 'vacant-only-v1', context: h.runtime.viewerAdmissionContext() });
    if (human) {
      assert.equal(result.error, 'human-owner-retained');
      assert.equal(h.viewer('owner-resume', 'session-owner', identity).disconnected, false);
    } else {
      assert.ok(result.ticket);
      assert.equal(h.viewer('new-guard', 'session-nextguard', { mode: 'explicit', ticket: result.ticket }).disconnected, false);
      expectRejectedWithoutMutation(h, () => h.viewer('old-guard', 'session-owner', identity));
    }
  }
});

test('guarded consumed lost-welcome retry stays current and loses permanently to admitted human', () => {
  const h = fixture(); const ticket = guardedTicket(h);
  const a = h.viewer('guard', 'session-guard', ticket); const identity = admissionOf(a); a.disconnect();
  const retry = h.viewer('retry', 'session-guard', ticket);
  assert.deepEqual(admissionOf(retry), identity);
  const human = h.manual('human', 'session-human'); human.disconnect(); expireGrace(h, 120001);
  const proof = h.runtime.issueProofAdmission(); assert.ok(proof);
  expectRejectedWithoutMutation(h, () => h.viewer('stale-ticket', 'session-guard', ticket), proof);
  expectRejectedWithoutMutation(h, () => h.viewer('stale-resume', 'session-guard', identity), proof);
});

for (const first of ['proof', 'guard']) {
  test(`${first}-first consumes real admission authority and rejects the competing handshake`, () => {
    const h = fixture(); const ticket = guardedTicket(h); const proof = h.runtime.issueProofAdmission();
    assert.equal(h.runtime.hasProofAdmission(proof), true, 'guard issuance must preserve proof');
    if (first === 'proof') {
      assert.equal(proofViewer(h, 'proof', proof).disconnected, false);
      expectRejectedWithoutMutation(h, () => h.viewer('guard', 'session-guard', ticket));
    } else {
      assert.equal(h.viewer('guard', 'session-guard', ticket).disconnected, false);
      assert.equal(h.runtime.hasProofAdmission(proof), false);
      const before = [...h.runtime.connections.viewers]; const epoch = h.runtime.viewerEpoch();
      assert.equal(proofViewer(h, 'proof', proof).disconnected, true);
      assert.deepEqual([...h.runtime.connections.viewers], before);
      assert.equal(h.runtime.viewerEpoch(), epoch);
    }
  });
}

for (const changed of ['old-operation', 'host']) {
  test(`guarded owner late rebind ACK after ${changed} change cannot grant`, () => {
    const h = fixture(); const a = h.guarded('a', 'session-guard'); h.grant(a);
    const identity = admissionOf(a); a.disconnect();
    const b = h.viewer('b', 'session-guard', identity);
    const old = h.host.sent.filter(e => e.event === 'viewer-session-rebind').at(-1);
    assert.ok(old); assert.equal(b.sent.some(e => e.event === 'control-grant'), false);
    let current = b;
    if (changed === 'old-operation') {
      b.disconnect(); current = h.viewer('c', 'session-guard', identity);
      assert.ok(h.host.sent.filter(e => e.event === 'viewer-session-rebind').at(-1));
    } else {
      h.host.disconnect(); h.io.connect(new FakeSocket('replacement-host', 'host'));
    }
    old.ack(null, { status: 'applied' });
    assert.equal(b.sent.some(e => e.event === 'control-grant'), false);
    assert.equal(current.sent.some(e => e.event === 'control-grant'), false);
    if (changed === 'old-operation') {
      const next = h.host.sent.filter(e => e.event === 'viewer-session-rebind').at(-1);
      next.ack(null, { status: 'applied' });
      assert.equal(current.sent.some(e => e.event === 'control-grant'), true);
    }
  });
}

for (const throwing of [false, true]) {
  test(`grace expiry observes resulting epoch after identity-checked removal; logger throws=${throwing}`, () => {
    const events = [];
    const h = fixture({ structuredLogger: { info(value) {
      if (value.event === 'viewer_disconnect_grace_expired') {
        assert.equal(h.runtime.connections.viewers.has('expiry-owner'), false);
        events.push(value);
        if (throwing) throw new Error('fixture logger failure');
      }
    } } });
    const a = h.manual('expiry-owner', 'expiry-session'); h.grant(a); a.disconnect();
    const timer = h.timers.find(t => t.ms === 8000 && !t.cancelled);
    assert.equal(timer.ms, 8000); h.advance(8001);
    assert.doesNotThrow(() => timer.fn());
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].correlation, { viewerId: 'expiry-owner', browserSessionId: 'expiry-session' });
    assert.deepEqual(events[0].meta, { reason: 'viewer-disconnect-timeout', leaseEpoch: h.lease.snapshot().leaseEpoch, state: 'REVOKING' });
    assert.deepEqual([...h.runtime.connections.viewers.keys()], []);
    timer.fn(); assert.equal(events.length, 1, 'stale callback cannot repeat evidence');
  });
}
test('rebind evidence requires applied Host ACK and contains current epoch; replaced grace callback is silent', () => {
  const events = []; const h = fixture({ structuredLogger: { info: value => events.push(value) } });
  const a = h.manual('before', 'same-session'); h.grant(a); const identity = admissionOf(a); a.disconnect();
  const old = h.timers.find(t => t.ms === 8000 && !t.cancelled);
  const next = h.viewer('after', 'same-session', identity);
  old.fn(); assert.equal(events.some(e => e.event === 'viewer_disconnect_grace_expired'), false);
  assert.equal(events.some(e => e.event === 'viewer_rebind_confirmed'), false);
  h.host.sent.find(e => e.event === 'viewer-session-rebind').ack(null, { status: 'applied' });
  const confirmed = events.filter(e => e.event === 'viewer_rebind_confirmed');
  assert.equal(confirmed.length, 1); assert.equal(confirmed[0].meta.leaseEpoch, h.lease.snapshot().leaseEpoch);
  assert.deepEqual(confirmed[0].correlation, { viewerId: 'after', previousViewerId: 'before', browserSessionId: 'same-session' });
  assert.equal(next._wrdRebindPending, false);
});

for (const outcome of ['rejected', 'timeout', 'cancelled']) {
  test(`failed rebind ${outcome} observation carries the direct server session`, () => {
    const events = []; const h = fixture({ structuredLogger: { info: value => events.push(value) } });
    const a = h.manual('before-failure', 'failure-session'); h.grant(a);
    const identity = admissionOf(a); a.disconnect();
    const next = h.viewer('after-failure', 'failure-session', identity);
    const rebind = h.host.sent.find(e => e.event === 'viewer-session-rebind');
    assert.ok(rebind); assert.equal(next._wrdRebindPending, true);
    assert.equal(events.some(e => e.event === 'viewer_rebind_failed'), false);
    if (outcome === 'cancelled') {
      // A same-ID replacement preserves the active lease, exercising the
      // operation's Host-object identity check before its old ACK can grant.
      h.io.connect(new FakeSocket('host', 'host'));
      assert.equal(h.lease.snapshot().state, 'ACTIVE');
      rebind.ack(null, { status: 'applied' });
    } else {
      rebind.ack(outcome === 'timeout' ? new Error('fixture timeout') : null, { status: 'rejected' });
    }
    const failed = events.filter(e => e.event === 'viewer_rebind_failed');
    assert.equal(failed.length, 1);
    assert.deepEqual(failed[0].correlation, { viewerId: 'after-failure', previousViewerId: 'before-failure', browserSessionId: 'failure-session' });
    assert.equal(failed[0].meta.reason, `rebind-${outcome}`);
    assert.equal(h.lease.snapshot().state, 'REVOKING');
    assert.equal(next.sent.some(e => e.event === 'control-grant'), false);
    assert.equal(next._wrdRebindPending, false);
  });
}
