# Controlled Native Latency Collector Wiring Implementation Plan — draft v3

**Repository checkpoint:** v3 draft/offline wiring scope independently approved; not implemented or deployed. Original draft provenance/NOT_RUN limits below remain. Root source holds cited in drafting background are historical; no runtime authority follows from this document.
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Root dispatches one fresh implementer per task, then separate spec-compliance and quality reviews; original implementer fixes findings before the next task. Workers do not spawn subagents. This header describes future execution, not authorization to start now.

**Planning status: v3 draft/offline wiring independently approved; implementation, deployment and live acceptance remain pending.** V1 provenance is e684; v2 used supplied c802/bb581/dfb context. Latest private review reports source hold released, planning source c54, separate runner-fix owner, Viewer still c802/bb581. These are supplied historical context, not verified Git/runtime evidence. The baseline ended failed-or-indeterminate; this draft does not affect or explain it. V3 reads private drafts/review and writes private v3 files only. No repository/source/package writes, implementation, tests, project imports, runtime/process/network/browser/service/native operations. V1/v2 remain unchanged.

V2's three original P2 fixes remain. V3 addresses only the trace-action dependency in `/tmp/wrd-native-latency-collector-drafts-v2-fix1-review-20261018.md`: use immutable slot type/action matched to actual accepted send, plus fresh live references, independently of InputTrace and Date.now. No new generic API/framework or trace/authority change. Reconcile source references before handoff; Scoped v3 review is approved; see [review](../reports/evidence/2026-10-18-runtime-continuation-r5/native-collector-v3-fix-review.md).

**Goal:** wire the existing controlled-scene lifecycle to genuine accepted-send/current applied-ACK Viewer clocks, existing post-apply evidence and strict CRC marker evaluation, with one bounded private evidence slot and a safe alternative report format.

**Architecture:** extend the existing LatencyMonitor rather than install a parallel collector. Observe actual transport success and existing ACK validation without changing product behavior, then project the existing in-memory Lab/producer/visual evidence into the existing strict Python evaluator. Leave native isolation and every execution guard unchanged.

**Tech Stack:** existing classic browser JavaScript, Node node:test/VM/fake transports and monotonic clocks, existing Python dataclasses/pytest/pure controlled-scene evaluator. No dependency installation, browser, network, native APIs or real capture is required for this increment's offline work.

**Spec:** `docs/superpowers/specs/2026-10-18-native-latency-collector-design.md` (versioned v3 draft; implementation remains pending).

## Global Constraints

- Native, visible and physical runtime acceptance remains NOT_RUN/BLOCKED until a separately reviewed target owner exists.
- The ordinary recovery and fresh three-hour continuity runs retain their fixed `businessInput/visibleEffect/physical=NOT_RUN`.
- At most one controlled input slot, lifetime 10000 ms from begin, <=8192 serialized metadata bytes, no new timer/listener/network action.
- Preserve `turn_lab_host.py:_local_fixture_probe`, `run_automatic_scene` and all existing proof, lease, reset, rebind, media and native guard conditions.
- Disabled/no slot means constant bounded no-op. Every hook is exception-isolated.
- Existing M1 aggregates and their semantics stay unchanged.
- No payload, text, code/key value, coordinates, clipboard, DOM, screenshot/pixels, credentials, URLs, IPs or arbitrary exception messages.
- No RTT/2, cross-machine wall-clock subtraction, subtraction of adapter time to label network, percentile addition or optical claim.
- Do not start a Lab/Host/browser just to demonstrate the known environment BLOCKED state.
- Preserve pre-existing changes, primary checkout/index, node_modules link, W2, service/watch/tunnel state. No dist/build/dependency/configuration/native-adapter/ordinary-runner change. Root controls one source/index writer handoff and exact owned commits.
- The pending resource question stays pending. No repeated user questions or implementation/runtime claims from this plan.

## File ownership and order

All future paths are relative to `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`.

| Task | Sole-writer paths | Deliverable |
|---|---|---|
| 1 | `web-client/js/latency-monitor.js`, `web-client/js/latency-monitor.test.js` | One reserved raw-evidence slot and M2 recording; no product hooks yet |
| 2 | `web-client/js/input.js`, `web-client/js/webrtc.js`, `web-client/js/input.test.js`, `web-client/js/webrtc.test.js`, `web-client/js/webrtc.frame-trace.test.js` | Actual transport/ACK boundary hooks and real-code fake-platform tests |
| 3 | `scripts/turn_controlled_scene_runtime.py`, `scripts/test_turn_controlled_scene_runtime.py` | Strict step bridge, stream-bound broker extension and privacy projection |
| 4 | `scripts/turn_controlled_scene_lab_runner.py`, `scripts/test_turn_controlled_scene_lab_runner.py` | Adapter/driver optional native-evidence context and safe artifact output mode |
| 5 | Tests from tasks1–4 only as needed, exact spec/plan/report and `docs/需求文档/WebRemoteDesktop-需求文档.md` | Cross-language pure integration, final evidence/requirements synchronization |

Tasks are serial. No other agent/root writes task-owned source/index during its handoff. Reviews are read-only; all corrections return to the original implementer. Root versions planning/review documentation before source work. Re-read current files and reconcile any post-F changes before each handoff; never apply draft line numbers blindly.

## Task 1: One bounded controlled slot in LatencyMonitor

**Files:** modify existing `web-client/js/latency-monitor.js` around createLatencyMonitor/recordInputSend/onPostApplyFrame; extend existing `latency-monitor.test.js`. Do not edit InputTrace, product pending ledgers or metric names.

