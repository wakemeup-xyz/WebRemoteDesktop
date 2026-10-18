# Host Cadence and Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Existing user authorization covers this work; no repeated workflow questions.

**Goal:** Explain capture cadence and fix startup/shutdown ownership defects while preserving remote-control authority and service availability.
**Architecture:** One pure capture-cycle observer, one existing-worker native-resource owner, and one pure per-invocation peer-close recorder. Shared host.py edits are strictly serial.
**Tech Stack:** CPython3.11 scalar/immutable state, deterministic unittest and AST-only Host methods.
**Spec:** ../specs/2026-10-18-host-cadence-cleanup-design.md

## Global Constraints

Worktree /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop, baseline4d591bb27434cca0c6071aadf7478cb8fba956ca. Preserve4 preexisting dirty docs (README.md, docs/archive/worklogs/review-anchors.md, docs/runbook-safe-startup.md, docs/需求文档/WebRemoteDesktop-需求文档.md) and untracked signal-server/node_modules. One source/index writer via explicit root handoff. Worker may only stage/commit its owned paths. Python /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11. No Host/native imports, actual threads/subprocess tests, tests/build/npm/network/browser/service/proof/tunnel/primary operations outside explicitly pure tests. No subagents. No FPS/quality/codec/resolution/bitrate/network/authority/grace/deadline changes. Runtime/user-input claims remain unqualified until separately observed.

### Task 1: Closed capture-cycle accounting and initialized worker state

**Files:** Create python-host/capture_cadence.py, python-host/test_capture_cadence.py. Modify python-host/host.py (__init__, _capture_loop, capture_observation_snapshot, production headroom comment), python-host/runtime_observability.py (unavailable child only), python-host/test_capture_observation.py (additive schema/AST tests only).
**Interfaces:** Implements CaptureCadenceObserver/start/finish/break_continuity/phase/snapshot and unavailable_capture_cadence exactly as spec. Existing CaptureObservation begin/finish/grab counters unchanged. Task2 later adds publication stop/generation guard and finally owner; do not implement those early.

- [ ] Write deterministic math tests with actual numeric endpoints, e.g. first start0, grabEnd10ms, postEnd15ms, sleepStart16ms/end51ms, nextStart60ms yields interval60=grab10+post5+pacing35+other10; requested30ms gives excess5ms, lockWait2ms/critical1ms are subsets. Assert one paired max record, no independent-max mixture. Actual direct unittest RED must fail due absent capability.
```python
observer = CaptureCadenceObserver()
observer.start(0, capture_generation=0, target_generation=0, min_interval_ns=50_000_000)
observer.finish(grab_finished_ns=10_000_000, post_grab_finished_ns=15_000_000,
    sleep_started_ns=16_000_000, sleep_finished_ns=51_000_000,
    sleep_requested_ns=30_000_000, publish_lock_wait_ns=2_000_000,
    publish_critical_ns=1_000_000, published=True)
observer.start(60_000_000, capture_generation=0, target_generation=0, min_interval_ns=50_000_000)
assert observer.snapshot(60_000_000)['lastInterval']['otherMs'] == 10
```
- [ ] Implement pure single-writer immutable60bucket count/sum/max observation with no locks in snapshot, fixed stages/counters/allowlists/caps from spec. First/unfinished/discontinuous/expired/no-window measurements preserve null. No P95. Bound large clock jumps in constant bounded work; no per-frame JSON, logs, sorts or full-history copy.
- [ ] Wire same-thread monotonic endpoints around existing loop phases without changing original min interval, pacing elapsed endpoint, >.001 condition or5ms retry. Protect only observation calls from exceptions, not MSS/business operations. Preserve grab success independently from publication failures. Existing fake tracks without observer return unavailable child and preserve capture behavior.
- [ ] Move all trace/cache/cadence fields consumed by worker before Thread.start. Use actual AST constructor+loop with immediate fake Thread.start, no real threads/native imports; behavioral RED on BASE fast grab must hit hidden attribute failure/count loss, GREEN publishes/counts/notifies without5ms fallback. Do not merely assert statement order. Fix comment1x semantics only.
- [ ] Pure tests cover2+cycles, oversleep/slow grab/no sleep/exact1ms, error retry, pause/profile generations, malformed clocks and scalar caps, invalid whole-interval exclusion, bucket expiry/exact60 boundary/huge jump, copy mutation, no-lock one-publication snapshot and unavailable selected-track adapter. Existing stop-inside-grab semantics unchanged until Task2.
- [ ] Run affected direct unittest only, capture command/count/child exit; self-review then owned-only commit. Report actual RED/GREEN, modified paths, semantics/unknowns, no production claims. Root performs independent task spec+quality review and original-worker fix loop.
```bash
cd python-host
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest test_capture_cadence test_capture_observation test_runtime_observability
```

