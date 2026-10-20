**Assessment: the missing initial `_firstFrameTimer` own property is the sole remaining startup-readiness predicate blocker in the recorded input-ready window.** This conclusion is about the native startup-to-baseline transition. It does not convert the failed run into a qualification PASS or explain every cleanup/process-observation issue.

This was a read-only diagnosis on 2026-10-18. No source or index changes, test runs, product/tool imports, browser/runtime actions, network calls, process inspection, service/status commands, or additional agents were used. Only existing source and recorded evidence were read. This report is the only new file.

**Evidence and source binding.** Source worktree: `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`. HEAD verified as `59bca14209eed299b0e94da58decb8b85e5ce70c`. The attempt records product TIP `dfb15434e79da90b803b763c533836e16c080c71`, tool TIP `59bca14209eed299b0e94da58decb8b85e5ce70c`, and Viewer build `de4ac13287760f3b`. The `web-client/js/webrtc.js` Git blob at both tips is `de18481ca867c52d80a225453a6769109ca15f59`; the current source file hashes to that same blob. There are no differences between these tips under `web-client`, `signal-server`, or `python-host`.

Attempt directory: `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-tool-only-continuation-private-r2-lahn2zqn/sequence-f3664a3798df872c83b9c1bc141da48d/attempts/b6eca7ff6a6c2a17b39275c128867c50`. Its `qualification-started.json` identifies output directory `ordinary-baseline-bz98fwaj`, scenario `baseline`, attempt `b6eca7ff6a6c2a17b39275c128867c50`, and manifest SHA `6053038beb6b0ccd6e7bea68c2d8c47871219f06a1dba63191729d1cb50a030a`. The summary retains root-attested Signal/Host/Viewer source pins to the product TIP. This review checks those recorded relationships; it makes no new runtime attestation.

Evidence hashes re-read without modification:

| File relative to attempt directory | SHA-256 |
|---|---|
| `qualification-result.json` | `af76a8dbeb32083ec9f8c630d7138362b3cd45d0f60ad16ad75d1a95fa025cd6` |
| `ordinary-baseline-bz98fwaj/session/samples.jsonl` | `87e153a2c5cc45ed2531018d8d8b5b0d65e726fc9472cb9bd17f671d7a282ff2` |
| `ordinary-baseline-bz98fwaj/session/summary.json` | `7b0f67cc806a9af743314baa8d0b76d6e723b667071c981d91ca30ecb5827b27` |
| `ordinary-baseline-bz98fwaj/session/lifecycle.json` | `868ee97b8d8e1e7c2a651039fb481730449309681fe360d2552ece0070a0c3fd` |

The native summary records `startup.status=verified`, `freshPage=true`, `authVerified=true`, selector `vacant-only-v1`, zero Start marks before, one after, and one guarded API request. Failure is exactly `{phase: startup, reason: baseline-incomplete}`. The unchanged runner assigns the verified startup result, starts its 45-second startup observation deadline, and raises `baseline-incomplete` if the model stays in startup (`scripts/ordinary_session_recovery.py:1344`). No deadline alteration is needed to explain this run.

**Recorded timeline.** There are 51 physical JSONL rows, covering elapsed 0.017288 through 47.306001 seconds. Rows 1–50 are startup observations and row 51 is terminal export; the wrapper's `completedRows=50` is therefore consistent with the separate terminal row. Early rows are properly unready: no frames, missing control and/or media readiness, and eventually `media-pending` at t=9.267724. Do not describe the timer field as the only unmet predicate during this early period.

At physical row 13 (t=10.267321), the session is actually input-ready and has 7 requestVideoFrameCallback callbacks. Row 14 (t=11.267740) has 25 callbacks. All 38 startup rows from physical rows 13–50, t=10.267321–47.286140, have the same fully ready input-gate values except that `firstFrameTimerHandlePresent` is null. Callback count increases at all 37 consecutive startup pairs, reaching 731. Maximum inter-row delta is 1.005011 seconds, below the 1.5-second sampling-gap threshold. Terminal export also remains input-ready, with 731 callbacks. Every one of the 51 rows reports the timer projection as null.

