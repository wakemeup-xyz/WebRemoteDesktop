# Controlled native latency collector wiring — design draft v3

**Repository checkpoint:** v3 draft/offline wiring scope independently approved; not implemented or deployed. Original draft provenance/NOT_RUN limits below remain. Root source holds cited in drafting background are historical; no runtime authority follows from this document.
**Planning status: v3 draft/offline wiring independently approved; implementation, deployment and live acceptance remain pending.** 2026-10-18. V1 provenance is source `e684ca494613ba93a7b491042922cf43e97cef31`; v2 used root-supplied c802/bb581/dfb context. The latest private review reports the source hold released, planning source c54 and a separate runner-fix owner; Viewer remains c802/bb581. These are supplied historical context, not independently checked Git/runtime facts. The actual baseline ended failed-or-indeterminate; this draft does not explain, qualify or overwrite it. This revision reads private drafts/review only, writes new private v3 drafts, and performs no repository/source/package writes, tests, project imports, runtime/process/network/browser/service/native operations or implementation. V1/v2 stay unchanged.

V2's three original P2 fixes remain intact. V3 changes only the trace-action dependency identified in `/tmp/wrd-native-latency-collector-drafts-v2-fix1-review-20261018.md`: the controlled slot's immutable reserved type/action, validated against actual accepted send, selects the fresh live source candidate. InputTrace metadata availability and Date.now never select or qualify this evidence. Source-line references are historical and require current-source reconciliation at implementation handoff.

Proposed eventual repository paths: `docs/superpowers/specs/2026-10-18-native-latency-collector-design.md`, matching implementation plan under `docs/superpowers/plans/`, and a scoped review/execution record under `docs/superpowers/reports/`. Root must version and independently review them after the current frozen-source diagnosis/runtime work; this draft grants no implementation or live-test start.

## Process, objective and boundary

This is one bounded integration increment across existing interfaces, with architectural documentation because it crosses the browser/Python evidence boundary. It applies superpowers:brainstorming and superpowers:writing-plans, read from `/Users/macstudio1/.codex/plugins/cache/superpowers-dev/superpowers/6.3.0/skills/`. Repository AGENTS.md explicitly authorizes completing context checks, options, spec and plan without repeated section approval; the root request restricts this task to drafts. No user question is necessary.

**Objective:** make the existing controlled-scene lifecycle capable of producing a bounded, privacy-safe numerical record from genuine accepted Viewer transport send, a current applied-ACK arrival on the same Viewer clock, the existing post-apply capture binding, a real producer event, and a CRC marker decoded from a matched RTP/rVFC frame. Complete the collector wiring with pure tests; do not implement the missing native GUI isolation environment.

The actual target remains unresolved. Preserve `turn_lab_host.py:_local_fixture_probe`, `run_automatic_scene` and all existing proof, lease, reset, rebind, media and native guard conditions. The ordinary recovery and fresh three-hour continuity runs retain their fixed `businessInput/visibleEffect/physical=NOT_RUN`. This increment cannot inject business input into them, add a fake capability, change input replay/transport decisions, or call a shared WindowServer app an isolated OS target. Native, visible and physical runtime acceptance remains NOT_RUN/BLOCKED until a separately reviewed target owner exists. The existing asynchronous resource question stays pending; do not ask it again.

## Source facts that constrain the design

All references are one-based, relative to the source root.

