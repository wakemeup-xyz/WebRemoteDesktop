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
