'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PassThrough } = require('node:stream');
const { assertLabOrigin, createLabRuntime, readLabTurnBootstrap, validateLabTurnBootstrap } = require('./turn-lab-signal');

function turnBootstrap() {
  return {
    schemaVersion: 1,
    selectedTurnServerId: 'fixture-turn',
    defaultTurnServerId: 'fixture-turn',
    turnFingerprint: 'fixture-fingerprint',
    turnUrls: ['turn:relay.fixture.invalid:3478?transport=udp'],
    turnUsername: 'fixture-user',
    turnCredential: 'fixture-credential',
  };
}

test('lab signal matches Python bare-loopback origin validation', () => {
  assert.throws(() => assertLabOrigin('http://127.0.0.1:8080'), /bare/);
  assert.throws(() => assertLabOrigin('http://127.0.0.1:5173'), /bare/);
  assert.throws(() => assertLabOrigin('http://0.0.0.0:41000'), /loopback/);
  assert.throws(() => assertLabOrigin('https://example.test:41000'), /loopback/);
  for (const value of ['http://127.0.0.1:8080/path', 'http://127.0.0.1:80@attacker.invalid', 'http://user@127.0.0.1:40123', 'http://127.0.0.1:40123?x=1', 'http://[::1]:40123/path', 'http://127.0.0.1:40123/']) {
    assert.throws(() => assertLabOrigin(value), /bare|canonical/);
  }
  assert.doesNotThrow(() => assertLabOrigin('http://127.0.0.1:41000'));
});

test('lab TURN bootstrap strictly accepts one selected complete TURN path and redacts validation errors', () => {
  const bootstrap = turnBootstrap();
  const validated = validateLabTurnBootstrap(bootstrap);
  assert.deepEqual(validated, bootstrap);
  assert.notEqual(validated, bootstrap);
  for (const broken of [
    { ...bootstrap, defaultTurnServerId: 'other' },
    { ...bootstrap, turnUrls: ['https://not-turn.fixture.invalid'] },
    { ...bootstrap, turnCredential: '' },
    { ...bootstrap, unexpected: true },
  ]) {
    assert.throws(() => validateLabTurnBootstrap(broken), (error) => (
      /lab TURN bootstrap/.test(error.message) && !error.message.includes('fixture-credential')
    ));
  }
});

test('lab Signal accepts one bounded stdin bootstrap and fails closed without one', async () => {
  const complete = new PassThrough();
  const accepted = readLabTurnBootstrap(complete);
  complete.end(`${JSON.stringify(turnBootstrap())}\n`);
  assert.equal((await accepted).selectedTurnServerId, 'fixture-turn');

  const absent = new PassThrough();
  const rejected = readLabTurnBootstrap(absent);
  absent.end();
  await assert.rejects(rejected, (error) => (
    error.message === 'lab TURN bootstrap pipe is invalid' && !error.message.includes('fixture-credential')
  ));
});

test('lab runtime exposes only the selected injected TURN path and preserves explicit no-TURN test mode', async () => {
  const withTurn = await createLabRuntime({ allowSourceFallback: true, turnBootstrap: turnBootstrap() });
  const noTurn = await createLabRuntime({ allowSourceFallback: true });
  try {
    assert.equal(withTurn.runtime.config.selectedTurnServerId, 'fixture-turn');
    assert.equal(withTurn.runtime.config.turnCatalog.servers.length, 1);
    assert.equal(withTurn.runtime.config.turnCatalog.servers[0].credential, 'fixture-credential');
    assert.equal(noTurn.runtime.config.turnConfigured, undefined);
    assert.deepEqual(noTurn.runtime.config.turnUrls, []);
  } finally {
    await Promise.all([withTurn.close(), noTurn.close()]);
  }
});