- `Input.recordLatency` already records real IDs through `LatencyMonitor.recordInputSend` after successful wrappers, but its time is read after trace/commit work (`web-client/js/input.js:348–425`, `:2575–2612`). It is useful M1 aggregate telemetry, not a raw per-action numerical export.
- `WebRTC.sendInput` deliberately returns true for a congested mouse move without calling `channel.send` (`web-client/js/webrtc.js:5078–5080`). A successful dispatch return therefore cannot prove actual submission. Add observation immediately after the actual `channel.send` at `:5087–5091`; preserve the early return.
- Socket submission happens in `Input.sendKeyboardSocket` and `_sendInput` (`input.js:395–403`, `:2581–2612`). Neither a prepared reservation nor the time before calling emit is the accepted-send boundary.
- `WebRTC.acceptObservedInputAck` invokes C validation before M1 and trace (`webrtc.js:1302–1342`). Capture the arrival clock at entry, but accept evidence only after existing validation. Preserve stale/future-sequence rejection and C → M1 → trace ordering. The native-evidence hook is observational and runs before the final trace.
- DataChannel ACKs arrive on the reliable input channel even when a mouse move was sent on input-move (`webrtc.js:5022–5024`, `:5070–5072`; `python-host/host.py:2854–2859`). The observer must record expected ACK source separately from actual send source; demanding they are the same object would reject valid moves.
- InputTrace hashes IDs, uses trace-relative/boot-scoped time, samples high-frequency events and owns incident deadlines (`input-trace.js:164–178`, `:245–264`, `:468–485`, `:518–565`). Its public snapshots are unsuitable for lossless raw joins. Do not change it or derive raw evidence by unhashing IDs/adding relative clocks to wall clocks.
- LatencyMonitor is the existing passive bounded owner (`latency-monitor.js:1–131`). Its M1/M2 pending ledger and metric windows remain unchanged. Its monotonic `clock()` is a processing high-water mark (`:37–41`); feeding a previously captured ACK time after validation/scope synchronization could reject it. The new optional raw observation slot keeps event time separate from processing/expiry time.
- Basic M2 already returns a matched new capture after applied input with original rVFC time (`webrtc.js:6263–6277`; `latency-monitor.js:185–203`). Detailed marker evidence is separately produced by `FrameTraceCollector.takeControlledVisualEvidence` (`webrtc.js:315–328`). Neither implies physical photons.
- Collector stream identity is canonical `video` (`webrtc.js:6216–6221`), while `PlaywrightLabViewerAdapter.viewer_session_identity` can return a browser track ID (`scripts/turn_controlled_scene_lab_runner.py:534–548`). Do not equate these namespaces. Use currentFrameTraceIdentity and retain the existing verified receiver/track/SSRC mapping (`webrtc.js:6253–6260`).
- The lifecycle adapter stores ACK ID/status only (`turn_controlled_scene_lab_runner.py:377–403`), and `aggregate_action_evidence` checks presence but computes no duration (`scripts/turn_controlled_scene_runtime.py:172–187`). The strict existing `evaluate_scene_result` requires exact row schemas, identity, nonce/action/tick and wire/RTP matching, then computes Viewer-clock sendToAck/sendToVisual (`scripts/turn_controlled_scene.py:400–530`). Reuse it.
- The legacy T5 transcript includes synthetic text, action payload and coordinates (`turn_controlled_scene_lab_runner.py:137–145`). It cannot be copied into a new privacy-safe latency artifact. Preserve the legacy format/consumers while adding an explicit alternative output projection.

## Alternatives

| Approach | Assessment |
|---|---|
| Extend LatencyMonitor with one explicitly reserved raw-evidence slot; observe actual transport/validated ACK/M2 boundaries; bridge to strict evaluator | **Selected.** Reuses the existing observer, needs no listeners/timers/new framework and preserves production delivery. |
| Poll InputTrace or five-second metric snapshots, or timestamp Python dispatch/ACK polling | Rejected: hashed/sampled IDs, different clock epochs, processing delay and overlapping windows cannot establish exact same-clock boundaries. |
| Install runner monkeypatches/subscriptions around Input send/ACK and add a parallel collector | Rejected: duplicates existing validation/measurement ownership, misses skipped moves or exact transport boundaries, and risks unbounded hooks/lifecycle cleanup. |

## Required behavior