**Interfaces:** consume Scope, existing now/validation and M2 matched row; produce the five spec APIs beginControlledInputEvidence, observeControlledSend, observeControlledAck, readControlledInputEvidence and clearControlledInputEvidence. Send/ACK/read take the explicit LiveTransportSnapshot; read also takes `{finalize,terminalReason}`. ControlledEvidence includes immutable beganAtMs/deadlineAtMs, computed remainingMs, finalized/expired and exactly observationCounters.{duplicateAcks,invalidObservations}. Raw event clocks remain separate from M1's processing high-water. Source references/snapshots are never exposed by reads.

- [ ] **Step 1: Add the failing pure slot test in the existing test file.** Use its already imported `createLatencyMonitor`; helpers below are complete local fixtures and introduce no browser/native operation.

```js
test('native latency: stores event clocks independently of processing high-water', () => {
  let now = 100;
  const m = createLatencyMonitor({ now: () => now, schedule: () => null, cancel() {} });
  const scope = { connectionAttemptId: 'attempt', generation: 2, leaseEpoch: 4 };
  const source = {}, pc = {};
  const live = { pc,
    datachannel: { selectedMoveSendSource: source, selectedReliableSendSource: source,
      reliableAckSource: source },
    socket: { selectedSendSource: null, reliableAckSource: null, object: null, id: null } };
  const current = { scope, leaseId: 'lease', streamId: 'video', pc, live };
  m.setScope(scope);
  assert.equal(m.beginControlledInputEvidence({ inputId: 'lab_inp_1',
    leaseId: 'lease', scope, streamId: 'video', inputType: 'mouse', action: 'down' }), true);
  assert.equal(m.observeControlledSend({ inputId: 'lab_inp_1', leaseId: 'lease',
    leaseEpoch: 4, inputType: 'mouse', action: 'down', seq: 1 }, {
    scope, streamId: 'video', transport: 'datachannel', sendSource: source,
    ackSource: source, socketId: null, pc, live, viewerClockMs: 100 }), true);
  now = 150;
  m.recordInputSend('unrelated', { scope, submittedAtMs: 150 });
  now = 300; // an existing consumer has advanced its processing clock
  m.snapshot();
  assert.equal(m.observeControlledAck({ schemaVersion: 2, inputType: 'mouse',
    inputIds: ['lab_inp_1'], leaseEpoch: 4, appliedSeq: 1, status: 'applied' }, {
    ...current, transport: 'datachannel', source, socketId: null,
    viewerClockMs: 200, verdict: 'reliable-applied' }), true);
  const row = m.readControlledInputEvidence('lab_inp_1', current);
  assert.equal(row.send.viewerClockMs, 100);
  assert.equal(row.ack.viewerClockMs, 200);
  assert.equal(row.hostTiming.hostApplyMs, null);
  assert.equal(JSON.stringify(row).includes('ackSource'), false);
  m.clearControlledInputEvidence('lab_inp_1');
  assert.equal(m.readControlledInputEvidence('lab_inp_1', current), null);
});
```

- [ ] **Step 2: Record RED.** Run `node --test --test-name-pattern='native latency:' web-client/js/latency-monitor.test.js`. Expected first failure: missing beginControlledInputEvidence. Save exact command/status in the future implementation report; do not run it during drafting.
- [ ] **Step 3: Implement the single slot and exact projection.** Inside createLatencyMonitor add one private slot, no collection framework/map/listeners. Validate all reservation fields before assignment; use only declared finite action enums. Retain at most the single send/ACK/post-apply row plus counters. Validate raw event timestamp against finite processing-now and send time; never pass a stored event timestamp through M1 clock(). Store beganAtMs/deadlineAtMs once; no read/observation/ACK can renew them. Add the public functions exactly as specified, including read's ID-bound finalize options. setScope cancels on scope change; every matching read compares current lease/PC/scope/stream and fresh applicable live selected-send/reliable-ACK/socket object+ID before returning or finalizing. Incoming ACK source must also be saved and still-current reliable source, including unordered moves. Calls for unrelated IDs do not populate/finalize/clear the occupied slot. onPostApplyFrame copies current matched true-fresh/after-applied rows without changing existing behavior. Enforce caps, reason precedence and finalized/expired fields. Reject PENDING/unfinalized at the eventual bridge.

```js
// Required shape inside createLatencyMonitor; all helpers stay private here.
let controlled = null;
// Public methods: beginControlledInputEvidence(reservation),
// observeControlledSend(meta, context), observeControlledAck(ack, context),
// readControlledInputEvidence(inputId, current, {finalize,terminalReason}),
// clearControlledInputEvidence(inputId).
// No raw envelope/payload or source reference is copied into a read result.
```

- [ ] **Step 4: Add negative/bounds cases as parallel table tests.** Required rows: valid time0; no send; second begin; wrong ID/type/action/lease/epoch/generation/stream/PC/source/socket ID; send twice; exact duplicate ACK no double sample; conflicting duplicate; duplicate/rejected/future-sequence ACK; invalid/NaN/infinite/negative/future clock; ACK/frame before send; ACK after video; post-apply missing freshness flag; 9999ms vs10000ms expiry; over128-character ID; 8KiB overflow; reset/scope replacement; observer throw. Add completed-send/ACK/M2 fixtures, then rotate selected move channel, reliable ACK channel, socket object or socket ID before a finalize=true read: each applicable rotation must yield finalized INCOMPLETE/source-changed without editing product ledgers. Add unordered ACK on the formerly saved reliable channel after the current reliable channel changes; it cannot qualify even when scope and saved source match. Wrong-ID finalizing read must return null and preserve the occupied slot/deadline. Repeated intermediate reads and completion polling never change beganAtMs/deadlineAtMs. Missing M2 at deadline yields finalized INCOMPLETE/post-apply-missing/expired=true. Counters have exactly duplicateAcks/invalidObservations and saturate safely. Assert no change to existing pending/outcomes/metric samples from controlled APIs and no new timer. All clocks advance deterministically; no wall-time sleeps.
- [ ] **Step 5: Record GREEN and focused compatibility.** Run the RED command, then `node --test web-client/js/latency-monitor.test.js`. Expected all scoped checks PASS; no runtime/native acceptance claim. Commit only owned source/tests after root's handoff procedure; proposed subject `feat(diagnostics): retain bounded controlled input evidence`. Obtain spec and quality review before Task2.

