# Remote Keyboard State Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a single-controller desktop lease and a versioned keyboard session protocol that makes mapping, combinations, release, takeover, transport changes, text input, and Host execution deterministic across direct WebRTC and manual tunnel modes.

**Architecture:** Signal Server owns `DesktopControlLease`; Viewer owns normalized local key state through `RemoteKeyboardController` and ordered delivery through `KeyboardTransport`; Host owns applied state through `RemoteKeyboardState` and a macOS `QuartzKeyboardAdapter`. Physical key, Unicode text, atomic batch, and reset are separate actions, while all state-changing paths pass through lease epoch, sequence, acknowledgement, and one Host executor.

**Tech Stack:** Browser JavaScript, Socket.IO, ordered reliable WebRTC DataChannel, Node.js test runner, Python 3.11, pytest/pytest-asyncio, PyObjC Quartz, HTML/CSS.

**Spec Coverage:** This plan covers the full approved spec `docs/superpowers/specs/2026-07-19-remote-keyboard-state-reliability-design.md`, including K-01 through K-13, compatibility migration, automated contracts, documentation, and real-browser acceptance.

**Truth Source:** `signal-server/lib/desktop-control-lease.js` for controller ownership; `web-client/js/remote-keyboard-controller.js` for local physical state; `web-client/js/keyboard-transport.js` for lease seq/pending ack/reset barrier; `python-host/remote_keyboard_state.py` for Host applied state; `python-host/quartz_keyboard_adapter.py` for canonical macOS physical mapping.

**Compatibility Notes:** Host first accepts v1 through one `LegacyInputAdapter` that converts into `RemoteKeyboardState`; Signal then introduces lease-aware v2 and a one-release legacy lazy-acquire window. v1 and v2 never write Quartz or pressed-state independently. No compatibility behavior may bypass lease authorization after Signal migration.

**Impact Map:**
- **Truth Source:** Control lease, Viewer physical state, transport sequence ledger, Host applied keyboard state, and Quartz mapping each gain one canonical module.
- **Backend:** Signal Server authorizes all desktop writes and serializes takeover; Python Host validates epoch/seq and executes all keyboard reset/apply paths in one worker.
- **Frontend:** Viewer gains controller state, transport barrier, control/read-only UI, correct Windows/Mac mapping, atomic shortcuts, and explicit Unicode text input.
- **Runtime Proof:** Two ordinary browser sessions prove control exclusion/takeover plus direct/tunnel release, long hold, modal keyup, text, batch, DataChannel failure, lost ack, Signal reconnect, and final zero pressed state.
- **Docs/Skills:** Update `docs/需求文档/WebRemoteDesktop-需求文档.md`, the 2026-07-19 diagnostic ledger, and a runtime acceptance report. Service/tunnel runbooks are unchanged because this feature does not alter lifecycle commands.
- **Commit Boundary:** Shared input fixtures, Signal lease/relay, Viewer keyboard modules/UI, Host state/Quartz integration, tests, and matching requirement/acceptance docs. Exclude tunnel, media, Terminal, cached skills, logs, and unrelated cleanup.

**Definition of Done:**
- K-01 through K-13 each map to a passing automated test and an implemented behavior.
- Direct WebRTC and manual tunnel reject every desktop write not owned by the ACTIVE lease.
- Reset barrier makes old transport, old seq, old lease, and old Viewer events unable to reintroduce pressed state.
- Host has no fixed 8-second key release and performs no startup `defaults write` or TIS input-source selection.
- Physical key, text, batch, and reset contracts pass shared fixture tests in Viewer, Signal, and Host.
- Focused and full Node/Python suites pass without logging raw key, code, text, leaseId, or input payload.
- Real two-browser acceptance records final `pressedKeyCount=0` and `modifierMask=0` for every failure/takeover case; hardware-unavailable ISO/JIS cases are explicitly marked unexecuted.

---

## File Map

### New files

- `shared/remote-input-v2-fixtures.json`: canonical valid/invalid wire examples consumed by all three layers.
- `signal-server/lib/remote-input-contract.js`: v2 envelope validation, normalization, and safe metadata summary.
- `signal-server/lib/remote-input-contract.test.js`: Signal contract and redaction tests.
- `signal-server/lib/desktop-control-lease.js`: pure single-controller state machine.
- `signal-server/lib/desktop-control-lease.test.js`: fake-clock lease transition tests.
- `web-client/js/keyboard-transport.js`: lease seq, adapter pinning, pending ack, and reset barrier.
- `web-client/js/keyboard-transport.test.js`: transport reorder/failure/ack tests.
- `web-client/js/remote-keyboard-controller.js`: DOM normalization, pressed state, mapping, quirks, batch, and text.
- `web-client/js/remote-keyboard-controller.test.js`: key lifecycle and mapping matrix.
- `python-host/remote_keyboard_state.py`: Host epoch/seq/state model plus legacy adapter.
- `python-host/test_remote_keyboard_state.py`: pure state model tests.
- `python-host/quartz_keyboard_adapter.py`: macOS physical and Unicode injection adapter.
- `python-host/test_quartz_keyboard_adapter.py`: Quartz mapping and side-effect tests.
- `docs/superpowers/reports/2026-07-19-remote-keyboard-runtime-acceptance.md`: automated and real-browser evidence.

### Modified files

- `signal-server/websocket/signaling.js`: lease events, authorization, transition ack, legacy activation, capability checks.
- `signal-server/websocket/signaling.test.js`: socket-level lease and relay tests.
- `web-client/js/webrtc.js`: protocol capability, acquire-before-offer, lease events, ack routing, teardown reset/release.
- `web-client/js/webrtc.test.js`: connection/control ordering tests.
- `web-client/js/input.js`: remove keyboard state/sendKey timers and delegate to new modules.
- `web-client/js/input.test.js`: integration tests for DOM focus, action bar, diagnostics, and lease gate.
- `web-client/js/diagnostic.js`: safe keyboard/control snapshot.
- `web-client/js/diagnostic.test.js`: redacted diagnostic contract.
- `web-client/viewer.html`: control status/request button and text input modal; load modules before `input.js`.
- `web-client/css/viewer.css`: compact lease and text modal states.
- `python-host/input_handler.py`: route keyboard through one state executor; remove global input mutations and stale timer.
- `python-host/host.py`: bind offer/DataChannel to lease and route all resets through async interface.
- `python-host/test_input_handler.py`: integration and single-executor tests.
- `python-host/test_offer_epoch.py`: lease-bound offer/DataChannel tests.
- `python-host/test_connection_diagnostics.py`: v2 ack and redacted diagnostics.
- `docs/需求文档/WebRemoteDesktop-需求文档.md`: active product contract and compatibility window.
- `docs/superpowers/reports/2026-07-19-remote-keyboard-mapping-stuck-key-systemic-analysis.md`: remediation ledger status/evidence links.

## Spec Coverage Matrix

| Diagnostic | Implementation task | Required proof |
|---|---|---|
| K-01 Windows Ctrl -> Command | Task 5, Task 9 | Windows left/right Ctrl matrix and real shortcut results |
| K-02 tracked keyup filtered by UI/IME | Task 5, Task 9 | desktop-down/modal-up tests and real modal release |
| K-03 unreliable release/cross-transport order | Task 1, Task 4, Task 6, Task 8 | reset high-water, lost transport, lost ack |
| K-04 virtual chord not atomic | Task 5, Task 9 | one batch, reverse release, zero final state |
| K-05 shared left/right modifier flags | Task 6, Task 7 | both-side modifier matrix and Host-derived mask |
| K-06 global Host watchdog postponement | Task 6, Task 8 | no stale timer plus valid hold longer than 10 seconds |
| K-07 fresh tunnel multi-Viewer pollution | Task 2, Task 3, Task 9 | two-Viewer direct/tunnel exclusion and takeover |
| K-08 reset outside Host lock | Task 6, Task 8 | blocked apply/disconnect reset serialization test |
| K-09 Dead/AltGraph/IME ambiguity | Task 5, Task 7, Task 9 | physical Dead/AltGr plus separate Unicode text path |
| K-10 ISO/JIS/Numpad gaps | Task 7 | canonical mapping tests and hardware-qualified runtime evidence |
| K-11 modifier payload/Host flag conflict | Task 5, Task 6 | pressed-code-derived flags and stolen snapshot rejection |
| K-12 fixed 8-second release | Task 5, Task 8 | fake and real hold beyond 8 seconds without forced up |
| K-13 global input-source side effects | Task 7, Task 11 | source tests and no global mutation symbols |