1. **Genuine accepted send.** Only successful return from an actual `RTCDataChannel.send` or connected Socket.IO `emit('input', envelope)` can record a send event, with `performance.now()` captured immediately afterward, before trace/sequence observation. This proves local API acceptance, not network delivery. Throws, refusal, buffered-move early return, preparation and source/lease changes produce no successful send observation. DC refusal followed by socket success yields one socket record with the original input ID.
2. **Current applied ACK.** Capture `performance.now()` at the entry to the current `acceptObservedInputAck` call; preserve it across C/M1 work. Record only a v2 applied ACK with exactly the reserved input ID and matching input type, lease epoch, actual current source, socket identity if relevant and scope. Reliable events require the existing C result applied and exact sent sequence/appliedSeq for this single-input collector. Unordered moves require an actual observed send plus the current reliable ACK channel, current scope/lease and applied status; they do not acquire reliable sequence authority. Duplicate, stale, rejected, wrong-source, old-scope, future-sequence, unknown-ID and late observations never create a successful numerical sample. Do not require ACK arrival to precede video arrival.
3. **Exact scope and live source fence.** Compare `{connectionAttemptId,generation,leaseEpoch}`, current lease ID and canonical stream at reservation, send, ACK and every read/export. Capture actual selected send source, expected reliable ACK source, applicable socket object/ID and current PC in memory at actual send. At ACK validation and final read compare them with a newly captured live transport snapshot, not only the incoming source or saved references. For DC, the current selected channel for the reserved type/action and current reliable inputChannel must still be the saved send/ACK sources; for a move these can be two different objects. For Socket.IO, current socket object **and** current socket ID must match the saved values; selected send/reliable ACK source are that same live socket. Incoming ACK source must also equal the saved **and still-current** reliable ACK source. Any applicable source/object/ID change invalidates the slot with sticky source-changed, even after all observations were collected or C's unordered path cannot supply reliable ownership. Lease ID is an in-memory fence, not a field added to the wire ACK. These checks never change product ACK validation or authority.
4. **Bounded observation and finalization.** At most one controlled input slot, lifetime 10000 ms from begin, <=8192 serialized metadata bytes, no new timer/listener/network action. Store immutable beganAtMs/deadlineAtMs once; reads cannot renew them. Refuse a second begin while a slot is occupied. Never evict business pending items to make room. Reads/observations expire it; scope change cancels it. Records have an explicit terminal reason and nullable missing fields, not fabricated zero times. Exact duplicate ACK observations are counted/ignored; contradictory duplicate send/ACK rows invalidate the slot. One runner-owned completion poll waits for independent late M2 joining within that same deadline, then performs an explicit ID-bound finalizing read. Clear in a driver per-step finally, including dispatch refusal, partial begin and exceptions. No exported PENDING/unfinalized evidence is acceptable.
5. **No product effect.** Disabled/no slot means constant bounded no-op. Every hook is exception-isolated. A collector failure may fail its own evidence but cannot change input return value, original exceptions, queue/sequence/ACK processing, lease, reset or media. Do not route business control through collector methods. Existing M1 aggregates and their semantics stay unchanged.
6. **Privacy.** Project metadata before retaining it. No payload, text, code/key value, coordinates, clipboard, DOM, screenshot/pixels, credentials, URLs, IPs or arbitrary exception messages. Source/PC references are held only in the one in-memory slot and never serialized. The new report uses exactly the per-run input/scope/lease/phase ordinals defined below and counts/durations; it never dumps the raw slot, reservation, claim, broker receipt or legacy transcript. Memory and durable metadata caps are not RSS guarantees.
7. **Independent metrics.** Applied-ACK RTT, Host queue/apply/adapter-await, post-apply-frame RTT and content-causal marker RTT remain separate. Missing Host fields stay null. No RTT/2, cross-machine wall-clock subtraction, subtraction of adapter time to label network, percentile addition or optical claim. New raw `sendToAckMs` measures actual ACK-entry arrival; it is not silently substituted into existing M1's processing-time five-second summaries.

## Browser interfaces and data flow

Extend `createLatencyMonitor` in the existing file; add no new global/module/framework. These APIs observe evidence only and never authorize or send input:

```ts
type Scope = { connectionAttemptId:string; generation:number; leaseEpoch:number };
type ControlledReservation = {
  inputId:string; leaseId:string; scope:Scope; streamId:'video';
  inputType:'mouse'|'keyboard'; action:string;
};
type LiveTransportSnapshot = {
  pc:object|null;
  datachannel:{selectedMoveSendSource:object|null;selectedReliableSendSource:object|null;
    reliableAckSource:object|null};
  socket:{selectedSendSource:object|null;reliableAckSource:object|null;
    object:object|null;id:string|null};
};
beginControlledInputEvidence(reservation:ControlledReservation): boolean;
observeControlledSend(
  meta:{inputId:string;leaseId:string;leaseEpoch:number;inputType:string;action:string;seq:number|null},
  context:{scope:Scope;streamId:'video';transport:'socket'|'datachannel';
    sendSource:object;ackSource:object;socketId:string|null;pc:object|null;
    live:LiveTransportSnapshot;viewerClockMs:number}
): boolean;
observeControlledAck(
  ack:object,
  context:{scope:Scope;leaseId:string;streamId:'video';transport:'socket'|'datachannel';
    source:object;socketId:string|null;pc:object|null;live:LiveTransportSnapshot;viewerClockMs:number;
    verdict:'reliable-applied'|'unordered-applied'}
): boolean;
readControlledInputEvidence(inputId:string,
  current:{scope:Scope;leaseId:string;streamId:'video';pc:object|null;live:LiveTransportSnapshot},
  options?:{finalize?:boolean;terminalReason?:'dispatch-refused'|'observation-error'|'cancelled'}
): ControlledEvidence|null;
clearControlledInputEvidence(inputId:string): void;
```