## Task 2: Capture actual send and current ACK-entry clocks

**Files:** exact Task2 allowlist above. Use existing `loadInput`, `loadWebRTC({realInput:true})`, duration-clock fixtures and production rVFC callback tests; platform transport/browser/clock may be fake, changed product methods may not be replaced by no-op models.

**Interfaces:** consume Task1 APIs. Genuine accepted-send meta must match the reserved immutable ID/inputType/action. The already proposed read-only snapshot method is `WebRTC.captureControlledTransportSnapshot()` with no action argument: one finite snapshot of current selectedMoveSendSource, selectedReliableSendSource, reliableAckSource plus Socket object/ID and PC. The existing observer chooses the candidate only from its matching slot's immutable type/action after validating actual send; it never asks trace metadata to choose. No additional public lookup API/callback/router. Preserve current selection/quarantine behavior, return values and C → M1 → trace ordering. Trace unavailable or wall-clock pruning cannot change evidence eligibility. Actual move send and reliable ACK channel remain distinct references.

- [ ] **Step 1: Add a real-code boundary RED test in `webrtc.test.js`.** This uses that file's existing loadWebRTC fixture; add the normal `require('./latency-monitor.js').createLatencyMonitor` locally. Avoid modifying C validators.

```js
test('native latency: accepted channel send and ACK entry survive later observer work', () => {
  let now = 100;
  const m = require('./latency-monitor.js').createLatencyMonitor({ now: () => now });
  const { WebRTC: w, context } = loadWebRTC({ realInput: true,
    LatencyMonitor: m, performance: { now: () => now } });
  const input = context.__Input;
  w.currentConnectionAttemptId = 'attempt'; w.connectionAttemptSequence = 2;
  w.pc = {};
  input.activeControlLease = { leaseId: 'lease', leaseEpoch: 4 }; input.isActive = true;
  const channel = w.inputChannel = { readyState: 'open', bufferedAmount: 0,
    send() { now = 110; } };
  w.socket = { connected: false };
  const reservation = input.prepareLabInput('mouse', 'down', { relX: .5, relY: .5 });
  const current = () => ({ scope: w.latencyScope(), leaseId: 'lease', streamId: 'video', pc: w.pc,
    live: w.captureControlledTransportSnapshot() });
  m.setScope(current().scope);
  assert.equal(m.beginControlledInputEvidence({ inputId: reservation.inputId,
    leaseId: 'lease', scope: current().scope, streamId: 'video',
    inputType: 'mouse', action: 'down' }), true);
  const originalTrace = input._recordInputTrace;
  input._recordInputTrace = function(...args) {
    const result = originalTrace.apply(this, args); now = Math.max(now, 200); return result;
  };
  assert.equal(input.dispatchPreparedLabInput(reservation), reservation.inputId);
  const pending = input._desktopWritePending.get(reservation.inputId);
  const originalAck = input._acceptMouseAck;
  input._acceptMouseAck = function(ack) {
    const result = originalAck.call(this, ack); now = 400; return result;
  };
  now = 300;
  w.acceptObservedInputAck({ schemaVersion: 2, inputType: 'mouse', leaseEpoch: 4,
    inputIds: [reservation.inputId], appliedSeq: pending.seq, status: 'applied' },
    { transport: 'datachannel', dataChannel: channel });
  const row = m.readControlledInputEvidence(reservation.inputId, current());
  assert.equal(row.send.viewerClockMs, 110);
  assert.equal(row.ack.viewerClockMs, 300);
});
```

- [ ] **Step 2: Record RED.** `node --test --test-name-pattern='native latency:' web-client/js/webrtc.test.js`. Task1 exists, so expected failure is absent real send/ACK evidence, not a missing monitor API.
- [ ] **Step 3: Add narrowly placed hooks.** In `WebRTC.sendInput`, immediately after actual channel.send returns, capture `performance.now()` and call observeControlledSend inside exception-isolated observation code. Derive sendSource from selected channel; ackSource from current reliable inputChannel. Do not add a call to the buffered-move return-true branch. In Input's two socket success sites capture/call immediately after socket.emit success, before trace work. Leave existing recordLatency timestamps/semantics alone. Metadata projections include only single ID, lease/type/action/sequence and scope/source references; never pass payload to storage.

```js
// The successful API call stays outside observer error suppression.
channel.send(JSON.stringify({ ...data, transport: 'datachannel' }));
const acceptedAtMs = performance.now();
try {
  // Build declared scalar meta and current source/lease/scope context here.
  // observeControlledSend receives no payload; ackSource is this.inputChannel.
  LatencyMonitor.observeControlledSend?.(sendMeta, sendContext);
} catch (_) { /* evidence failure cannot change delivery */ }
return true;
```

The names sendMeta/sendContext denote projections from genuine accepted data, current lease/scope/PC, selected channel and fresh no-argument LiveTransportSnapshot; they are not callbacks/globals. The observer checks that send ID/type/action equals the immutable slot before retaining it. At ACK entry capture raw Performance time; after real C/M1 processing capture a fresh snapshot. Inside observeControlledAck, match the reserved ID/accepted send and select the live candidate using only slot inputType/action. Do not use Input.peekInputAckMetadata/_unorderedTraceSends/trace action=ack for this selection, and do not modify those existing trace facilities. The unordered branch still compares saved/current selected send, saved/current reliable ACK and actual incoming source; scope-only M1 matching is insufficient. Unknown ID, no actual send or source mismatch cannot qualify. Trace remains last; M1 timestamps/authority unchanged.

