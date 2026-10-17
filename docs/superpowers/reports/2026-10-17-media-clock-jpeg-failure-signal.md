# JPEG pause/resume failure: signal and relay boundary diagnosis

2026-10-17,Asia/Shanghai(+08:00). Private read-only analysis of /tmp/wrd-public-media-clock-jpeg-20261017a. No source/index/Git/runtime/service/tunnel/network/browser/probe/native-input operation. Two pure contract validators were invoked locally with synthetic envelopes; no live messages. Only this report is written0600.

## Outcome and bounded session association

FAIL at post-recovery-not-healthy after69.744991s/69samples,0missing. Real Start/pause/resume UI, current suspend ACK, new active generation2 ACK and fresh resumed frame/input gate all passed; resume completed4.010156s after UI request. Required60s stable follow-up did not pass. This is not a failure to receive the resume ACK or an initial stale-origin rejection. No business input, clipboard, terminal, native commands, physical/visible-effect or ordinary reconnect acceptance was performed.

No JPEG start byte-offset checkpoint exists. The summary's final mtime is12:42:09.422770, and elapsed69.744991s suggests an approximate shell-run beginning12:40:59.678; that subtraction includes script/setup/cleanup and is NOT a recorded exact start. Log extraction used a conservative envelope12:40:55–12:42:22, then narrowed by the real admitted Viewer and lifecycle: bootstrap12:41:05.484/07.166, Host Viewer-online12:41:08.108, Signal same-viewer connection-attempt binds12:41:08.905/17.303/20.863. One unique Host TUNNEL_RELAY_STATS Viewer scope in12:41:08–12:42:09 exactly matches the one unique Signal bound Viewer scope, compared in memory without persisting raw identities. This excludes the previous300s TURN run, whose grace cleanup ended before this envelope. Later twelve-second grace-tail observations are labelled cleanup context, not the initiating failure.

Primary sources are summary/samples, /tmp/signal-server.log and primary /Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log; connector/watch logs are time-filtered to the same envelope. Current worktree source was read only for mechanism/contract interpretation.

## What failed before cleanup

Post-recovery sample0 at browserNow20225ms is healthy/current,gateallowed,relayload38,feedback3. Through sample40(browser60224ms) frames progressed to96 and feedback35, gateallowed, keyboard READY withlastSent0/pending0. At samples41–44 image age increases while socket remains connected, lease/current media origin remain valid and keyboard remains READY0/0.

Final sample45 at browser65226ms: last qualified current-origin image load60025.6ms,age5200.4ms; last feedback received60023.6ms,age5202.7ms,feedbackSequence35. Current relay expected/rendered scope, lease and desired generation2 all still match, and active/applied media ACK remains current. Frame sequence96/load callback96 have stopped progressing. UI becomes media-stalled, media gatefalse,inputAllowedfalse; first-new-frame proof is cleared. Navigator remains online, document visible/focused. Socket connect counter1/disconnect0,proofRejected0,superseded0 throughout the live observations. This is image/feedback freshness failure with connected signaling state, not a sampled Socket disconnect.

Last feedback is a historical snapshot, not continuously refreshed server state: it showedpending1,oldestPendingAge493ms,lastAckAge553ms,timeoutCount1/coalesced29 at its own receive time. Do not treat those ages as still current5.2s later. The simultaneous loss of both a nonvolatile feedback update and image load suggests a shared producer/send/forward/scheduling boundary is worth examining; it does not by itself identify TCP or network loss.

The summary reports cleanup.ownedBrowserClosed=true and failure acceptance-condition-not-met. Summary was already committed12:42:09.423. Signal's eventual close12:42:13.168 is later, so it cannot be substituted for the first pre-cleanup image freshness failure. Conversely an input reset submitted before cleanup may only be processed/logged later; the logged time alone does not identify its submission cause.

## Host continued work, with load/backpressure deterioration

Same-viewer Host relay stats describe completed aggregate intervals, not exact per-frame arrival at Signal/Viewer:

| Host wall time | Relay behavior |
| --- | --- |
|12:41:14.124|medium,4.0fps,21sent/19acked,avg worker encode54.8ms,max in-flight2|
|12:41:31.882|medium,2.6fps,13sent/13acked,avg172ms|
|12:41:32.607|low profile,reason ACK latency1301ms|
|12:41:38.760|low,1.0fps,7sent/8acked,avg453ms|
|12:41:42.103/.603|survival640x360/2fps,one slot,backpressure/ACK latency1546ms|
|12:42:00.716|survival,1.3fps,7sent/7acked,avg113.8ms|
|12:42:08.354|loop snapshot:relayRunning=true,JPEG worker inFlight1,pending0|
|12:42:09.079|survival,0.6fps,5sent/5acked,avg worker encode1050.5ms,pending1|