Scope remains limited to macOS Host and ordinary browser Viewer. The lease stays in Signal process memory; this plan does not add persistent storage, TURN, VPS, native Viewer software, media changes, or Terminal ownership changes.

---

### Task 1: Establish the v2 wire contract and shared fixtures

**Files:**
- Create: `shared/remote-input-v2-fixtures.json`
- Create: `signal-server/lib/remote-input-contract.js`
- Create: `signal-server/lib/remote-input-contract.test.js`

- [ ] **Step 1: Write failing validator and redaction tests**

Create tests with these exact cases:

```javascript
const assert = require('node:assert/strict');
const test = require('node:test');
const fixtures = require('../../shared/remote-input-v2-fixtures.json');
const { validateRemoteInput, summarizeRemoteInput } = require('./remote-input-contract');

test('valid v2 fixtures normalize without changing contract fields', () => {
  for (const fixture of fixtures.valid) {
    const result = validateRemoteInput(fixture.envelope);
    assert.equal(result.ok, true, fixture.name);
    assert.equal(result.value.schemaVersion, 2);
    assert.equal(result.value.leaseEpoch, fixture.envelope.leaseEpoch);
    assert.equal(result.value.seq, fixture.envelope.seq);
  }
});

test('invalid fixtures fail with stable error codes', () => {
  for (const fixture of fixtures.invalid) {
    const result = validateRemoteInput(fixture.envelope);
    assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: fixture.code });
  }
});

test('safe summary never contains key code text or lease token', () => {
  const envelope = fixtures.valid.find((item) => item.name === 'unicode-text').envelope;
  const text = JSON.stringify(summarizeRemoteInput(envelope));
  assert.equal(text.includes(envelope.payload.text), false);
  assert.equal(text.includes(envelope.leaseId), false);
  assert.deepEqual(Object.keys(summarizeRemoteInput(envelope)).sort(), [
    'action', 'leaseEpoch', 'payloadBytes', 'schemaVersion', 'seq', 'type'
  ]);
});
```

Fixtures must include valid `key-down`, `key-repeat`, `text`, `batch`, and `reset`, plus invalid schema, missing lease, invalid seq, unknown physical code shape, text over 4096 Unicode scalars, batch over 16 steps, unknown reset reason, and unknown action. Use non-secret constant sample values.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test signal-server/lib/remote-input-contract.test.js
```

Expected: FAIL with `Cannot find module './remote-input-contract'`.

- [ ] **Step 3: Implement the canonical validator**

Export a result-based interface; do not throw on client data:

```javascript
const ACTIONS = new Set(['key', 'text', 'batch', 'reset']);
const PHASES = new Set(['down', 'up']);
const RESET_REASONS = new Set([
  'window-blur', 'visibility-hidden', 'deactivated', 'keyboard-mode-change',
  'transport-change', 'control-revoked', 'controller-disconnect', 'lease-expired',
  'signal-disconnect', 'webrtc-disconnected', 'datachannel-closed', 'viewer-disconnect',
  'host-reconnect', 'host-stop', 'batch-failed', 'pending-reset', 'manual', 'unspecified',
]);
const MAX_TEXT_SCALARS = 4096;
const MAX_BATCH_STEPS = 16;

function fail(code) {
  return { ok: false, code };
}

function unicodeScalarCount(value) {
  return Array.from(String(value)).length;
}

function validateRemoteInput(data) {
  if (!data || data.schemaVersion !== 2) return fail('invalid-schema');
  if (data.type !== 'keyboard' || !ACTIONS.has(data.action)) return fail('invalid-action');
  if (typeof data.leaseId !== 'string' || data.leaseId.length < 16) return fail('invalid-lease');
  if (!Number.isSafeInteger(data.leaseEpoch) || data.leaseEpoch < 1) return fail('invalid-epoch');
  if (!Number.isSafeInteger(data.seq) || data.seq < 1) return fail('invalid-seq');
  const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
  if (data.action === 'key') {
    if (!PHASES.has(payload.phase) || typeof payload.code !== 'string' || payload.code.length > 32) {
      return fail('invalid-key');
    }
  }
  if (data.action === 'text' && (typeof payload.text !== 'string' || unicodeScalarCount(payload.text) > MAX_TEXT_SCALARS)) {
    return fail('invalid-text');
  }
  if (data.action === 'batch' && (!Array.isArray(payload.steps) || payload.steps.length < 1 || payload.steps.length > MAX_BATCH_STEPS)) {
    return fail('invalid-batch');
  }
  if (data.action === 'batch' && payload.steps.some((step) => !step || !PHASES.has(step.phase) || typeof step.code !== 'string')) {
    return fail('invalid-batch-step');
  }
  if (data.action === 'reset' && !RESET_REASONS.has(payload.reason)) {
    return fail('invalid-reset-reason');
  }
  return { ok: true, value: { ...data, payload } };
}

function summarizeRemoteInput(data) {
  return {
    schemaVersion: Number(data.schemaVersion || 0),
    type: data.type === 'keyboard' ? 'keyboard' : 'unknown',
    action: ACTIONS.has(data.action) ? data.action : 'unknown',
    leaseEpoch: Number.isSafeInteger(data.leaseEpoch) ? data.leaseEpoch : 0,
    seq: Number.isSafeInteger(data.seq) ? data.seq : 0,
    payloadBytes: Buffer.byteLength(JSON.stringify(data.payload || {}), 'utf8'),
  };
}

module.exports = { validateRemoteInput, summarizeRemoteInput, MAX_TEXT_SCALARS, MAX_BATCH_STEPS };
```

Signal validates physical code shape and length but does not duplicate the macOS support table. `QuartzKeyboardAdapter` is the canonical support truth and returns `unsupported-code` for `ContextMenu`, `Convert`, and `NonConvert`; do not validate physical input through `key` or character content. Validate modifier fields as booleans, `location` as 0..3, reset reason against the spec enum, and reject unknown payload fields rather than forwarding them.

- [ ] **Step 4: Run GREEN and fixture parse check**

Run:

```bash
node --test signal-server/lib/remote-input-contract.test.js
node -e "const f=require('./shared/remote-input-v2-fixtures.json'); if(f.valid.length<5||f.invalid.length<7) process.exit(1); console.log('fixtures-ok')"
```

Expected: all contract tests pass and output includes `fixtures-ok`.

- [ ] **Step 5: Commit**

```bash
git add shared/remote-input-v2-fixtures.json signal-server/lib/remote-input-contract.js signal-server/lib/remote-input-contract.test.js
git commit -m "feat(input): define remote keyboard protocol v2"
```

### Task 2: Implement the pure DesktopControlLease state machine

**Files:**
- Create: `signal-server/lib/desktop-control-lease.js`
- Create: `signal-server/lib/desktop-control-lease.test.js`

- [ ] **Step 1: Write failing fake-clock state tests**

Cover first acquire, read-only denial, explicit takeover, transition ack, stale ack, heartbeat, expiry, controller disconnect, Host disconnect, and old credential rejection:

```javascript
test('takeover freezes old controller until host transition ack grants new lease', () => {
  const lease = makeLease();
  const first = lease.requestControl({ viewerId: 'viewer-a' });
  const activeA = lease.confirmTransition({ leaseEpoch: first.transition.leaseEpoch });
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...activeA.lease }), true);

  const takeover = lease.requestControl({ viewerId: 'viewer-b', takeover: true });
  assert.equal(takeover.state, 'REVOKING');
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...activeA.lease }), false);
  assert.equal(lease.snapshot().controllerViewerId, null);

  const activeB = lease.confirmTransition({ leaseEpoch: takeover.transition.leaseEpoch });
  assert.equal(activeB.state, 'ACTIVE');
  assert.equal(lease.authorize({ viewerId: 'viewer-b', ...activeB.lease }), true);
  assert.equal(lease.authorize({ viewerId: 'viewer-a', ...activeA.lease }), false);
});
```

Use injected `now()` and `makeLeaseId()` so tests advance exactly from 0 to 11,999 and 12,000ms without sleeping.

Define the local helper in the test file:

```javascript
function makeLease() {
  let currentTime = 0;
  let id = 0;
  const lease = new DesktopControlLease({
    now: () => currentTime,
    makeLeaseId: () => `lease-${String(++id).padStart(16, '0')}`,
  });
  lease.advanceTo = (value) => { currentTime = value; };
  return lease;
}
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test signal-server/lib/desktop-control-lease.test.js
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the deep module**