### Task 2: Capture worker owns resource closure and rejects late pixels

**Files:** Create python-host/capture_resource_owner.py, python-host/test_capture_resource_owner.py. Modify python-host/host.py (__init__, _capture_loop, shutdown, resource_snapshot), python-host/test_capture_observation.py (new stop/generation publication semantics). Create python-host/test_capture_shutdown_contract.py for actual AST integration (required by the direct test command).
**Interfaces:** Pure CaptureResourceOwner(resource): claim_worker()->resource|None, close_worker()->None, close_unclaimed()->bool, snapshot()->fixed scalar dict. Its short claim lock only at entry/closure, never per grab or reader. States unclaimed/worker-owned/closing/closed/close-failed; constructor fallback can claim only unclaimed and closes outside lock, worker never touches a claimed-away object. close errors captured as fixed failed; no raw text. ScreenCaptureTrack.resource_snapshot adds captureCloseState and shutdown join observation; executorShutdown remains request-only evidence.

- [ ] Behavioral RED: fake grab calls stop/clear midway and returns a screenshot; real AST loop must not refill buffer/bounds or increment capture_seq/trace published after stop. A suspend/resume generation crossing must also discard. Old source publishes, so RED fails for the behavioral assertion. Completed grab count still increments success.
- [ ] Add publication condition under capture lock: running && !suspended && generationStillCurrent; snapshot generation before grab. Keep Task1 cadence counters accurate for discarded successful grabs and break continuity at stop/pause/error.
```python
if not self._capture_running or self._suspended or generation != self._capture_generation:
    # Discard successful late grab without changing completed/failed grab semantics.
    continue
```
- [ ] Implement owner as exact-once claim state with immutable nonblocking snapshot. Capture loop obtains local resource and finally closes only its owned resource. Constructor starts only after all state initialization; if start raises, atomic unclaimed fallback either closes before late worker entry or leaves already-worker-owned resource to worker. No extra worker, timer, wait task or retry loop.
- [ ] Shutdown only requests stop/notifies, retains original2.0s join and executor.shutdown(wait=False), clears buffers; no caller sct.close/default-executor close waiting. Local worker retains resource until finally. Join timeout/error/cancel reports pending/unknown with actual thread-alive/owner state. Cancellation must not claim closure. Legacy absent-owner fixtures with no native resource remain supported, never close a possibly-live legacy resource on assumption.
- [ ] Fake-owner tests: worker/fallback race and falsey resource, duplicate calls, close raises, worker exception/stop, start failure and late entry, join2s stillalive before eventual worker completion, snapshot while closing, no native close while fake grab active. Use fake Threads/events with deterministic scheduling/callbacks; do not start real threads or sleep. Assert old buffer never returns after stop and Task1 arithmetic/retry/pacing intact.
- [ ] Run affected pure suites once after edits; self-review and owned-only commit/report. Root independent task review checks actual ownership/exceptions, stale peer protection unchanged; original-worker fixes if needed. Real platform acceptance remains root-only after final whole review.
```bash
cd python-host
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest test_capture_resource_owner test_capture_shutdown_contract test_capture_cadence test_capture_observation test_runtime_observability
```

### Task 3: Invocation-specific truthful peer cleanup completion

**Files:** Create python-host/peer_cleanup_observation.py, python-host/test_peer_cleanup_observation.py. Modify python-host/host.py imports and _close_peer_connection only. No changes to capture worker or control protocol.
**Interfaces:** Pure PeerCleanupObservation(sequence, reason, *, peer_present, track_present, sender_present, now_ns): stage(name,status,result=None), terminal(outcome,now_ns,observations)->dict, start_record()->dict. Fixed allowlists/keys/caps in spec; no arbitrary repr. Host sequence allocated synchronously before first await; capped999999999 with clipped/uniqueness limit. Existing logger emits WRD_PEER_CLEANUP JSON start/terminal<=2048 bytes, log failures swallowed only around emission.

