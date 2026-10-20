# Final branch integration review

## Findings

### [P2] Restore the documented enclosing relationship between Host timing stages

Location: `python-host/input_timing.py:9–11`, with producer `python-host/input_admission_queue.py:59,90` and enclosing timer `python-host/host.py:2371–2391` (unchanged in candidate `5b4baca`).

When an input waits behind another entry in M3's Host admission queue, `InputTiming` inherits that earlier admission timestamp through `input_queued_ns`. Its `hostQueueMs` therefore includes the outer Host queue. In contrast, `hostAdapterAwaitMs` starts only after that queue dequeues the input, immediately before `apply_keyboard` / `handle_input`. The exported queue substage can consequently exceed its documented enclosing total. This conflicts with total spec §6.2 and media spec §3's adapter-entry → adapter-return total and internal queue/apply substages, and produces misleading latency decomposition precisely under load.

Focused counterexample used the actual AST-extracted Host admission/execution/ACK methods, real `InputAdmissionQueue` and `InputTiming`, a fake monotonic clock and a fake native adapter. Input 2 entered at 10ms, waited until 100ms, then applied for 10ms. Its real ACK was `{hostAdapterAwaitMs:9.999999999999995, hostQueueMs:90, hostApplyMs:10}`. No Host/native modules, real timer, capture, input, network or service were started.

Fix: preserve the accepted contract by starting `hostQueueMs` at adapter entry, excluding the outer admission wait from that substage. If outer admission latency is deliberately exposed instead, use a separately specified field/total and update the shared contract and consumers; do not silently broaden the existing substage or relabel `hostExecuteMs`. Add an integrated queued-input timing regression asserting the chosen enclosure and boundaries, including nonzero outer wait. The current documentation must remain consistent with the actual exported interval.

### [P2] Publish freshness when a verified fresh frame is actually joined

Location: `web-client/js/latency-monitor.js:181–192`; producer adapter `web-client/js/webrtc.js:5435–5438` at frozen `e5e086d` (`consumeInputFrameMatches`; shifted by the unrelated W4b fix at final candidate).

M2 provides a strictly validated same-scope binding for a successful input and a new capture, matched to an actual rVFC timestamp. The adapter consumes that row only through `onPostApplyFrame`, which records `inputToPostApplyFrameMs` but never updates `freshAt`. The sole freshness setter is the generic `recordStage('freshFrameAgeMs', ...)`, and it has no production caller. Consequently the diagnostic freshness gauge remains unavailable even after valid new-capture presentation evidence exists. Keeping unassociated paint/Host timing unavailable is correct, but the implemented successful association also never makes the specified gauge available (media spec §3.2 and M4.3).

Focused counterexample loaded the real `LatencyMonitor`, `WebRTC.ensureInputFrameCollector`, `FrameTraceCollector.observeVideoFrame` / `acceptBinding`, and `consumeInputFrameMatches` in an offline VM. A send at 10ms, actual callback at 100ms and valid late binding at 800ms yielded `inputToPostApplyFrameMs={last:90,count:1,lastSampleAgeMs:700}` while `freshFrameAgeMs={last:null,count:0,available:false}`. Changing the attempt correctly kept the new scope unavailable. This verifies a missing success hook, not a demand to fabricate freshness for ordinary uncorrelated frames.

Fix: consume the validated fresh capture identity and its original Viewer callback time to update the gauge. Preserve the original 100ms timestamp (700ms age at this join), deduplicate captureSeq within the appropriate stream/scope, and do not let reused/older/late previous-scope rows refresh it. Pause and scope change must clear it; unassociated paint, ACK, frame_timing and unknown evidence remain unavailable. Cover these cases through the real collector/adapter path.

## Verdict

**Needs fixes for two new P2 integration defects. No new P0/P1 finding identified in this broad review.** The known M5/W4b R1 findings are not repeated here. M5 repair `36dec3a`, W4b repair `5b4baca`, and I1 fixture repair `9a8bf3a` were read for their integration effects; no additional blocking issue was found in those deltas. Their task-specific scoped reviews remain separate evidence owned by the root coordinator.

Reviewed range: frozen `b6bd0c1..e5e086d`, including imported prior related fixes `2a2c5ff`, extended by the exact final deltas through `5b4baca`. This is a selective whole-branch integration/architecture review, not a claim that every line of the approximately 1.5MB packet received independent task-level re-review.

## Architecture and documentation

