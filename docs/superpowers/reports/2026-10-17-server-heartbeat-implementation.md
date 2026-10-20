# Task S1 implementation report — 2026-10-17

Status: DONE for implementation and offline verification. Production load and real-session acceptance: NOT RUN. Independent implementation review is still required before deployment.

## Commit and ownership

- Commit: `d1166abe43f3292f05f3f49ba75f488fd348c94f` — `feat(observability): trace admitted viewer heartbeat closure`.
- Exactly five source/test paths committed: `signal-server/lib/observability/viewer-heartbeat.js`, `signal-server/test/viewer-heartbeat.test.js`, `signal-server/server.js`, `signal-server/websocket/signaling.js`, `signal-server/websocket/signaling.test.js`.
- Index returned empty after commit. Preexisting README, runbook, requirements, review-anchor and concurrent parent report changes preserved; node_modules symlink preserved. No repository docs staged by this task. This task report remains available for the parent's documentation ownership.
- Applied the git-commit skill for the authorized commit. No subagents used.

## Implementation

`createViewerHeartbeatRegistry` provides injected monotonic/wall clocks, logger and existing-runtime snapshot getter; returns attach and synchronous idempotent stop. Default monotonic time is performance.now. WeakSets prevent repeated enrollment of an admitted Socket or shared Engine without retaining dead owners strongly. The strong recorder Set holds at most eight objects. Overflow synchronously finalizes the oldest diagnostic with capacity coverage/current=false and cannot reject admission.

Each admitted recorder owns exact callback references for Engine packetCreate/packet/flush/close and namespace disconnect. It observes only heartbeat type and aggregate message counts. It stores numeric timestamps/counts and a 32-entry heartbeat-only ring; no packet/batch objects or payloads are retained. Flush inspects at most 64 array entries and explicitly flags incomplete scans. Aggregate counts, ring sequence and overwrite counts share a small tested saturating primitive; regular mutable counters are private. The primitive is exported solely as a pure function, with no mutable state exposed.

First terminal callback captures monotonic/wall association, scope and transport buffer/writable/state immediately. A single queued microtask permits the same Engine close dispatch to contribute its fixed reason, including namespace-first ordering. Scope is rechecked before finalization. Ordinary finalized closures prefer an actually observed Engine reason. Explicit shutdown emits shutdown/server-shutdown even if a terminal microtask was pending. Callbacks copied before exact off become harmless after finalization. Cleanup and record removal precede serialization/logger invocation; logger throw cannot prevent cleanup and triggers no retry.

The output has fixed schema, compact ASCII JSON, prefix WRD_SIGNAL_HEARTBEAT, bounded numeric fields, one log maximum per recorder and independent 4096-byte JSON cap. Projection/serialization cap failures emit only small fixed metadata with capacity coverage. Prohibited identity/auth/request/URL/payload/error fields are never read for projection. Safe transport getters and runtime snapshot exceptions become null/unknown/error coverage. Existing fractional runtime millisecond values are explicitly floored after finite/range validation; counts remain exact integers. Node output excludes RSS, process and arbitrary snapshot keys. No delivery/RTT/root-cause conclusion is produced.

Production setupSignaling invokes the optional observer only after accepted ordinary/proof admission, claim/rebind/supersession, and before connected welcome. Callback errors are contained. Host, relay, rejected token/proof/resume/proofless admission paths do not attach. Existing proof, viewer generation, disconnect grace, lease, reconnect, timer, media and authority logic is unchanged.

Production createServerApp creates the registry using runtimeObserver.snapshot. HTTP close/error heartbeat stop callbacks are registered BEFORE bindRuntimeObserver. runtime.close synchronously stops heartbeat before stopping runtimeObserver, then follows the existing Terminal close behavior. No runtime.js timer changes were made.

## RED evidence

Before creating the actual module or wiring, ran:

`node --test signal-server/test/viewer-heartbeat.test.js signal-server/websocket/signaling.test.js`

Captured `/tmp/wrd-heartbeat-red.txt`: the new actual-module test failed because the actual module did not exist; the injected accepted-Viewer admission test independently failed with actual [] against the accepted Viewer expected attachment. These were the intended missing-module/wiring failures, not syntax or installed-dependency errors. Existing signaling checks otherwise executed. Initial tests were added before implementation.

## Final GREEN evidence

