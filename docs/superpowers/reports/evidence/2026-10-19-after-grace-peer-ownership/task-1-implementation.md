# Task 1 implementation report — 2026-10-19

Status: implementation complete; independent review pending. Offline synthetic source evidence only.

## Scope and implementation

Checkout: `/Users/macstudio1/.codex/worktrees/after-grace-recovery/WebRemoteDesktop`; branch `codex/after-grace-recovery-remediation`; starting HEAD `f239ee662428f55937796a6b82d6c987991193f1`. Starting worktree was clean. No index, commit, checkout, build, dependency installation, services, network, browser, native operation, process scan, or raw runtime samples/logs were used. Separate successor-operations documents later appeared as untracked files; they were not read or edited.

Exact changed files:

- `web-client/js/webrtc.js`: existing `handleControlGrant()` retirement branch now also accepts `this.pc && mediaLeaseChanged && !peerLease`. The existing retirement body stays in place, before attempt advancement and existing reconcile. No owner migration, guard relaxation, extra retry, diagnostic, or change to M1/ACK/lease/reset/media/FPS/codec/quality/network modes.
- `web-client/js/webrtc.test.js`: adds `afterGracePeerFixture()`, one platform-baseline test and ten ownership regressions. PC/DOM/socket/timer/rVFC/play are platform boundaries. Product recovery, grant, offer, callback binding, real Input, stats sampler, media controller/runtime and media ACK handling execute their actual bodies. Real positive generation manual-pause/resume precedes recovery. Current emitted requests supply ACK identity. Actual saved rVFC supplies frame proof. No product lifecycle or gate method is stubbed in the new fixture.
- `web-client/js/input-signaling-continuity.test.js`: repairs the pre-existing simplified fixture's PC browser boundary and negotiated identity, and explicitly asserts/ACKs the real transport reset that peer retirement now exposes (details below).
- `.superpowers/sdd/2026-10-19-after-grace-peer-ownership-plan/task-1-report.md`: this report only.

## RED and initial GREEN

Node throughout: `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node` (24.15.0).

1. Before source change, `node --test --test-name-pattern='after-grace fixture' web-client/js/webrtc.test.js`: 1/1 PASS, 176.337451ms. Real controller/runtime initialized, positive generation suspended ACK then active ACK remained resuming/input closed until real current rVFC. Baseline episode completed and actual generated resets were ACKed; effective Input became true.
2. Before source change, exact `node --test --test-name-pattern='after-grace ownership' web-client/js/webrtc.test.js`: 0/1 PASS, 1 FAIL, 175.565082ms. Failure: `AssertionError [ERR_ASSERTION]: new attempt must not retain a peer owned by the previous attempt`, operator `notStrictEqual`, at then `webrtc.test.js:8467`, `assert.notEqual(w.pc, orphan)`. Both values were the same `RecoveryPeer`; preceding assertion proved `_wrdControlLease === null`. The failure was stale peer identity, not a missing platform API. Source still matched starting HEAD.
3. After the minimal source condition extension, same command/test: 1/1 PASS, 188.307589ms.

## Matrix and fixture corrections

Final ownership matrix covers completed and pending startup, allowance/episode preservation, ACK→frame, frame→ACK early replay, old attempt/generation ACK and old rVFC rejection, connection/track before grant, same lease duplicate, within-grace reuse, first grant without previous media lease, and different leased peer retirement.

Retired-producer test captures actual old track/connection/ICE, DC open/close/message, generated watchdog timer, real sampler onSample/onError, rVFC, metadata/playing, generated 8s ontrack fallback and two actual play promises (resolve and reject). Every producer must exist. Each queued closure runs individually after retirement, first against a new resuming peer and again against active input. It must preserve pc/stream/paint/readiness/gate/phase/sampler/frame owner/frame callback/timer and frame IDs/emission count/capture FPS. Fake peer close also invokes channel close synchronously to test close reentry fencing. New streams assert exactly one actual platform play call. Within-grace test keeps peer/attempt/sequence and proves media ACK+frame cannot replace either keyboard or mouse reset ACK: input stays false after zero and one applied reset ACK, true only after both.

During focused development, duplicate-grant's immediate effective-input=true assertion failed, and first-grant initially compared absent `_mediaControlLease` to literal null rather than nullish. These were test expectations, not new product changes. They were corrected to the actual contracts, then 11/11 focused tests passed (304.291224ms; after synchronous-close coverage, 329.031874ms).