- [ ] **Step 4: Extend actual-path RED/GREEN cases.** Test DC refusal→socket success exactly once; thrown channel/emit; disconnected socket; congested mouse-move true-return with zero sends/evidence; genuine move on inputMoveChannel with ACK on inputChannel; selected-channel quarantine regression; source rotation before ACK **and after send/ACK/M2 completion before final read**; old reliable-channel unordered ACK after current reliable channel replacement; socket object and socket-ID rotations independently; stale/future sequence; duplicate ACK; scope/lease replacement; missing LatencyMonitor; all hooks throwing; ±60000 wall-clock jumps. Assert new evidence invalidation does not alter actual product ACK result/M1/trace dispatch. Exercise keyboard wrappers and desktop prepared keyboard/text. Preserve raw v2 envelope equality and one-use reservation. Existing production rVFC tests must retain original callback time through trace-first/frame-first late binding, including video before ACK. Failed CRC stays absent visual evidence.

- [ ] **Step 4a: Add the trace-independence actual-method RED/GREEN cases below.** Extend the existing realInput fixture tests; leave _recordInputTrace, peekInputAckMetadata, _pruneUnorderedTraceSends, sendInput and ACK validators real. Only supply the trace collector capability (real InputTrace instance or unavailable), fake native transport/clock and current source objects. Test all traceUnavailable false/true × Date.now shift -60000/0/+60000 between accepted move and current reliable-channel ACK. Assert original Performance send/ACK times survive even when the hint map is empty. Under each unavailable/jump variant, wrong-source, unknown-ID and buffered suppressed-move cases must still have no successful controlled ACK. No changes to trace clock/pruning/ownership are permitted to make these pass.

```js
for (const traceUnavailable of [false, true]) for (const wallStep of [-60000, 0, 60000]) {
  test(`native latency: trace independent move ${traceUnavailable}/${wallStep}`, () => {
    let mono = 100, wall = 1792208500000;
    class PageDate extends Date { static now() { return wall; } }
    const m = require('./latency-monitor.js').createLatencyMonitor({ now: () => mono });
    const { WebRTC: w, context } = loadWebRTC({ realInput: true, LatencyMonitor: m,
      performance: { now: () => mono }, Date: PageDate });
    const input = context.__Input;
    const trace = require('./input-trace.js').InputTrace.create({ now: () => mono,
      hashInputIds: null, setTimeoutFn: () => null, clearTimeoutFn() {} });
    input._traceCollector = traceUnavailable ? () => null : () => trace;
    w.currentConnectionAttemptId = 'attempt'; w.connectionAttemptSequence = 2; w.pc = {};
    input.activeControlLease = { leaseId: 'lease', leaseEpoch: 4 }; input.isActive = true;
    const reliable = w.inputChannel = { readyState: 'open', bufferedAmount: 0,
      send() { throw new Error('move must use the selected move channel'); } };
    w.inputMoveChannel = { readyState: 'open', bufferedAmount: 0, send() { mono = 110; } };
    w.socket = { connected: false, id: 'socket' };
    const reservation = input.prepareLabInput('mouse', 'move', { relX: .5, relY: .5 });
    const current = () => ({ scope: w.latencyScope(), leaseId: 'lease', streamId: 'video',
      pc: w.pc, live: w.captureControlledTransportSnapshot() });
    m.setScope(current().scope);
    m.beginControlledInputEvidence({ inputId: reservation.inputId, leaseId: 'lease',
      scope: current().scope, streamId: 'video', inputType: 'mouse', action: 'move' });
    assert.equal(input.dispatchPreparedLabInput(reservation), reservation.inputId);
    wall += wallStep; mono = 210;
    w.acceptObservedInputAck({ schemaVersion: 2, inputType: 'mouse', status: 'applied',
      inputIds: [reservation.inputId], leaseEpoch: 4 },
      { transport: 'datachannel', dataChannel: reliable });
    const row = m.readControlledInputEvidence(reservation.inputId, current());
    assert.equal(row.send.viewerClockMs, 110);
    assert.equal(row.ack.viewerClockMs, 210);
    if (traceUnavailable || wallStep !== 0) assert.equal(input._unorderedTraceSends.size, 0);
    m.clearControlledInputEvidence(reservation.inputId);
    trace.dispose();
  });
}
```

Run the same existing native-latency scoped Node command from Step2 for RED/GREEN, then Task2's finite regression suite. These are future pure fake-platform tests; this drafting turn runs none of them. The negative variants reuse the same fixture but change only actual ACK source/ID or move bufferedAmount before real dispatch; never invoke a model that bypasses real send/ACK methods.
- [ ] **Step 5: Record GREEN and finite regression.** Run the scoped native-latency tests, then `node --test web-client/js/input.test.js web-client/js/webrtc.test.js web-client/js/webrtc.frame-trace.test.js`. Existing clock/ACK ordering tests remain authoritative; do not weaken them. Proposed owned commit `feat(diagnostics): capture controlled transport and ack boundaries`; obtain two independent reviews.

## Task 3: Strict numerical bridge and safe artifact projection

**Files:** existing runtime module and its test file. Reuse `scripts/turn_controlled_scene.py` without edits. No imports of Host/native modules and no real Lab/network calls in these new tests.

**Interfaces:** produce NativeLatencyContext, evaluate_native_latency_step(..., action_id:int, phase:str), native_latency_artifact(...); extend FixtureBroker with optional keyword-only stream_id=None. Require finalized=true/non-PENDING evidence. Result and safe projection must carry exactly sendViewerClockMs/ackViewerClockMs/postApplyViewerClockMs/visibleViewerClockMs; safe ordinals are exactly phaseOrdinal/inputOrdinal/scopeOrdinal/leaseOrdinal, counters are exactly observationCounters.{duplicateAcks,invalidObservations}, and reason values are exactly the spec StepReason union. Later adapter supplies actual producer streamId and WorkStep.phase; neither is guessed from a track ID/type/action.

