# Task S1 heartbeat independent implementation review

Date: 2026-10-17. Exact reviewed source range: `514422b649ad519c749026a7c4a07eb1dd916607..d1166abe43f3292f05f3f49ba75f488fd348c94f`.

## Findings and verdicts

No actionable P0–P3 correctness, architecture, privacy, or source/spec-compliance finding identified in this increment.

- **Spec compliance: PASS.** The implementation satisfies the admitted-main-Viewer-only observation contract and the accepted shutdown-order correction.
- **Code quality: PASS.** The observer is bounded, diagnostic-only, separately owned, and does not modify admission, lease, resume, media, input, transport, or heartbeat timer behavior.

These verdicts cover the five source/test files in the supplied complete 42,577-byte review package. They do not certify production loading, a real Viewer close, causal attribution, or long-session continuity. The parent reported the primary runtime as `9e57bf4`; this review did not inspect or change that runtime.

## Independent verification

Read the complete package, task brief, implementation report, heartbeat spec and plan, accepted design review, actual implementation, relevant admission/disconnect and server lifecycle paths, runtime observer, test fixtures, and installed Engine.IO event implementation. The implementation report was treated as a claim to verify, not as test evidence.

Reviewed fixture safety before execution: Engine.IO is exercised via its prototype without construction/open/listen; the actual server fixture injects both Terminal owners, stubs the spawn-helper mutation, rejects child-process calls, and never listens. Signaling uses the existing in-memory FakeSocket/makeIo adapters. Runtime timers are injected in runtime tests.

Executed independently:

- `node --test signal-server/test/viewer-heartbeat.test.js signal-server/test/runtime-observability.test.js` — **18 passed, 0 failed**.
- `node --test --test-name-pattern=heartbeat signal-server/websocket/signaling.test.js` — **3 passed, 0 failed**, including the two new admission tests and the existing heartbeat-expiry authority regression.
- `git diff 514422b649ad519c749026a7c4a07eb1dd916607 d1166abe43f3292f05f3f49ba75f488fd348c94f --check` — **PASS**.
- Compared all five source/test paths against `d1166ab` after HEAD advanced to the parent's documentation commit `58ad766`; **no differences**. The executed source therefore matches the requested review target.

The broader 115-test result in the implementation report was not independently rerun. RED chronology cannot be proven from the final diff alone and is not claimed as independently reproduced.

## Contract checks

1. `signaling.js:1103–1105` attaches only in the admitted main Viewer branch, after claim/rebind/supersession and before welcome. The map predicate is identity-only and contains no admission authority. Exceptions cannot interrupt welcome. The actual signaling tests cover ordinary/proof acceptance, rejection, proof replay, stale resume, supersession/rebind, Host/relay exclusion, missing engine, and throwing observer.
2. `viewer-heartbeat.js:84–114` observes only packet type and bounded flush entries. No payload, options, raw packet, batch, identity, request, URL, or error content is retained or projected. Installed Engine.IO confirms packetCreate precedes queue insertion, flush precedes transport.send, and received pong precedes the library's refresh. Output makes no delivery or RTT claim.
3. `viewer-heartbeat.js:146–188` captures terminal time and safe state immediately, merges the later Engine reason within one microtask, rechecks map ownership, sets the finalized guard, removes exact own handlers, clears owner/engine/predicate/ring references, removes registry ownership, then serializes/logs. Product listeners remain intact. Tests cover namespace-first and Engine-first observations, both product/observer callback orders, old scopes, copied callbacks, queued close followed by shutdown, throwing logger, and serialization failure.
4. Retention is bounded to eight active registry records and 32 heartbeat entries each. Message events only increment saturating counters; flush scans at most 64 entries. The million-message test and overflow test exercise these bounds. No new timer, retry loop, socket, connection, or process probe is introduced.
5. Serialization is constructed from fixed keys/enums and validated numeric leaves, with nullable missing evidence, a 4096-byte independent JSON cap, ASCII-only output, and fixed minimal fallback. Canary/getter tests and maximum-width schema budget tests pass. Fractional runtime millisecond values are deliberately floored; counters remain integer-validated. Runtime output excludes RSS and arbitrary snapshot keys.
6. `server.js:132–135` registers heartbeat close/error disposal before binding runtime disposal; `server.js:494–497` stops heartbeat first on explicit runtime close. Actual no-listen server tests verify snapshot → heartbeat cleanup/log → runtime stop for all three paths, preserve the product disconnect handler, and leave zero owned Engine callbacks. Existing server/io/Terminal close behavior is unchanged.

## Architecture and documentation

The small registry module owns projection and listener lifetime; signaling owns admission and passes only an observation hook; server owns lifecycle; the existing runtime sampler remains the sole sampling mechanism. There is no competing authority store or recovery path.

The active heartbeat spec and plan document the schema, event semantics, coverage limitations, privacy, budgets, and cleanup order. The private implementation report accurately separates offline verification from production NOT RUN. Deployment/status documentation and persisted review-anchor updates remain the parent's explicitly assigned work; this review does not mark the whole task or live acceptance complete. No source finding is inferred from that planned parent-owned documentation step.

Only this private review artifact was written. No source/index/dependency edits, build, npm test/pretest, browser/network/native action, service/tunnel operation, or subagent was used.
