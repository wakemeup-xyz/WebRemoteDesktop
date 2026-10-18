# Host reset ACK race — read-only design assessment

Assessment date: 2026-10-18. Scope: the current source worktree `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`, Host code at `c23948256803afda3383080849a7b5fb9076632d` and unchanged through `e5927c748f25c28546a7bd9d86690d4bac434404`. No source/index changes, tests, imports of Host/native modules, service operations, or browser/network actions were performed. This report is a design, not a tested fix.

## Conclusion

There is a concrete secondary reset-ACK suppression race. Keep all existing authority checks and the rule that an applied reset ACK follows successful input reset and old-resource cleanup. Prefer serializing zero-viewer cleanup with the **existing** `_control_transition_lock`, carrying the entry Signal generation and immutable authority snapshot across that wait. An already-completed, same-scope trusted reset with no attached producer/resources can absorb the redundant zero-viewer cleanup. Do not suppress zero-viewer cleanup solely because a lock is held or a control operation says pending.

A narrower token only around the detached-PC close can fix the observed interleaving, but leaves the same problem possible when zero-viewer status arrives during `relay.stop()` or `_reset_keyboard_lifecycle()` earlier in the same reset. The existing lock supplies the required ordering without a new lock, deadline, retry, authority exception, or background task. The precise design below must still receive implementation review.

## Observed fault and separation from initiating disconnect

The supplied bounded runtime audit `/tmp/wrd-host-cadence-long-a-signaling-audit.md` reports:

- At 15:01:23.862 CST, reset-only transition cleanup A begins with peer, track and sender present. `_apply_control_transition()` has already cleared the active binding, advanced authority, stopped the old relay and obtained an applied input reset.
- A detaches those resources synchronously, then awaits old PC/track shutdown. At 15:01:23.865–23.867, the zero-viewer status callback invokes cleanup B with no peer/track/sender present. B uses the default `preserve_authority=False`, advancing the same Host authority and resetting input again.
- A returns at 15:01:23.920 after 57.565 ms with the old peer/resource closed and capture thread stopped, but `authorityCurrent=false`. The guard immediately after A therefore returns before the first reset ACK. Signal retries the same epoch at 15:01:24.856 and reaches applied/FREE at 15:01:24.861.

This explains the secondary approximately one-second reset retry, not the initial browser WebSocket 1006 / transport-close at 15:01:15.5. The initial close precedes cleanup by about eight seconds. Media was still advancing at the initial loss, and the audit does not identify a server heartbeat timeout or a Cloudflare cause.

## Source facts

- `host.py:3303–3325`: `on_control_transition()` waits for current Signal initialization, then holds `_control_transition_lock` while running the real `_apply_control_transition()`.
- `host.py:3413–3489`: the transition advances authority, clears input binding, awaits relay stop, trusted input reset and preserved-authority old-peer cleanup, then publishes applied and emits the ACK. Every relevant await has an authority guard. New grants are serialized by the same transition lock.
- `host.py:3493–3640`: `_close_peer_connection()` detaches current resource references before awaiting reset/PC/track operations. Default cleanup advances authority. Invocation-local diagnostics deliberately survive superseding cleanup; retain this behavior.
- `host.py:5633–5650`: zero-viewer status currently does not take the transition lock and does not carry any Signal/authority fence across its relay-stop await.
- `host.py:3178–3194`: immutable authority includes revision plus viewer/lease/attempt/connection-generation binding fields. It is stronger than checking an epoch or `pc is None` alone.
- `host.py:3641–3680`, `5754–5764`: new offers and Signal disconnect advance authority independently. Their fences must remain able to supersede old reset work; the proposed status lock must not be added to these paths or used to defeat their checks.
- Callback registration checks the current Socket.IO client at callback entry (`host.py:2374–2395`); an old callback can nevertheless be suspended after entry. The new status scope check is therefore necessary after waiting.

## Proposed smallest complete ordering change

Modify only `on_viewer_status()` plus deterministic tests; do not modify `_apply_control_transition()` ACK sequencing, `_close_peer_connection()` authority semantics, or Signal retry policy.

For a zero-viewer status, before its first await:

