# Native latency collector v2 — scoped fix review

**Verdict: changes requested for one regression introduced by the source-fence fix.** All three original P2 contract gaps are addressed as specified below. This verdict covers the draft/offline wiring scope only; it is not source implementation or runtime approval.

## New finding in the fixes

**[P2] Do not make the controlled ACK source snapshot depend on the existing trace action hint.** V2 design line 87 requires constructing the ACK snapshot from “existing pre-validation action metadata” and says unknown action cannot qualify; plan line 167 repeats that dependency. The actual `Input.peekInputAckMetadata` obtains an unordered move's action from `_unorderedTraceSends`, which is a trace-owned hint, not the reserved controlled slot. `_recordInputTrace` returns before populating this map if the trace collector is unavailable (`web-client/js/input.js:731–738`), and `_pruneUnorderedTraceSends` deletes its entries on either forward or backward wall-clock jumps (`:896–901`). A genuinely sent move with a valid monotonic slot and current reliable-channel ACK can consequently become action=`ack` (`:933`) and fail the new source snapshot purely because tracing is unavailable or Date.now changed. This conflicts with the retained ±60000 wall-clock-jump coverage and the intended independence from InputTrace.

Specify how this narrow hook uses the matching reserved slot's immutable type/action (already validated against the actual accepted-send projection), while capturing fresh live source references and retaining all current scope/lease/transport checks. Existing trace metadata may remain a diagnostic hint; do not change its clocks, sampling, ownership, ACK authority or product behavior to make the collector work. Add actual-method cases with trace unavailable and Date.now jumping ±60000 between a real accepted move and its current reliable-channel ACK. Evidence must retain the original Performance timestamps and valid source fence. Wrong-source, suppressed-move and unknown-ID cases must still fail. This is a refinement of the new source-snapshot contract, within Task 2's existing scope.

## Original finding disposition

| Original finding | Disposition | V2 evidence |
|---|---|---|
| P2-1: final read lacked live transport identities | **ADDRESSED** | Design lines 44, 61–83, 87, 107 and 113 require explicit applicable live selected-send/reliable-ACK/socket object+ID snapshots at ACK and every read, including completed slots. Task 1 line 101 and Task 2 line 169 cover rotation after all observations and former-channel unordered ACKs. The separate new trace-hint dependency above must still be corrected. |
| P2-2: original send/ACK clocks absent from fixed step/artifact schema | **ADDRESSED** | Design lines 147–167 enumerate four original clock fields, all counters and StepReason values; lines 207–211 define exact ordinal and safe FrameKey projections. Task 3's fixture, positive assertions and projection/schema cases retain 100/160/200/240 and reproduce 60/100/140 without raw-dictionary recovery. `phase` is now an explicit evaluator argument. |
| P2-3: no callable independent M2 completion/finalization | **ADDRESSED** | Design lines 80–83 and 93–109 add explicit ID-bound read finalization, immutable began/deadline, remaining budget, deterministic missing-stage reasons and finalized/expired state. Lines 174–188 define completion polling and shared existing wait budgets. Task 4 lines 289–344 covers late M2, missing M2 at the original deadline, refusal/partial begin/errors/cancellation, fresh final-read fences and cleanup. No new browser timer/listener or renewed lifetime is required. |

The completion contract explicitly acknowledges that existing synchronous calls do not provide a hard process deadline. The added clock, source and lifecycle fields remain bounded metadata and do not add control authority. No other fix-induced schema/signature or privacy conflict was found within this scoped review.

## Review scope and limits

Read v1 review and v1→v2 draft diffs, then the changed v2 contracts/plan examples. Necessary interface reads were limited to existing ACK metadata/trace hint handling, ACK routing and the current claim timeout signature. No broader implementation review was attempted.

Reviewed fixed files:

- `/tmp/wrd-native-latency-collector-design-draft-v2-20261018.md` — parent-supplied SHA-256 `5f8fc1ea44290739c0c70297435c7685b344e2b888108de376d9a11af0534d8f`.
- `/tmp/wrd-native-latency-collector-plan-draft-v2-20261018.md` — parent-supplied SHA-256 `aaa09dcd9fe9c34b33df7b34c6822e6a0f9c0b200ded77abb6cb1b6712b099f9`.

Hashes and runtime/source identities were supplied by the parent, not independently verified. The parent now reports the source hold released, source at planning commit `c54`, another worker owning the runner fix, Viewer still `c802`/`bb581`, Signal PID33747 and Host PID36877 unchanged. The v2 drafts' held-c802/baseline-diagnosis wording is historical context and must be reconciled when versioning; it grants no operational authority.

Only this requested review file was written. V1 and v2 drafts, repository source/packages and other workers were untouched. No tests, project imports, builds, Git/process/health/runtime/network/browser/service/native operations were performed. Six current-run metrics remain null/NOT_RUN. The unresolved isolated Mac/macOS guest resource and all native/proof/lease/reset/rebind/media guards remain outside this review's authorization.

After the single new source-snapshot dependency is resolved and checked, the three original P2 items need no further scope expansion. Draft approval would authorize neither implementation by itself nor native/visible/physical or ordinary-production acceptance.