**Complete predicate comparison.** The actual `_gates` source is `scripts/ordinary_session_recovery.py:670`. Offline jq reductions over the recorded rows identified failing predicate names; they did not modify rows or execute the runner. For all 38 input-ready startup rows, the direct failure-name set is exactly `[firstFrameTimerHandlePresent]`; the fresh `ContinuitySummary` per-row failure-name set is empty. The following lists account for every predicate relevant to the startup transition, including the delegated continuity checks.

| Predicate group | Recorded input-ready window | Result |
|---|---|---|
| Gate status and reasons | `status=observed`, `blockedReasons=[]` | Pass |
| Eight required true fields | `allowed`, `inputActive`, `hasInputLease`, `viewportSupported`, `hasPaintedFrame`, `currentAttemptReady`, `hasActiveControl`, `socketConnected` are all true | Pass |
| Six non-timer required false fields | `manualDisconnect`, `superseded`, `mouseResetPending`, `draftComposing`, `draftPending`, `draftUncertain` are all false | Pass |
| Timer required false field | `firstFrameTimerHandlePresent=null`, but source requires identity with Python `False` | **Fail** |
| Exact enums | `uiPhase=connected`, `desiredMediaState=active`, `mediaRuntimePhase=active`, `keyboardControllerState=READY`, `keyboardTransportState=ready`, `surfaceState=settled` | Pass |
| Allowed enum alternatives | `desktopWriteRecoveryState=none`; `recoveryState=idle` | Pass |
| Compatibility input verdict | `sample.inputAllowed=true` | Pass |
| Sample availability and schema | Samples present; recorded wrapper row validation passed; native model remained startup without schema failure | Pass in recorded run |
| Socket, scope, build, attempt | Socket connected, `scopeStable=true`, build `de4ac13287760f3b` matching manifest, nonempty attempt hash | Pass |
| Relay path | Observed `path-1`, local relay, remote relay, UDP, remote UDP, relay UDP | Pass |
| PC and numeric scope | `pcState=connected`, `pcIdentity=1`, `generation=1`, `leaseEpoch=1`, all nonnegative | Pass |
| Frame count, age and historical gap | Count positive; age 4.3–47.9 ms; max gap at most 183.3 ms, all well below 5000 ms | Pass |
| Startup result | Verified real guarded Start recorded in summary | Pass |
| Three ordinary identities | All nonempty, stable: session `37c82a5ea0c1be26`, socket `c9980763d1474554`, admission `75cf37671e47815c` | Pass |
| Two-sample startup proof | First otherwise-ready adjacent pair is t=10.267321/11.267740, callbacks 7→25; all 37 later pairs also progress | Pass except timer predicate in both samples |
| Host observation | All 51 rows stable, complete coverage, no Host disconnect | Pass |
| Pre-fault disconnect/event guard | Every row has `firstDisconnectEvent=null` and no server events | Pass |
| Sampling cadence and build equality | No delta >1.5 s; one matching build | Pass |

`ContinuitySummary.observe` (`scripts/passive_session_soak.py:270`) supplies the path, sample identity, PC and frame-age gates. `_gates` makes a fresh one-row probe and asks only whether failures exist, so its probe does not require a one-second completed PASS or a second progressing sample. Startup separately requires the previous sample to pass and callbacks to grow (`scripts/ordinary_session_recovery.py:753`). The two real rows above satisfy the latter progression condition. Under the unchanged source predicates, the timer field is the only reason those ready observations cannot admit baseline. This is a static conclusion from recorded values, not a rewritten or replayed qualification result.

**Exact product/observer mismatch.** `scripts/passive_session_sampler.js:327` intentionally projects three states:

```javascript
Object.prototype.hasOwnProperty.call(client, '_firstFrameTimer')
  ? client._firstFrameTimer !== null : null
```