- `node --test signal-server/test/viewer-heartbeat.test.js`: 14/14 PASS, 0 failures, approximately 0.42 seconds. Output `/tmp/wrd-heartbeat-module-green.txt`.
- `node --test signal-server/websocket/signaling.test.js signal-server/test/runtime-observability.test.js`: 115/115 PASS, 0 failures, approximately 23.28 seconds. Output `/tmp/wrd-heartbeat-green.txt`.
- `node --check signal-server/lib/observability/viewer-heartbeat.js`: PASS.
- `node --check signal-server/websocket/signaling.js`: PASS.
- `node --check signal-server/server.js`: PASS.
- `git diff --check` and staged diff check: PASS. Full source and test diff self-reviewed before the exact-path commit.

Module test coverage includes:

1. Exact heartbeat ages/counts and exact own off preserving product listener counts; close once and private payload canaries.
2. Installed Engine.io Socket prototype actual sendPacket/flush/onPacket, using Object.create and fake transport/server, without constructor/onOpen/schedulePing/listen. packetCreate precedes queue push; nonwritable retains the queue; flush precedes transport.send; incoming pong reaches observer and only the library's own refresh runs. Observer leaves method/timer references unchanged.
3. Namespace-first immediate buffer capture, Engine reason enrichment, product replacement/rebind before old callbacks finish, current=false old scopes, observer-before-product and product-before-observer callback orders.
4. Engine-first, namespace-only, repeated close, shutdown-before-queued-finalizer, copied callbacks after cleanup and shutdown all log at most once and remove observer callbacks.
5. Thirty sequential enrollments demonstrate eight-recorder capacity and no retained-listener growth. One million message events produce only aggregate counts and no heartbeat-ring growth. One hundred heartbeat events leave ring32 with ringDropped68.
6. Getter canaries on IDs/request/handshake/auth/URL/data/options, unknown reason/description, NaN/infinity/oversized values, invalid writable/name/buffer and incomplete flush. Entry 65 is a throwing getter proving the flush scan never reaches it.
7. Real runtimeObserver injected fake-clock samples prove whitelist projection with no new timer and no sampler start/stop by registry; actual application lifecycle tests also verify fractional milliseconds project as integers.
8. Actual createServerApp, actual Socket.IO namespace registered connection callbacks, fake admitted Viewer, injected terminal owners and mocked child-process entry points/pty-helper setup. No HTTP listener/client or native probes. All three paths runtime.close/HTTP close/HTTP error prove snapshot -> heartbeat log/cleanup -> runtime stop, zero observer callbacks and preserved product disconnect handler. Repeated close is harmless.
9. Fixed enum/source/current/proof combinations and maximum numeric widths serialized against the actual emitted key set; all remain below 2200 bytes. Transport/state/node enum alternatives and numeric null alternatives also checked. Independent event bound <=48 bytes, JSON <=4096 and complete line <=4120 checked.
10. Failing clocks, missing engine, failing runtime snapshot/logger/serialization; cleanup occurs without retries or raw canaries. Explicit mutation/timer spies reject observer calls to sendPacket/flush/close/connect/transport.send/setTimeout/setInterval.
11. Shared production saturation primitive tested at zero, MAX-1 and repeated MAX; maximum never wraps and counterClipped changes only on clipping.

Signaling additions verify post-map/pre-welcome attachment; authenticated token rejection; one-use proof replay rejection; ordinary explicit generation/resume/stale-resume results; human supersession; old scope false; strict proofless/relay rejection; Host exclusion; missing engine and observer throw still welcome. Existing 113 signaling/runtime cases remain green alongside the two added admission cases.

## Self-review and limits

Self-review corrected shutdown source precedence, deliberately floored fractional runtime values, strengthened snapshot getter exception handling and revoked-array protection, eliminated duplicate strong attachment arguments, added shared saturation boundary tests, and verified HTTP listener registration order by actual runtime execution. No open implementation concern identified by self-review; this is not a substitute for independent review.

Coverage begins after admission and stays partial; incomplete flush scans cannot prove absence of a handed-off ping. Ages are server monotonic event ages, not RTT/one-way latency. One runtime snapshot cannot reconstruct earlier scheduling. No input/media/service/auth behavior or heartbeats/timers were patched. No browser, network request, server listen, service restart, native capture/input, tunnel operation, build, npm test/pretest or dependency installation was performed. Production process does not yet contain this new module/wiring; production loaded NOT RUN, actual Viewer closure capture NOT RUN, real long-session acceptance NOT RUN. Tunnel untouched.