- [ ] **Step 1: Add a fixed complete in-memory test fixture and failing numerical test.** Use the test file's existing proof()/layout() helpers; construct fresh dicts on every test to permit mutation cases.

```py
def native_rows():
    import hashlib, json
    identity = {"attemptId": "attempt", "generation": 2, "streamId": "video"}
    reservation = {"inputId": "lab_inp_1", "leaseId": "lease", "leaseEpoch": 4,
                   "type": "mouse", "action": "down", "payload": {"relX": .5, "relY": .5}}
    action = {key: reservation[key] for key in ("type", "action", "payload")}
    digest = hashlib.sha256(json.dumps(action, sort_keys=True, separators=(",", ":"),
                                      ensure_ascii=True).encode()).hexdigest()
    send = {"inputId": "lab_inp_1", "viewerClockMs": 100, **identity}
    ack = {"inputId": "lab_inp_1", "status": "applied", "viewerClockMs": 160, **identity}
    post = {"inputId": "lab_inp_1", "viewerClockMs": 200, **identity,
            "captureSeq": 10, "rtpTimestamp": 900, "wireTimestamp": 900,
            "rtpOrigin": 50, "traceStatus": "matched", "captureFresh": True,
            "captureAfterApplied": True}
    evidence = {"schemaVersion": 1, "state": "COMPLETE", "reason": "none",
                "inputId": "lab_inp_1", "leaseId": "lease",
                "scope": {"connectionAttemptId": "attempt", "generation": 2, "leaseEpoch": 4},
                "streamId": "video", "beganAtMs": 90, "deadlineAtMs": 10090,
                "remainingMs": 9790, "finalized": True, "expired": False,
                "send": send, "ack": ack, "postApply": post,
                "hostTiming": {"hostAdapterAwaitMs": 20, "hostQueueMs": 3, "hostApplyMs": 12},
                "observationCounters": {"duplicateAcks": 0, "invalidObservations": 0}}
    receipt = {"inputId": "lab_inp_1", **frame(tick=1, action_id=101), "focused": True,
               "realm": "lab-run", "runId": "run-1", "streamId": "video"}
    visual = {"marker": {"runNonce": 7, "sceneId": 3, "tick": 1, "actionId": 101},
              "viewerClockMs": 240, **identity, "captureSeq": 11,
              "rtpTimestamp": 1000, "wireTimestamp": 1000, "rtpOrigin": 50,
              "traceStatus": "matched"}
    claim = {"inputId": "lab_inp_1", "status": "claimed", "actionDigest": digest}
    return reservation, evidence, claim, receipt, visual

def test_native_latency_strict_bridge_keeps_metrics_and_frame_keys_separate():
    reservation, evidence, claim, receipt, visual = native_rows()
    context = runtime.NativeLatencyContext(proof(), layout(), "video")
    result = runtime.evaluate_native_latency_step(context, reservation=reservation,
        evidence=evidence, claim=claim, receipt=receipt, visual=visual, action_id=101, phase="down")
    assert result["status"] == "PASS"  # synthetic pure calculation, no native acceptance
    assert result["sendToAckMs"] == 60
    assert result["inputToPostApplyFrameMs"] == 100
    assert result["sendToVisualMs"] == 140
    assert result["sameFrame"] is False
    assert result["hostApplyMs"] == 12
    assert result["sendViewerClockMs"] == 100
    assert result["ackViewerClockMs"] == 160
    assert result["postApplyViewerClockMs"] == 200
    assert result["visibleViewerClockMs"] == 240
    assert result["ackViewerClockMs"] - result["sendViewerClockMs"] == result["sendToAckMs"]
    assert result["postApplyViewerClockMs"] - result["sendViewerClockMs"] == result["inputToPostApplyFrameMs"]
    assert result["visibleViewerClockMs"] - result["sendViewerClockMs"] == result["sendToVisualMs"]
```

- [ ] **Step 2: Record RED.** `python3 -m pytest -q scripts/test_turn_controlled_scene_runtime.py -k native_latency`. Expected missing NativeLatencyContext/evaluator before implementation.
- [ ] **Step 3: Implement strict bridge and report projection.** First validate exact schema/types/caps/finalized state, current lease/scope and transient actionDigest/claim/broker identity. Reject PENDING/finalized=false as evidence-unfinalized with null durations. Copy the four original event timestamps into the declared result fields before projection; never read Python time or recover clocks from raw dictionaries later. Project the four exact evaluator schemas and call evaluate_scene_result without loosening it. Null unsuccessful durations and discard provisional arrays on failure. Keep M2/visible FrameKeys distinct. Missing Host timings stay null. Extend broker optional stream binding with legacy unchanged; native mode requires it. Emit the exact fixed ordinal/counter names; map errors only to the finite StepReason values, following the spec's precedence. No recursive dictionary dumping or arbitrary exception strings.

```py
# Required reuse, after exact projection and guard/broker checks:
strict = evaluate_scene_result(
    context.proof, execution_mode="automatic-isolated", input_ids=[input_id],
    send_samples=[send], ack_samples=[ack], producer_samples=[producer],
    visual_samples=[visual_row],
)
# Publish numerical values only after the required strict and M2 gates pass.
# Preserve separate postApply/visible identities; never upgrade M2 to a marker.
```

All identifiers in this reuse block are exact local projections from the function arguments, with the schema and validation order specified above. Durable source identity must distinguish checked-out source fallback from a real build; absent/unverified identity is null/incomplete, never synthesized from the supplied draft revision.