Input IDs, attempt IDs and lease IDs follow the existing printable-ASCII128 bound; scope uses nonnegative safe integers. Reserve only an existing prepared Lab input ID; inputType/action are immutable in the slot and use current finite enums excluding command/reset. observeControlledSend must match that exact ID/type/action against the genuine accepted-send projection before retaining it. A slot without such a send cannot qualify an ACK. Sequence is null for move and otherwise the actual positive envelope sequence. Canonical stream comes from currentFrameTraceIdentity().

The already proposed narrow snapshot method becomes `WebRTC.captureControlledTransportSnapshot(): LiveTransportSnapshot` with no action argument and no new getter/callback/framework. In one synchronous read it captures the two existing finite product channel candidates: selectedMoveSendSource (current mouse-move selection) and selectedReliableSendSource (current non-move selection), both under current selection/quarantine rules; plus current reliable inputChannel, current Socket object/ID and PC. It does not send or alter eligibility. The observer privately selects selectedMoveSendSource **only** when its matching reserved slot has inputType=mouse/action=move; otherwise selectedReliableSendSource. Actual transport=socket selects the existing socket branch. This is a fixed snapshot of the two current channel paths, not an extensible router or action authority. If a tiny selection helper is extracted for consistency, retain current product behavior and selected-channel quarantine tests. For an accepted Socket.IO path, object/source references and a bounded nonempty ID are mandatory; null cannot qualify. Unused candidate branches changing do not invalidate a slot using a different branch.

At ACK, first match the reserved ID and its already validated accepted send; use only that slot's immutable inputType/action to select the applicable fresh source candidate. The wire inputType must match the slot; a different action projection at send invalidates it. Do not call Input.peekInputAckMetadata, read _unorderedTraceSends, use an action from InputTrace, or accept a caller-supplied replacement action to choose the controlled source. Existing product/trace metadata calls remain unchanged for their existing purposes. Unknown ID/no accepted send means no controlled ACK evidence, without acquiring authority. The same immutable-slot selection applies on every final read; the adapter passes a fresh no-argument snapshot. InputTrace unavailable, hint eviction or Date.now±60000 cannot remove or alter this slot or its Performance timestamps. Internal references/snapshots never leave the slot.

```ts
type ControlledEvidence = {
  schemaVersion:1; state:'PENDING'|'COMPLETE'|'INCOMPLETE'; reason:string;
  inputId:string; leaseId:string; scope:Scope; streamId:'video';
  beganAtMs:number;deadlineAtMs:number;remainingMs:number;
  finalized:boolean;expired:boolean;
  send:{inputId:string;viewerClockMs:number;attemptId:string;generation:number;streamId:string}|null;
  ack:{inputId:string;status:'applied';viewerClockMs:number;attemptId:string;generation:number;streamId:string}|null;
  postApply:{inputId:string;viewerClockMs:number;attemptId:string;generation:number;streamId:string;
    captureSeq:number;rtpTimestamp:number;wireTimestamp:number;rtpOrigin:number;
    traceStatus:'matched';captureFresh:true;captureAfterApplied:true}|null;
  hostTiming:{hostAdapterAwaitMs:number|null;hostQueueMs:number|null;hostApplyMs:number|null};
  observationCounters:{duplicateAcks:number;invalidObservations:number};
};
```

COMPLETE means the send/current applied ACK/M2 post-apply fields are present, not native or visible acceptance. The browser reason enum is exactly `none`, `not-sent`, `ack-missing`, `post-apply-missing`, `scope-changed`, `lease-changed`, `source-changed`, `clock-invalid`, `expired`, `conflicting-observation`, `metadata-cap`, `dispatch-refused`, `observation-error`, `cancelled`. Both counters are nonnegative safe integers saturated at Number.MAX_SAFE_INTEGER; exact duplicate ACKs increment duplicateAcks, rejected/malformed/conflicting observations increment invalidObservations, and neither allocates a row. Missing values remain null.

Read options default to finalize=false. A wrong ID returns null without modifying the occupied slot, deadline or finalization. Every matching-ID read rechecks current scope/lease/PC and the live selected-send/reliable-ACK/socket fence before returning data. Intermediate missing observations yield PENDING/finalized=false while time remains. `finalize:true` is ID-bound, freezes an exportable terminal projection, and sets finalized=true: COMPLETE/none only when all required fields arrived and this read occurs before the original deadline with every fence valid; otherwise INCOMPLETE. First sticky identity/clock/conflict/budget error wins; otherwise explicit terminalReason wins; otherwise missing-stage precedence is not-sent → ack-missing → post-apply-missing; if all fields exist but finalizing read missed deadline, reason=expired. The expired flag records processing-now >= deadlineAtMs even when a missing-stage reason is more informative. At the deadline, missing M2 therefore finalizes INCOMPLETE/post-apply-missing/expired=true. A later observation cannot repair finalized/expired evidence. Repeated matching reads may recheck and downgrade an existing completed projection if the live fence is no longer valid; they never grant a fresh deadline. Export accepts only finalized=true and non-PENDING.