The final aggregate proves the producer completed some work up to that interval boundary; it does not prove a frame or feedback was emitted at each instant of the last5.2s, reached Signal, survived volatile forwarding, or loaded in the Viewer. Host sent counters increment after its Socket.IO emit returns, which is not a receiver delivery ACK. RelayJpegProcessor.encodeMs encloses MSS grab, image conversion and JPEG save in the worker; it is not pure JPEG codec time or queue/transport duration.

Host loop rolling max rises to333.028ms by12:42:08,missedSampleCount0; JPEG worker repeatedly appears in-flight during this run. System load increases fromabout24to62before failure, with higher values afterward; these are host-wide load samples, not proof which process/thread was responsible. Resource snapshots approach staleness(age9246ms at12:42:08), and system swap-rate fields are not process-specific. No5s global Host event-loop block is recorded, but the worker/native call can remain pending while that loop still schedules. A window percentile cannot rule out unmeasured worker blocking.

Current producer source explains a narrow blind spot: host.py RelayStreamer._run calls emit_feedback_if_due at the top of its SAME async loop, then awaits worker.submit_latest and awaits frame Socket.IO emit. Feedback has a1s minimum cadence but no independent heartbeat worker. A long JPEG worker/emit await can therefore pause both image production and feedback without disconnecting signaling or blocking the whole Host loop. Current logs do not split worker queue/native grab/conversion/JPEG/emit await for the offending interval. Signal forwards frames via viewerSocket.volatile.emit, while relay-frame-feedback uses ordinary emit; shared downstream backpressure could also affect them. No per-frame/feedback emit-receive trace is persisted to choose between these alternatives.

## Server heartbeat, close and connector evidence

One time-matched WRD_SIGNAL_HEARTBEAT record at12:42:13.168 reports engine transport-error,current/prooftrue,duration65060ms,pc/pf/pr2/2/2. Last pingCreated age14957ms,pingInFlush14956ms,pongReceived14559ms; no heartbeat deadline was due at close. Coverage partial/post-admission,engine=true,no invalid values/scan limit/counter clipping. Ring contains all six heartbeat events, with successful second pc/pf/pr around50s of admitted observer lifetime. pc means created,pf means batch inclusion BEFORE send,pr means received pong; none is proof of JPEG delivery.

Close-captured WebSocket writable=false,bufferLength1. Existing Node snapshot at that close:statusok,age384ms,count57,last/max lag2725ms,p95lag192ms,missed2. This is material real Node scheduling/backpressure context, but it is a rolling close-time snapshot several seconds AFTER the pre-cleanup failure artifact. It does not prove the entire earlier5.2s gap was caused by Node, and close-time writable/buffer state cannot be projected backward. Closing an already departing browser can itself cause transport errors/writes to fail. Raw error descriptions are not persisted, so TCP/peer/shutdown subcause remains unknown.

Signal grace starts12:42:13.169; lease-expired cleanup12:42:21.307; Host Viewer0/resources release12:42:21.404–406. These late events are cleanup. Host continues reporting relay work/backpressure after the browser is gone, with expected later ACK timeouts; do not count those post-cleanup timeout observations as the initial media cause.

No connector edge loss/re-registration/error is logged in12:40:55–12:42:22. Existing watcher12:41:28 saysorigin_ok1/formal_ok1/actionnone. Lack of connector error plus one HTTP success does not prove uninterrupted WebSocket delivery. No active DNS/TCP/protocol probe was performed. The prior TURN run/old edge incidents are not used as explanations here.

## Confirmed M6 reset reason contract defect

The source chain is deterministic: webrtc.js:4746 armRelayFreshnessTimer invokes invalidateRelayInputProof('relay-frame-stale') once image age>=5000; that method4646 invokes Input.setActive(false,{resetKeyboard:true,reason}). input.js2293/2332 calls resetKeyboard(reason)->keyboardController.reset(reason); remote-keyboard-controller.js198 forwards to transport.resetBarrier(reason); keyboard-transport.js278–294 sends keyboard reset payload{reason} unchanged. Signal remote-input-contract.js RESET_REASONS:17–22 and Host remote_keyboard_state.py _RESET_REASONS:19–24 are matching strict allowlists; BOTH exclude relay-frame-stale and relay-start.

