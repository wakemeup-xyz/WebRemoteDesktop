'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { createServerApp } = require('../server');
const { createRuntimeContext } = require('../websocket/runtime-context');
const { signAccessToken } = require('../lib/auth');
const { loadConfig } = require('../lib/config');

process.env.JWT_SECRET = 'fixture-api-jwt-secret';
process.env.VIEWER_ACCESS_PASSWORD = 'fixture-api-viewer-password';
process.env.HOST_SHARED_SECRET = 'fixture-api-host-secret';

async function withRuntime(run, options = {}) {
  const state = createRuntimeContext(options);
  const config = { ...loadConfig(), enableTerminal: false, logDir: '', terminalAuditLog: '', enableDiagPersist: false };
  const runtime = createServerApp({ config, signalingRuntimeContext: state, allowSourceFallback: true,
    logger: { log() {}, info() {}, warn() {}, error() {} } });
  const sockets = [];
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  const token = signAccessToken('viewer', 'viewer-password-login', config);
  const request = (session, auth = token, fields = {}) => fetch(`${origin}/api/auth/viewer-admission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify({ viewerSessionId: session, ...fields }),
  });
  async function viewer(session, admission) {
    return new Promise((resolve, reject) => {
      const socket = connect(origin, { autoConnect: false, reconnection: false, transports: ['websocket'],
        auth: { role: 'viewer', token, viewerSessionId: session, viewerAdmission: admission } });
      sockets.push(socket);
      const deadline = setTimeout(() => reject(new Error('fixture socket deadline')), 2000);
      socket.once('connected', data => { clearTimeout(deadline); resolve({ socket, data }); });
      socket.once('viewer-admission-rejected', data => { clearTimeout(deadline); resolve({ socket, rejected: data }); });
      socket.once('connect_error', error => { clearTimeout(deadline); reject(error); });
      socket.connect();
    });
  }
  async function host() {
    return new Promise((resolve, reject) => {
      const socket = connect(origin, { autoConnect: false, reconnection: false, transports: ['websocket'],
        auth: { role: 'host', token: signAccessToken('host', 'host-daemon', config) } });
      sockets.push(socket);
      const deadline = setTimeout(() => reject(new Error('fixture host deadline')), 2000);
      socket.once('connected', () => { clearTimeout(deadline); resolve(socket); });
      socket.once('connect_error', error => { clearTimeout(deadline); reject(error); });
      socket.connect();
    });
  }
  try { await run({ state, runtime, request, viewer, host, config, token }); }
  finally {
    sockets.forEach(socket => socket.disconnect());
    await runtime.close();
    await new Promise(resolve => runtime.io.close(resolve));
  }
}

test('real server auth route and Socket.IO share admission state, enforce auth binding and bounded capacity', async () => {
  await withRuntime(async ({ request, viewer, state, config }) => {
    assert.equal((await request('session-alpha', null)).status, 401);
    assert.equal((await request('session-alpha', signAccessToken('host', 'host-daemon', config))).status, 403);
    assert.equal((await request('bad')).status, 400);
    const issued = await request('session-alpha');
    assert.equal(issued.status, 201); assert.equal(issued.headers.get('cache-control'), 'no-store');
    const admission = (await issued.json()).admission;
    const mismatch = await viewer('session-other', { mode: 'explicit', ticket: admission.ticket });
    assert.ok(mismatch.rejected); assert.equal(state.viewerEpoch(), 0);
    const a = await viewer('session-alpha', { mode: 'explicit', ticket: admission.ticket });
    assert.equal(a.data.viewerAdmission.mode, 'resume');
    assert.equal(state.connections.viewers.size, 1);
    const bTicket = (await (await request('session-bravo')).json()).admission;
    assert.equal((await request('session-full')).status, 429);
    const b = await viewer('session-bravo', { mode: 'explicit', ticket: bTicket.ticket });
    assert.equal(state.connections.viewers.size, 1);
    assert.equal([...state.connections.viewers.keys()][0], b.socket.id);
    const old = await viewer('session-alpha', a.data.viewerAdmission);
    assert.ok(old.rejected);
    assert.equal([...state.connections.viewers.keys()][0], b.socket.id);
    assert.equal((await request('session-full')).status, 429, 'consumption must not evict replay evidence');
  }, { maxViewerAdmissions: 2 });
});

test('proof-only runtime refuses human ticket issuance', async () => {
  await withRuntime(async ({ request }) => {
    assert.equal((await request('session-alpha')).status, 403);
    assert.equal((await request('session-guard', undefined, { initialPolicy: 'vacant-only-v1' })).status, 403);
  }, { requireViewerProof: true, realm: 'lab-test' });
});

test('guard route validates own policy presence exactly, and ignores client context', async () => {
  await withRuntime(async ({ request, state, host }) => {
    for (const initialPolicy of [null, [], {}, true, false, 0, 1, '', 'unknown']) {
      const response = await request('session-guard', undefined, { initialPolicy });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, 'invalid-initial-policy');
    }
    const unavailable = await request('session-guard', undefined, { initialPolicy: 'vacant-only-v1',
      context: { viewerEpoch: 0, occupied: false, relayOccupied: false, hostOnline: true } });
    assert.equal(unavailable.status, 409);
    assert.equal((await unavailable.json()).error, 'host-unavailable');
    await host();
    const issued = await request('session-guard', undefined, { initialPolicy: 'vacant-only-v1',
      context: { viewerEpoch: 99, occupied: true, relayOccupied: true, hostOnline: false }, viewerEpoch: 99 });
    assert.equal(issued.status, 201);
    assert.equal(issued.headers.get('cache-control'), 'no-store');
    const admission = (await issued.json()).admission;
    assert.deepEqual(Object.keys(admission).sort(), ['expiresAt', 'ticket']);
    assert.equal(state.viewerEpoch(), 0);
    assert.equal((await request('bad', undefined, { initialPolicy: 'vacant-only-v1' })).status, 400);
    // An absent own property retains unrestricted human issuance.
    assert.equal((await request('session-human')).status, 201);
    const pending = await request('session-nextguard', undefined, { initialPolicy: 'vacant-only-v1' });
    assert.equal(pending.status, 409); assert.equal((await pending.json()).error, 'human-intent-pending');
  });
});

test('guard API fails closed on unavailable snapshot and maps guarded capacity and occupancy', async () => {
  await withRuntime(async ({ state, request, host }) => {
    await host();
    const snapshot = state.viewerAdmissionContext;
    state.viewerAdmissionContext = () => null;
    let response = await request('session-guard', undefined, { initialPolicy: 'vacant-only-v1' });
    assert.equal(response.status, 503); assert.equal((await response.json()).error, 'admission-unavailable');
    state.viewerAdmissionContext = snapshot;
    state.connections.relayViewers.set('relay', {});
    response = await request('session-guard', undefined, { initialPolicy: 'vacant-only-v1' });
    assert.equal(response.status, 409); assert.equal((await response.json()).error, 'relay-occupied');
    state.connections.relayViewers.clear();
    for (const session of ['session-first', 'session-second']) {
      assert.equal((await request(session, undefined, { initialPolicy: 'vacant-only-v1' })).status, 201);
    }
    assert.equal((await request('session-full', undefined, { initialPolicy: 'vacant-only-v1' })).status, 429);
    assert.equal((await request('session-human')).status, 201, 'human revokes pending guards at capacity');
  }, { maxViewerAdmissions: 2 });
});

test('real guarded route ticket claims ordinary ownership and yields to human supersession', async () => {
  await withRuntime(async ({ request, viewer, state, host }) => {
    await host();
    const response = await request('session-guard', undefined, { initialPolicy: 'vacant-only-v1' });
    assert.equal(response.status, 201);
    const ticket = (await response.json()).admission;
    const guard = await viewer('session-guard', { mode: 'explicit', ticket: ticket.ticket, initialPolicy: null, viewerEpoch: 99 });
    assert.equal(guard.data.viewerAdmission.mode, 'resume');
    const blocked = await request('session-anotherguard', undefined, { initialPolicy: 'vacant-only-v1' });
    assert.equal(blocked.status, 409); assert.equal((await blocked.json()).error, 'viewer-occupied');
    const humanTicket = (await (await request('session-human')).json()).admission;
    const human = await viewer('session-human', { mode: 'explicit', ticket: humanTicket.ticket });
    assert.ok(human.data);
    assert.ok((await viewer('session-guard', guard.data.viewerAdmission)).rejected);
    assert.ok((await viewer('session-human', human.data.viewerAdmission)).data);
    assert.equal(state.connections.viewers.size, 1);
  });
});
