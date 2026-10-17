# Server heartbeat observer independent design review

Review date: 2026-10-17. Target: the supplied `/tmp/wrd-server-heartbeat-observer-brief.md` and the installed source in `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop` (parent-supplied HEAD 32ee30e).

## Verdict

Spec: APPROVE after the single correction below. Quality: APPROVE after the same correction. This is a justified, bounded diagnostic addition: existing namespace disconnect logging cannot distinguish ping creation, flush intent and received pong. It does not establish delivery or root cause. No auth/reconnect, transport configuration or tunnel changes are needed.

## Actionable blocker: register fallback disposal before runtime stop

`server.js:131` currently calls `bindRuntimeObserver(server, runtimeObserver)`; `lib/observability/runtime.js:110–113` registers the runtime stop on HTTP `close` and `error`. Appending a heartbeat close fallback later means the existing runtime stop executes first, contradicting the required shutdown order and the proposed wiring test. Changing only `runtime.close()` does not cover direct HTTP close.

Precise fix: create the heartbeat registry after creating runtimeObserver, then register its synchronous, idempotent HTTP `close` disposal callback BEFORE calling `bindRuntimeObserver`. Keep the explicit `runtime.close()` order as heartbeat registry stop, runtimeObserver stop, existing terminal close. If adding an HTTP `error` fallback for matching disposal, register it in that same earlier position and keep it strictly diagnostic. Do not remove/reorder unrelated listeners, call server/io/engine close, or alter terminal cleanup. `runtime.js` need not change. Test actual server wiring without listening: separately cover explicit runtime.close, HTTP close and any added error fallback; use ordered snapshot/stop markers, and verify one log and zero remaining owned callbacks after an already-queued finalizer executes.

The parent has accepted this correction and will incorporate it before dispatch. With it incorporated, there are no remaining design blockers.

## Source verification and acceptance feasibility

- Installed Engine.IO 6.6.9 `socket.js:85–116, 306–321, 356–407` confirms packetCreate before buffer insertion; flush before buffer reset and transport.send; packet before pong timer refresh; buffer clearing on nextTick after close. The brief correctly limits flush evidence to handoff intent.
- Installed Socket.IO `client.js:247–265` calls namespace `_onclose` from its earlier Engine close listener; `socket.js:536–554` emits namespace disconnect synchronously. Delayed one-microtask finalization is necessary to retain the later Engine reason. The observer must remain enrolled through the dispatch and remove only its own callback references.
- The attach point immediately before Viewer welcome at `signaling.js:1103` is after admission, map claim and supersession. Product namespace disconnect cleanup is registered later at line 1919, so the real wiring must test observer-first namespace ordering as well as product-first fixtures. Rechecking ownership at finalization handles map deletion/replacement without transferring identity; an ordinary grace-preserved disconnected map entry may correctly remain current=true under this deliberately map-only definition.
- Existing FakeSocket is an EventEmitter with outbound emit overridden. In integration tests use its `trigger` path for namespace events and a separate fake Engine emitter. Existing makeIo executes actual middleware/admission handlers; rejected token attempts throw before admission and should be asserted as such. These fixtures can exercise the required admission cases without a loopback listener.
- Importing the installed Engine Socket prototype and initializing only the fields required by actual sendPacket/flush/onPacket is feasible offline. A fake pong interval refresh marker and null timeout avoid creating timers; do not construct/open the Engine socket. This meaningfully verifies event signatures instead of copying library ordering.
- Packet listeners can count both text and binary Engine message packets solely from type; no payload size/type inspection is necessary. Message handling remains constant work with saturated counts, and flush scanning remains bounded to 64 entries. Ring/log serialization happens at terminal observation rather than per message. No binary-specific counter, byte counter or additional packet event is justified.
- Ring size 32, registry size 8, exact callback removal, clearing all recorder-held object/predicate references, and closed guards on copied callbacks make bounded ownership achievable. Tests should inspect registry state/listener counts directly rather than rely on nondeterministic garbage collection. The one microtask closure must retain only cleared recorder state after synchronous stop.
- Existing runtime snapshots are fractional performance-clock measurements. Project valid nonnegative time values to bounded integer milliseconds deliberately; do not accidentally reject ordinary fractional values as invalid. Snapshot age is tied to the existing RSS sample cadence, not a separate heartbeat scheduler measurement. The brief already avoids treating available as proof of all timer execution.

Review only: read source and the supplied brief; no tests executed, no application/index/runtime/network/browser/native/service/tunnel changes. Only this private review artifact was written.
