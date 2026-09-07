# Task 2 report — bounded, sanitized Viewer input tracing

## Delivery

- Worktree: `/Users/macstudio1/AI/Claude/WebRemoteDesktop/.worktrees/input-recovery-observability`
- Branch: `codex/input-recovery-observability`; required base: `2602a6739e5a9b8f0d59b78b1a2d7147c2bd4b31`.
- Implementation commit: `2cf87431fec71a0646c2345e7f3b154168630158` (`feat(diagnostics): trace sanitized viewer input decisions`).
- Scope is the Task 2 Viewer collector, Input/mobile/diagnostic/WebRTC hooks, focused regressions, and critical graph/HTML ordering. `keyboard-transport.js`, Signal relay behavior, Host behavior, diagnostic upload behavior, wire envelopes, leases, and control authorization were not changed.
- No service, tunnel, live Viewer/origin, physical device, Quartz, or public-path operation was run. The unrelated parent-owned test process was left untouched; the owned orphaned initial trace test process was terminated and verified absent.

## TDD evidence

### Baseline

The parent-thread baseline for this isolated branch was Viewer **747/747** on BASE. That baseline and all Task 1 recovery ownership/draft semantics were preserved; the final Viewer count includes the new Task 2 regressions.

### RED

1. Initial collector RED:

   `node --test web-client/js/input-trace.test.js`

   Observed before `input-trace.js` existed: the test file loaded its RED-safe fallback and all collector tests failed at the assertion that `InputTrace.create` must be available. This established the collector contract before implementation.

2. Critical-path handoff RED:

   `node --test web-client/js/diagnostic.test.js`

   The newly added deferred-handoff and classic-script tests initially failed because diagnostic core had no input-trace snapshot/incident seam and could not resolve the top-level `Input` from the classic script. The failure was fixed by installing the core wrapper and publishing the exact `Input` object on the classic global.

3. Mobile non-interference RED:

   `node --test web-client/js/mobile-text-input.test.js`

   The callback-after-send-throws regression reproduced the replay hazard: a tracing wrapper that had already invoked the business callback caused the catch path to invoke it again. The test then drove the at-most-once fix and explicit event handoff.

4. Intermediate collector stress probes supplied by the parent exposed two real RED cases: evicting a 256-entry ring freed unresolved digest capacity, producing 128 actual hash calls despite a reported pending count of 64; and an ACK record with explicit receiver `accepted=false` plus `status=applied` was exported as accepted. The final collector tests retain both cases as formal regressions.

### GREEN

- Required focused command:

  `set -o pipefail; node --test web-client/js/input-trace.test.js web-client/js/input-recovery.test.js web-client/js/input.test.js web-client/js/diagnostic.test.js web-client/js/webrtc.test.js 2>&1 | tail -12`

  **369 tests, 369 pass, 0 fail**.

- Expanded input/mobile/core command:

  `node --test web-client/js/input-trace.test.js web-client/js/mobile-text-input.test.js web-client/js/input.test.js web-client/js/diagnostic.test.js web-client/js/input-recovery.test.js web-client/js/webrtc.test.js`

  **404 tests, 404 pass, 0 fail**.

- Final offline Viewer command:

  `set -o pipefail; node --test web-client/css/*.test.js web-client/js/*.test.js 2>&1 | tail -20`

  **765 tests, 765 pass, 0 fail**. This is the parent’s 747-test baseline plus the Task 2 tests.

- Critical asset-build command (using the existing installed dependency tree as instructed):

  `NODE_PATH=/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/node_modules node --test signal-server/test/web-asset-build.test.js`

  **5 tests, 5 pass, 0 fail**. The same command without `NODE_PATH` failed before test execution with `Cannot find module 'esbuild'`; this is an isolated worktree module-resolution condition, not a test failure.

- `node --check` passed for each changed production JavaScript file. `git diff --check` and staged-diff checks passed. Existing WebRTC VM runs continue to print the ledgered offline `fetch is not defined` STUN fallback warning; it produced no failing test and was not masked.

## Implementation and files