A real own null value means false (known absent handle); an own non-null value means true; a missing own property remains null/unknown. The observed gates have `status=observed`, not unavailable or scope-changed, and all other fields are populated. Under this source projection their null timer field means the actual WebRTC object lacked that own property.

The product `const WebRTC = { ... }` declaration begins at `web-client/js/webrtc.js:393` and explicitly initializes many timer handles, but does not declare `_firstFrameTimer`. The only initial handle allocation is the legacy `setTimeout` assignment at line 2652. `clearFirstFrameDeadline` at line 2632 assigns null only inside `if (this._firstFrameTimer)`. Calling it on a never-allocated field leaves the field absent.

For an ordinary non-tunnel pending startup, `beginFirstFrameDeadline` takes its early branch at line 2640: clear the legacy deadline, use `startStartupMediaBudget`, then return. That initial budget is owned by `_startupEpisode.timer`, rather than `_firstFrameTimer`. Real successful paint calls `clearFirstFrameDeadline` through `markMediaAttemptReady` (line 1182) and connected UI phase (line 1794), but these calls likewise cannot create null ownership when the legacy timer was never allocated. This matches the actual recorded session: trusted first frame, active input, complete real media readiness, and an absent legacy timer property.

Requirements agree with this lifecycle: `docs/需求文档/WebRemoteDesktop-需求文档.md:18` specifies the non-tunnel initial 8-second soft feedback, 72-second total active budget and 12-second paint cap. The mismatch does not justify changing any of these deadlines or the runner's 45-second observation limit.

**Minimal legitimate product fix.** Declare `_firstFrameTimer: null` in the real WebRTC singleton beside its other timer state. This one-line runtime change makes ownership explicit from construction: there is a known absent legacy handle before it is armed. The current allocate/cancel paths then retain their intended null/handle lifecycle. It leaves the active `_startupEpisode` budget and ordinary recovery behavior untouched. The repair is an explicit product state invariant, not an observer inference or a special-case qualification bypass.

| Alternative | Assessment |
|---|---|
| Initial own `_firstFrameTimer: null` | Recommended minimum. Represents actual absence at object construction and fixes all fresh-page observations. |
| Also make clear use a null check and assign null unconditionally | Reasonable optional hardening, especially for zero-valued fake handles, but expands beyond the proven fresh-object defect. It should have a separately stated invariant/test if included. |
| Only assign null unconditionally in `clearFirstFrameDeadline` | Repairs this observed path once clear is called, but leaves construction ownership implicit. Less direct than declaring the field. |
| Normalize missing property to false in sampler; remove timer gate; seed it in the observation installer/fixture | Reject. Loses unknown-state evidence or fabricates native readiness; does not repair real product state. |
| Force legacy timer allocation in ordinary pending startup | Reject. Adds a second deadline owner and risks conflicting with the new budget. |
| Extend startup observer/production deadlines or retry failed attempt automatically | Reject. Cannot turn the persistent missing own property into known false; changes unrelated behavior/evidence policy. |

**Why existing offline coverage missed it.** `scripts/passive-session-sampler.test.js:455` uses a mock WebRTC object and explicitly seeds `_firstFrameTimer:37`; its boolean test sets null and deletes the property and correctly asserts false versus null (lines 546–549). That sampler behavior should remain unchanged. `scripts/test_ordinary_session_recovery.py:662` constructs `ready_sample` with `firstFrameTimerHandlePresent=False`; `NativeStartupPage` (line 1364) likewise emits synthetic ready samples and seeds true during its early unready period. These do not obtain timer ownership from a fresh real WebRTC object. The legacy timer tests at `web-client/js/webrtc.test.js:6118`, 6144 and 6167 allocate the legacy timer before proving cancellation, which creates ownership and hides the fresh-start branch.