1. Capture the current Signal generation, `_capture_authority()`, and exact control operation tuple. Keep the original overlay update path; coalescing the cleanup does not suppress its viewer-count update.
2. Obtain the same lazily initialized `_control_transition_lock` used by `on_control_transition()`, and enter it. This waits for an actual in-flight transition to finish, rather than returning immediately on `lock.locked()`.
3. Inside the lock, recheck the captured Signal generation and full immutable authority. If either changed, this status cleanup is stale and must not stop a replacement relay, close a replacement peer, reset a newer input binding, or advance authority. Skip its cleanup. Do not treat a newer lease as permission to operate on it.
4. Coalesce cleanup only when the captured operation was exactly `(epoch, 'reset', 'pending')`, the current operation is exactly `(same_epoch, 'reset', 'applied')`, the immutable authority and Signal generation still match, the active input binding and current viewer are absent, and **all** current producer/resource references are absent. Check exact absence with `is None`, not truthiness. The relevant references are `relay_streamer`, `pc`, `screen_track`, `video_sender`, input channels, `media_sender` and `capture_adapter`. The old owner already completed trusted reset and old resource shutdown before its applied state/ACK. This avoids even the redundant second native reset, while preserving diagnostic records for the one actual cleanup.
5. Otherwise execute ordinary zero-viewer cleanup under the same lock. In particular, a failed/rejected/cancelled transition or any attached resource must not be swallowed merely because the earlier tuple was pending. Capture and operate on the actual current relay. After any relay-stop await, recheck the entry Signal generation and authority **before** invoking `_close_peer_connection()` so an intervening disconnect/new offer cannot cause this callback to close replacement resources. Keep existing ordinary cleanup semantics where this callback is current.
6. Leave positive-viewer status behavior unchanged. Release the lock on success, error and cancellation through `async with`. Do not catch `CancelledError` as a normal applied outcome. An exception in transition cleanup must never make the coalescing predicate true.

This is a normal ordering barrier: it does not acknowledge a reset early, preserve an old authority after a real successor, extend a deadline or retry, or make a pending grant active. The shared lock already exists and is not taken by `_close_peer_connection()`, input queues, offer handling, Signal disconnect or overlay sends; the selected paths do not call `on_viewer_status()` from inside a transition. No new lock cycle is introduced by inspection. Hold the lock for the fallback cleanup as well so a new transition cannot acknowledge its grant while a zero-status cleanup still owns old detached resources.

The `pending reset -> applied reset` predicate is intentionally strict. After a grant the binding changes, so the full authority guard rejects an older zero-status callback. After cancellation or reset failure, fallback cleanup remains available. If a currently attached replacement object exists without an authority change, the empty-resource predicate refuses coalescing, rather than trusting an impossible fixture or assuming absence from `pc` alone. Tests must exercise these boundaries.

## Alternatives rejected or limited

- **Remove or relax the post-cleanup authority check:** unsafe; stale reset/offer work can acknowledge or republish after a new owner or Signal connection.
- **Return on `_control_transition_lock.locked()` or pending tuple:** unsafe; it can drop the only cleanup after a failed/cancelled transition, and a lock can be held by a grant rather than the intended reset.
- **Skip every empty cleanup:** unsafe; clearing input authority and native key/button state is meaningful even with no PC, and a relay or native queue may still exist.
- **Mark only PC close with a token:** sound only if the marker includes full authority, exact owner token and detached-resource absence, is cleared in `finally`, and is reset-only. It fixes the observed interval but does not cover zero-status arrival during relay stop or input reset. If chosen for a deliberately narrow patch, those earlier interleavings must remain explicit failing/unqualified cases.
- **ACK before close or after a fixed delay:** breaks the existing reset barrier and hides rather than fixes the race.
- **Change Signal dispatch order/retry timing:** does not make concurrently delivered Host callbacks safe and is unnecessary for this correction.

## Behavioral RED interleavings

Use the actual extracted Host methods, controllable await gates, fake adapters and fake PC/track/relay objects. Assert outcomes and call ordering, not source substrings. No native input, sockets, MSS, capture threads, real services or wall-clock sleeps are needed.