The public class must be limited to:

```javascript
class DesktopControlLease {
  constructor({ now, makeLeaseId, heartbeatIntervalMs = 3000, expiresAfterMs = 12000, transitionTimeoutMs = 3000 })
  requestControl({ viewerId, takeover = false })
  confirmTransition({ leaseEpoch })
  rejectTransition({ leaseEpoch, reason })
  heartbeat({ viewerId, leaseId, leaseEpoch })
  beginRelease({ viewerId, reason })
  viewerDisconnected(viewerId)
  hostDisconnected()
  expire()
  authorize({ viewerId, leaseId, leaseEpoch })
  snapshot()
}
```

Internally keep only `state`, monotonic `_epoch`, `_active`, `_pending`, and deadlines. `requestControl()` allocates the next epoch and returns a `control-transition` effect; it never marks the candidate ACTIVE. `confirmTransition()` is the only grant path. `authorize()` requires state ACTIVE and exact socket owner/token/epoch. `snapshot()` must omit leaseId.

- [ ] **Step 4: Run GREEN and mutation matrix**

Run:

```bash
node --test signal-server/lib/desktop-control-lease.test.js
```

Expected: all state transitions pass without real timers.

- [ ] **Step 5: Commit**

```bash
git add signal-server/lib/desktop-control-lease.js signal-server/lib/desktop-control-lease.test.js
git commit -m "feat(signal): add single desktop control lease"
```

### Task 3: Wire lease authorization into Signal Server

**Files:**
- Modify: `signal-server/websocket/signaling.js:5-393`
- Modify: `signal-server/websocket/signaling.test.js`

- [ ] **Step 1: Add failing socket-level tests**

Extend `FakeSocket` tests to prove:

```javascript
test('input is not relayed before control transition ack', () => {
  const { host, viewer } = connectHostAndViewer();
  viewer.trigger('control-acquire', { requestId: 'req-1' });
  viewer.trigger('input', v2Key({ leaseId: 'wrong-lease-token', leaseEpoch: 1, seq: 1 }));
  assert.equal(host.sent.some((entry) => entry.event === 'input'), false);

  const transition = host.sent.find((entry) => entry.event === 'control-transition').data;
  host.trigger('control-transition-ack', { leaseEpoch: transition.leaseEpoch, status: 'applied' });
  const granted = viewer.sent.find((entry) => entry.event === 'control-state' && entry.data.controller).data;
  viewer.trigger('input', v2Key({ leaseId: granted.leaseId, leaseEpoch: granted.leaseEpoch, seq: 1 }));
  assert.equal(host.sent.filter((entry) => entry.event === 'input').length, 1);
});
```

Add separate tests for B takeover ordering, stale Viewer input, tunnel input, heartbeat expiry, Host replacement, text redaction, and legacy offer lazy-acquire. Assert no lease token appears in captured log lines.

Reuse the existing `FakeSocket` and `makeIo`, and add these helpers in `signaling.test.js`:

```javascript
function connectHostAndViewer() {
  resetConnections();
  const io = makeIo();
  setupSignaling(io, { makeLeaseId: () => 'lease-000000000001' });
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);
  return { io, host, viewer };
}

function v2Key(overrides = {}) {
  return {
    schemaVersion: 2,
    type: 'keyboard',
    action: 'key',
    leaseId: 'lease-000000000001',
    leaseEpoch: 1,
    seq: 1,
    inputIds: ['input-1'],
    payload: { phase: 'down', code: 'KeyA', location: 0, repeat: false },
    ...overrides,
  };
}
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test signal-server/websocket/signaling.test.js
```

Expected: new lease tests fail because current relay forwards every authenticated Viewer input.

- [ ] **Step 3: Add injected lease and transition effects**

Create one lease per `setupSignaling()` invocation:

```javascript
const desktopLease = options.desktopControlLease || new DesktopControlLease({
  now: options.now || Date.now,
  makeLeaseId: options.makeLeaseId,
});

function emitControlTransition(effect) {
  if (!effect || !connections.host) return false;
  connections.host.emit('control-transition', effect.transition);
  return true;
}
```

Register `control-acquire`, `control-heartbeat`, `control-release`, and Host-only `control-transition-ack`. Broadcast safe `control-state` snapshots; include full leaseId only in the controller's grant event. Add an injected interval/scheduler so production calls `expire()` once per second and tests tick it deterministically.

- [ ] **Step 4: Gate all desktop write paths**

Before relaying `input`, `offer`, `relay-stream-control`, resolution, media profile, and state-changing command, authorize against the active lease. Read-only Viewer diagnostics and stats remain allowed. For v2 direct offers, require control first and attach `leaseEpoch` to the Host offer. v2 tunnel control/frame/ack use the same main Viewer socket. For a legacy `relay-viewer` companion, bind it only when exactly one main Viewer exists; reject it when multiple main Viewers are online. For legacy offer/tunnel activation, queue the activation until the reset transition ack, then bind it to the issued lease.

Signal must overwrite `viewerId` from `socket.id`; never read it from Viewer payload. Use `validateRemoteInput()` for v2 socket input and `summarizeRemoteInput()` for logs.

- [ ] **Step 5: Run GREEN and full Signal regression**

Run:

```bash
cd signal-server && npm test
```

Expected: all Signal tests pass, including auth, Terminal, diagnostics, and lease tests.

- [ ] **Step 6: Commit**

```bash
git add signal-server/websocket/signaling.js signal-server/websocket/signaling.test.js
git commit -m "feat(signal): enforce desktop control ownership"
```

### Task 4: Build KeyboardTransport with seq and reset barrier

**Files:**
- Create: `web-client/js/keyboard-transport.js`
- Create: `web-client/js/keyboard-transport.test.js`

- [ ] **Step 1: Write failing transport model tests**

Use injected adapters and clock; do not create DOM or real sockets:

```javascript
test('late datachannel key is invalidated by higher socket reset barrier', async () => {
  const sent = [];
  const transport = makeTransport({
    sendDataChannel: (data) => sent.push(['dc', data]) && true,
    sendSocket: (data) => sent.push(['socket', data]) && true,
  });
  transport.setLease({ leaseId: 'lease-000000000001', leaseEpoch: 7 });
  assert.equal(transport.send({ action: 'key', payload: keyDown('KeyA') }).accepted, true);
  transport.markAdapterUnavailable('datachannel');
  const barrier = transport.resetBarrier('transport-change');
  assert.deepEqual(sent.map(([kind, data]) => [kind, data.action, data.seq]), [
    ['dc', 'key', 1],
    ['socket', 'reset', 2],
  ]);
  assert.equal(transport.canSendNewInput(), false);
  transport.acceptAck({ schemaVersion: 2, leaseEpoch: 7, appliedSeq: barrier.seq, status: 'applied' });
  assert.equal(transport.canSendNewInput(), true);
});
```

Also test pinning while keys are down, ordinary ack ledger, duplicate ack, seq gap response, reset timeout, 256 pending cap, no transport, and lease revoke.

Define the helpers next to the tests:

```javascript
function makeTransport(overrides = {}) {
  let inputId = 0;
  const transport = KeyboardTransport.create({
    sendDataChannel: () => false,
    sendSocket: () => false,
    makeInputId: () => `input-${++inputId}`,
    ...overrides,
  });
  return transport;
}

function keyDown(code) {
  return { phase: 'down', code, location: 0, repeat: false };
}
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test web-client/js/keyboard-transport.test.js
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the transport interface**

Use this public surface:

```javascript
const KeyboardTransport = (() => {
  function create({ sendDataChannel, sendSocket, now = Date.now, makeInputId, ackTimeoutMs = 3000 }) {
    return {
      setLease,
      send,
      resetBarrier,
      acceptAck,
      markAdapterUnavailable,
      canSendNewInput,
      getSnapshot,
    };
  }
  return { create };
})();