- `web-client/js/input-trace.js` adds the independent critical-path collector. It accepts only the specified stages and finite enums/numbers, uses a 256-entry ring and 64 KiB serialized bound, aggregates move/wheel traffic, and returns detached snapshots. Input IDs are never placed in public events; a real UTF-8/WebCrypto SHA-256 digest is retained only as lowercase first-16-hex correlation data. Digest capacity is capped at 64 unresolved promises and ring eviction does not release a slot until the promise settles.
- The collector holds at most 256 reliable ACK waiters, one deadline timer, and 10-second late-ACK retention. Matching requires input type, lease epoch, and connection attempt. Timeout records and `onIncident(reason, { connectionAttemptId, leaseEpoch })` retain triggering identity; late ACK records preserve the receiver’s actual status/acceptance and add only late classification.
- `web-client/js/input.js` records the real effective gate, DC/socket/none enqueue result, keyboard/pointer/text ACK results, recovery, reset, lease, visibility/focus, active/park, and attempt lifecycle decisions. It exports the same top-level `Input` object to `globalThis`/`window` for diagnostic-core’s early-load-safe classic-script lookup. `getDiagnosticState()` now emits only bounded effective-gate, surface, draft, viewport, recovery, keyboard, and desktop-write metadata.
- `web-client/js/mobile-text-input.js` records IME and control DOM phases with safe mobile-text metadata, carries the originating event ID into deferred serial drains, clears it at the dispatch boundary, and makes tracing wrappers at-most-once when a hook throws after the business callback.
- `web-client/js/diagnostic-core.js` owns the same collector across deferred diagnostic loading, queues only attributed current-identity input incidents, and rechecks active, visible, control-authorized, current attempt/epoch identity before using the existing `autoSendFailure` cooldown/queue. Old-attempt/epoch incidents remain trace-only.
- `web-client/js/webrtc.js` records safe connection-attempt and reconnect lifecycle/recovery observations without changing transport/control behavior. `signal-server/scripts/web-asset-graph.js` and `web-client/viewer.html` load `input-trace.js` immediately before diagnostic core and before Input.
- Tests exercise the real collector, actual Node WebCrypto hashing, real Input gate/send/ACK hooks, actual DataChannel and Socket fallback results, recovery fixture dispatch, classic global handoff, WebRTC attempt lifecycle, IME deferred association, callback-throw non-replay, and privacy canaries.

## Privacy, stress, correlation, and handoff evidence

- Fixed-vector test uses the required real digest path and verifies the expected first-16-hex result. Serialized snapshots contain no raw input IDs, key/code fields, text, payload, coordinates, DOM labels/values, lease IDs, tokens, or passwords. Unknown fields/reasons/states are dropped rather than serialized through an arbitrary-object path.
- With 64 unresolved digests, 256 unrelated lifecycle entries evict the original ring records but do not increase actual hash calls. The next 64 submissions are counted as dropped; after the original promises settle, exactly one subsequent slot is available. The ring remains bounded at 256 and serialized snapshots remain at or below 64 KiB.
- 260 reliable submissions retain at most 256 ACK waiters and at most one fake deadline timer. Advancing the viewer clock beyond 3000 ms emits one timeout per retained waiter; records are retained only through the 10-second bound. High-frequency 1000 move/wheel iterations produce aggregate counters only and no per-event records or hash calls.
- Explicit receiver rejection (`accepted=false`) with an `applied` status remains rejected in the trace. A late ACK receives `reason=late-ack` while retaining actual status/acceptance. A stale same-ID ACK with wrong epoch/attempt remains visible and leaves the current waiter to time out; only a matching type/epoch/attempt clears it.
- Real Input tests verify a rejected keyboard gate produces exactly DOM plus gate records and no transport record; actual pointer sends record a DC acceptance, a DC failure, and Socket fallback; actual receiver ACK status is retained. Recovery fixture tests dispatch real pointer/lifecycle/recovery paths and verify DOM/gate/send/timeout/lifecycle stages without raw lease or coordinate material.
- Diagnostic tests prove a trace recorded before deferred `diagnostic.js` loading remains in the same collector and that the production-style classic script export makes `Diagnostic._currentInput()` resolve the exact live Input object. WebRTC tests prove attempt lifecycle records are handed to that collector.
- IME tests prove composition phases and a deferred text drain retain their originating event ID, then prove a later toolbar action has no old DOM association. A hook that sends and then throws invokes the business callback once and preserves the accepted result.

## Self-review and concerns

