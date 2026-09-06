const assert = require('node:assert/strict');
const test = require('node:test');

const { createLabRuntime } = require('../../scripts/turn-lab-signal');

async function viewerToken(origin, password) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

async function issueProof(origin, auth) {
  const response = await fetch(`${origin}/api/proof-admission`, { method: 'POST', headers: auth });
  assert.equal(response.status, 201);
  return (await response.json()).admission;
}

test('proof status supports a 60-second watchdog window without starving release', async () => {
  const lab = await createLabRuntime({ allowSourceFallback: true });
  try {
    const token = await viewerToken(lab.origin, lab.credentials.viewerPassword);
    const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const admitted = await fetch(`${lab.origin}/api/proof-admission`, { method: 'POST', headers: auth });
    assert.equal(admitted.status, 201);
    const proof = (await admitted.json()).admission;
    const body = JSON.stringify({ token: proof.token, epoch: proof.epoch, realm: proof.realm });

    for (let request = 0; request < 301; request += 1) {
      const response = await fetch(`${lab.origin}/api/proof-admission/status`, {
        method: 'POST', headers: auth, body,
      });
      assert.notEqual(response.status, 429);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).active, true);
    }

    const released = await fetch(`${lab.origin}/api/proof-admission/release`, {
      method: 'POST', headers: auth, body,
    });
    assert.equal(released.status, 200);
    assert.equal(released.headers.get('cache-control'), 'no-store');
    assert.equal((await released.json()).released, true);

    const unauthorized = await fetch(`${lab.origin}/api/proof-admission/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    assert.equal(unauthorized.status, 401);
    const invalid = await fetch(`${lab.origin}/api/proof-admission/status`, {
      method: 'POST', headers: auth, body: JSON.stringify({ token: proof.token }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await lab.close();
  }
});

test('proof route limiters count only authenticated exact leases and isolate each lease key', async () => {
  const lab = await createLabRuntime({ allowSourceFallback: true, maxProofAdmissions: 2 });
  try {
    const token = await viewerToken(lab.origin, lab.credentials.viewerPassword);
    const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const target = await issueProof(lab.origin, auth);
    const targetBody = JSON.stringify(target);

    for (let request = 0; request < 25; request += 1) {
      const response = await fetch(`${lab.origin}/api/proof-admission/release`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: targetBody,
      });
      assert.equal(response.status, 401);
    }
    let released = await fetch(`${lab.origin}/api/proof-admission/release`, {
      method: 'POST', headers: auth, body: targetBody,
    });
    assert.equal(released.status, 200);
    assert.equal((await released.json()).released, true);

    const malformedTarget = await issueProof(lab.origin, auth);
    for (let request = 0; request < 25; request += 1) {
      const response = await fetch(`${lab.origin}/api/proof-admission/release`, {
        method: 'POST', headers: auth, body: JSON.stringify({ token: malformedTarget.token }),
      });
      assert.equal(response.status, 400);
    }
    released = await fetch(`${lab.origin}/api/proof-admission/release`, {
      method: 'POST', headers: auth, body: JSON.stringify(malformedTarget),
    });
    assert.equal(released.status, 200);
    assert.equal((await released.json()).released, true);

    const targetProof = await issueProof(lab.origin, auth);
    const otherProof = await issueProof(lab.origin, auth);
    const otherBody = JSON.stringify(otherProof);
    for (let request = 0; request < 21; request += 1) {
      await fetch(`${lab.origin}/api/proof-admission/release`, {
        method: 'POST', headers: auth, body: otherBody,
      });
    }
    released = await fetch(`${lab.origin}/api/proof-admission/release`, {
      method: 'POST', headers: auth, body: JSON.stringify(targetProof),
    });
    assert.equal(released.status, 200);
    assert.equal((await released.json()).released, true);
  } finally {
    await lab.close();
  }
});