Observation methods never call setScope to repair mismatches. Raw event timestamps are finite nonnegative Performance timestamps <= processing-now; validate order against send, but do not feed an earlier stored event timestamp through LatencyMonitor's processing clock() high-water mark. Zero is valid. `remainingMs = max(0,deadlineAtMs-processingNow)` comes from that same Viewer clock and is a polling budget, not a measurement or a new timer.

`Input` socket writers call `observeControlledSend` with a small explicit metadata projection. `WebRTC.sendInput` calls it only after actual channel.send, passing the selected send channel and current reliable ACK channel separately. These hook calls are inside local try/catch that cannot swallow original send failures. Capture timestamp directly after API success, then construct/call observation. Existing recordLatency/trace order and return values remain.

At entry to acceptObservedInputAck capture raw Performance arrival time and current scope/lease/source/PC without product mutation. After C and existing M1 dispatch capture the fresh no-argument snapshot and call the controlled hook. It matches the reserved ID/actual accepted send and selects the live candidate using only immutable slot type/action. In the unordered early-return branch call it after existing M1 unordered processing, requiring incoming source === saved expected ACK source === current reliableAckSource, plus saved selected send === the candidate selected by immutable slot type/action. The M1 scope ledger and trace hint are neither source ownership nor action provenance. Snapshot/read failure invalidates this evidence without affecting product handling. Trace remains last; InputTrace clocks/sampling/hints and C/KeyboardTransport validators/authority remain unchanged. Sparse M2 correlation likewise receives no action from InputTrace.

Existing `LatencyMonitor.onPostApplyFrame` additionally copies only a valid matched current M2 row into the reserved slot. Preserve captureFresh/captureAfterApplied, captureSeq/wire/RTP and the original callback time. It may arrive before ACK; store it independently and finalize after all observations. The basic sparse collector stays independent of detailed tracing.

## Python bridge and producer identity

Add functions to existing `scripts/turn_controlled_scene_runtime.py`:

```py
@dataclass(frozen=True)
class NativeLatencyContext:
    proof: ProducerProof
    layout: MarkerLayout
    stream_id: str  # exact currentFrameTraceIdentity stream, currently "video"

def evaluate_native_latency_step(context: NativeLatencyContext, *,
    reservation: Mapping[str, Any], evidence: Mapping[str, Any] | None,
    claim: Mapping[str, Any] | None, receipt: Mapping[str, Any] | None,
    visual: Mapping[str, Any] | None, action_id: int, phase: str) -> dict[str, Any]: ...

def native_latency_artifact(*, source_identity: Mapping[str, str],
    lifecycle_status: str, lifecycle_reason: str,
    step_results: list[Mapping[str, Any]], workload_complete: bool) -> dict[str, Any]: ...
```

The step evaluator first validates all raw schemas/caps, current reservation/evidence lease and scope, Host claim ID/status and actionDigest against the actual transient action, and the broker's already-validated nonce/realm/run/layout/action receipt. Add optional keyword `stream_id: str | None = None` to FixtureBroker; legacy callers retain behavior, native-latency mode requires a nonempty canonical stream and rejects receipts missing/mismatching it. Pass actual streamId in configure_loopback_producer's identity; do not add it retrospectively to a receipt that never carried it.

Then project exact existing `_SEND_FIELDS`, `_ACK_FIELDS`, `_PRODUCER_FIELDS`, `_VISUAL_FIELDS` (no schema relaxation) and call `evaluate_scene_result(..., execution_mode='automatic-isolated', input_ids=[id], ...)`. A successful numerical step requires that strict result PASS plus complete M2 post-apply evidence. Invalid clocks/missing ACK/native evidence fail the step; missing/mismatched wire joins produce UNALIGNED, never a visible value. If the existing evaluator returns provisional latency arrays alongside any failure, discard them: all successful numerical fields in the public step result remain null unless the required corresponding gate passes.

