'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertLabOrigin, createLabRuntime } = require('./turn-lab-signal');

test('lab signal rejects production port and non-loopback origins', () => {
  assert.throws(() => assertLabOrigin('http://127.0.0.1:8080'), /8080/);
  assert.throws(() => assertLabOrigin('http://0.0.0.0:41000'), /loopback/);
  assert.throws(() => assertLabOrigin('https://example.test:41000'), /loopback/);
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
    assert.equal((await proof.json()).admission.realm, lab.realm);
    const issue = await fetch(`${lab.origin}/api/lab-context/issue`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wrd-lab-context-secret': lab.contextSecret },
      body: JSON.stringify({ origin: lab.origin, realm: lab.realm, epoch: 0, mode: 'legacy', runId: 'run-1', policyId: 'experiment/test' }),
    });
    const credential = (await issue.json()).context.credential;
    const consume = await fetch(`${lab.origin}/api/lab-context/consume`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wrd-lab-context-secret': lab.contextSecret },
      body: JSON.stringify({ credential }),
    });
    assert.equal(consume.status, 200);
    const replay = await fetch(`${lab.origin}/api/lab-context/consume`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-wrd-lab-context-secret': lab.contextSecret },
      body: JSON.stringify({ credential }),
    });
    assert.equal(replay.status, 409);
  } finally {
    await lab.close();
  }
});