if (typeof module !== 'undefined') module.exports = { KeyboardTransport };
```

`send()` generates schemaVersion 2, lease fields, seq and inputIds. Normal key messages remain on the pinned reliable adapter while local pressed count is nonzero. `resetBarrier()` may use Socket.IO even after a DataChannel failure and blocks new input until an applied/duplicate ack covers its seq. Snapshot exposes only state, epoch, last sent/applied seq, pending count, and adapter name.

- [ ] **Step 4: Run GREEN**

Run:

```bash
node --test web-client/js/keyboard-transport.test.js
```

Expected: all transport state cases pass.

- [ ] **Step 5: Commit**

```bash
git add web-client/js/keyboard-transport.js web-client/js/keyboard-transport.test.js
git commit -m "feat(viewer): add reliable keyboard transport"
```

### Task 5: Build RemoteKeyboardController and mapping matrix

**Files:**
- Create: `web-client/js/remote-keyboard-controller.js`
- Create: `web-client/js/remote-keyboard-controller.test.js`

- [ ] **Step 1: Write the failing lifecycle matrix**

Table-drive Mac/Windows and left/right modifiers, then add focused regressions:

```javascript
test('tracked keyup releases even when current target is inside a modal', () => {
  const { controller, sent } = makeController();
  controller.handleDomEvent(keyEvent('keydown', { code: 'ShiftLeft', key: 'Shift' }));
  controller.handleDomEvent(keyEvent('keyup', {
    code: 'ShiftLeft', key: 'Shift', target: modalInputTarget(),
  }));
  assert.deepEqual(sent.map((item) => [item.action, item.payload.phase, item.payload.code]), [
    ['key', 'down', 'ShiftLeft'],
    ['key', 'up', 'ShiftLeft'],
  ]);
  assert.equal(controller.getSnapshot().pressedKeyCount, 0);
});

test('windows ControlRight maps once to MetaRight for down repeat and up', () => {
  const { controller, sent } = makeController({ mode: 'windows' });
  controller.handleDomEvent(keyEvent('keydown', { code: 'ControlRight', key: 'Control', ctrlKey: true }));
  controller.handleDomEvent(keyEvent('keyup', { code: 'ControlRight', key: 'Control' }));
  assert.deepEqual(sent.map((item) => item.payload.code), ['MetaRight', 'MetaRight']);
});
```

Cover K-01/K-02/K-04/K-09/K-12: Ctrl+C/V/X/Z/A/S/F, Ctrl+Shift, Ctrl+Alt, duplicate down, repeat down without up, untracked up, Meta batch, CapsLock tap, AltGr armed state, double Shift mismatch, Dead physical code, composition text, virtual chord ownership, and a fake-clock 10-second hold with no automatic release.

Define controller test helpers with a fake transport that records accepted actions:

```javascript
function makeController({ mode = 'mac' } = {}) {
  const sent = [];
  const transport = {
    setLease() {},
    send(item) { sent.push(item); return { accepted: true, seq: sent.length, adapter: 'datachannel' }; },
    resetBarrier(reason) { sent.push({ action: 'reset', payload: { reason } }); return { accepted: true, seq: sent.length }; },
    canSendNewInput() { return true; },
    getSnapshot() { return { pendingAckCount: 0, state: 'READY' }; },
  };
  const controller = RemoteKeyboardController.create({ transport, mode, now: () => 0 });
  controller.setLease({ leaseId: 'lease-000000000001', leaseEpoch: 1 });
  return { controller, sent };
}

function keyEvent(type, overrides = {}) {
  return {
    type,
    code: 'KeyA',
    key: 'a',
    location: 0,
    repeat: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    target: { tagName: 'DIV', isContentEditable: false, closest: () => null },
    getModifierState: () => false,
    preventDefault() {},
    ...overrides,
  };
}

function modalInputTarget() {
  return { tagName: 'INPUT', isContentEditable: false, closest: (selector) => selector === '.modal' ? {} : null };
}
```

- [ ] **Step 2: Run RED**

Run:

```bash
node --test web-client/js/remote-keyboard-controller.test.js
```

Expected: FAIL because the controller module does not exist.

- [ ] **Step 3: Implement normalized pressed truth**

Expose only the spec interface:

```javascript
const RemoteKeyboardController = (() => {
  function create({ transport, mode = 'mac', now = Date.now, onStateChange = () => {} }) {
    const pressed = new Map();
    let state = 'INACTIVE';
    return {
      setLease,
      setMode,
      handleDomEvent,
      sendChord,
      sendText,
      reset,
      getSnapshot,
    };
  }
  return { create };
})();

if (typeof module !== 'undefined') module.exports = { RemoteKeyboardController };
```

`handleDomEvent()` must call `releaseTrackedKeyup()` before `shouldIgnoreNewKeydown()`. Store normalized `code/location/modifier sides/downSeq/adapter` at accepted keydown. On accepted keyup remove local physical state and leave remote commit in transport's pending ledger. On failed keyup clear local state, enter reset-required, and call `resetBarrier()`.

- [ ] **Step 4: Implement quirks, batch, and text**

`sendChord()` emits one batch with modifiers ordered `Control, Shift, Alt, Meta`, main key down/up, then only batch-owned modifiers in reverse. Meta+ordinary key on macOS uses batch without releasing a physically held Meta. `sendText()` accepts only committed non-empty text and never changes pressed state. Mode change awaits reset barrier before changing the active label.

`sendText()` must reject while the pressed map is non-empty, while transport is not READY, or while the Viewer lacks a lease. This prevents a text commit from being interleaved with a physical modifier chord.

- [ ] **Step 5: Run GREEN and contract fixture check**

Run:

```bash
node --test web-client/js/remote-keyboard-controller.test.js web-client/js/keyboard-transport.test.js
```

Expected: all mapping and lifecycle cases pass.

- [ ] **Step 6: Commit**

```bash
git add web-client/js/remote-keyboard-controller.js web-client/js/remote-keyboard-controller.test.js
git commit -m "feat(viewer): centralize remote keyboard state"
```

### Task 6: Implement the Host RemoteKeyboardState model

**Files:**
- Create: `python-host/remote_keyboard_state.py`
- Create: `python-host/test_remote_keyboard_state.py`
- Read fixture: `shared/remote-input-v2-fixtures.json`

- [ ] **Step 1: Write failing pure-model tests**

Use a recording adapter with `post_key` and `post_text`; `RemoteKeyboardState` releases tracked codes by calling the same `post_key(..., is_down=False, ...)` interface:

```python
class RecordingKeyboardAdapter:
    def __init__(self):
        self.events = []
        self.last_modifier_mask = 0

    def post_key(self, code, is_down, modifier_mask):
        self.events.append((code, is_down, modifier_mask))
        self.last_modifier_mask = modifier_mask

    def post_text(self, text):
        self.events.append(("text", text))

def key_envelope(*, epoch=1, seq, phase, code):
    return {
        "schemaVersion": 2,
        "type": "keyboard",
        "action": "key",
        "leaseId": "lease-000000000001",
        "leaseEpoch": epoch,
        "seq": seq,
        "payload": {"phase": phase, "code": code, "location": 0, "repeat": False},
    }

def reset_envelope(*, epoch=1, seq):
    return {
        "schemaVersion": 2,
        "type": "keyboard",
        "action": "reset",
        "leaseId": "lease-000000000001",
        "leaseEpoch": epoch,
        "seq": seq,
        "payload": {"reason": "transport-change"},
    }

def active_state(adapter):
    state = RemoteKeyboardState(adapter)
    state.transition(connection_generation=1, lease_id="lease-000000000001", lease_epoch=1)
    return state