Keep frame semantics separate. M2 post-apply first-frame capture and the marker's T3 capture can legitimately differ because an application can repaint later. Preserve both FrameKeys and times; do not relabel M2 as marker evidence or force them to share captureSeq. `sameFrame` is true only if attempt/generation/stream/captureSeq/wire/time all match. M2's fresh/after-applied claim applies only to its own FrameKey. Marker causality is established by the real guarded input, reserved producer action, novel nonce/action/tick CRC and matched T3 frame. Do not claim a Host captureFresh flag for the T3 row when it is absent. No detailed trace, no valid receiver/SSRC association, bad CRC or unavailable rVFC yields null/UNALIGNED; this increment does not repair detailed first-offer trace capability or alter media packets.

The in-memory step result has exactly these fields; no artifact projection may recover clocks from undeclared raw dictionaries:

```ts
type StepReason = 'none'|'evidence-missing'|'evidence-unfinalized'|'not-sent'|'ack-missing'
 |'post-apply-missing'|'scope-changed'|'lease-changed'|'source-changed'|'clock-invalid'
 |'expired'|'conflicting-observation'|'metadata-cap'|'dispatch-refused'|'observation-error'
 |'cancelled'|'claim-missing'|'claim-mismatch'|'producer-missing'|'producer-mismatch'
 |'marker-missing'|'marker-mismatch'|'wire-unaligned'|'strict-evaluation-failed';
type NativeFrameKey = {attemptId:string;generation:number;streamId:string;captureSeq:number;
  rtpTimestamp:number;wireTimestamp:number;rtpOrigin:number};
type NativeLatencyStep = {
  status:'PASS'|'INCOMPLETE'|'FAIL'|'UNALIGNED'; reason:StepReason;
  inputId:string;leaseId:string;scope:Scope;streamId:'video';actionId:number;
  phase:'wheel'|'down'|'move'|'up'|'focus-down'|'focus-up'|'text';
  sendViewerClockMs:number|null;ackViewerClockMs:number|null;
  postApplyViewerClockMs:number|null;visibleViewerClockMs:number|null;
  sendToAckMs:number|null;inputToPostApplyFrameMs:number|null;sendToVisualMs:number|null;
  hostAdapterAwaitMs:number|null;hostQueueMs:number|null;hostApplyMs:number|null;
  postApplyFrame:NativeFrameKey|null;visibleFrame:NativeFrameKey|null;sameFrame:boolean|null;
  observationCounters:{duplicateAcks:number;invalidObservations:number};
};
```

Carry original accepted-send and ACK-entry times unchanged into sendViewerClockMs/ackViewerClockMs, and original M2/marker rVFC times into postApplyViewerClockMs/visibleViewerClockMs. When all relevant gates pass, subtraction of the first timestamp from each corresponding timestamp must reproduce all three deltas exactly. Null clock inputs cannot manufacture a duration. Known valid raw scalar event times may remain for audit when a later non-clock gate fails, but all invalid/unverified clocks and all unsuccessful duration values are null. Reasons are selected by fixed validation order: browser terminal evidence → claim → producer/broker → marker → wire → strict evaluator. Arbitrary evaluator failure strings/exceptions map to the finite reason above rather than pass through. Extra fields reject the result schema.

## Lifecycle adapter and output

Extend existing PlaywrightLabViewerAdapter with these exact methods:

```py
begin_controlled_input_evidence(reservation: Mapping[str, Any]) -> bool
read_controlled_input_evidence(input_id: str, *, finalize: bool = False,
    terminal_reason: str | None = None) -> Mapping[str, Any] | None
controlled_input_remaining_seconds(input_id: str) -> float
wait_for_controlled_input_completion(input_id: str) -> Mapping[str, Any] | None
clear_controlled_input_evidence(input_id: str) -> None
```

Use real current scope/lease/frame identity and a newly captured no-argument live snapshot on every read; do not pass Viewer measurement time or substitute action metadata from Python. Keep the original prepared ID/type/action privately in the adapter and immutable reservation in LatencyMonitor; the monitor selects its candidate from that reservation, already matched to accepted send. A different ID cannot finalize/clear it. Before begin capture external Python monotonic call-start+10s; this conservative bound and original Viewer deadline never reset. remaining_seconds is the minimum of that allowance and page remainingMs/1000, clamped0; it schedules polling and is not cross-clock latency arithmetic.

