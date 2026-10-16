# Task C2 implementation report

Implementation commit: `2f53810` — `fix(host): fence asynchronous control and peer ownership`.

## Scope and behavior

- Host exposes immutable `_capture_authority()` tuples and `_authority_matches(snapshot)` across revision, viewer, lease/epoch, attempt/sequence and connection generation. `__new__` fixtures use explicit fallback values; production initialization declares revision and Signal lifecycle state.
- Accepted transitions record highest epoch, operation kind and outcome. Lower epochs and same-epoch different kinds are rejected. A completed reset retry acknowledges without executing native reset again; rejected reset can retry. Authenticated Signal reconnect resets the epoch namespace only after the serialized native reset completes. Revision never rolls back.
- Socket callbacks retain their source client identity; handlers queued across connection generations cannot apply old connection work. Disconnect freezes authority before awaits. Rebind validates authority after each lock wait and updates the PC's owner metadata atomically with input/media/relay owner.
- Reset and adapter binding use `_authority_input_queue()`. The existing keyboard/desktop adapter queues drain in-flight native work before reset returns. Old binder completion cannot schedule a desktop bind after a newer reset; the reset waits for the old binder and its own actual native reset. No native cancellation is treated as quiescence.
- Offer processing validates lease/attempt first, freezes authority, checks every awaited initialization/SDP boundary, builds the candidate PC/track/sender locally, and publishes only a still-current candidate. Old callbacks/cleanup own captured resources. Teardown detaches old peer, sender, track, capture adapter and candidates before awaits; cleanup after track shutdown rechecks current authority.
- Media resume checks authority after the real `asyncio.to_thread` capture wait, before restoring a sender or committing/acknowledging media state. Attempt changes suspend prior capture/sender demand. Input adapter results and post-ACK capture tracing also check authority without changing M1 timing semantics.
- Different-lease Viewer grant closes the old PC and uses existing createPeerConnection/createOffer negotiation even when that PC reports connected. Same-lease grants retain it. PC lease metadata is scoped to the PC; in-progress offer captures peer, socket, lease and attempt and checks ownership after awaits.

## Red-green evidence

1. Added real Event ordering: epoch-7 offer pauses inside old PC close; real reset 8 and grant 9 complete; releasing old close previously constructed a stale PC. Added actual capture-await resume interleaving with attempt bind 2; prior code restored attempt 1.
   - `PYTHONDONTWRITEBYTECODE=1 python3 -m pytest python-host/test_offer_epoch.py python-host/test_media_suspension.py -q`
   - Red: **43 passed, 2 failed**, both expected regressions (stale PC construction and `wrd-1` replacing `wrd-2`).
2. Added connected-PC different-lease grant regression.
   - `node --test web-client/js/input-signaling-continuity.test.js`
   - Red: **9 passed, 1 failed**, old PC close count stayed zero.
3. Updated same-epoch grant→reset legacy test to require rejection; serialized grant/revoke test now uses unique reset epoch 3, matching C1.
4. Added real handler chains for failed A→B rebind → reset → grant B → offer/ICE B → formal B→C rebind; epoch-20 old await → disconnect → authenticated safe reset → epoch-1 grant; completed/failed reset retry; native adapter bind draining; local SDP candidate invalidation; old track shutdown not clearing new recovery resources; stale Viewer createOffer completion.

## Final verification

- `PYTHONDONTWRITEBYTECODE=1 python3 -m pytest python-host/test_offer_epoch.py python-host/test_media_suspension.py -q`: **52 passed**.
- `node --test web-client/js/input-signaling-continuity.test.js`: **11 passed**.
- `PYTHONDONTWRITEBYTECODE=1 python3 -m pytest python-host/test_offer_epoch.py python-host/test_media_suspension.py python-host/test_viewer_session_rebind.py python-host/test_input_timing_contract.py python-host/test_input_handler.py python-host/test_media_apply_stability.py -q`: **117 passed**.
- `node --test web-client/js/input-signaling-continuity.test.js web-client/js/webrtc.test.js`: **237 passed**.
- `git diff --check` and `git diff --cached --check`: passed.
- All capture, PC construction and native input in new lifecycle regressions use fake adapters/objects. No service/native input/capture/prod dist/dependency install was invoked.

## Self-review and handoff

Lock order: control handler → authority input queue → existing native adapter queue; offer handler → authority input queue; rebind → offer lock → media lock. Control does not await the offer/media lock. Media capture wait never holds the input queue. Each commit after an await rechecks the shared authority; stale candidate cleanup uses only local old objects.

M3 must reuse `_capture_authority()` / `_authority_matches()` for queue admission/completion. Its `reset_after_quiescent(old_scope, apply_reset)` should replace the adapter draining wait while retaining C2's revision and operation metadata. It must not add another authority or consider cancellation/timeout a completed native drain. The current adapter-backed reset implementation remains real and serialized before applied ACK.

Extra scoped test file: `python-host/test_viewer_session_rebind.py` updates the registration assertion to execute the source-client wrapper and reject an obsolete client; root authorized this addition. Shared `webrtc.js` staging selected only grant/PC/createOffer hunks; W1b deferred loader edits and all sibling changes were excluded.

Real service startup, production Viewer maintenance-window validation, direct/TURN/tunnel real connections, physical/native input, optical visible latency and long-duration acceptance: **NOT RUN**. Root coordinates later acceptance and independent review.
