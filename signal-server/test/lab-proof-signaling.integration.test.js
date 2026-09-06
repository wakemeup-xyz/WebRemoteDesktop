'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { io } = require('socket.io-client');
const { createLabRuntime } = require('../../scripts/turn-lab-signal');

async function loginAndIssueProof(lab) {
  const login = await fetch(`${lab.origin}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: lab.credentials.viewerPassword }),
  });
  assert.equal(login.status, 200);
  const token = (await login.json()).token;
  const proof = await fetch(`${lab.origin}/api/proof-admission`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(proof.status, 201);
  return { token, admission: (await proof.json()).admission };
}

function connect(origin, token, auth) {
  return new Promise((resolve, reject) => {
    const socket = io(origin, { auth: { token, ...auth }, transports: ['websocket'], timeout: 2000, reconnection: false });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('socket did not report its admission result'));
    }, 2500);
    const finish = (result) => {
      clearTimeout(timer);
      resolve({ socket, ...result });
    };
    socket.once('connected', (payload) => finish({ accepted: true, payload }));
    socket.once('proof-admission-rejected', (payload) => finish({ accepted: false, payload }));
    socket.once('connect_error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
  });
}

async function issueContext(lab, admission, runId) {
  const response = await fetch(`${lab.origin}/api/lab-context/issue`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-wrd-lab-context-secret': lab.contextSecret },
    body: JSON.stringify({
      origin: lab.origin, realm: lab.realm, proofToken: admission.token, epoch: admission.epoch,
      mode: 'legacy', runId, policyId: 'experiment/socket-proof',
    }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).context.credential;
}

test('strict Lab Socket.IO admits only one exact proof and rejects proofless and relay bypasses', async () => {
  const lab = await createLabRuntime({ allowSourceFallback: true });
  const sockets = [];
  try {
    const { token, admission } = await loginAndIssueProof(lab);
    const credential = await issueContext(lab, admission, 'proofless-reject');
    const proofless = await connect(lab.origin, token, { role: 'viewer' });
    sockets.push(proofless.socket);
    assert.equal(proofless.accepted, false);
    assert.equal(proofless.payload.reason, 'viewer-proof-required');
    assert.equal(lab.runtime.signalingRuntime.hasProofAdmission(admission), true);

    const relay = await connect(lab.origin, token, { role: 'relay-viewer' });
    sockets.push(relay.socket);
    assert.equal(relay.accepted, false);
    assert.equal(relay.payload.reason, 'relay-viewer-disabled');
    assert.equal(lab.runtime.signalingRuntime.hasProofAdmission(admission), true);

    const swapped = await connect(lab.origin, token, { role: 'viewer', proofAdmission: { ...admission, realm: 'other-lab' } });
    sockets.push(swapped.socket);
    assert.equal(swapped.accepted, false);
    assert.equal(lab.runtime.signalingRuntime.hasProofAdmission(admission), true);

    const consumed = await fetch(`${lab.origin}/api/lab-context/consume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }),
    });
    assert.equal(consumed.status, 200);

    const valid = await connect(lab.origin, token, { role: 'viewer', proofAdmission: admission });
    sockets.push(valid.socket);
    assert.equal(valid.accepted, true);
    assert.equal(valid.payload.role, 'viewer');
    assert.deepEqual(lab.runtime.signalingRuntime.getProofViewerConsumer(admission), { socketId: valid.socket.id });

    const replay = await connect(lab.origin, token, { role: 'viewer', proofAdmission: admission });
    sockets.push(replay.socket);
    assert.equal(replay.accepted, false);
  } finally {
    sockets.forEach((socket) => socket.close());
    await lab.close();
  }
});

test('Lab context consumes before proof Viewer admission and burns when proof was consumed first', async () => {
  const normal = await createLabRuntime({ allowSourceFallback: true });
  const stale = await createLabRuntime({ allowSourceFallback: true });
  const sockets = [];
  try {
    const normalIdentity = await loginAndIssueProof(normal);
    const normalCredential = await issueContext(normal, normalIdentity.admission, 'normal');
    const consumed = await fetch(`${normal.origin}/api/lab-context/consume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: normalCredential }),
    });
    assert.equal(consumed.status, 200);
    const accepted = await connect(normal.origin, normalIdentity.token, { role: 'viewer', proofAdmission: normalIdentity.admission });
    sockets.push(accepted.socket);
    assert.equal(accepted.accepted, true);

    const staleIdentity = await loginAndIssueProof(stale);
    const staleCredential = await issueContext(stale, staleIdentity.admission, 'stale');
    const viewer = await connect(stale.origin, staleIdentity.token, { role: 'viewer', proofAdmission: staleIdentity.admission });
    sockets.push(viewer.socket);
    assert.equal(viewer.accepted, true);
    const staleConsume = await fetch(`${stale.origin}/api/lab-context/consume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: staleCredential }),
    });
    assert.equal(staleConsume.status, 409);
    const replay = await fetch(`${stale.origin}/api/lab-context/consume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: staleCredential }),
    });
    assert.equal(replay.status, 409);
  } finally {
    sockets.forEach((socket) => socket.close());
    await Promise.all([normal.close(), stale.close()]);
  }
});