- Task 3 still owns `diagnostic.js` upload unification and downstream Signal/Host input-state/trace handling; this commit intentionally stops at the Viewer/core producer seam and reports that handoff rather than adding upload or wire fields.
- The Task 1 normal-composition UI-only follow-up (abnormal retained-draft notice) was explicitly left for the original Task 1 implementer and is not touched here. Draft/composing paths are excluded from automatic input incidents.
- Unit/VM/offline Viewer evidence is not physical-device, system-IME, Quartz/native-effect, live WebRTC, public-origin, tunnel, or production-watcher evidence. Those remain **NOT RUN**.
- The existing WebRTC fixture’s `fetch`-undefined fallback warning remains a ledgered offline condition. Asset-build verification requires the pre-existing `NODE_PATH` dependency tree. No dependencies were installed or edited.
- `collaboration.send_message` was not exposed in this subagent tool surface, so no Codex-app thread tool was used; progress/evidence are carried in this report and the final handoff. Parent independent review remains the acceptance gate.

## Scoped commits

- `2cf87431fec71a0646c2345e7f3b154168630158` — `feat(diagnostics): trace sanitized viewer input decisions`
- `24f8d51` — `docs(diagnostics): record Task 2 input trace evidence` (this report).
- No merge, push, or main-checkout mutation was performed.

## Fix round 1 — review findings (FIX_BASE `ddede163f0af802cec0ffb4575b652dc52d8e0a7`)

### Covering implementation and tests

- `web-client/js/input.js`: exact reason canonicalization; current-gate/visibility/active-lease incident eligibility; nested trace-scope restoration; mobile dispatch gate before the real keyboard controller; touch adapter trace callbacks; touch-only listener ownership; and safe event-ID handoff for external mobile actions.
- `web-client/js/mobile-text-input.js`: explicit trace options for external actions; at-most-once business callback behavior when tracing throws; and composition-end eligibility evaluated after `composing` is cleared while deferred drains retain only their active drain event ID.
- `web-client/js/touch-input-adapter.js`: bounded per-pointer gesture attribution and trace wrappers around deferred down/up sends; intentionally unassociated move/wheel/toolbar sends remain null; hook failures never replay a business callback.
- `web-client/js/input.test.js`: exact-prefix privacy canaries, accepted mobile gate-before-transport ordering, and real Input/adapter/collector physical DOM plus ACK correlation.
- `web-client/js/input-recovery.test.js`: real touch and IME accepted writes retain event IDs and current-attempt/epoch timeout incidents without raw text/lease/coordinates.
- `web-client/js/touch-input-adapter.test.js`: physical down/up attribution versus deliberate null toolbar attribution, and callback-after-send-throws non-replay.

### RED evidence

1. Finding 1: `python3 .superpowers/sdd/2026-09-07-input-recovery-observability-plan/root-trace-browser-probe.py` on reviewed HEAD reported `acceptedPointerSends=2`, `acceptedKeyboardSends=2`, but `allDomSendsHaveAssociatedAck=false`; the down records had `eventId=null` while the corresponding up records retained IDs. The direct regression `node --test --test-name-pattern='touch dispatch attributes' web-client/js/touch-input-adapter.test.js` failed with actual callback DOM phases `[]` instead of `['down','up']`.
2. Finding 2: `python3 .superpowers/sdd/2026-09-07-input-recovery-observability-plan/root-mobile-incident-probe.py` reported physical `2 writes/2 timeouts/1 incident`, touch `2/2/0`, and IME `1/1/0`. The new real fixture test `node --test --test-name-pattern='touch and IME reliable writes retain' web-client/js/input-recovery.test.js` first failed its safe touch event-ID assertion, then (after touch attribution) failed because the IME timeout had no incident. The root probe remained the independent RED reproduction.
3. Finding 3: `node --test web-client/js/input.test.js` after adding the prefix-attack test reported **103 tests, 102 pass, 1 fail**; `runtime-phase:active:PASSWORD_CANARY`, `media-state:active:TEXT_CANARY`, and a long suffix were retained. The targeted RED was the expected exact bounded reason list versus those leaked suffixes.
4. Finding 4: `node --test --test-name-pattern='accepted mobile text records its gate' web-client/js/input.test.js` failed because the accepted sequence was `dom-received, transport-send`, missing `gate`.

### GREEN evidence