- Control authority remains centralized in Signal's lease state and Host's revision/binding snapshots. The shared admission queue waits for native work before reset; Viewer recovery retains current-identity reset/media gates. M/W observation does not grant control. No second recovery controller or automatic network/path/quality downgrade was found in the reviewed changes.
- The media flow preserves selected capture provenance through worker awaits and cache fallback, commits causality only after successful RTP send, and retains the original rVFC timestamp for late joins. The missing freshness hook and mismatched Host timing ownership above are the two cross-layer measurement defects.
- Web entry work keeps typed authentication failure separate from proxy/network failure, bounds request/body waits, verifies current/retained hashed assets before publication, and records build identity. Watcher observation/deadline/state ownership is separate from owned recovery work; unknown completion remains fenced. No watcher or tunnel action was performed during this review.
- Runtime observation uses allowlisted bounded snapshots/queues and current versus peak RSS separately. Diagnostic persistence uses one bounded receipt/retention interface and server redaction, with explicit loss metadata. The new adaptive policy path remains unconfigured/disabled until matching local qualification; `36dec3a` fences the real legacy apply helper against stale C authority and preserves full-window resource failure evidence.
- Documentation generally reflects the implemented ownership and explicitly separates offline checks from deployment and real acceptance. The Host stage contract mismatch is also a documentation-sync defect until corrected. README/runbook/requirements/execution-rollup edits currently owned by the root are not treated as already committed or as completed deployment evidence. Historical planning banners point to the execution report; this review does not mark I2 complete.

## Evidence and limits

Read the total spec/plan, Global Constraints, I1 matrix, progress rulings, relevant M/C contracts, selected task reviews and execution report; inspected changes by Signal/Host/Viewer/asset/watch/observability ownership boundaries. Reviewed imported continuity changes together with the later C tasks. The review covered C authority/lease/epoch → queue/quiescence → media resume; capture/encoding/RTP/rVFC identity; auth/assets; bounded diagnostics/resource sampling; watcher lifecycle; and disabled adaptive-policy integration.

The root reports I1 Host 23 files / 290 passing tests, initial JS 79 files / 1411 tests with 1409 passes and two fixture failures, 49 passing targeted checks after `9a8bf3a`, and a successful temporary schema1 → schema2 build. I inspected the two fixture corrections: they provide an isolated verified manifest and verify the new durable diagnostic layout/receipt identities without loosening production checks. These suites/builds were not rerun. Only the two new isolated behavioral counterexamples above were executed.

No source, production dist, dependency, index, service, Viewer, network, tunnel, native input/capture or real codec mutation/run was performed. This ignored review file is the only artifact written. Live browser playback, input correctness, public-path performance, hardware/optical evidence, normal versus pressured resources and three-hour per-path continuity remain NOT RUN for this review. Final acceptance requires the root's documented deployment and actual-run evidence; unit-test success alone does not establish readiness.

The root owns the versioned review rollup and handoff anchor. After one consolidated fix wave, re-review only the findings/fixes and their affected cross-layer behavior; do not reinterpret this review as production acceptance.

## Final fix wave scoped re-review — `5b4baca..1b706d3`

**Findings: none. Both prior P2 findings are RESOLVED. Specification, architecture and documentation sync: APPROVED for this scoped fix.** This supersedes the earlier Needs fixes verdict for the two integration findings. It does not change the separate production/real-acceptance limitations above.

### Original P2 1 — Host timing enclosure: RESOLVED

`python-host/input_timing.py:7–11` now starts its queue boundary inside the adapter instead of inheriting M3 admission time. The unchanged Host timer encloses adapter entry/return, and both native adapter implementations construct `InputTiming` inside that call. The fix restores the agreed `hostQueueMs` / `hostApplyMs` substages without changing the compatibility alias, ACK fields, queue authority or capacity.

The new actual-Host/real-queue regression at `python-host/test_input_timing_contract.py:104` retains nonzero outer admission wait and separately models internal wait. It asserts second adapter entry at 100ms after submission at 10ms, an actual ACK total of 15ms, queue substage 5ms and apply substage 10ms, including the enclosure invariant. This directly addresses the original counterexample; existing native-worker timing coverage remains in the same file. Media spec §3.3 and the appended requirements note now explicitly state that outer admission wait is outside these three fields and cannot be called network residual.

### Original P2 2 — Verified freshness success hook: RESOLVED

