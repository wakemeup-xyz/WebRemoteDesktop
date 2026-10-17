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
  function grant(socket) {
    socket.trigger('control-acquire', { requestId: 'acquire' });
    const event = host.sent.filter(e => e.event === 'control-transition').at(-1);
    host.trigger('control-transition-ack', { leaseEpoch: event.data.leaseEpoch, status: 'applied' });
  }
  return { runtime, lease, io, host, timers, viewer, manual, grant, advance: value => { now = value; } };
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
function expectRejectedWithoutMutation(h, connect) {
  const viewers = [...h.runtime.connections.viewers];
  const snapshot = h.lease.snapshot(), count = h.host.sent.length, epoch = h.runtime.viewerEpoch();
  const rejected = connect();
  assert.equal(rejected.disconnected, true);
  assert.ok(rejected.sent.some(e => e.event === 'viewer-admission-rejected'));
  assert.deepEqual([...h.runtime.connections.viewers], viewers);
  assert.deepEqual(h.lease.snapshot(), snapshot);
  assert.equal(h.host.sent.length, count);
  assert.equal(h.runtime.viewerEpoch(), epoch);
}

test('current owner resumes inside grace only after Host ACK, and after grace requires reset/regrant', () => {
  for (const expired of [false, true]) {
    const h = fixture();
    const a = h.manual('a', 'current-session'); h.grant(a);
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
      h.host.trigger('control-transition-ack', { leaseEpoch: reset.data.leaseEpoch, status: 'applied' });
      h.grant(a2); assert.equal(h.lease.snapshot().state, 'ACTIVE');
    }
  }
});

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