test('lab signal creates a private runtime with random temporary authentication', async () => {
  const lab = await createLabRuntime({ allowSourceFallback: true });
  try {
    assert.match(lab.origin, /^http:\/\/127\.0\.0\.1:(?!8080$)\d+$/);
    assert.notEqual(lab.credentials.jwtSecret, process.env.JWT_SECRET);
    assert.equal(lab.runtime.config.port, 0);
    assert.notEqual(lab.realm, 'production');
    const login = await fetch(`${lab.origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: lab.credentials.viewerPassword }),
    });
    const token = (await login.json()).token;
    assert.ok(token);
    const proof = await fetch(`${lab.origin}/api/proof-admission`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(proof.status, 201);
    const admission = (await proof.json()).admission;
    assert.equal(admission.realm, lab.realm);
    const leaseStatus = await fetch(`${lab.origin}/api/proof-admission/status`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(admission),
    });
    assert.deepEqual(await leaseStatus.json(), { active: true });
    const malformedLease = await fetch(`${lab.origin}/api/proof-admission/status`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ ...admission, extra: true }),
    });
    assert.equal(malformedLease.status, 400);
    const mismatchedRelease = await fetch(`${lab.origin}/api/proof-admission/release`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ ...admission, realm: 'production' }),
    });
    assert.deepEqual(await mismatchedRelease.json(), { released: false });
    const issue = await fetch(`${lab.origin}/api/lab-context/issue`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wrd-lab-context-secret': lab.contextSecret },
      body: JSON.stringify({ origin: lab.origin, realm: lab.realm, proofToken: admission.token, epoch: 0, mode: 'legacy', runId: 'run-1', policyId: 'experiment/test' }),
    });
    const credential = (await issue.json()).context.credential;
    const secondIssue = await fetch(`${lab.origin}/api/lab-context/issue`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wrd-lab-context-secret': lab.contextSecret },
      body: JSON.stringify({ origin: lab.origin, realm: lab.realm, proofToken: admission.token, epoch: 0, mode: 'legacy', runId: 'run-1', policyId: 'experiment/test' }),
    });
    assert.equal(secondIssue.status, 201);
    const secondCredential = (await secondIssue.json()).context.credential;
    assert.notEqual(credential, secondCredential);
    const consume = await fetch(`${lab.origin}/api/lab-context/consume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    assert.equal(consume.status, 200);
    const secondConsume = await fetch(`${lab.origin}/api/lab-context/consume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: secondCredential }),
    });
    assert.equal(secondConsume.status, 409);
    const replay = await fetch(`${lab.origin}/api/lab-context/consume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    assert.equal(replay.status, 409);
    const badToken = await fetch(`${lab.origin}/api/lab-context/issue`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wrd-lab-context-secret': lab.contextSecret },
      body: JSON.stringify({ origin: lab.origin, realm: lab.realm, proofToken: 'swapped', epoch: 0, mode: 'legacy', runId: 'run-1', policyId: 'experiment/test' }),
    });
    assert.equal(badToken.status, 400);
    for (const changed of [
      { realm: 'production' }, { epoch: 1 }, { mode: 'candidate' }, { policyId: '' },
    ]) {
      const rejected = await fetch(`${lab.origin}/api/lab-context/issue`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-wrd-lab-context-secret': lab.contextSecret },
        body: JSON.stringify({ origin: lab.origin, realm: lab.realm, proofToken: admission.token, epoch: 0, mode: 'legacy', runId: 'run-1', policyId: 'experiment/test', ...changed }),
      });
      assert.equal(rejected.status, 400);
    }
    const unknown = await fetch(`${lab.origin}/api/lab-context/issue`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wrd-lab-context-secret': lab.contextSecret },
      body: JSON.stringify({ origin: lab.origin, realm: lab.realm, proofToken: admission.token, epoch: 0, mode: 'legacy', runId: 'run-1', policyId: 'experiment/test', extra: true }),
    });
    assert.equal(unknown.status, 400);
    const released = await fetch(`${lab.origin}/api/proof-admission/release`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(admission),
    });
    assert.deepEqual(await released.json(), { released: true });
    const replayedRelease = await fetch(`${lab.origin}/api/proof-admission/release`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(admission),
    });
    assert.deepEqual(await replayedRelease.json(), { released: false });
  } finally {
    await lab.close();
  }
});