1. **Observed detached-PC race:** start a reset at epoch N with old PC/track; suspend PC close after detachment. Start zero-viewer status and ensure it reaches the transition wait. Before release: no applied ACK, status incomplete, no second native reset, old input remains inactive. Release PC then track. After both handlers finish: exactly one applied ACK on the first reset, old PC close and track shutdown each once, control operation applied/reset, no extra authority advance. This fails current code by losing the first ACK.
2. **Earlier relay-stop race:** suspend trusted reset in actual old relay stop before input reset/PC close; start zero-viewer status. Release and require one old relay stop, one trusted reset and one first ACK after all old resources close. Current code can advance authority from the concurrent status and abandon the first transition.
3. **Earlier native-reset race:** suspend trusted reset in `_reset_keyboard_lifecycle()` with no PC or with a PC still attached; start zero status. Require status to wait and preserve the first ACK; no duplicate reset after successful same-scope reset. This prevents a PC-token-only patch passing while leaving the earlier race.
4. **Signal disconnect while status waits:** advance Signal generation and authority via real extracted disconnect logic while old reset PC close is held; release. Neither old transition nor waiting status may emit applied for the old operation, operate on new resources, or advance the new scope. Existing disconnect must retain its ability to supersede old work.
5. **New authority/new offer while old reset is held:** advance authority and attach a replacement PC/track/relay representing a legitimate successor; finish old owner. Old cleanup closes only its detached objects, waiting status skips stale work, replacement references remain, old applied ACK absent. Keep the already-tested new-offer/new-grant fences intact. Separately cover active binding/attempt field changes, not revision alone.
6. **Reset rejection, exception and cancellation:** while native reset or old resource close is held, queue zero status; then reject/raise/cancel. Never emit applied early or classify a pending/failed reset as completed. Waiting status must not be silently coalesced; ordinary current-scope fallback reset/cleanup must still run where references remain. Detached objects after cancellation remain owned by the interrupted close exactly as the existing implementation defines; do not falsely claim release from empty Host references.
7. **Resource-empty guard:** after a same-scope reset reports applied, inject one attached resource at a time (especially relay, track or channel with `pc=None`) without altering the scope in the fixture. Status must refuse coalescing and run ordinary cleanup. This catches `pc is None` or truthiness shortcuts.
8. **Normal zero-viewer path:** no transition in flight, active stale peer/track/input lease. Preserve existing close/reset behavior; no skipped cleanup or early ACK. Positive-viewer overlay behavior remains unchanged.
9. **Grant in flight:** zero status captured during a grant must not be mistaken for a reset-only coalescing token. If a completed grant changes full authority, the stale status must leave its binding and resources alone. If grant fails with current old scope, fallback zero cleanup stays active.
10. **Relay-stop replacement fence:** a normal zero-status callback is suspended in relay stop; a new Signal/authority/resource scope is installed. After release it must not call `_close_peer_connection()` on the replacement. This is a pre-existing adjacent weakness exposed by the required new scope wait and is inexpensive to cover in the same handler change.

## Test locations and scoped commands

Existing real lifecycle coverage lives in `python-host/test_offer_epoch.py`, including zero-viewer cleanup (line742), `_authority_host` fake-native fixture (line1382), old offer/new grant race (line1404), reset idempotency/retry (line1634), old track/new resources (line1728), authenticated Signal generation and failed reset retry (lines1751–1859), and old relay stop supersession (line1923). That file imports `host` and its dependency stack; it is not an AST-only test module. Do not run it indiscriminately under a no-native-import qualification requirement.

The existing pure cleanup seam is `python-host/test_peer_cleanup_observation.py`: it extracts the actual `_close_peer_connection()` AST with controlled dependencies and tests overlapping invocations without importing Host or native modules. Its existing overlap case intentionally verifies authority suppression by a truly superseding cleanup; retain it unchanged because the fix must be in redundant status orchestration, not broad cleanup authority behavior.

Create a focused pure module, for example `python-host/test_control_transition_status_ordering.py`. Extract actual `_advance_authority`, `_capture_authority`, `_authority_matches`, `_apply_control_transition`, `on_control_transition`, `on_viewer_status` and `_close_peer_connection` methods; optionally extract actual `on_disconnect` for the Signal case. Compile a minimal fake class, inject only `asyncio`, recorder dependencies, a bounded logger, fake SIO/overlay, fake queue/native-reset functions and the actual pure `PeerCleanupObservation` dependency. Keep native binding/reset implementations fake; the orchestration and every scope decision being fixed must remain real AST methods. Use `unittest.IsolatedAsyncioTestCase` plus events or the existing deterministic `Hold` mechanism. No AST edits or replacement business methods to manufacture the desired guard.

Suggested required commands, cwd `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop/python-host`:

```sh
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest test_control_transition_status_ordering test_peer_cleanup_observation
```

Then the already-relevant pure affected set, once after the final implementation:

```sh
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest test_control_transition_status_ordering test_peer_cleanup_observation test_capture_resource_owner test_capture_shutdown_contract test_capture_cadence test_capture_observation test_runtime_observability
```

Run real imported `test_offer_epoch` / `test_host_input_admission` only if the root separately determines that their dependency-import effects fit the current qualification scope; the pure AST behavioral RED/green tests are the mandatory evidence for this focused change. Do not broaden to all tests, npm hooks, native-input tests or service restarts as part of source review.

## Acceptance boundary

This change can remove a confirmed secondary first-ACK loss and unnecessary reset retry after grace expiry. It cannot establish why the initial WebSocket closed, certify actual user input delivery, or qualify ordinary automatic reconnection through a one-use proof session. Keep those separate evidence and design tasks. Runtime review should look for one reset barrier completion without a timer-driven same-epoch retry after a controlled ordinary disconnect, while retaining fail-closed input during the gap and human Viewer priority. No tunnel action follows from this finding.
