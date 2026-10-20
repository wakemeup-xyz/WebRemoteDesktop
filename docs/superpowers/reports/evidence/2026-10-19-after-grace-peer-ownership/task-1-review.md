# Task 1 independent review

## Spec Compliance

- ✅ **Spec compliance: implementation compliant.** The bounded predicate at `web-client/js/webrtc.js:4185` retires an existing unleased peer only when retained media lease identity changes; the pre-existing different-leased-peer branch remains at `:4183`. First grant and same-lease paths therefore do not acquire a new unconditional retirement condition.
- ✅ Contract 2–3 order is correct: watchdog/event retirement, peer/DC reference clearing and offer/frame invalidation precede synchronous `oldPeer.close()` (`webrtc.js:4187`); control state and final attempt advancement follow (`:4203`), and replacement uses the existing reconcile (`:4229`, `:4252`). No owner migration or extra begin-attempt is introduced.
- ✅ Contracts 4–6 have real source-VM coverage: first grant/different lease (`webrtc.test.js:8653`, `:8665`), duplicate/within-grace reuse (`:8614`, `:8632`), pending budget preservation (`:8509`), matching-media-ACK/frame two orders and old-scope rejection (`:8463`, `:8521`, `:8535`), and connection/track before grant (`:8550`).
- ✅ Retired producer testing invokes saved closures rather than merely checking nulled properties (`webrtc.test.js:8569`); fake close also synchronously calls old channel close (`:8375`). Invariants cover peer/stream, paint/readiness/Input/runtime, sampler/frame owner, timer/frame IDs, emissions and capture FPS before and after active recovery.
- ✅ Duplicate-grant concern is **not a Task 1 defect or spec deviation**: the unchanged replay at `webrtc.js:806` calls `beginDesired` and captures a fresh resume baseline; unchanged `media-activity-runtime.js:70` accepts the same desired identity when already active and returns it to resuming (`:89`). Contract 4 requires peer/attempt reuse and preservation of established same-attempt frame proof, not immediate effective-Input continuity. The test keeps `isCurrentAttemptMediaReady/hasPaintedFrame`, owner, sampler, rVFC and offer count intact (`webrtc.test.js:8614`) and explicitly exercises renewed matching ACK/frame instead of masking the temporary closed gate. Any optimization of replay semantics requires separate scope.
- ⚠️ Documentation completion remains a root follow-up below; this does not invalidate the product implementation verdict.

## Strengths

- `web-client/js/webrtc.js:4184`: three inserted lines extend the existing retirement mechanism and preserve the authorization, lease/reset, M1, ACK, network-mode and ownership guards instead of adding another recovery mechanism.
- `web-client/js/webrtc.test.js:8381`, `:8391`, `:8432`: fixture loads real Input, stats, media controller and runtime. `loadWebRTC` really evaluates product sources (`:202`, `:204`); the sampler wrapper still calls its real factory (`:8398`). Positive-generation pause/resume is established through real APIs and actual emitted-request ACKs (`:8440`), and frame proof comes from saved real rVFC callbacks (`:8412`).
- `web-client/js/webrtc.test.js:8632`: within-grace regression independently proves media ACK/frame cannot satisfy keyboard or mouse reset barriers; zero and one reset ACK leave effective Input closed, both open it.
- `web-client/js/input-signaling-continuity.test.js:75`, `:100`: the older fixture now supplies browser close/replacement boundaries and metadata its already-negotiated peer would carry. The latter agrees with real offer lease binding (`webrtc.js:5638`). The changed expectation at `input-signaling-continuity.test.js:227` checks and ACKs an actual additional reset rather than clearing safety state: retired DC is absent during `Input.setControlLease` (`input.js:499`), and adapter unavailability emits a transport-change reset (`keyboard-transport.js:457`).

## Issues

### Critical (Must Fix)

- None found.

### Important (Should Fix)

- None found.

### Minor (Nice to Have)

- `docs/superpowers/specs/2026-10-19-after-grace-peer-ownership-design.md:3` and `docs/superpowers/plans/2026-10-19-after-grace-peer-ownership-plan.md:251`: current headline status still says implementation/tests have not run, and the plan execution record mandated at `:33` has no Task 1 RED/GREEN/result/commit/review append. The separate task report contains those implementation results, but readers following the versioned spec/plan will get stale status. Root should append the actual candidate/final commit, reported RED/GREEN and 459/459 result, this review conclusion, and the still-pending deployment/runtime qualification; update the spec status without claiming runtime PASS. This is documentation bookkeeping, not a product-code blocker.

## Cannot Verify

- This task-scoped source review cannot establish deployed resource identity, a new ordinary baseline→within→after→continuity sequence, native/visible/physical effects or three-hour stability. These remain NOT_RUN; the prior after-grace FAIL remains FAIL. The implementation report explicitly preserves that boundary.
- The reported RED/GREEN and final 459/459 run are recorded at `.superpowers/sdd/2026-10-19-after-grace-peer-ownership-plan/task-1-report.md`; this review does not independently re-execute or authenticate historical shell execution. No new code doubt justified a focused reproducer, so no tests were rerun.

## Review Checks and Scope

- Reviewed Task 1 only, base `f239ee662428f55937796a6b82d6c987991193f1` → head `cc833d82a2e0700135a92dc53fac7bfad0912dbf`.
- Read the supplied immutable diff once. The combined tool response truncated its beginning mid-hunk, so completed only the cut-off `handleControlGrant/reconcile`, new fixture and continuity-fixture/test ranges from precise source ranges; the diff was not reread.
- Named focused checks outside visible hunks: (1) hidden product-method stubs in the reused VM loader — inspected `loadWebRTC:94–219`; (2) duplicate-grant replay/reset behavior — inspected `replayMediaActivityIntent:806–823` and runtime `beginDesired:52–99`; (3) whether legacy fixture negotiation metadata/reset expectation masks a regression — inspected real offer identity `webrtc.js:5630–5645`, `Input.setControlLease:444–514` and transport adapter unavailability `keyboard-transport.js:457–464`; (4) required execution-record synchronization — checked exact spec/plan status and record anchors.
- No git command, source/index/HEAD mutation, suite/focused test, service/network/browser/native operation, process scan, raw log/sample read, or subagent delegation occurred. Only this requested review report was written.

## Assessment

**Task quality: Approved.**

**Reasoning:** The minimal predicate change uses the existing retirement-before-attempt ordering and the new tests exercise actual product media/Input gates, including queued old producers and independent reset ACKs. No blocking correctness or safety issue was found; root should complete the versioned execution record before final handoff, and keep runtime qualification separate.

