# Guarded ordinary recovery R1 independent review

2026-10-18. Findings first. **Changes requested before implementation** for findings 1–2; finding 3 is a small plan correction. No production action is authorized by this review.

## Findings

### P2 — The selected Playwright API replaces the page WebSocket, so the specified native-close qualification is not the operation the runner will execute

Primary locations: `/tmp/wrd-ordinary-recovery-design-draft/R1/2026-10-18-guarded-ordinary-recovery-design.md:136-138`; plan `2026-10-18-guarded-ordinary-recovery-plan.md:263-281`.

The design installs `route_web_socket` before final navigation, forwards through `connect_to_server`, then treats `ws instanceof WebSocket` plus `ws.close(...)` as a check and close of the current **native** WebSocket. Installed Playwright 1.59.0 does not preserve that premise. Its `driver/package/lib/server/dispatchers/webSocketRouteDispatcher.js:104-109` installs `webSocketMockSource` as an init script. In `driver/package/lib/generated/webSocketMockSource.js:93,114-145,329-330`, the original native constructor is captured privately and `globalThis.WebSocket` is replaced with a class extending `WebSocketMock`. The wrapper constructs its private native upstream at lines 236-254; normal routed messages go through the Playwright binding. Its public `close()` at lines 207-215 is wrapper behavior and supplies `wasClean:true` to the route binding. The proposed `instanceof WebSocket` check succeeds for that wrapper; it is not evidence of native identity.

This does not establish that the supported routing API is unsafe or that ordinary server admission/resume is altered. It does establish a mismatch in the load-bearing fault/evidence claim: both recovery baselines and the injected close use a routed WebSocket wrapper, and the close metadata cannot be described as a direct native transport observation. API existence alone does not reconcile it. Pure fake-route tests as currently planned also cannot expose this discrepancy.

Resolve explicitly before Task5: either specify and review this as a Playwright-routed signaling stimulus (including wrapper/forwarding effects, synthetic close metadata and the narrower interpretation of recovery evidence), or select a supported sequence that demonstrably preserves the original native target and state what future retries use. Do not reach into Playwright private `_ws` internals. Keep the fresh no-route continuity run separate and retain the existing prohibition on claiming WS1006 reproduction. Update spec, plan, fixed evidence labels and verification expectations consistently; no live experiment was run in this review.

### P2 — Host replacement termination has no defined observation producer

Primary locations: design `:116,126-128,181`; plan `:198,253-254` and the exact event schemas at `:88-90`.

The runner must terminate on Host replacement and classify expiry/reset in an uncontested interval, but its permitted identity projection contains only session/socket/admission, and its selected log events are only grace-started, grace-expired, rebind-confirmed, rebind-failed and reset-completed. The unchanged sampler exposes no Host identity (`scripts/passive_session_sampler.js:347-387`). The separate startup projection can observe `hostOnline`, but a boolean cannot identify a replacement. Current signaling does emit `signal_socket_disconnected` with `meta.role:'host'` (`signal-server/websocket/signaling.js:1961-1969`), yet that event is outside the selected schema. Host replacement itself changes `connections.host` while it stays online and has no matching selected lifecycle event (`:1033-1067`). No periodic status/Host identity reader or conservative Host-disconnect alarm is specified among the new producers.

Concrete gap: after the old socket's grace expiry and reset completion, a Host replacement can occur while the disposable Viewer is disconnected. Ordinary owner/session generation remains valid. Reconnection can obtain a new lease and fresh media from the new Host. The allowed grace/reset events and final browser gates can all satisfy the after-grace PASS conditions even though the required Host-replacement stop condition occurred. The manifest being unchanged only means the root attestation file did not change; it does not detect this runtime transition.

Define a bounded producer and exact consumer behavior. A minimal source-compatible route is to use the existing `/api/status` Host identity privately (`server.js:239-244`, `signaling.js:2009-2016`) at named points/ticks, plus a conservative bounded Host-disconnect observation from the existing log for intervals the browser cannot observe. Alternatively define an equally explicit limited event contract. Keep raw Host IDs in memory only; missing/change/coverage ambiguity must stop with the existing fixed reason. Add a fake-log/status test where the Host changes during the after-grace outage while ordinary owner, build and final gates remain valid, and ensure it cannot PASS. This needs no new control authority, terminal admin access or broad observability feature.

### P3 — Task6 requires a source test addition outside its exclusive owned paths

Primary location: plan `:287-290`, against the mandatory ownership rule at `:38`.

Task6 owns only the new review document and the C5 addendum (plus a private requirements patch). It nevertheless instructs that worker to **add** guard-owned real-handler within/after-grace regression scenarios. Those additions require a test-file write, normally `signal-server/websocket/viewer-admission.integration.test.js`, which is not in its owned list. A worker following the exclusive-path rule cannot complete that requirement; a worker following the checkbox writes outside its handoff.

Move the regression addition into Task1 or Task3, which already own that integration test, and make Task6 only run/review it; or explicitly grant Task6 that exact test path. No new test framework or wider suite is needed.

## Checked scope and non-findings

Read the R1 revision report, full R1 spec and plan, both root assessments, and the relevant unchanged Signal admission/runtime/auth/signaling/lease, passive helper/sampler, logger and installed Playwright API/implementation files. Verified all four entries in R1 `SHA256SUMS` successfully. Reviewed artifacts:

- Design SHA256: `7a12f3ecccca0c688d581d0a8420341a0c4d697ebb38f2afd1b58cb530566f5c`.
- Plan SHA256: `ef1dc47b527c3aed162aab4327e4d2b1ef9e403142837700c3360261cb5569d8`.
- Revision report SHA256: `6a4af224d1ba47b5298bcba970e11b17e6a70ba0a09f4303832ab574bc8aec67`.

No additional concrete authority defect was found in the specified human-intent fence, retained human/legacy owner, capacity priority, first-consume epoch/vacancy checks, consumed lost-welcome retry or unchanged ordinary resume semantics. The default/proof separation and rejected-guard nonmutation requirements are coherent at design level. In particular, a later human issue invalidates pending guarded initial tickets, while current admitted-owner recovery remains ordinary until actual human admission. The planned expiry event can bind the reset-only epoch when read from the resulting lease snapshot, and rebind epoch must come from the already-confirmed active lease as specified. The current manager factory/start/launch/stop API sequence matches the existing helper; no additional lifecycle API mismatch was established.

This is a static architecture/spec+plan review, not implementation approval or runtime acceptance. I did not inspect the other worker's mutable `webrtc.js`, `input-signaling-continuity.test.js` or `webrtc.test.js` patch. No module imports/execution, tests, builds, browser/network/service/native/proof/tunnel operations or tracked/index writes occurred. The only new file is this private review report. Root's Host/P1/P2 source and deployment evidence remain separate prerequisites; I do not independently attest their implementation or loading.