Native-mode ACK waiting uses nonfinal slot reads instead of the legacy unbounded monkeypatch array. ACK/claim/receipt/visual waits consume the same remaining allowance via their existing timeout parameters. After visual evidence, call exactly one wait_for_controlled_input_completion. That method repeatedly performs a synchronous page read, using the existing external page-read/poll cadence (<=100ms or remaining budget, whichever is smaller), until COMPLETE, a terminal error, or the original deadline. It installs no JS timer/listener and calls no send/recovery methods. If complete, terminal or out of budget, its last page evaluation performs an ID-bound finalize=true read with a fresh live snapshot; no PENDING result leaves the method. A timely late M2 binding can therefore fill the slot after the marker wait; missing M2 at the deadline becomes the deterministic missing-stage reason. No wait buys a second10s. If a page evaluation cannot return under the outer lifecycle allowance, record unavailable/incomplete and use existing owned cleanup; do not call that a hard process deadline guarantee.

On dispatch refusal, exception or cancellation, attempt the same ID-bound finalizing read with terminal_reason dispatch-refused/observation-error/cancelled before clear; if the page is unavailable, create only a fixed incomplete result with null absent clocks. Always attempt ID-bound clear in finally, even after partial begin. Cleanup failure is visible and never a PASS.

Extend ExecutableLabDriver.run(*, native_latency: NativeLatencyContext | None = None). Without context, preserve the existing T5 path and schema. With context, retain prepare → bind → producer-action preparation → begin observation → genuine dispatch → ACK/claim/receipt/visual waits under the remaining slot budget → completion poll → ID-bound finalized read → strict evaluation, clear in finally. Reject PENDING or finalized=false at the Python bridge as evidence-unfinalized with null durations. Retain existing safety-release semantics and full exact_workload; do not invent a one-action/full-workload PASS. The raw reservation/action is transiently needed for binding/digest verification and is not copied into the native-latency result.

Add `--artifact-kind {legacy,native-latency-v1}` to the existing lifecycle CLI, default legacy. This is an output/observation selector, **not** an isolation/capability flag. Native-latency output mode writes and prints only `native_latency_artifact`; it never writes/prints the legacy transcript containing raw synthetic payloads. All static/native preflight/Host arm gates stay ahead of dispatch unchanged. Current native preflight remains BLOCKED, with zero dispatches, no rows and all measurements null. No new CLI to turn a probe true or to claim ordinary ownership.

Native artifact has exactly this top-level shape (names are fixed; `rows` has <=91 phase records because the existing workload expands to 91 steps):

```ts
{
  schemaVersion:1,
  sourceIdentity:{sourceCommit:string|null,sourceFilesSha256:string|null,
    sourceMode:'source-fallback'|'built'|'unknown',buildId:string|null},
  executionMode:'automatic-isolated',
  lifecycle:{status:'BLOCKED'|'INCOMPLETE'|'FAIL'|'PASS',reason:string},
  measurementBoundary:'viewer-api-accepted-to-original-rvfc',
  counts:{attempted:number,complete:number,incomplete:number,unaligned:number,failed:number},
  rows:Array<SafeNativeLatencyStep>, workloadComplete:boolean,
  nativeQualification:'NOT_RUN'|'INCOMPLETE'|'FAIL'|'PASS',
  physical:'NOT_RUN', ordinaryProductionInput:'NOT_RUN'
}
```

Counts are saturated nonnegative safe integers: attempted=len(rows); complete counts status PASS; incomplete/unaligned/failed count INCOMPLETE/UNALIGNED/FAIL respectively. Their sum equals attempted for this <=91-row artifact. The phase argument is the current WorkStep.phase; it cannot be inferred from type/action because focus-down/down and focus-up/up are different declared phases.

SafeNativeLatencyStep has exactly NativeLatencyStep's status/reason/actionId/phase, four named Viewer clock fields, three named Viewer deltas, three Host stages, postApplyFrame/visibleFrame, sameFrame and observationCounters; replace inputId/leaseId/scope/streamId with exactly `phaseOrdinal`, `inputOrdinal`, `scopeOrdinal`, `leaseOrdinal` (positive safe integers1..91). phaseOrdinal is ordered work-step position; inputOrdinal assigns by first-seen inputId; scopeOrdinal assigns by first-seen full Scope plus canonical stream; leaseOrdinal assigns by first-seen leaseId plus leaseEpoch in that scope. No hashes/extra label fields are added. Each nullable postApplyFrame/visibleFrame is projected to exactly `{scopeOrdinal,captureSeq,rtpTimestamp,wireTimestamp,rtpOrigin}`, removing attemptId/generation/streamId; scopeOrdinal already denotes the generation and stream scope. Both observation counters retain their exact names and saturation rule. No input content, raw nonce/source/socket/proof identities or binding action enters this projection. Retain synthetic action numbers and scalar frame correlation values only. Source identity comes from a root-verified source-file manifest or actual build identity, never draft text or a caller's unverified commit label. Existing LabIdentity alone supplies no source commit/build proof; if no verified source manifest is provided by the later target lifecycle, main uses all-null/unknown identity and qualification stays INCOMPLETE/NOT_RUN. Source fallback has buildId null. This collector increment does not invent source/build provenance or add a capability flag to fill it.