- `node --test web-client/js/input-trace.test.js web-client/js/input-recovery.test.js web-client/js/input.test.js web-client/js/diagnostic.test.js web-client/js/webrtc.test.js`: **373 tests, 373 pass, 0 fail**.
- `node --test web-client/js/mobile-text-input.test.js web-client/js/touch-input-adapter.test.js`: **57 tests, 57 pass, 0 fail**.
- `NODE_PATH=/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/node_modules node --test signal-server/test/web-asset-build.test.js`: **5 tests, 5 pass, 0 fail**.
- `set -o pipefail; node --test web-client/css/*.test.js web-client/js/*.test.js 2>&1 | tail -20`: **771 tests, 771 pass, 0 fail**.
- `python3 .superpowers/sdd/2026-09-07-input-recovery-observability-plan/root-trace-browser-probe.py` now reports `allDomSendsHaveAssociatedAck=true`, four safe send/ACK pairs with event IDs `1..4`, and `pendingAckCount=0`.
- `python3 .superpowers/sdd/2026-09-07-input-recovery-observability-plan/root-mobile-incident-probe.py` now reports physical **2 accepted writes/2 ACK timeouts/1 `input-ack-timeout` incident**, touch **2/2/1**, and IME **1/1/1**. All incidents retain `connectionAttemptId='recovery-attempt-1'` and `leaseEpoch=7`.
- `node --check` passed for all three changed production JavaScript files; `git diff --check` passed.

### Privacy, stress, correlation, and handoff evidence

- The new exact-prefix test rejects `PASSWORD_CANARY`, `TEXT_CANARY`, and a 100-repeat `SUFFIX_CANARY` from serialized diagnostic state. Existing collector and recovery tests continue to reject raw text, key/code, payload, coordinates, DOM labels/values, lease IDs, and tokens.
- Existing collector regressions remain green for the 64 unresolved-hash slot bound under ring churn, 256-entry/64 KiB snapshot bounds, 256 reliable ACK waiters, actual receiver acceptance versus status, late ACK classification, and stale same-ID identity not clearing the current waiter.
- Actual touch gesture sends retain only the active pointer’s event ID; mobile text retains only the active DOM event or one deferred drain ID. No event-ID history map or unbounded lifecycle structure was added. Intentional move/wheel and toolbar sends remain unassociated.
- Nested physical keyboard/pointer sends restore their enclosing synchronous scope, while top-level DOM listeners clear it. Lifecycle/ACK/recovery records still clear context, preventing stale DOM attribution after dispatch. A trace hook that throws after a send leaves the original result intact and invokes the business callback once.
- Accepted mobile text is verified through real Input + MobileTextInput + RemoteKeyboardController + collector hooks as `dom-received → gate(accepted) → transport-send`, with the same event ID on all three records. The touch/IME timeout test uses the real Input adapters and collector, not wrapper-only assertions.
- Diagnostic deferred handoff, classic global Input resolution, and WebRTC lifecycle evidence from the initial Task 2 report remain unchanged; this round does not add upload, Host, Signal, Quartz, or live/public behavior.

### Self-review and concerns

- Changes remain tracing-only. Touch changes add callbacks and bounded attribution around existing sends; gesture recognition, send results, recovery ownership, control authorization, wire envelopes, lease behavior, and protocol fields are unchanged. The separate Task 1 normal-composition UI follow-up remains untouched.
- All evidence is offline Node/VM or the supplied offline Chromium probes. Physical devices, system IME, native Quartz effects, live WebRTC, public origin/tunnel, and production watcher behavior are **NOT RUN** and are not claimed here.
- The existing WebRTC VM `fetch is not defined` STUN fallback warning remains a baseline offline warning; it caused no test failure. Asset build uses the pre-existing `NODE_PATH` dependency tree; no dependency install or service operation was performed.
- Parent review remains the acceptance gate. The report is append-only and the supplied probe fixtures were not modified.

### Fix-round scoped commits

- `53ad8bd` — `fix(diagnostics): preserve mobile input trace identity`.
- Pending report commit: `docs(diagnostics): record Task 2 fix-round evidence`.

## Fix round 2 — deferred focus attribution (FIX_BASE `6ee8d02`)

### Review finding and covering files