- [ ] **Step 4: Add mutation/privacy/schema tests.** Remove/mutate send, ACK, current lease, claim ID/digest, broker realm/run/nonce/layout/action/focus/stream; change finalized=true to false or state to PENDING; replace canonical video with track ID; mutate marker/nonce/scene/tick/action and wire/RTP/origin/capture scope; inject provisional numbers on a failing strict result. Unknown fields, booleans as ints, invalid clocks, duplicate IDs/oversized arrays fail. Assert exact key sets for NativeLatencyStep and SafeNativeLatencyStep, exact reason membership, exact four ordinal names and exactly duplicateAcks/invalidObservations counters. Build a safe artifact from the positive result and assert all four original clock fields remain100/160/200/240 and reproduce60/100/140 deltas after projection. Verify stable first-seen ordinal reuse, distinct scope/lease ordinal changes and counts summing to attempted. Same-frame and distinct-frame identities stay separate. Privacy canaries for text/coordinates/token/URL/arbitrary error/source object never serialize. Test >91 rows, size cap, unverified source/build, and fixed NOT_RUN fields. Synthetic PASS assertions remain in temporary memory and do not publish native evidence.
- [ ] **Step 5: Record GREEN.** Run the scoped command, then `python3 -m pytest -q scripts/test_turn_controlled_scene_runtime.py scripts/test_turn_controlled_scene.py`. Proposed commit `feat(diagnostics): evaluate private controlled latency evidence`; obtain two reviews.

## Task 4: Wire the existing lifecycle adapter/driver and private output mode

**Files:** existing lifecycle runner and its focused tests. No Lab Signal/Host/guard/admission changes. Existing legacy T5 defaults and consumers remain unchanged.

**Interfaces:** adapter produces the same five v2 methods, including ID-bound finalizing read/remaining budget/completion poll/clear. Each read computes fresh scope/lease/canonical frame/PC and the no-argument live snapshot; LatencyMonitor selects the candidate from its immutable slot already validated against actual send, not Python/trace action hints. ExecutableLabDriver.run(*,native_latency:NativeLatencyContext|None=None) and existing output selector remain unchanged.

- [ ] **Step 1: Add RED tests for the current gap.** Extend existing fake adapter/Run/Broker tests with the exact five adapter methods, stream-bearing receipt and Task3 rows. Record calls: bind/producer preparation/begin before dispatch; ACK/claim/receipt/visual waits share original remaining allowance; independent completion poll follows them; its finalizing read precedes strict evaluation; clear runs last for every step and exception. Assert no legacy ACK monkeypatch in native mode. Refused dispatch yields no invented send/success, attempts finalizing read with dispatch-refused, then clears; failed drag retains its original safety release. Preserve the legacy default and91-step workload tests.

```py
def test_native_latency_driver_clears_observation_after_refused_dispatch():
    calls = []
    class Adapter:
        def prepare_lab_input(self, _step): return native_rows()[0]
        def begin_controlled_input_evidence(self, _reservation): calls.append("begin"); return True
        def dispatch_prepared_lab_input(self, _reservation): calls.append("dispatch"); return None
        def read_controlled_input_evidence(self, _input_id, *, finalize=False, terminal_reason=None):
            assert finalize is True and terminal_reason == "dispatch-refused"
            calls.append("finalize-refusal")
            return None
        def clear_controlled_input_evidence(self, _input_id): calls.append("clear")
    class Run:
        def bind_controlled_input(self, **_fields): calls.append("bind")
    class Producer:
        def prepare_native_action(self, _action_id): calls.append("prepare-native")
    class Broker:
        def reserve(self, **_fields): calls.append("reserve")
    context = runner.NativeLatencyContext(proof(None), layout(None), "video")
    result = runner.ExecutableLabDriver(lab_run=Run(), viewer=Adapter(), producer=Producer(),
        broker=Broker(), fixture_id="fixture").run(native_latency=context)
    assert result["status"] != "PASS"
    assert calls == ["reserve", "bind", "prepare-native", "begin", "dispatch", "finalize-refusal", "clear"]
```

In this test file define its own `native_rows()` fixture with the exact Task3 row content (do not import test modules), because each task must be independently readable. The existing proof(None)/layout(None) helpers already ignore their identity argument. The adapter intentionally has no ACK/native/visual methods: a correct driver cannot call them after dispatch refusal.

- [ ] **Step 2: Record RED.** `python3 -m pytest -q scripts/test_turn_controlled_scene_lab_runner.py -k native_latency`. Expected absent native_latency run argument/adapter evidence calls.
- [ ] **Step 3: Implement page adapters, shared budget and callable finalization.** Reads pass actual Input lease, WebRTC scope/canonical frame/PC and fresh captureControlledTransportSnapshot() with no action argument; Python never supplies substitute action metadata or Viewer measurement time. Capture private Python monotonic call-start+10s before begin; do not renew it. remaining_seconds takes the minimum of this conservative allowance and the page's original remainingMs/1000. Pass this remaining budget to existing native-mode ACK/claim/receipt/visual timeout parameters. Native ACK waiting reads the slot, not an unbounded monkeypatch array. After visual wait, call wait_for_controlled_input_completion exactly once; it uses existing external polling <=100ms or remaining budget, adds no JS timer/listener and performs a fresh-fence ID-bound finalize=true read when complete/terminal/expired. No PENDING/unfinalized result reaches the evaluator. Other v2 producer/static/workload/refusal/cleanup contracts remain unchanged.