First affected-suite attempt without dependency reuse failed because isolated checkout could not resolve existing `jsonwebtoken`. Output was tailed, so it has no trustworthy aggregate recorded; its pipeline shell status was not treated as test success. No dependency installation occurred. Existing `/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/node_modules/jsonwebtoken` was confirmed, and root authorized read-only test reuse through `NODE_PATH`.

First full affected run with dependency reuse: 459 tests, 429 PASS, 30 FAIL, 24539.023964ms. Failures were in the old `input-signaling-continuity` fixture; repeated exact failure was `oldPeer.close is not a function` at the existing retirement body. The fixture supplied only `{connectionState:'connected'}` and stubbed `createOffer`, hence omitted both browser close/replacement boundaries and metadata a real negotiated peer carries. The final correction distinguishes this already-negotiated healthy starting peer from the new unleased-refresh fixture: `ContinuityPeer` provides real platform close/createDataChannel, and immediately after the first stubbed-offer grant only, `_wrdControlLease` and `_wrdConnectionAttemptId` reflect its accepted negotiation. Later grants still execute real retirement/reconcile. Same-lease/retained identity assertions were kept.

An intermediate targeted continuity run after only platform-boundary repair had 85 tests, 84 PASS, 1 FAIL, 985.731373ms. Remaining test was `real revocation and a different regrant discard suspended identity and start fresh sequences`: actual keyboard lastSent was 1 instead of the old expected 0. Real retirement clears DC before rebind; a still-suspended identity triggers actual socket transport-change reset #1. The test now asserts exactly one reset when not explicitly revoked, no reset when revoked first, asserts seq=1, sends its matching applied ACK, and expects the next write at seq=2/1 respectively. Mouse new-lease sequence remains 0 before its first write. Focused rerun of that test: 1/1 PASS, 162.374594ms. No reset barrier is bypassed.

## Existing duplicate-grant semantics for reviewer

The unchanged `webrtc.js:806–823` `replayMediaActivityIntent()` calls runtime `beginDesired()` and captures a new resume baseline for positive generation active intent; unchanged `handleControlGrant()` replays at the end. Unchanged `media-activity-runtime.js` `beginDesired()` accepts an already active desired identity and returns to resuming. Therefore the duplicate-grant test proves `isCurrentAttemptMediaReady()` and `hasPaintedFrame` remain true and peer/attempt/sequence/owner/stats/rVFC/offers remain unchanged, while explicitly asserting runtime resuming and effective Input temporarily false. It then supplies the real matching ACK/current frame and actual reset ACKs. The spec's retained same-attempt frame proof is preserved; immediate effective-input continuity is not claimed. Existing replay behavior is a separate optimization/review concern, not silently removed from coverage or changed by this patch.

## Final validation

Final focused exact command:

```sh
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-name-pattern='after-grace ownership' web-client/js/webrtc.test.js
```

Result: 10 tests, 10 PASS, 0 FAIL/cancelled/skipped/todo, 304.791350ms.

Full affected invocation uses the command below. The actual shell command wrapped this identical child argument list with `node -e` / `spawnSync(process.execPath, [...], {encoding:'utf8'})`, printed TAP aggregate lines and failure blocks, and propagated the child's status; it made no files and did not filter tests.

```sh
NODE_PATH=/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/node_modules /Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-reporter=tap web-client/js/webrtc.test.js web-client/js/input-signaling-continuity.test.js web-client/js/media-activity-lifecycle.test.js web-client/js/datachannel-watchdog.test.js web-client/js/desktop-session-state-owner.test.js web-client/js/latency-monitor.test.js
```

Final full result: 459 tests, 459 PASS, 0 FAIL/cancelled/skipped/todo, 24420.546633ms; child and wrapper exited 0. This includes all eleven new fixture/ownership tests and all existing affected tests. No skip or test-name filter was used for this run.

`git diff --check`: PASS after code/test changes.

## Self-review and boundaries

Self-review found and fixed the incomplete old continuity platform fixture, retained independent ACK barriers and explicitly documented duplicate-grant replay behavior. Source change is limited to three inserted lines/one replaced line; old retirement body and ownership guards are unchanged. New fixture confirms both real media instances are present and cannot exploit absent-runtime permissiveness. Stats factory is only wrapped to capture options and still invokes the real sampler factory.

No implementation commit was made; root owns index/commits. Independent task/final review and code admission remain pending. All results are offline synthetic VM source regressions, not evidence of real HTML rendering, decoded/displayed latency or physical input. Ordinary complete new runtime sequence, native, visible, physical and three-hour continuity remain NOT_RUN; no deployment/production loading is claimed. The prior after-grace FAIL remains FAIL.