The remaining finding was that delayed long-press, drag-start, and serial text-drain callbacks carried an event ID after their DOM scope ended but no originating focus category. `refreshEligibility` therefore evaluated `_traceIncidentEligible(undefined)` and disabled timeout incidents. The fix carries the validated `desktop` category on each active touch pointer and the validated `mobile-text` category on the single active text drain, while each deferred send recomputes eligibility against current visibility, media/gate, active lease, and draft state. Nested external actions now pass the enclosing focus category through the mobile wrapper; null event IDs remain deliberately unassociated.

- `web-client/js/input.js`: pass the enclosing focus category alongside the event ID into nested mobile actions.
- `web-client/js/mobile-text-input.js`: retain one bounded drain focus category, clear it with the drain timer, and pass it to every deferred delete/text send while refreshing current eligibility.
- `web-client/js/touch-input-adapter.js`: retain `desktop` attribution only on active pointer entries and pass it through long-press, drag-start, and tap deferred commits; null move/wheel/toolbar sends remain unassociated.
- `web-client/js/input-recovery.test.js`: real Input + touch/mobile adapters + collector regressions for long-press, drag-start, 17-step drain, and current-hidden negative eligibility.
- `web-client/js/touch-input-adapter.test.js`: verifies physical sends receive `focusKind='desktop'` while intentional unassociated actions receive no focus category.

### RED evidence

- Unchanged supplied probe: `python3 .superpowers/sdd/2026-09-07-input-recovery-observability-plan/root-deferred-incident-probe.py` exited **1**. It reported long-press `sends=1, ackTimeouts=1, incidents=0`; drag-start `1/1/0`; and deferred-drain `17/1/0`, with event IDs retained but no incident. It failed with `AssertionError: deferred user writes timed out with no incident`.
- New real fixture regressions before the production change: `node --test --test-name-pattern='deferred (long-press|drag-start|mobile text drain)' web-client/js/input-recovery.test.js` reported **3 tests, 0 pass, 3 fail**; each failed at the expected `incidents.length` assertion (`0 !== 1`).
- Focus handoff regression before the production change: `node --test --test-name-pattern='touch dispatch attributes' web-client/js/touch-input-adapter.test.js` reported **1 test, 0 pass, 1 fail**; actual associated calls were `[[1, undefined], [2, undefined], [null, undefined], [null, undefined], [null, undefined]]`, missing `desktop` on the physical sends.

### GREEN evidence

- `node --test --test-name-pattern='deferred (long-press|drag-start|mobile text drain|touch send)' web-client/js/input-recovery.test.js`: **4 tests, 4 pass, 0 fail**.
- `node --test --test-name-pattern='touch dispatch attributes' web-client/js/touch-input-adapter.test.js`: **1 test, 1 pass, 0 fail**.
- `node --test web-client/js/input-recovery.test.js web-client/js/input.test.js web-client/js/mobile-text-input.test.js web-client/js/touch-input-adapter.test.js`: **191 tests, 191 pass, 0 fail**.
- Re-ran the unchanged probes: `root-trace-browser-probe.py` green with `allDomSendsHaveAssociatedAck=true` and four event-ID-correlated send/ACK pairs; `root-mobile-incident-probe.py` green with physical `2/2/1`, touch `2/2/1`, and IME `1/1/1` (writes/timeouts/incidents); `root-deferred-incident-probe.py` green with long-press `1/1/1`, drag-start `1/1/1`, and deferred-drain `17/1/1`.
- `node --check web-client/js/input.js`, `node --check web-client/js/mobile-text-input.js`, `node --check web-client/js/touch-input-adapter.js`, and `git diff --check` passed. The prior round’s final Viewer **771/771** and asset build **5/5** remain unchanged; this narrow round did not rerun unrelated full suites per the dispatch.

### Current-state, privacy, and non-interference evidence

- The real hidden-state regression accepts the deferred touch write and records its ACK timeout, but produces **zero** incident callbacks after `document.hidden` becomes true before the deferred send. This guards against caching the originating eligibility decision.
- The positive regressions prove event IDs and current-identity timeout incidents for delayed long-press, drag-start, and the 17th serial delete after the first 16 are ACKed. Existing physical DOM correlation and later unassociated toolbar-action tests remain green, proving nested focus preservation and stale-context clearing.
- Only one focus value is retained per active touch pointer and one focus value per active text drain; no event-ID→context history or unbounded lifecycle structure was introduced. Existing bounded collector privacy/stress coverage remains green, and no raw text, key/code, payload, coordinates, DOM value/label, lease ID, token, or password is serialized.
- No gesture recognition, business callback/send result, wire/control protocol, lease authorization, recovery ownership, or Task 1 UI behavior changed. Physical device, system IME, Quartz/native effects, live WebRTC, public origin/tunnel, and watcher acceptance remain **NOT RUN**.

