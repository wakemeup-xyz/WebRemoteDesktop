# Task 1 implementation handback

Status: DONE. Source/index write ownership is returned to root. No staging or commits were performed.

## Implementation

Implemented the narrow `vacant-only-v1` initial policy on the existing ordinary admission manager and authenticated route. Ticket records now retain policy and the issued server Viewer epoch; the one ordinary owner retains policy across normal resume and consumed-ticket lost-welcome retry. Human and legacy acceptance retain null policy. No second owner, persistence, endpoint, flag, or resume authority was introduced.

Guard issue captures the existing human sequence without advancing it. Both issue and first consume validate vacancy, relay vacancy, online Host, safe epoch, retained human owner and live pending human intent. First consume requires the issued epoch and existing subject/session/TTL/fence binding. All rejecting paths leave manager records and ordinary ownership unchanged; there is no rejection-time pruning. Expired records are pruned on successful issue. Each issue/admit captures `now()` once. Live-map scans remain bounded by the existing capacity (default 128/max 256); TTL remains default 30000/max 120000 ms.

Human issuance validates before mutation, computes effective capacity excluding only revocable live unconsumed guards, then on success removes expired and unconsumed guard records, increments human sequence and inserts the human ticket. Consumed live evidence and live human records remain protected. Current consumed tickets check the existing current subject/session/generation before any initial-policy gate, and ordinary resume stays unchanged. Proof admission still clears owner/tickets and advances the ordinary fence; accepted ordinary admission still advances the proof epoch and invalidates proofs.

Runtime context snapshots derive epoch, Viewer map occupancy (including grace records), relay map occupancy and Host presence synchronously. The route validates presence with an own-property test; absent policy stays human issuance while every present value except the exact enum gets 400. Request context/epoch and handshake policy cannot supply authority. Error mapping is 400 validation, 429 capacity, 409 known availability/priority, 503 unavailable snapshot, with existing authentication/role/proof-only behavior retained. Signaling supplies the fresh server snapshot immediately at ordinary admission and continues directly into epoch/map claim with no asynchronous boundary.

## TDD evidence and commands

Working directory for every source/test command:
`/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`.

RED was run before changing the predecessor product implementation, with just the two required behavioral tests:

```sh
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test signal-server/lib/viewer-admission.test.js > .superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-1-red.log 2>&1
```

Actual Node output: 2 tests, 0 pass, 2 fail. Both assertions received `undefined` instead of `human-intent-pending` / `human-owner-retained`, demonstrating the predecessor treated guarded issuance as unrestricted human issuance. Each test also checks the corresponding original human ticket/current-owner recovery remains accepted once the guard is rejected. Complete failure stacks and output are in `task-1-red.log`. The wrapper printed the log using `cat`, so its final shell exit was 0; the Node failure exit was not separately captured. The recorded failed assertions and 0/2 pass summary are the RED evidence; the wrapper's 0 is not represented as a test pass.

After implementation and the full scoped test matrix, one GREEN run:

```sh
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test signal-server/lib/viewer-admission.test.js signal-server/websocket/runtime-context.test.js signal-server/websocket/viewer-admission.integration.test.js > .superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-1-green.log 2>&1
result=$?
tail -n 85 .superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-1-green.log
exit $result
```

Result: exit 0; 58 tests, 58 pass, 0 fail/cancelled/skipped/todo. Duration reported 1298.516426 ms. Full output is in `task-1-green.log`. Existing fixture connection/event logging is present; no warnings or failures occurred. No redundant behavioral reruns were performed.

Additional static-only checks:

```sh
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --check signal-server/test/viewer-admission-api.test.js
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --check signal-server/test/proof-admission.test.js
```

Both exit 0 with empty output. After self-review simplified one API test to avoid simulating grace by clearing the Viewer map; its syntax check was repeated because that file changed (exit 0, empty output). The passing 58-test behavioral set was unchanged by that API-only edit.