```py
began = False
terminal_reason = None
cleanup_errors = []
try:
    began = self.viewer.begin_controlled_input_evidence(reservation)
    if not began:
        raise RuntimeError("controlled-evidence-unavailable")
    dispatched = self.viewer.dispatch_prepared_lab_input(reservation)
    if dispatched != input_id:
        terminal_reason = "dispatch-refused"
        raise RuntimeError("viewer-lab-input-dispatch-refused")
    ack = self.viewer.wait_for_applied_ack(input_id,
        timeout_seconds=self.viewer.controlled_input_remaining_seconds(input_id))
    claim = self.lab_run.wait_for_controlled_claim(input_id,
        timeout_seconds=self.viewer.controlled_input_remaining_seconds(input_id))
    receipt = self.broker.wait_for_receipt(input_id,
        timeout_seconds=self.viewer.controlled_input_remaining_seconds(input_id))
    visual = self.viewer.wait_for_decoded_visual(input_id, step.action_id,
        timeout_seconds=self.viewer.controlled_input_remaining_seconds(input_id))
    evidence = self.viewer.wait_for_controlled_input_completion(input_id)
    result = evaluate_native_latency_step(native_latency, reservation=reservation,
        evidence=evidence, claim=claim, receipt=receipt, visual=visual,
        action_id=step.action_id, phase=step.phase)
except Exception:
    terminal_reason = terminal_reason or "observation-error"
    raise
finally:
    if terminal_reason is not None:
        try:
            self.viewer.read_controlled_input_evidence(input_id, finalize=True,
                                                      terminal_reason=terminal_reason)
        except Exception:
            cleanup_errors.append("observation-error")
    # Clear is ID-bound and harmless if begin did not occupy this exact slot.
    try:
        self.viewer.clear_controlled_input_evidence(input_id)
    except Exception:
        cleanup_errors.append("observation-error")
```

The finalizer independently attempts clear even if finalizing read throws, preserves the first terminal_reason and records cleanup_errors separately. Any cleanup_errors downgrades the step/run to INCOMPLETE with observation-error unless an earlier fixed reason already exists; a previously calculated PASS cannot survive it. Include cancellation separately with terminal_reason=cancelled. All zero-remaining calls return timeout/missing evidence immediately without issuing new requests. The waits above remain actual current driver calls with remaining timeout arguments. This ID-bound clear also covers partially failed begin. Apply the original drag safety release once under its unchanged condition.

- [ ] **Step 3a: Add pure completion-poll tests before wiring the success branch.** Use a fake Page.evaluate returning the actual slot-shaped records and a deterministic external monotonic clock; track evaluations and waits. Required cases: marker wait finishes while M2 missing, first poll PENDING, late M2 join while original budget remains, final read COMPLETE/finalized=true with original callback time; no M2 through deadline, final read INCOMPLETE/post-apply-missing/expired=true; already terminal source error; wrong input ID; dispatch refusal; begin partially raising; read raising; clear raising; cancellation. In every case assert beganAtMs/deadlineAtMs are unchanged, every wait <=remaining allowance, at most one completion-poll invocation per step, final read uses the same ID and fresh live snapshot, and the exported status is never PENDING. Fake evaluator does not run product input. Inspect/exercise the exact browser read expression through existing VM code paths as part of Task5; do not replace its source-fence semantics with a fake boolean.

```py
# Required assertion pattern for the deterministic missing-M2 fixture:
assert exported["finalized"] is True
assert exported["state"] == "INCOMPLETE"
assert exported["reason"] == "post-apply-missing"
assert exported["expired"] is True
assert exported["deadlineAtMs"] == original_deadline_at_ms
assert all(delay <= remaining for delay, remaining in recorded_external_waits)
assert installed_browser_timers == installed_browser_listeners == 0
```

The test fixture defines these variables from its recorded fake page/runner operations; they are assertions about actual adapter behavior, not a production telemetry API. No live browser is launched. The successful late-M2 fixture likewise asserts finalized COMPLETE and unchanged original rVFC time, with no renewed10s deadline.

- [ ] **Step 4: Implement artifact selection/private atomic write.** Native output mode calls only the safe projection writer/print path, including all early BLOCKED/error branches. Default legacy output stays byte/schema compatible. New private writer uses fixed-key projected JSON, same-directory exclusive temp file mode0600, bounded serialized length, fsync/replace and cleanup; no stale PASS after failure, no fallback to raw transcript. Print only projected JSON or a fixed bounded failure category. Source fallback has buildId null and explicit source provenance; no inferred build. No native gate/CLI boolean changes.
- [ ] **Step 5: Test BLOCKED/serialization/lifecycle with fakes only.** Use existing run_automatic_scene's real current BLOCKED behavior, never a substituted PASS. Either desktop flag, headed producer or artifact selector still leaves dispatch0/native NOT_RUN and no measurement rows. Assert caps/0600/replace failures/stale protection/fixed errors/cleanup and no raw legacy output. Page-evaluate tests check fresh live snapshots on intermediate and final reads, exact finalize/terminalReason arguments, wrong-ID preservation and no Date.now/input side effects or installed timers/listeners. Actual send/ACK/rVFC behavior remains Task2's real VM-loaded code. No browser/native/startup/socket/HTTP/port probe.
- [ ] **Step 6: Record GREEN.** Run scoped native tests, then select the existing pure legacy/driver/serialization tests in this file; inspect test bodies before broadening because this file also contains loopback HTTP tests. Proposed commit `feat(diagnostics): connect controlled latency lifecycle reporting`; obtain two reviews.

## Task 5: Cross-boundary pure verification and versioned status

**Files:** only prior-task test paths and the precise repository documentation named above. No further production change without returning the finding to its original task owner.

**Interfaces:** exact finalized JSON ControlledEvidence from actual VM-loaded product methods must be accepted by the actual pure Python evaluator, without timestamp/identity repair. Four original clocks, ordinals/counters/reasons keep the v2 schema unchanged. Controlled source choice must remain independent of InputTrace availability and wall-clock action-hint pruning.