This run's source attribution is stronger than a late server timestamp: post-recovery ticks0..44 keyboard READY,lastSent0,pending0; tick45 simultaneously setsframeStale=true and keyboard RESET_REQUIRED,lastSent1,pending1 while socketDisconnect remains0. Thus the reset was already submitted by the stale path before harness cleanup. Signal later logs12:42:12.784 rejection keyboard/reset/seq1/leaseEpoch7,reasonINVALID_RESET_REASON. The wire reason string itself was not persisted in that log, but the observed transition and inspected producer directly support the stale producer; no initial/resume reset was outstanding in the prior44samples. The current reset contract rejects that producer in both endpoints.

Exact production validation boundary: the registered Signal input handler in signal-server/websocket/signaling.js:1394 calls validateRemoteInput(data) for schemaVersion2; the keyboard reset branch in signal-server/lib/remote-input-contract.js:164–165 checks RESET_REASONS.has(payload.reason), returns INVALID_RESET_REASON, and signaling.js:1397–1400 emits signal_input_rejected then returns before Host forwarding. The generic mouse reset regex branch at contract.js:108–110 is a different protocol path and does not make these keyboard reasons legal. A reset that bypassed Signal through another allowed transport would still reach Host host.py:2530 apply_keyboard -> input_handler.py:129–145 (projects the strict protocol fields) -> RemoteKeyboardState.apply at remote_keyboard_state.py:227–230 -> validate_remote_input at143/188–193; the same missing reason is rejected before keyboard application/sequence advance. In this observed Socket path Signal rejected it, so no matching Host reset application is expected or proven.

Ordering check: setUiPhase(media-stalled) runs first but its syncChromeCapabilities only renders Chrome capability state; it does not call Input.setActive or syncDesktopInputGate. The following invalidateRelayInputProof therefore retains the explicit resetKeyboard:true deactivation path. If a different callback already deactivated Input, its separate inactive-with-pressed-keys/RESET_REQUIRED fallback can also forward the same unsupported reason. These are distinct local producer branches, both requiring wire reason normalization while retaining diagnostic attribution.

Temporal limitation: browser final sample proves local reset admission/submission and pending state BEFORE the harness finally closes its browser; it does not timestamp Socket.IO wire flush, Signal receipt or Host execution. No matching raw payload was persisted. The same-viewer/sequence1 Signal rejection, first reset appearing exactly at the stale threshold, and zero earlier post-recovery reset sequence jointly support this stale producer. The12:42:12.784 server log is a handling/logging timestamp; it cannot establish a cleanup-triggered submission, nor quantify the transit/queue delay from that timestamp alone.

Pure actual-validator calls with synthetic valid v2 keyboard envelopes confirm: relay-frame-stale and relay-start -> INVALID_RESET_REASON in both Signal and Host; deactivated and transport-change -> accepted in both. No live input was sent.

Smallest appropriate repair: keep the precise M6 UI/trace diagnostic reason (relay-frame-stale or relay-start), while mapping the safety keyboard wire reset to an existing allowed reason such as deactivated. This is input deactivation, so deactivated is semantically closer than transport-change. Cover BOTH paths in invalidateRelayInputProof, including its explicit resetKeyboard fallback when already inactive. Avoid globally substituting all reset reasons. The alternative is a coordinated Signal+Host protocol allowlist expansion with parity/regression tests, but that adds unnecessary cross-end rollout coupling for a local diagnostic reason. Do not simply weaken validation or alter ACK/lease/scope fencing.

Tests for a later fix should drive actual stale current-origin timer -> actual Input/KeyboardTransport -> real Signal+Host pure validation and match current reset ACK; preserve fail-closed gate until fresh current image and required reset ACK. Also cover relay-start invalidation, duplicate stale timer/old origin, inactive-with-pressed-keys branch and no business input. This review performs no fix or deployment.

The defect explains why stale-triggered keyboard safety reset cannot complete and can obstruct subsequent recovery. It does NOT explain the first missing image/feedback interval: the threshold gap existed before this reset was generated. Preserve that cause as UNKNOWN.

## Smallest remaining diagnosis boundary

Need one bounded same-session monotonic summary around the existing JPEG worker/emit/feedback loop: submit/start/finish/loop-resume, frame emit await start/return, feedback due/emit start/return plus safe per-origin sequence/count at existing Signal forwarding. Reuse already-owned worker and loop boundaries, do not add screenshots/payloads/coordinates/raw IDs or a broad new observer. Until those boundaries are measured, neither capture/native JPEG work, loop scheduling, emit queue/TCP backpressure nor downstream delivery is individually proven as the initiating5.2s cause. Fix the confirmed reset reason incompatibility separately; keep the original JPEG continuity FAIL and historical signaling FAIL visible.