The real source startup fixture in `web-client/js/input-signaling-continuity.test.js:1239` executes `beginStartupEpisode` and `beginFirstFrameDeadline`, then real rVFC painting. Its success test at line 1514 asserts actual Input active and `_startupEpisode.timer===null`, but does not assert ownership of `_firstFrameTimer` or load the unchanged passive sampler against that actual object. This is a missing connection between independently valid product/observer/reducer fixtures, rather than evidence that unknown sampler values should be relaxed.

**Focused RED/GREEN recommendation, not executed here.** First add a regression assertion immediately after loading the real WebRTC source: it owns `_firstFrameTimer` and that field is null. Against current source this must fail; no setup may seed that field. Extend the actual non-tunnel startup fixture to assert the field remains its own null before and after `beginFirstFrameDeadline`, pending media and successful real rVFC paint. Prove the startup episode retains its own scheduled budget before paint and is complete afterward.

Add one offline integration test loading the unchanged passive sampler into the same VM as actual WebRTC/Input, with only the required deterministic DOM/transport/statistics/build environment supplied. Drive the actual startup and frame/control path; do not synthesize `inputGate`, set the timer field, or replace `getEffectiveInputGate`. The emitted timer projection must be false after success, while live timer ownership in the existing armed legacy branch must project true and cancellation must return false. Keep the existing deleted-property→null test. If a reducer bridge is added, send two actual sampler emissions with known scope/identity and increased rVFC callbacks into the unchanged startup model, and assert transition to baseline. An actual product-to-sampler assertion is the essential test; merely updating Python `ready_sample` again would repeat the gap.

For strict-gate regression coverage, preserve/check null and true rejection for `firstFrameTimerHandlePresent`, plus a real unrelated blocked condition. The new product source initializer is the GREEN change. Run only the relevant WebRTC/startup/sampler/ordinary-recovery suites plus the normal frontend build; no broad runtime acceptance claim should follow solely from those checks. Existing startup timing tests should continue proving 8/72/12-second behavior, no retry-budget reset and no tunnel/recovery policy change. No tests were run as part of this assessment.

**Deployment scope and qualification limits.** The proposed product runtime delta is solely `web-client/js/webrtc.js`, accompanied by focused tests and repository-tracked review/implementation documentation when implementation is authorized. The generated hashed Viewer assets and manifest must be rebuilt through the existing Signal frontend build and loaded in a fresh page. `README.md:69` and `signal-server/server.js:530` establish that normal Signal startup builds `web-client/dist`; production serves generated assets, not loose source. No Host or Signal business-logic source modification is needed for this defect, and no tunnel operation is relevant. A deployment should use the established controlled frontend/local Signal procedure and new build/source evidence; this report does not authorize or perform a restart. Avoid unnecessary Host restart for a Viewer-only state declaration. A previous failed attempt, admission, source manifest or result must not be reused as proof of the new build.

The immutable actual result remains failed-or-indeterminate, worker exit 1, not timed out, with row validation passed but worker stage failed and all later validation stages not evaluated. The native continuity summary has 0 admitted baseline samples and 0 admitted baseline seconds, requested 300 seconds: it is INCOMPLETE. Lifecycle says capture/write okay, browser closed, manager stop okay, but cleanup incomplete and owned process exit not observed. Outer result also has `qualification=null`, `finalRuntimeIntegrity=null`, `postCloseOccupancy=null`, `nextRunAdmission=NOT_ESTABLISHED`, `strictFreshPreflightRequired=true`, `serverMapDrainEstablished=false`, `automaticNextRun=false`, and process observation limitations. This review does not establish diagnostics completeness (the final sample has partial coverage/dropped events), full process-tree exit, server map drain, vacant admission, current service health, physical input effects or continuity PASS. Those remain separate gates for any later authorized fresh run.

The defensible conclusion is narrow and strong: after t=10.267321, the recorded ordinary relay session satisfies every startup predicate except the missing timer-ownership projection, and fresh-object explicit null ownership is the smallest product repair. Completion and successful redeployment require subsequent authorized implementation, focused checks, fresh integrity/preflight evidence and a full new baseline qualification.
