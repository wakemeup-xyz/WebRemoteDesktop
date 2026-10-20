### Spec Compliance

- ✅ Spec compliant for Task 1 source scope: reviewed exact base `c7914309e01e45f5f8678fd872a9cdb989ac530f` to tip `2cc162a282cde5846232026db8265b67592aa798`, against `task-1-brief.md`, binding `global-constraints.md`, and the design's Server contract. All nine owned paths have the required corresponding changes. No additional authority, map, owner, endpoint, persistence, grace/reset/rebind policy, or runtime fake ACK was added.
- ✅ Human priority and capacity match the specified order: `signal-server/lib/viewer-admission.js:35` checks the retained human/legacy owner and every live unconsumed human ticket; `:47` validates first and captures time once; `:60` rejects effective-capacity overflow before mutation; `:63` prunes/revokes only on successful issue. Guard issue captures the human fence without advancing it. Human issue removes pending guards and advances the fence while retaining live consumed evidence.
- ✅ First consume preserves rejected-ticket/owner state and requires fresh guarded availability plus the issued epoch before mutation (`signal-server/lib/viewer-admission.js:74`, `:90`). Consumed retry checks current subject/session/generation before initial guard checks (`:81`), preserving policy and existing recovery authority. Human and legacy owner policy is null; ordinary resume remains unchanged.
- ✅ Server snapshots include grace occupancy, relay occupancy, Host presence, and server epoch (`signal-server/websocket/runtime-context.js:120`). The route distinguishes absent policy from every invalid present value, ignores client context, preserves authentication/proof-only checks, and maps validation/capacity/availability/unavailable errors as specified (`signal-server/routes/auth.js:94`, `:102`, `:109`). Signaling supplies the fresh snapshot (`signal-server/websocket/signaling.js:1089`).
- ✅ Recovery and races are exercised through actual in-memory signaling handlers: guard-owned within/after-grace recovery with rebind/reset ACK barriers (`signal-server/websocket/viewer-admission.integration.test.js:81`), retained human versus guard after grace/TTL (`:275`), current consumed retry versus newer human (`:293`), proof-first/guard-first (`:305`), and late old operation/current Host change ACK rejection (`:323`). Fake ACKs remain offline fixture actions.
- ⚠️ Root's isolated loopback execution of `signal-server/test/viewer-admission-api.test.js:90`, `:117`, `:137` and `signal-server/test/proof-admission.test.js:112` remains **NOT_RUN** at this source review gate. Syntax checks are reported, not treated as API behavioral passes. Root should execute the already-scoped two test files after this review.
- ⚠️ Deployment, production loading, live recovery, fresh three-hour continuity, business input, visible effect, and physical acceptance are **NOT_RUN** here. Source approval does not imply production acceptance. Other task/prerequisite implementation and preservation of pre-existing dirty paths are outside this exact diff gate; their controller-owned verification remains separate.

### Strengths

- The implementation shares a small read-only guard validator instead of duplicating issue/consume policy, and delays all mutation until after validation/capacity succeeds (`signal-server/lib/viewer-admission.js:35`, `:47`, `:74`). The map remains bounded with no live-evidence eviction.
- Required RED cases check useful behavioral outcomes: a rejected guard leaves the pending human ticket usable and retained human recovery possible (`signal-server/lib/viewer-admission.test.js:10`, `:16`). Additional tests distinguish current consumed recovery from stale generations and pending human intent (`:108`, `:117`, `:129`, `:143`).
- Capacity tests cover pending guards yielding to humans, invalid humans not evicting records, and consumed records rejecting capacity overflow while remaining replay evidence (`signal-server/lib/viewer-admission.test.js:153`, `:174`). Legacy pinning is tested both before guard issue and between issue/consume (`:191`, `:223`).
- Actual-handler rejection assertions protect Viewer map, lease, Host event count, Viewer epoch, and an outstanding proof (`signal-server/websocket/viewer-admission.integration.test.js:66`, `:234`, `:246`, `:257`). Proof/guard acceptance interleavings are asserted independently (`:305`).
- Route tests check own-property invalid values, server-only context, exact response shape, priority/capacity/error mappings, real Socket.IO ownership, and strict proof refusal (`signal-server/test/viewer-admission-api.test.js:83`, `:90`, `:117`, `:137`; `signal-server/test/proof-admission.test.js:112`). Their execution is explicitly pending rather than claimed complete.

### Issues

#### Critical (Must Fix)

None found in this task scope.

#### Important (Should Fix)

None found in this task scope.

#### Minor (Nice to Have)

None recorded. Existing fixture connection/event output is the documented baseline, not a new warning/error defect.

### Review checks and boundaries

- Read the supplied full diff once; recovered only tool-truncated portions, and extracted target line numbers from the same diff for references. Did not run git commands or reread changed files generally.
- One named cross-contract risk required a focused unchanged-code check: asynchronous work between fresh context validation and ordinary epoch/map claim could allow a second claimant. Checked `signal-server/websocket/signaling.js:1093` through the claim/welcome boundary and `:435` through the early rebind/map branch, plus the direct helper binding at `:133`. The fresh guarded case has an empty Viewer map, so rebind returns before any lease/I/O work; ordinary epoch advance and map insertion occur synchronously before welcome. The existing runtime epoch helper's synchronous increment/proof clearing is visible in the diff at `signal-server/websocket/runtime-context.js:114`. No widened authority was needed.
- Inspected existing `task-1-red.log`: two expected behavioral assertion failures, with actual `undefined` versus required priority errors; its wrapper exit was not mistaken for successful Node execution.
- Inspected existing `task-1-green.log` summary and warning/error search: 58 tests, 58 pass, 0 fail/cancelled/skipped/todo, duration 1298.516426 ms; existing fixture connection/event output present, no warning/error matches. No tests were rerun.
- No source/index edits, service/status/browser/network/native/proof/build/npm operations, package-wide tests, or subagents. Only this requested private review artifact was written.

### Assessment

**Task quality: Approved.**

The implementation is narrow, maintains the existing ordinary owner and recovery model, and preserves human priority through retained ownership, pending intent, capacity, and first-consume races. No actionable source defect was identified; root's pending API gate and all deployment/runtime acceptance remain separate requirements.