```

```python
def test_reset_high_water_rejects_late_datachannel_key():
    adapter = RecordingKeyboardAdapter()
    state = RemoteKeyboardState(adapter)
    state.transition(connection_generation=3, lease_id="lease-000000000001", lease_epoch=7)
    assert state.apply(key_envelope(epoch=7, seq=1, phase="down", code="KeyA")).status == "applied"
    assert state.apply(reset_envelope(epoch=7, seq=3)).status == "applied"
    late = state.apply(key_envelope(epoch=7, seq=2, phase="down", code="KeyB"))
    assert late.status == "duplicate"
    assert state.snapshot().pressed_key_count == 0

def test_left_shift_release_keeps_right_shift_flag():
    adapter = RecordingKeyboardAdapter()
    state = active_state(adapter)
    state.apply(key_envelope(seq=1, phase="down", code="ShiftLeft"))
    state.apply(key_envelope(seq=2, phase="down", code="ShiftRight"))
    state.apply(key_envelope(seq=3, phase="up", code="ShiftLeft"))
    assert state.snapshot().pressed_codes == frozenset({"ShiftRight"})
    assert adapter.last_modifier_mask == SHIFT_MASK
```

Add tests for duplicate/gap/stale/new epoch, repeat, batch-owned keys, batch exception cleanup, text scalar limit, reset idempotence, connection generation, unsupported code, and shared fixture parsing.

Add a CapsLock synchronization case: explicit `locks.capsLock` reconciles only when non-null, while `null` preserves Host state. Assert Numpad and ISO/JIS support comes from the adapter result and not character fallback.

Add a stolen-token case: the correct epoch with a leaseId different from the Host transition is rejected without adapter calls. A future epoch arriving through input is also rejected; only `transition()` may advance epoch.

- [ ] **Step 2: Run RED**

Run:

```bash
python3 -m pytest python-host/test_remote_keyboard_state.py -q
```

Expected: collection FAIL because `remote_keyboard_state` does not exist.

- [ ] **Step 3: Implement the state model**

Define immutable result/snapshot types and one mutable session:

```python
@dataclass(frozen=True)
class ApplyResult:
    status: str
    lease_epoch: int
    applied_seq: int
    pressed_key_count: int
    modifier_mask: int

class RemoteKeyboardState:
    def __init__(self, adapter):
        self._adapter = adapter
        self._connection_generation = 0
        self._lease_id = None
        self._lease_epoch = 0
        self._last_applied_seq = 0
        self._pressed_codes = set()

    def transition(self, *, connection_generation: int, lease_id: str, lease_epoch: int) -> ApplyResult:
        self._release_all("lease-transition")
        self._connection_generation = connection_generation
        self._lease_id = lease_id
        self._lease_epoch = lease_epoch
        self._last_applied_seq = 0
        return self._result("applied")

    def apply(self, envelope: dict) -> ApplyResult:
        parsed = validate_remote_input(envelope)
        if not parsed.ok:
            return self._result("invalid-input")
        envelope = parsed.value
        if envelope["leaseId"] != self._lease_id or envelope["leaseEpoch"] != self._lease_epoch:
            return self._result("stale-lease")
        seq = envelope["seq"]
        if seq <= self._last_applied_seq:
            return self._result("duplicate")
        if envelope["action"] != "reset" and seq != self._last_applied_seq + 1:
            return self._result("sequence-gap")
        self._apply_action(envelope["action"], envelope.get("payload") or {})
        self._last_applied_seq = seq
        return self._result("applied")
```

Derive modifier mask from pressed physical codes after every action. Catch `UnsupportedPhysicalCode` separately and return `unsupported-code` without character fallback; on any other adapter exception, release current lease state and return `execution-failed`. `LegacyInputAdapter` owns one internal seq counter and resets whenever its observed transport changes.

Define `validate_remote_input()` in `remote_keyboard_state.py` before `RemoteKeyboardState`; it is a result-based Python parser matching the shared fixtures. It checks schema/type/action, exact lease/seq types, key phase/code/location/repeat, boolean modifier/lock fields, the reset reason enum, text scalar count, batch count/steps, and unknown fields. It never raises on client data and never returns raw values in its error result.

- [ ] **Step 4: Run GREEN**

Run:

```bash
python3 -m pytest python-host/test_remote_keyboard_state.py -q
```

Expected: all pure state and fixture cases pass.

- [ ] **Step 5: Commit**

```bash
git add python-host/remote_keyboard_state.py python-host/test_remote_keyboard_state.py
git commit -m "feat(host): add ordered remote keyboard state"
```

### Task 7: Extract the QuartzKeyboardAdapter and complete mappings

**Files:**
- Create: `python-host/quartz_keyboard_adapter.py`
- Create: `python-host/test_quartz_keyboard_adapter.py`
- Modify: `python-host/input_handler.py:1-240,620-883`

- [ ] **Step 1: Write failing adapter tests**

Patch Quartz calls and assert the canonical mapping:

```python
@pytest.mark.parametrize(("code", "mac_code"), [
    ("IntlBackslash", 10),
    ("IntlYen", 93),
    ("IntlRo", 94),
    ("NumpadComma", 95),
    ("Lang2", 102),
    ("Lang1", 104),
    ("KanaMode", 104),
    ("ShiftLeft", 56),
    ("ShiftRight", 60),
])
def test_physical_code_mapping(code, mac_code):
    assert MAC_KEY_CODE_BY_DOM_CODE[code] == mac_code

def test_text_uses_unicode_event_without_input_source_switch(monkeypatch):
    calls = patch_quartz(monkeypatch)
    adapter = QuartzKeyboardAdapter()
    adapter.post_text("中文🙂")
    assert calls.unicode_strings == ["中文🙂"]
```

Define `patch_quartz()` in the same test file by monkeypatching module-level event constructors/posters and returning a `SimpleNamespace(unicode_strings=[])`:

```python
from types import SimpleNamespace
import inspect
import input_handler
import quartz_keyboard_adapter as adapter_module

def patch_quartz(monkeypatch):
    calls = SimpleNamespace(unicode_strings=[])
    monkeypatch.setattr(adapter_module, "CGEventSourceCreate", lambda *_: "source")
    monkeypatch.setattr(adapter_module, "CGEventCreateKeyboardEvent", lambda *_: {})
    monkeypatch.setattr(adapter_module, "CGEventSetFlags", lambda *_: None)
    monkeypatch.setattr(adapter_module, "CGEventPost", lambda *_: None)
    monkeypatch.setattr(
        adapter_module,
        "CGEventKeyboardSetUnicodeString",
        lambda _event, _length, value: calls.unicode_strings.append(value),
    )
    return calls

def test_no_global_input_mutation_symbols():
    source = inspect.getsource(adapter_module) + inspect.getsource(input_handler)
    assert "subprocess.run" not in source
    assert "ApplePressAndHoldEnabled" not in source
    assert "TISSelectInputSource" not in source
    assert "_switch_to_abc_keyboard" not in source
```

This makes the absence of global mutation executable rather than a manual claim.

Assert every existing valid mapping is retained, `ContextMenu/Convert/NonConvert` are unsupported, Numpad decimal/comma are distinct, batch delay defaults to zero, and step delay clamps to 0..12ms.

Add lock-state tests around `CGEventSourceFlagsState`: `get_caps_lock()` reads `kCGEventFlagMaskAlphaShift`; `set_caps_lock(desired)` emits one CapsLock tap only when current state differs and does nothing when desired is `None` or already synchronized.

- [ ] **Step 2: Run RED**

Run:

```bash
python3 -m pytest python-host/test_quartz_keyboard_adapter.py -q
```

Expected: collection FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement the Quartz adapter**

Move the physical mapping out of `_handle_keyboard()` into one constant. Implement:

```python
class QuartzKeyboardAdapter:
    def __init__(self, *, source=None, step_delay_ms: float = 0):
        self._source = source or CGEventSourceCreate(kCGEventSourceStateHIDSystemState)
        self._step_delay_ms = max(0.0, min(float(step_delay_ms), 12.0))

    def post_key(self, code: str, is_down: bool, modifier_mask: int) -> None:
        mac_code = MAC_KEY_CODE_BY_DOM_CODE.get(code)
        if mac_code is None:
            raise UnsupportedPhysicalCode(code)
        event = CGEventCreateKeyboardEvent(self._source, mac_code, is_down)
        if modifier_mask:
            CGEventSetFlags(event, modifier_mask)
        CGEventPost(kCGHIDEventTap, event)

    def post_text(self, text: str) -> None:
        event = CGEventCreateKeyboardEvent(self._source, 0, True)
        CGEventKeyboardSetUnicodeString(event, len(text.encode('utf-16-le')) // 2, text)
        CGEventPost(kCGHIDEventTap, event)

    def get_caps_lock(self) -> bool:
        flags = CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState)
        return bool(flags & kCGEventFlagMaskAlphaShift)

    def set_caps_lock(self, desired) -> None:
        if desired is None or bool(desired) == self.get_caps_lock():
            return
        self.post_key('CapsLock', True, 0)
        self.post_key('CapsLock', False, 0)