Cap serialized artifact at 131072 bytes. Output private files atomically with mode0600 using a sibling temporary file; failure cannot leave a stale PASS or fall back to raw transcript. Do not print arbitrary exceptions. Do not aggregate per-step p95 values or combine five-second snapshots; this increment reports per-phase observations and counts only. Any later workload-level percentile must be computed from that workload's own valid unique samples with its method/window explicitly recorded.

## Error policy and acceptance

No environment/guard: BLOCKED, no input, no raw observations, native/visible/physical NOT_RUN. Missing clock/ACK/producer claim: INCOMPLETE or FAIL for the specific observed gate, durations null. Missing wire association: UNALIGNED, visible null. An observer exception preserves business behavior but makes its own evidence incomplete. Scope loss is sticky for that slot; later frames/ACKs cannot repair it. Artifact-write failure is visible and cannot become a successful result.

Offline completion requires actual unchanged product send/ACK/rVFC methods exercised with fake transports/browser/clock and all scoped pure suites passing; independent spec and quality reviews; and no source/timing/authority change outside the allowlist. Tests may assert calculated numbers from synthetic fixtures but must label them offline and must not persist/publish native PASS. Real target, real native/visible pilot, physical keyboard/device and optical performance remain separately unmeasured. Do not start a Lab/Host/browser just to demonstrate the known environment BLOCKED state.

## Files and remaining resource dependency

Modify only `web-client/js/latency-monitor.js`, `input.js`, `webrtc.js`; their existing focused test files; `scripts/turn_controlled_scene_runtime.py`, `scripts/turn_controlled_scene_lab_runner.py`; their existing tests; and the spec/plan/report plus precise requirement note. Reuse `turn_controlled_scene.py` unchanged. No changes to native adapter/guard, Lab admission/server/Host, ordinary runner, shared supervisor, dist, tunnel, credentials, services, codec/FPS/quality or dependency configuration.

Root can version/review this bounded spec/plan, implement the pure wiring after F operations, and run assigned offline tests without resolving target availability. The target identity/access route is the load-bearing external dependency for any native execution; current evidence establishes neither an assigned Mac nor a disposable macOS guest. No extra maintenance approval is needed and no further user question belongs to this collector increment. A future target-owner subproject must satisfy the existing isolated desktop/capture/input identity contract before any native operation.

## V3 scoped self-review and retained P2 mapping

P2-1 retained: LiveTransportSnapshot is required on send/ACK/read; immutable reserved type/action selects one of the fresh finite channel candidates, then saved/current selected-send/reliable-ACK/Socket object+ID and incoming ACK source must agree. Completed-slot rotation and former-channel unordered ACK tests remain.

P2-2: NativeLatencyStep explicitly declares sendViewerClockMs, ackViewerClockMs, postApplyViewerClockMs and visibleViewerClockMs; SafeNativeLatencyStep carries them unchanged. All ordinal and counter names and the finite StepReason enum are enumerated. Positive and projection tests reproduce the three deltas; no undeclared raw dictionary is available to the artifact builder.

P2-3: Existing fifth browser read API now has ID-bound finalize options and fixed terminal precedence. The adapter completion poll and all native waits share original began/deadline and a conservative external bound, with no browser timer/listener or renewed lifetime. Finalizing read freshly checks live fences; the bridge rejects unfinalized/PENDING evidence. Tests cover timely late M2, missing-M2 timeout, wrong-ID finalization and refusal/exception cleanup.

V2-fix1 P2: eliminated the pre-validation trace-action requirement and the snapshot action argument. The existing snapshot method now returns only the two fixed live channel candidates plus reliable ACK/Socket/PC; the matching slot's immutable inputType/action, validated at actual send, chooses the applicable candidate inside the existing observer. No new observer API, trace lookup, callback or generalized routing layer. Task2 adds actual-method trace-unavailable and Date.now±60000 cases with original Performance times; wrong source, unknown ID and suppressed send still fail. All other schema, finalization/deadline and privacy contracts are unchanged.

No source changes, imports, implementation or tests were performed. This is private scoped contract self-review only; v3 independent rereview, implementation authority and runtime evidence remain outstanding.