- [ ] **Step 1: Add a bounded cross-language regression.** In the existing Node fixture run real accepted send, real ACK validators and production rVFC callback with fake PC/video/clock. Perform the exact ID-bound finalizing read with fresh live snapshots, then feed that actual JSON to the pure Python evaluator via one bounded execFileSync timeout5000/maxBuffer131072. Include WorkStep.phase explicitly. Four raw event times must remain unchanged through Python step and safe artifact and reproduce the three deltas. Fake claim/producer records are explicitly synthetic; no native report is published. Negative cases: canonical stream/wire mismatch, missing send after move suppression, unfinalized evidence, late M2 within original deadline, missing M2 at deadline, sources rotating after all observations before finalization and former reliable-channel unordered ACK. Callback100 joined800 retains100. Use root's existing interpreter, no installation/network setup.

```js
const { execFileSync } = require('node:child_process');
const program = [
  'import json, sys',
  'sys.path.insert(0, "scripts")',
  'from turn_controlled_scene_runtime import NativeLatencyContext, MarkerLayout, evaluate_native_latency_step',
  'from turn_controlled_scene import ProducerProof',
  'row = json.load(sys.stdin)',
  'ctx = NativeLatencyContext(ProducerProof(**row["proof"]), MarkerLayout(**row["layout"]), "video")',
  'print(json.dumps(evaluate_native_latency_step(ctx, **row["arguments"]), allow_nan=False))',
].join('\n');
const result = JSON.parse(execFileSync('python3', ['-c', program], {
  cwd: path.resolve(__dirname, '../..'), input: JSON.stringify(bridgeInput),
  encoding: 'utf8', timeout: 5000, maxBuffer: 131072,
}));
```

bridgeInput is assembled from actual finalized VM evidence and explicit synthetic proof/layout/claim/receipt/visual plus phase. It uses dataclass snake_case keys, never timestamp/identity repair. This one test-only child runs a pure evaluator. If future execution policy excludes it, report integration NOT_RUN. This v3 drafting turn executes none of it.

- [ ] **Step 2: Run one final appropriate offline matrix.** After all affected focused checks pass, run `node --test web-client/js/latency-monitor.test.js web-client/js/input.test.js web-client/js/webrtc.test.js web-client/js/webrtc.frame-trace.test.js` and `python3 -m pytest -q scripts/test_turn_controlled_scene_runtime.py scripts/test_turn_controlled_scene.py`; run only inspected pure lifecycle tests for Task4. Do not sum overlapping suite counts, do not run a lifecycle CLI or HTTP tests to fill this table. Record exact revision, command, result and limitations. Expand/repeat only for new failures or changes.
- [ ] **Step 3: Sync truthful documentation.** Requirement note: collector wiring/offline verification complete at actual commit; no target supplied and native/visible/physical and ordinary-production input acceptance remain NOT_RUN. Preserve old failed/incomplete run history. Report actual send/API acceptance vs ACK receipt, M2 post-apply vs content marker, measured Host stages, missing joins, report/window/sample scope and target dependency. Include scoped source review, RED/GREEN, explicit no-live-operations and unchanged native guards. Do not certify150–200ms, optical timing, a physical keyboard or full usability from synthetic fixtures.
- [ ] **Step 4: Final independent whole-increment review.** Root gives exact final diff/spec/plan to a fresh reviewer, then resolves findings with original owners and repeats affected scoped reviews/tests. Verify no InputTrace/ACK/lease/media policy change, no new capability/native bypass, no raw-data serialization/new output on legacy path, exact source/clock/stream projections and one-slot cleanup on all failures. Only after completion version the final implementation/status record; proposed documentation subject `docs: record controlled latency collector offline readiness`.
- [ ] **Step 5: Hand back the remaining resource dependency once.** Offline-ready collector does not close native acceptance. An independently isolated Mac/macOS guest, native lifecycle probe/capture alignment and actual finite run are separate work. Keep the pending resource request open without reasking the unavailable user or manipulating production ordinary sessions. Root chooses subsequent work based on the actual resource answer.

## V3 scoped self-review and retained P2 mapping

| Spec requirement | Task coverage |
|---|---|
| One slot/time/budget/privacy/no observer authority | 1,2,3,4 |
| Actual API success, skipped move, fallback, current ACK entry/source | 2 |
| P2-1 live selected-send/reliable-ACK/current socket object+ID at ACK and final read, including after-completion rotations | 1,2,4,5 |
| Original rVFC/M2 and CRC/T3 distinctions, canonical stream | 1,2,3,4,5 |
| P2-2 exact original send/ACK/M2/visible clocks, ordinals/counters/finite StepReason, strict evaluator and null gaps | 3,5 |
| P2-3 ID-bound finalizing read and original10s completion poll for independent late M2; no browser timer/listener | 1,4,5 |
| New safe output, legacy compatibility, private bounded atomic write | 3,4 |
| Isolation/native guards unchanged and no active-run interference | all tasks; final review5 |
| Truthful runtime/resource NOT_RUN and versioned review | 5 |
| V2-fix1 trace-action dependency: immutable reserved type/action + actual send and fresh finite live candidates; trace unavailable/Date.now jumps/negative controls | 1,2 Step4a; no trace/authority changes |

Scoped self-check: the existing snapshot method has no trace/action argument; it captures only the two finite live send candidates and current reliable ACK/Socket/PC. Matching immutable slot metadata, checked against genuine accepted send, selects the branch inside the existing observer; unknown ID/suppressed send/wrong source still cannot qualify. Actual-method trace-unavailable and Date.now±60000 tests preserve Performance times without editing InputTrace or authority. Original three P2 fixes, fixed schemas, finalization/deadline/privacy and isolated-target prerequisites remain. No generic lookup/callback/router API was added. V3 independent scoped rereview remains required.

No work in this plan was executed. Root must reconcile private historical source context with the current checkout before any versioned handoff. No new question or execution authority arises from this collector task.