`web-client/js/webrtc.js:197–198` carries the already validated M2 provenance flags into the matched row. The existing actual collector → `consumeInputFrameMatches` → monitor path therefore reaches `web-client/js/latency-monitor.js:196–201` with scope, stream, capture sequence and original rVFC clock intact. Successful matched input evidence is required; freshness uses the callback timestamp, not metadata/join arrival.

The new constant-size capture high-water is reset on scope change and retained through pause/resume. The existing scope/age checks plus `mediaSince` reject old-scope and pre-boundary/paused presentations; old or repeated capture sequences cannot refresh the gauge, including after sparse collector recreation. Unmatched input, unassociated paint, frame_timing, ACK, missing/failing freshness flags, wrong stream and expired joins remain unavailable. The scalar setter now rejects freshness values (`latency-monitor.js:205–209`); a targeted repository call-site search confirmed there is no production scalar caller to break. Other metric stage behavior is unchanged.

The six new integrated cases in `web-client/js/webrtc.frame-trace.test.js:370` onward use the real collector, consumer and monitor. They cover rVFC100/binding800 → age700, no ACK/visible-effect fabrication, capture high-water, pause/resume and scope boundaries, unknown/reused/wrong-stream/expired evidence, and scalar rejection. The changed monitor pause test now establishes freshness using a provenance-bearing row rather than bypassing the successful association contract. Media spec and requirements describe these exact semantics, including original timestamp and the unavailable cases.

### Review evidence and boundary

Read the exact nine-file commit diff plus the versioned final-integration-fixes report and ignored final-fix report. Outside-diff reads were confined to `acceptBinding` provenance validation, its existing consumer, production freshness/scalar call sites and the already reviewed Host timer/adapter boundaries. No whole-branch re-review was performed and no new issue requiring a counterexample arose.

Implementer evidence inspected: targeted **11 Python tests passed** and **44 JavaScript tests passed**, following the documented red cases. Those suites were not rerun; their new behavior assertions directly cover both reproduced defects and affected lifecycle boundaries. Independently checked `git diff --check 5b4baca 1b706d3`, which passed.

Only this ignored review record was appended. No source, root dirty documents, Git index/commit, dist, dependencies, service, browser/Viewer, network/tunnel, native input/capture or real codec operation was changed or invoked. Candidate `1b706d38554f4135856f097fbcd9b8cc653aa68e` has no remaining finding from this final integration review; root-owned deployment and real validation remain separate.

## I2 startup regression scoped review — `1b706d3..adfcb48`

**Findings: none. Scoped fix APPROVED.** The reported initial media startup failure is addressed by the code change; successful production playback after deployment remains to be verified by the root task.

The production delta is one assignment in `python-host/host.py:5082`: a new authoritative attempt begins with active demand, matching its existing `active` / generation-0 media binding. The real Viewer characterization at `web-client/js/webrtc.test.js:4054` establishes why this is necessary: a fresh visible controller binds its attempt but has no generation ≥1 resume intent, so no subsequent resume message repairs an initially suspended new track.

Old resource ownership remains protected. `on_connection_attempt_bind` still validates the current Viewer lease and monotonic attempt sequence, returns before mutation for an identical bind, advances authority, suspends the old track and relay, and detaches the old sender before initializing new demand. Changing the Boolean does not call resume on any old object. The existing offer publication authority check remains in force; explicit suspension is checked again before the newly constructed sender/track are installed. A stale previous-attempt awaited media completion still fails its authority check before resuming or committing current resources.

The new actual Host handler regressions cover cold bind → offer with no resume request, replacement bind → offer with old track/sender/relay still frozen, explicit manual-pause and terminal-active before offer, duplicate binding preserving that pause, and a pause delivered while SDP is awaiting. Their fake construction adapters now expose real suspension/detachment effects rather than hiding them; the production startup flag is not forced by the fixture. The Viewer regression uses the real media controller/runtime, binding, visible ensure and replay methods.

Read the exact four-file diff, `docs/superpowers/reports/2026-10-17-runtime-media-start-fix.md`, and only the relevant unchanged bind/offer/media-await boundaries. Inspected reported RED startup failures and targeted GREEN **125 Python / 258 JavaScript** results and assertions; no suite rerun was needed. Documentation correctly identifies this remediation-wave regression and preserves the failed I2 observation without attributing historical black screens to it or claiming runtime acceptance.

No source, root dirty documents, index/commit, service, browser, Viewer, network/tunnel, native input/capture or codec operation was changed or invoked. Only this ignored review artifact was appended. Root may proceed with its already authorized controlled Host deployment and guarded playback verification; this review itself does not establish successful video, recovery or long-session acceptance.