### Fix-round-2 scoped commit

- `8363b79` — `fix(diagnostics): retain deferred input focus attribution`.

## Fix round 3 — nested touch focus handoff (FIX_BASE `af69a58`)

### Finding and covering files

The final rereview found that the outer deferred touch scope supplied `focusKind='desktop'` to `_withInputTraceEvent()`, but that helper retained only the event ID. The nested `runMobileEditingAction()` therefore saw no focus category and the MobileTextInput wrapper defaulted the same physical touch send to `mobile-text`. `_withInputTraceEvent()` now validates the finite focus-kind allowlist, retains the selected kind with the event ID for the nested scope, drops explicitly invalid categories rather than inheriting stale focus, and preserves the existing context restore/clear and current-state eligibility behavior.

- `web-client/js/input.js`: bounded focus-kind allowlist and scoped context retention in `_withInputTraceEvent()`.
- `web-client/js/input-recovery.test.js`: real Input + TouchInputAdapter + MobileTextInput + collector regression that clears the original DOM scope before a deferred long-press send, then observes the nested scope at the actual WebRTC send boundary; invalid-category negative coverage is included.

### RED evidence

- `node --test --test-name-pattern='deferred touch dispatch retains desktop focus through nested mobile scope' web-client/js/input-recovery.test.js` exited **1** on `6ee8d02/af69a58`: the actual nested send had `focusKind=undefined` where the test required `desktop`, while the original `_inputTraceContext` had already cleared after pointerdown.
- After strengthening the invalid-category case with an inherited `desktop` context, `node --test --test-name-pattern='invalid nested focus categories' web-client/js/input-recovery.test.js` exited **1** before the final correction: the invalid option incorrectly retained `desktop` (expected no focus and `incidentEligible=false`).

### GREEN evidence

- `node --test --test-name-pattern='deferred touch dispatch retains desktop focus through nested mobile scope|invalid nested focus categories' web-client/js/input-recovery.test.js`: **2 tests, 2 pass, 0 fail**.
- `node --test web-client/js/input-recovery.test.js web-client/js/input.test.js web-client/js/mobile-text-input.test.js web-client/js/touch-input-adapter.test.js`: **193 tests, 193 pass, 0 fail**.
- `python3 .superpowers/sdd/2026-09-07-input-recovery-observability-plan/root-deferred-incident-probe.py`: **exit 0**; unchanged probe reports long-press `1/1/1`, drag-start `1/1/1`, and deferred-drain `17/1/1` for sends/ACK timeouts/incidents.
- `node --check web-client/js/input.js` and `git diff --check` passed.

### Correlation, privacy, and scope evidence

- The new real deferred-touch test records the physical `desktop` focus at the actual nested WebRTC send boundary, verifies the original DOM context is `null` before the timer fires, and confirms the nested send retains the originating DOM event ID. This covers the mobile wrapper seam rather than only the outer TouchInputAdapter callback.
- Explicitly invalid focus categories are removed from the nested context and cannot authorize incidents, even when a stale enclosing context had `desktop`; valid categories remain finite and bounded. No map, history, gesture state machine, business send/result, protocol field, or recovery ownership changed.
- Existing focused privacy, ACK identity, ring/hash bounds, unassociated-action, current-visibility, callback non-replay, and normal draft/composition regressions remain green from the 193-test matrix. No raw text, key/code, payload, coordinates, DOM value/label, lease ID, token, or password is serialized.
- Evidence remains offline Node/VM and supplied offline Chromium only. Physical device, system IME, Quartz/native effects, live WebRTC, public origin/tunnel, and watcher acceptance remain **NOT RUN**. Task 1’s separate normal-composition notice-only UI issue remains untouched.

### Fix-round-3 scoped commit

- `c408d1d` — `fix(diagnostics): retain nested touch focus attribution`.