- [ ] Behavioral AST RED: closeA detaches real fake PC/track and waits; closeB empty advances authority then returns; A eventually returns. Require exactly one start+terminal per invocation, A retains old-object observations, B says absent. BASE loses A record. Inject new recovery/trace/coordinator/peer during waits and assert A never clears it.
- [ ] Implement pure fixed-shape bounded formatter/status state. Presence uses is not None (falsey fake covered). Stage reset result applied/rejected/unknown independent from await returned; no result disclosure. Peer close return and nullable connectionState==closed separate. Track shutdown return and owner/thread states separate; senderReleaseConfirmed null; no all-released bool. Durations null on invalid/rollback, capped/clipped on excessive, no raw exception strings.
- [ ] Instrument actual close in try/except/finally while preserving reset→PC→track ordering, original exception/CancelledError propagation and every authority/identity write fence. Emit terminal outside fence even if stages fail/cancel; later skipped stages stay not-started. Do not add retries, cleanup tasks, deadlines or make track shutdown run when old code would have skipped it. Remove misleading presence-as-release completion message; no existing scripts/python consumer requires its format.
```python
record = PeerCleanupObservation(1, 'manual', peer_present=True,
    track_present=False, sender_present=False, now_ns=0)
record.stage('peerClose', 'running')
record.stage('peerClose', 'returned')
terminal = record.terminal('returned', 1_000_000,
    {'peerConnectionClosed': True})
assert terminal['senderReleaseConfirmed'] is None
```
- [ ] Pure AST tests reset/PC/track errors and cancellation at each await, empty/falsey/missing/broken getters, logger failure, old completion after new peer, unknown reason/exception secret canary, sequence saturation, invalid clocks, no task/thread/retry creation. Keep unknown release facts unknown.
- [ ] Run test_peer_cleanup_observation plus affected pure Task1/2 suites; self-review/owned-only commit/report. Root independent spec+quality review and fixes; most-capable final review exact whole increment before promotion. No live tests by workers.
```bash
cd python-host
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest test_peer_cleanup_observation test_capture_resource_owner test_capture_shutdown_contract test_capture_cadence test_capture_observation test_runtime_observability
```

### Task 4: Root-only guarded promotion, measurements and qualification

**Files:** docs/superpowers/reports/2026-10-18-host-cadence-cleanup-execution.md, bounded evidence directory, this plan completion marks/current overview. Private reviewed operational derivatives only outside tracked tree.
**Consumes:** All task commits/reviews, most-capable full source review, known runningSignal45287/Host94398/build79bf, existing primaryHEAD/index/W2/tunnel/watch/quick source truth. No old PID-pinned wrapper replay.

- [ ] Freeze exact reviewed source/diff with zero primary baseline mismatches; current frontend assets remain byte-identical; preserve4W2 undeployed paths and all preexisting dirty docs. Independently review Host-only operational script, exact source allowlist and subprocess cleanup/failure classification before execution.
- [ ] Fresh health/Hostonline/Viewer0/relay0; guarded source apply; safe helper restart-host only. Verify same Signal/build/assets, new Host identity/current source and primaryHEAD/index/tunnelwatch/quick preserved. Read/report both passwords only from runtime config, never in versioned documents. Restore services if any operation stops them.
- [ ] Fresh normalUI/oneStart/one-useproof300s via existing reviewed SUP/helper; exact browser/math/log windows, actual cadence partition and worker close-owner evidence. No business native input. Retain failed/missing/observation gaps; no P95/causal/content-freshness claim from snapshots alone. If short fails, diagnose/fix actual cause before long.
- [ ] After pass start fresh10800s passive same-route continuity, no concurrent heavy work; humanViewer priority. Inspect controlled cleanup after it ends; correct boundaries/PIDs/build/capture counts/phase timings and actual MSS-close result separately from fake tests. Keep actual input/visible/physical BLOCKED/NOT_RUN and ordinary recovery unqualified; do not lower quality/threshold or weaken guard.
- [ ] Update bounded report, spec/plan/review records, source-loaded and real acceptance separately; final evidence review and docs-only guarded sync. End healthy local/formal entry, Host online and no owned Viewer. Keep branch/worktree/preexisting dirty files; do not merge/push/tunnel churn without that distinct request.
