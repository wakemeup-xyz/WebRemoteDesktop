# Explicit Viewer first-frame timer state

2026-10-18. Bounded product correction within the user's authorized reliability implementation and acceptance. The user has already selected brainstorming plus writing-plans and continuous implementation without repeated planning approval.

## Evidence and desired result

The second actual guarded baseline of deployed product `dfb15434e79da90b803b763c533836e16c080c71`, using corrected tool revision `59bca14209eed299b0e94da58decb8b85e5ce70c`, reached the normal guarded Start action and sustained relay media. Its result remains INCOMPLETE: startup deadline elapsed at 47.306 seconds of observation, with zero qualified baseline time and samples. All 38 input-ready startup rows between 10.267 and 47.286 seconds failed the existing gate on exactly `firstFrameTimerHandlePresent:null`; consecutive frame progress and other per-row startup conditions were present. This does not establish overall qualification or cleanup success.

`WebRTC` does not declare its own `_firstFrameTimer` initially. The normal startup episode uses the separate startup media budget and returns from `beginFirstFrameDeadline` before creating the legacy timer. `clearFirstFrameDeadline` only assigns null when an existing truthy timer is cleared. The unchanged passive sampler intentionally reports an absent own property as unknown (`null`) and an own null handle as absent (`false`). The unchanged ordinary gate requires literal false. The missing initial state makes a successfully connected new path remain unqualifiable.

## Selected design and alternatives

Declare `_firstFrameTimer: null` in the production `WebRTC` state beside the first-frame/paint state. Retain the existing owner, startup episode path, timer scheduling, cancellation and attempt fences. The property represents the legacy timer only; it must never imply that a startup budget is inactive or that media/input is ready.

Changing the sampler to infer absence would hide a producer contract gap. Weakening the gate to accept unknown would undermine the fail-closed observation contract. Creating and clearing a synthetic timer would alter the lifecycle unnecessarily. Explicit initialization is the smallest product correction and keeps the consumer honest.

## Global constraints

- Change only `web-client/js/webrtc.js` and `web-client/js/webrtc.test.js` for the implementation task; this spec and its plan are separate root-owned documents.
- Keep the passive sampler, ordinary runner, immutable supervisor and all readiness/continuity/cleanup predicates byte-for-byte unchanged.
- Keep authority, admission, resume/proof restrictions, timeout/retry budgets, quality, codec, resolution, FPS, bitrate and network policy unchanged.
- Preserve both actual failed attempts and their one-use markers. A later real attempt requires a distinct reviewed deployment and operational context.
- Run only offline Node VM tests for this task. No browser, network, native input, process inspection, service/build/install or runtime configuration operations by workers.
- Preserve the four pre-existing dirty documents, node_modules link, primary index, W2 files, tunnel/watch and prior evidence.
- Business input, native visible effect and physical qualification remain NOT_RUN; no numeric input-to-picture latency may be inferred from RTT or video FPS.

## Verification contract

Load the actual production WebRTC source without assigning `_firstFrameTimer` in the test fixture. Verify that a fresh instance owns a null handle and that the unchanged production sampler projects false. Exercise the real startup-budget delegation path, proving the legacy handle remains absent without changing its budget. Exercise the real legacy scheduling and clearing path, proving that the sampler projects true while armed and false after cancellation. Also preserve a negative sample with the own property deliberately deleted: the sampler must still report null. These are producer/consumer behavior tests, not source-text assertions or a fabricated ready sample.

Demonstrate the focused regression failing before the implementation, passing afterward, then run the existing affected WebRTC and passive sampler suites once. Independently review the task and complete increment before deployment. Do not turn offline success into runtime acceptance.

## Runtime and remaining work

This correction changes the Viewer asset, so publishing it requires a fresh reviewed build/deployment record; old product asset hashes cannot be reused. Root owns that operation under the user's existing maintenance authorization, preserving tunnel/watch and restoring health if local reload is necessary. The separate process observer diagnostics problem remains open and must not be retroactively excused. Fresh desktop capture cadence, ordinary reconnection scenarios, long-session continuity and true input-to-visible-effect measurements remain separate acceptance items.