```

Use safe UTF-16 chunk boundaries below Quartz limits. Delete `_setup_macos_input()` startup calls to `defaults write` and `_switch_to_abc_keyboard()`. Keep the user-triggered input-method command as an explicit command path until Task 9 converts it to batch.

Import `CGEventSourceFlagsState`, `kCGEventSourceStateHIDSystemState`, and `kCGEventFlagMaskAlphaShift` for lock synchronization. The adapter must not import `subprocess` or Carbon TIS APIs.

- [ ] **Step 4: Run GREEN and existing Host input tests**

Run:

```bash
python3 -m pytest python-host/test_quartz_keyboard_adapter.py python-host/test_input_handler.py -q
```

Expected: adapter mapping tests and existing pointer/input tests pass.

- [ ] **Step 5: Commit**

```bash
git add python-host/quartz_keyboard_adapter.py python-host/test_quartz_keyboard_adapter.py python-host/input_handler.py python-host/test_input_handler.py
git commit -m "refactor(host): isolate Quartz keyboard adapter"
```

### Task 8: Route Host offers, DataChannels, reset, and ack through one executor

**Files:**
- Modify: `python-host/input_handler.py:33-340,816-883`
- Modify: `python-host/host.py:1053-1216,1274-1495,1748-1769,1864-1960`
- Modify: `python-host/test_input_handler.py`
- Modify: `python-host/test_offer_epoch.py`
- Modify: `python-host/test_connection_diagnostics.py`

- [ ] **Step 1: Add failing serialization and lease-bound channel tests**

Add an async test that blocks a key apply, schedules disconnect reset, then releases the apply and asserts recorded Quartz order ends with keyup and empty state. Add tests that direct DataChannel input inherits only the offer-bound `viewerId/leaseEpoch`, old channels are rejected after takeover, and v2 ack includes `appliedSeq/status/pressedKeyCount/modifierMask` without key data.

Define the blocking helper locally:

```python
import asyncio
import threading

class BlockingAdapter(RecordingKeyboardAdapter):
    def __init__(self):
        super().__init__()
        self.started = threading.Event()
        self.allow = threading.Event()

    def post_key(self, code, is_down, modifier_mask):
        self.started.set()
        while not self.allow.is_set():
            time.sleep(0.001)
        super().post_key(code, is_down, modifier_mask)

def make_handler_with_blocking_adapter():
    adapter = BlockingAdapter()
    handler = InputHandler(keyboard_adapter=adapter)
    handler._running = True
    return handler, adapter
```

The production executor runs `post_key()` off the event loop. Await `asyncio.to_thread(adapter.started.wait, 1)` before scheduling reset, call `adapter.allow.set()`, and wrap the whole test in `asyncio.wait_for(..., timeout=1)` to fail deterministically on deadlock.

```python
@pytest.mark.asyncio
async def test_disconnect_reset_is_serialized_after_inflight_keydown():
    async def run_case():
        handler, adapter = make_handler_with_blocking_adapter()
        apply_task = asyncio.create_task(handler.handle_input(key_envelope(seq=1, phase="down", code="KeyA")))
        assert await asyncio.to_thread(adapter.started.wait, 1)
        reset_task = asyncio.create_task(handler.reset_keyboard(reason="signal-disconnect"))
        adapter.allow.set()
        await asyncio.gather(apply_task, reset_task)
        return handler, adapter

    handler, adapter = await asyncio.wait_for(run_case(), timeout=1)
    assert adapter.events[-1][:2] == ("KeyA", False)
    assert handler.get_keyboard_snapshot().pressed_key_count == 0
```

- [ ] **Step 2: Run RED**

Run:

```bash
python3 -m pytest python-host/test_input_handler.py python-host/test_offer_epoch.py python-host/test_connection_diagnostics.py -q
```

Expected: new tests fail because callbacks call synchronous release methods outside the input lock and offers do not bind lease data.

- [ ] **Step 3: Create the single keyboard executor seam**

Use `ThreadPoolExecutor(max_workers=1, thread_name_prefix="keyboard")` only for `RemoteKeyboardState`. Add async methods:

```python
async def apply_keyboard(self, envelope):
    async with self._keyboard_lock:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._keyboard_executor, self._remote_keyboard.apply, envelope)

async def reset_keyboard(self, reason="manual", lease_epoch=None):
    async with self._keyboard_lock:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            self._keyboard_executor,
            lambda: self._remote_keyboard.reset(lease_epoch=lease_epoch, reason=reason),
        )
```

Remove `check_stale_keys()`, `_key_stale_seconds`, `_last_key_event_time`, and the `monitor_input_stale` task. Keep mouse-move drop behavior on its existing path.

- [ ] **Step 4: Bind control transitions and DataChannels**

Register `control-transition` on the Host Socket.IO client. It must await `reset_keyboard()`, establish the new opaque leaseId/epoch/connection generation, release mouse buttons through the same input lifecycle, then emit `control-transition-ack`. Store offer binding `{viewerId, leaseId, leaseEpoch, connectionGeneration}` from Signal-owned state and inject the binding context into every DataChannel input; ignore client-provided viewer identity and reject a payload leaseId that differs from the binding.

`on_disconnect()`, PC/DataChannel close, viewer status zero, Host stop, and connection replacement call the async reset interface. If a callback is synchronous, schedule exactly one task on the running loop and retain it in a bounded task set so shutdown can await it.

- [ ] **Step 5: Emit v2 applied acknowledgements**

For direct input, send ack on the reliable input DataChannel. For Socket.IO, emit through Signal with viewerId routing. Ack fields come only from `ApplyResult`; existing latency monitor continues using local pending timestamps and `hostExecuteMs`.

- [ ] **Step 6: Run GREEN and Host regression**

Run:

```bash
python3 -m pytest python-host -q
```

Expected: all Host tests pass; no stale monitor task remains.

- [ ] **Step 7: Commit**

```bash
git add python-host/input_handler.py python-host/host.py python-host/test_input_handler.py python-host/test_offer_epoch.py python-host/test_connection_diagnostics.py
git commit -m "feat(host): enforce leased keyboard execution"
```

### Task 9: Integrate control lease, controller, text, and atomic shortcuts in Viewer

**Files:**
- Modify: `web-client/js/webrtc.js:386-427,614-709,1020-1103,1650-1841`
- Modify: `web-client/js/webrtc.test.js`
- Modify: `web-client/js/input.js:1-270,340-670,747-800`
- Modify: `web-client/js/input.test.js`
- Modify: `web-client/js/diagnostic.js`
- Modify: `web-client/js/diagnostic.test.js`
- Modify: `web-client/viewer.html:14-80,177-219`
- Modify: `web-client/css/viewer.css`

- [ ] **Step 1: Add failing acquire-before-offer and UI tests**

Assert socket auth advertises `inputProtocolVersion: 2`, no offer or tunnel control is sent before `control-state.controller=true`, takeover revokes Input immediately, disconnect sends reset/release, and ack reaches `KeyboardTransport.acceptAck()` before latency monitoring.

Add DOM integration tests for:

```javascript
assert.equal(elements.get('controlStatus').textContent, '只读');
elements.get('requestControlBtn').listeners.get('click')({ preventDefault() {} });
assert.deepEqual(socketEmits.at(-1), ['control-acquire', { requestId: socketEmits.at(-1)[1].requestId, takeover: true }]);

