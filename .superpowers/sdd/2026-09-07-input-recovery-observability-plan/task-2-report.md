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
- Report-only commit is intentionally deferred until this appendable report is written and verified; no merge, push, or main-checkout mutation was performed.
