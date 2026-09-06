'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertLabOrigin, createLabRuntime } = require('./turn-lab-signal');

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
    assert.equal(secondConsume.status, 200);
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