dispatchKeyboard(documentListeners, 'keydown', { code: 'ShiftLeft', key: 'Shift', target: desktopTarget() });
dispatchKeyboard(documentListeners, 'keyup', { code: 'ShiftLeft', key: 'Shift', target: textModalInputTarget() });
assert.equal(Input.keyboardController.getSnapshot().pressedKeyCount, 0);
```

Add these local event helpers to `input.test.js`; they use the existing `loadInputWithListeners()` listener map and do not bypass the real document handlers:

```javascript
function desktopTarget() {
  return { tagName: 'VIDEO', isContentEditable: false, closest: () => null };
}

function textModalInputTarget() {
  return { tagName: 'TEXTAREA', isContentEditable: false, closest: (selector) => selector === '.modal' ? {} : null };
}

function dispatchKeyboard(documentListeners, type, overrides) {
  const event = {
    type,
    code: 'KeyA',
    key: 'a',
    location: 0,
    repeat: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    target: desktopTarget(),
    getModifierState: () => false,
    preventDefault() {},
    ...overrides,
  };
  documentListeners.get(type)(event);
}
```

The test invokes `dispatchKeyboard(documentListeners, 'keydown', ...)` and `dispatchKeyboard(documentListeners, 'keyup', ...)`; `desktopTarget()` and `textModalInputTarget()` are therefore defined rather than assumed.

Test compositionend submits one text action, modal cancel sends none, every action button sends one batch, and no `setTimeout(...30)` shortcut sequence remains.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test web-client/js/webrtc.test.js web-client/js/input.test.js web-client/js/diagnostic.test.js
```

Expected: new control, text, and batch tests fail.

- [ ] **Step 3: Acquire control before media activation**

Add `inputProtocolVersion: 2` to main Viewer socket auth. On `connected`/host-online, emit `control-acquire` before `createOffer()` or `startTunnelRelay()`. Handle `control-state`, `control-revoked`, and `control-transition-failed`; only ACTIVE state enables `Input.setActive(true)`. Heartbeat every 3 seconds only while ACTIVE. A Signal socket disconnect immediately freezes the controller and clears its local lease; reconnect must reacquire before offer/input. Hidden, unload, manual disconnect, and logout send reset then `control-release`; blur only resets keyboard. Remove the v2 `relaySocket`; main `this.socket` emits `relay-stream-control`, receives `relay-frame`, and emits `relay-frame-ack`, so tunnel media and input have the same socket owner.

- [ ] **Step 4: Instantiate controller and transport once**

Load scripts in this order:

```html
<script src="js/keyboard-transport.js"></script>
<script src="js/remote-keyboard-controller.js"></script>
<script src="js/input.js"></script>
```

`Input` creates one transport with WebRTC DataChannel and Socket.IO adapters, then one controller. Document listeners delegate DOM events; remove `_pressedKeys`, `_keyReleaseTimer`, `_keyStaleMs`, `normalizeKeyboardEvent()`, `sendKeyboardReset()`, and timer-based `sendKey()` from `input.js`.

- [ ] **Step 5: Add control and text UI**

Add `controlStatus`, `requestControlBtn`, `textInputBtn`, `textInputModal`, `remoteTextInput`, submit and cancel controls. Keep layout compact and consistent with the existing action bar. Only show `请求控制` when read-only/free; show `正在切换` while waiting. Text modal accepts composition and explicit submit, caps input length at 4096 scalars, clears after accepted send, and never writes content to console or diagnostics.

- [ ] **Step 6: Replace all virtual shortcuts with batch**

Represent action buttons by physical chord only:

```javascript
const actions = {
  enter: { main: 'Enter', modifiers: [] },
  copy: { main: 'KeyC', modifiers: ['MetaLeft'] },
  paste: { main: 'KeyV', modifiers: ['MetaLeft'] },
  cut: { main: 'KeyX', modifiers: ['MetaLeft'] },
  undo: { main: 'KeyZ', modifiers: ['MetaLeft'] },
  selectAll: { main: 'KeyA', modifiers: ['MetaLeft'] },
  save: { main: 'KeyS', modifiers: ['MetaLeft'] },
  find: { main: 'KeyF', modifiers: ['MetaLeft'] },
  screenshot: { main: 'KeyA', modifiers: ['MetaLeft', 'ShiftLeft'] },
  switchInputMethod: { main: 'Space', modifiers: ['ControlLeft'] },
};
```

Arrow and Enter buttons also use batch down/up. `showDock` may remain a validated command because it represents mouse edge movement, not a keyboard chord.

- [ ] **Step 7: Make diagnostics state-only**

Expose lease state, epoch, last sent/applied seq, pending count, pressed count, modifier mask, adapter and last reset reason enum. Remove raw keyboard debug entries and labels containing key/code. Preserve existing metadata-only logging tests.

- [ ] **Step 8: Run GREEN and Viewer regression**

Run:

```bash
node --test web-client/js/keyboard-transport.test.js web-client/js/remote-keyboard-controller.test.js web-client/js/input.test.js web-client/js/webrtc.test.js web-client/js/diagnostic.test.js web-client/css/viewer-layout.test.js
```

Expected: all Viewer keyboard, connection, diagnostics, and layout tests pass.

- [ ] **Step 9: Commit**

```bash
git add web-client/js/keyboard-transport.js web-client/js/remote-keyboard-controller.js web-client/js/webrtc.js web-client/js/webrtc.test.js web-client/js/input.js web-client/js/input.test.js web-client/js/diagnostic.js web-client/js/diagnostic.test.js web-client/viewer.html web-client/css/viewer.css
git commit -m "feat(viewer): enforce leased keyboard control"
```

### Task 10: Close compatibility, docs, and diagnostic ledger

**Files:**
- Modify: `signal-server/websocket/signaling.js`
- Modify: `signal-server/websocket/signaling.test.js`
- Modify: `python-host/remote_keyboard_state.py`
- Modify: `python-host/test_remote_keyboard_state.py`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`
- Modify: `docs/superpowers/reports/2026-07-19-remote-keyboard-mapping-stuck-key-systemic-analysis.md`

- [ ] **Step 1: Add failing legacy migration tests**

Test exact upgrade behavior:

- Host capability v2 is required before Signal grants a v2 lease.
- legacy direct offer and tunnel activation lazy-acquire one lease.
- legacy `relay-viewer` companion binds only when exactly one main Viewer is online and is rejected in ambiguous multi-Viewer state.
- legacy DataChannel and Socket.IO both enter one Host `LegacyInputAdapter`.
- legacy transport change performs reset before the first event on the new transport.
- second legacy Viewer remains read-only.
- takeover from v2 resets legacy state before grant.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test signal-server/websocket/signaling.test.js
python3 -m pytest python-host/test_remote_keyboard_state.py -q
```

Expected: at least capability and legacy transport-change cases fail until migration behavior is complete.

- [ ] **Step 3: Finish the one-release compatibility adapter**

Record `inputProtocolVersion` for Host and Viewer sockets. Reject v2 activation when Host capability is absent with `host-protocol-too-old`. Mark legacy input internally; never attach a fake client-controlled lease token. Host adapter binds legacy input to the server-issued offer/relay lease and owns its seq/reset behavior.

Add a named config constant `LEGACY_INPUT_COMPAT_ENABLED = true` with removal criteria in the requirement document; do not add an environment variable that lets production silently keep legacy forever.

- [ ] **Step 4: Update active product truth and remediation ledger**

Update requirements to state:

- single controller with explicit takeover;
- Mac/Windows physical mapping and exact unsupported keys;
- key/text/batch/reset protocol semantics;
- direct/tunnel identical control authorization;
- long hold and lifecycle release behavior;
- v1 compatibility window and ordered deployment;
- default diagnostic redaction;
- real-browser acceptance remains required after implementation.

In the diagnostic report, add a remediation table with K-01..K-13 status, implementing commit, focused test command, and runtime evidence field. Until Task 12 is complete, runtime fields must say `未执行` rather than `通过`.

- [ ] **Step 5: Run GREEN and documentation checks**

Run:

```bash
node --test signal-server/websocket/signaling.test.js
python3 -m pytest python-host/test_remote_keyboard_state.py -q
rg -n '单一控制租约|keyboard/batch|Unicode text|K-13|未执行' docs/需求文档/WebRemoteDesktop-需求文档.md docs/superpowers/reports/2026-07-19-remote-keyboard-mapping-stuck-key-systemic-analysis.md
git diff --check
```

Expected: migration tests pass, all required contract terms are present, and diff check is clean.

- [ ] **Step 6: Commit**

```bash
git add signal-server/websocket/signaling.js signal-server/websocket/signaling.test.js python-host/remote_keyboard_state.py python-host/test_remote_keyboard_state.py docs/需求文档/WebRemoteDesktop-需求文档.md docs/superpowers/reports/2026-07-19-remote-keyboard-mapping-stuck-key-systemic-analysis.md
git commit -m "docs(remote): close keyboard protocol migration contract"
```

### Task 11: Run full automated closure and static security checks

**Files:**
- Modify only files needed to fix failures within this plan's commit boundary.

- [ ] **Step 1: Run focused cross-layer contract tests**

```bash
node --test signal-server/lib/remote-input-contract.test.js signal-server/lib/desktop-control-lease.test.js signal-server/websocket/signaling.test.js web-client/js/keyboard-transport.test.js web-client/js/remote-keyboard-controller.test.js web-client/js/input.test.js web-client/js/webrtc.test.js web-client/js/diagnostic.test.js
python3 -m pytest python-host/test_remote_keyboard_state.py python-host/test_quartz_keyboard_adapter.py python-host/test_input_handler.py python-host/test_offer_epoch.py python-host/test_connection_diagnostics.py -q
```

Expected: zero failures.

- [ ] **Step 2: Run full repository-owned regressions**

```bash
cd signal-server && npm test
cd .. && node --test web-client/js/*.test.js web-client/css/*.test.js scripts/*.test.js
python3 -m pytest python-host skills/webremote-service/scripts/wrd_service_test.py -q
```

Expected: zero failures. Do not run `hapi` or `basiclib` suites because they are separate vendored/subproject scopes and untouched by this feature.

- [ ] **Step 3: Scan for removed hazards and raw input logging**

```bash
rg -n '_keyStaleMs|_key_stale_seconds|monitor_input_stale|ApplePressAndHoldEnabled|_switch_to_abc_keyboard|TISSelectInputSource|setTimeout.*30' web-client/js/input.js python-host/input_handler.py python-host/host.py
rg -n 'console\.(log|warn|error).*\b(key|code|text)\b|logger\.(info|warning|error).*\b(key|code|text)\b' web-client/js signal-server python-host --glob '!*.test.js' --glob '!test_*.py'
```

Expected: first command returns no matches. Review every second-command match; only constant event names or redacted metadata are allowed. Any payload/key/text interpolation must be removed and covered by a redaction test.

- [ ] **Step 4: Verify scope and staged closure**

```bash
git diff --check
git status --short
git diff --stat origin/main...HEAD
```

Expected: only planned source/test/docs changes plus known user-owned `.agents/skills/webremote-service` cache shape and `back-debug.log.1`; no secrets, logs, tunnel state, or unrelated subproject changes are staged.

- [ ] **Step 5: Commit any narrow closure fixes**

If Step 1-4 required changes, stage only those exact files and commit:

```bash
git commit -m "test(remote): close keyboard reliability regressions"
```

If no files changed, record `no closure fix commit required` in the runtime acceptance report and do not create an empty commit.

### Task 12: Complete strict real-browser and real-Host acceptance

**Files:**
- Create: `docs/superpowers/reports/2026-07-19-remote-keyboard-runtime-acceptance.md`
- Modify: `docs/superpowers/reports/2026-07-19-remote-keyboard-mapping-stuck-key-systemic-analysis.md`

**Required skill during execution:** `webapp-testing` for browser automation/inspection. Use an ordinary browser session for final evidence; mocks and jsdom do not satisfy this task.

- [ ] **Step 1: Confirm external prerequisites without changing service/tunnel state**

Ask the user to have the current Signal Server and Host running from the implementation commit. Read the current public URL only from `/tmp/wrd-safe-current-url.txt` if public testing is requested. Do not start/restart cloudflared or rotate a tunnel. Record:

- implementation commit;
- browser name/version and Viewer OS;
- Host OS/version;
- direct or manual tunnel mode;
- selected candidate pair for direct mode;
- whether ISO/JIS/Numpad physical hardware is available.

- [ ] **Step 2: Prove single-Viewer mapping and release**

For both Mac and Windows mode, execute and record visible results for left/right modifiers, Ctrl/Cmd C/V/X/Z/A/S/F, Ctrl+Shift, Ctrl+Alt/AltGr, CapsLock, Option/Dead, action-bar batches, and text input with Chinese, emoji, and multiline text. Hold an arrow key for more than 10 seconds and verify movement stops immediately on release.

Before opening each resolution/network/diagnostic/text modal, hold Shift; release inside the modal and verify diagnostics report `pressedKeyCount=0` and `modifierMask=0`. Do not record the actual typed text in the report.

- [ ] **Step 3: Prove direct/tunnel control lease with two Viewers**

Use Viewer A and Viewer B as two distinct browser contexts:

1. A acquires direct control; B is read-only and its key/mouse input has no effect.
2. A holds a modifier; B requests takeover; A freezes before Host reset and B only activates after ack.
3. Send a delayed event from A after B activation; verify no effect and a stale-lease rejection counter increment.
4. Repeat with A in tunnel and B direct, then A direct and B tunnel.
5. Disconnect the controller while a modifier is down; next controller must start with Host pressed state zero.

- [ ] **Step 4: Inject transport and lifecycle failures**

Through browser test hooks limited to development diagnostics:

- close the reliable input DataChannel after keydown and verify Socket.IO reset barrier;
- suppress one reset ack and verify new keydown remains blocked until lease reacquire;
- hide/unhide the page, close one Viewer, disconnect/reconnect Signal, and refresh during a held modifier;
- rapidly alternate mode change, takeover, and reconnect.

After every case capture lease epoch, last sent/applied seq, reset reason, barrier RTT, pressed count, modifier mask, and visible result.

- [ ] **Step 5: Record hardware-limited coverage honestly**

If ISO/JIS/Numpad hardware is present, execute the physical mapping cases. If absent, write `未执行：缺少对应实体键盘；自动化 mapping table 已通过` for each unavailable family. Do not mark them runtime-passed.

- [ ] **Step 6: Write the acceptance report and close the ledger**

The report must contain:

- exact automated commands and pass counts;
- runtime environment and commit;
- a case table with expected/actual/evidence/status;
- no raw key/text values;
- separate `已通过`, `未通过`, and `未执行` totals;
- residual limitations for browser-reserved shortcuts and unavailable hardware.

Update K-01..K-13 ledger rows with real evidence. A K item can become `已闭环` only when its required automated and runtime cases pass; otherwise retain `代码完成/运行未验收` or `未通过`.

- [ ] **Step 7: Verify and commit acceptance evidence**

```bash
rg -n '已通过|未通过|未执行|pressedKeyCount|modifierMask|selected candidate|lease epoch' docs/superpowers/reports/2026-07-19-remote-keyboard-runtime-acceptance.md
rg -n 'Secret|password|leaseId|payload.*text|payload.*key' docs/superpowers/reports/2026-07-19-remote-keyboard-runtime-acceptance.md
git diff --check
```

Expected: first command finds complete evidence sections; second command returns no sensitive content; diff check is clean.

```bash
git add docs/superpowers/reports/2026-07-19-remote-keyboard-runtime-acceptance.md docs/superpowers/reports/2026-07-19-remote-keyboard-mapping-stuck-key-systemic-analysis.md
git commit -m "docs(remote): record keyboard runtime acceptance"
```

---

## Final Delivery Gate

Before merging or pushing implementation, run:

```bash
git log --oneline --decorate -15
git diff --check origin/main...HEAD
git status --short --branch
```

Confirm every plan checkbox is resolved, every Definition of Done item has evidence, and known user-owned `.agents/skills/webremote-service` cache changes plus `back-debug.log.1` remain untracked/unstaged. Never include runtime passwords, current tunnel URL files, debug logs, or generated cache links in a commit.