`git diff --check --` on the eight tracked owned paths returned exit 0 with empty output. `git diff --cached --name-only` was empty. Reviewed those eight diffs and the new unit test using `git diff --no-index -- /dev/null signal-server/lib/viewer-admission.test.js` (exit 1 indicates the expected new-file diff, not a verification failure).

## Coverage

Pure unit cases cover pending human Start priority and continued admission; retained human/legacy owner after TTL; guarded issue preserving the human fence; later human issue then expiry; stale pending human intent; changed epoch/vacancy; occupied/relay/Host gates at issue and consume; malformed contexts and policy enums; pristine legacy compatibility after rejection; retained guard owner/new guard after TTL; consumed current lost-welcome retry; pending human preserving an already consumed guard's recovery; newer admitted human defeating stale guard resume and consumed retry; same-session new generation; full pending-guard capacity yielding to human; invalid human request retaining guards; consumed capacity/evidence retention; subject/session confusion; proof clearing ordinary history; one time capture per operation; legacy pinning between guarded issue and consume.

Runtime test checks fresh independent snapshots and grace-retained map occupancy. In-memory integration runs actual signaling handlers and the existing DesktopControlLease, including both original human and guard-owned within-grace Host rebind ACK recovery and after-grace reset/regrant. Early acquire stays blocked through REVOKING until an applied reset ACK. Old rebind ACK cannot grant a newer socket; a changed current Host cannot grant. Fake Host ACKs exist only in these offline fixture tests.

Actual handler races cover two guards before/after vacancy; human issue supersession; Host/relay/epoch changes; grace occupancy; retained human versus prior guarded owner beyond grace and TTL; consumed lost-welcome retry then newer human; proof-first and guard-first consumption. `expectRejectedWithoutMutation` still pins Viewer map, lease, Host event count and Viewer epoch, and now accepts a previously issued proof to assert it remains usable after rejection.

API extensions cover own-property/null/array/object/boolean/number/string policy validation; ignored client context; Host/relay unavailable mapping; missing snapshot 503; capacity and human priority; real guarded route-to-Socket.IO ordinary ownership; human supersession and recovery; strict proof-only refusal. Proof API extension checks a refused guarded request leaves the outstanding realm-bound proof active.

## Changed source paths (exclusive ownership)

1. `signal-server/lib/viewer-admission.js`
2. `signal-server/routes/auth.js`
3. `signal-server/websocket/runtime-context.js`
4. `signal-server/websocket/signaling.js`
5. `signal-server/lib/viewer-admission.test.js` (new)
6. `signal-server/test/viewer-admission-api.test.js`
7. `signal-server/websocket/runtime-context.test.js`
8. `signal-server/websocket/viewer-admission.integration.test.js`
9. `signal-server/test/proof-admission.test.js`

Private orchestration artifacts added: this report, `task-1-red.log`, `task-1-green.log` beside it. No source writes outside the nine paths, primary checkout edits, documentation edits, index writes, subagents, services/status/network/browser/build/install/native/proof runtime operations were performed. Strict passive helper, sampler and original SUP were untouched.

## Self-review and remaining verification

Reviewed all nine owned changes against the supplied Task 1 brief, global constraints, and binding spec through Server contract. No correctness concern remains identified. Test-only simulated contexts prove individual pure-manager rejection gates; real monotonic runtime epochs, actual guard-owned ordinary recovery, and no-mutation signaling behavior are covered independently by real in-memory handlers.

The two ephemeral-loopback API test files are source-complete and syntax-checked but **NOT RUN** by this implementer: root exclusively owns their execution after review. No production deployment, live recovery qualification, three-hour continuity, business input, visible effect or physical acceptance is claimed. Prerequisite Host/P1/P2 corrections were consumed unchanged; this increment does not reimplement them. Root owns subsequent independent review, API execution, staging/commit and any deployment/runtime qualification.
