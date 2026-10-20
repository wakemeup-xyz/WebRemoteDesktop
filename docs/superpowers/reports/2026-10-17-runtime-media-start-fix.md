# I2 runtime media startup regression

## Finding and scope

I2's production probe against reviewed `1b706d3` reported successful Viewer login and connected Host ICE/DataChannel at 07:34:27, but capture sequence stayed at 2 and RTP/decoded frames stayed at zero throughout its 45-second observation. Those runtime observations were supplied by the coordinating task; this isolated fix did not operate the production service, browser, native input, or tunnel.

The defect was introduced in this remediation wave: `git blame` attributes the unconditional `_media_activity_suspended = True` in `on_connection_attempt_bind` to `2f538104`. This finding does not establish the cause of earlier historical black-screen incidents.

The startup sequence explains the result:

1. A newly initialized, visible Viewer owns active media demand at generation 0. `ensureMediaActiveIfVisible` may request replay, but `replayMediaActivityIntent` has no generation ≥1 intent and emits no media resume request.
2. Control grant binds the connection attempt for WebRTC as well as tunnel. Host correctly suspends the old track, sender, and relay, but also set the new attempt's suspension flag to true while recording active/generation 0.
3. The matching offer builds a fresh track and sender, then suspends both when publishing the answer because the flag is still true. Successful ICE and DataChannel cannot clear that flag.

## Minimal fix and preserved boundaries

Ruling: keep old resource suspension and authority invalidation intact, but initialize the new attempt's demand flag to active, consistent with its existing active/generation 0 binding and the actual Viewer protocol. This changes one production assignment. It does not resume the previous track, sender, or relay.

An explicit pause received for the new attempt still sets the flag before or during SDP processing, and the new offer honors it. Reasserting an identical bind is still idempotent. Existing stale authority, lease, sequence, and asynchronous completion fences are unchanged. No wire protocol or requirement change is needed.

## Test evidence

The Host regression exercises real `on_connection_attempt_bind`, `on_offer`, and sender adapters. Only native capture/SDP transport boundaries are substituted; the startup flag is not forced by the test. The Viewer characterization executes the real controller, runtime, bind, visible ensure, and replay methods.

- RED before production change: cold bind→offer and replacement bind→offer both failed because the newly installed track remained suspended; explicit manual-pause and terminal-active controls passed (2 failed, 2 passed).
- GREEN: new media starts without an extra resume request; replaced old resources remain frozen; explicit pause before offer, duplicate bind, and pause during awaited SDP remain suspended.
- Existing stale resume completion test remains green and proves that previous-attempt work cannot restore the old sender.
- Targeted Python: **125 passed** across `test_offer_epoch.py`, `test_media_suspension.py`, `test_media_apply_coordinator.py`, `test_media_apply_stability.py`, `test_aiortc_media_sender.py`, `test_media_profile.py`, and `test_input_handler.py`.
- Targeted JavaScript: **258 passed** across `webrtc.test.js`, `media-activity-controller.test.js`, `media-activity-runtime.test.js`, and `media-activity-lifecycle.test.js`.
- `git diff --check` passed for the changed production/test files.

## Runtime acceptance

Production loading, fresh rendered video, repeated connection recovery, and long-session latency/resource evidence remain **NOT RUN by this fix task**. The coordinating task owns deployment and the guarded I2 probe. Passing these offline tests does not complete I2 or the broader runtime acceptance criteria.