test('lab context burns when its viewer proof was consumed before host startup', async () => {
  const lab = await createLabRuntime({ allowSourceFallback: true });
  try {
    const login = await fetch(`${lab.origin}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: lab.credentials.viewerPassword }),
    });
    const token = (await login.json()).token;
    const proofResponse = await fetch(`${lab.origin}/api/proof-admission`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    });
    const admission = (await proofResponse.json()).admission;
    const issue = await fetch(`${lab.origin}/api/lab-context/issue`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wrd-lab-context-secret': lab.contextSecret },
      body: JSON.stringify({ origin: lab.origin, realm: lab.realm, proofToken: admission.token, epoch: admission.epoch, mode: 'legacy', runId: 'run-stale', policyId: 'experiment/test' }),
    });
    const credential = (await issue.json()).context.credential;
    assert.equal(lab.runtime.signalingRuntime.admitProofViewer(admission), true);
    const consumed = await fetch(`${lab.origin}/api/lab-context/consume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }),
    });
    assert.equal(consumed.status, 409);
    const replay = await fetch(`${lab.origin}/api/lab-context/consume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }),
    });
    assert.equal(replay.status, 409);
  } finally {
    await lab.close();
  }
});

test('controlled input binding is loopback proof-and-host-secret bound and one-use', async () => {
  const lab = await createLabRuntime({ allowSourceFallback: true });
  try {
    const login = await fetch(`${lab.origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: lab.credentials.viewerPassword }) });
    const token = (await login.json()).token;
    const proof = await fetch(`${lab.origin}/api/proof-admission`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const admission = (await proof.json()).admission;
    const issued = await fetch(`${lab.origin}/api/lab-context/issue`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wrd-lab-context-secret': lab.contextSecret },
      body: JSON.stringify({ origin: lab.origin, realm: lab.realm, proofToken: admission.token, epoch: admission.epoch, mode: 'legacy', runId: 'run-1', policyId: 'experiment/test' }),
    });
    const credential = (await issued.json()).context.credential;
    assert.equal((await fetch(`${lab.origin}/api/lab-context/consume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }),
    })).status, 200);
    assert.equal(lab.runtime.signalingRuntime.admitProofViewer(admission, 'viewer-1'), true);
    lab.runtime.signalingRuntime.connections.viewers.set('viewer-1', { id: 'viewer-1' });
    const headers = { 'content-type': 'application/json', 'x-wrd-lab-host-secret': lab.credentials.hostSecret, 'x-wrd-lab-proof-token': admission.token };
    const digest = 'a'.repeat(64);
    const binding = { realm: lab.realm, runId: 'run-1', epoch: admission.epoch, inputId: 'input-1', leaseId: 'lease-1', leaseEpoch: 4, fixtureId: 'fixture-1', actionDigest: digest };
    const denied = await fetch(`${lab.origin}/api/lab-controlled-input/bind`, { method: 'POST', headers: { ...headers, 'x-wrd-lab-host-secret': 'wrong' }, body: JSON.stringify(binding) });
    assert.equal(denied.status, 403);
    const bound = await fetch(`${lab.origin}/api/lab-controlled-input/bind`, { method: 'POST', headers, body: JSON.stringify(binding) });
    assert.equal(bound.status, 201);
    const claimBody = { realm: lab.realm, runId: 'run-1', epoch: admission.epoch, inputId: 'input-1', leaseId: 'lease-1', leaseEpoch: 4, actionDigest: digest };
    const claim = await fetch(`${lab.origin}/api/lab-controlled-input/claim`, { method: 'POST', headers, body: JSON.stringify(claimBody) });
    const claimed = (await claim.json()).binding;
    assert.equal(claimed.inputId, binding.inputId);
    assert.equal(claimed.actionDigest, digest);
    assert.equal(claimed.viewerSocketId, 'viewer-1');
    const replay = await fetch(`${lab.origin}/api/lab-controlled-input/claim`, { method: 'POST', headers, body: JSON.stringify(claimBody) });
    assert.equal(replay.status, 409);
  } finally { await lab.close(); }
});
