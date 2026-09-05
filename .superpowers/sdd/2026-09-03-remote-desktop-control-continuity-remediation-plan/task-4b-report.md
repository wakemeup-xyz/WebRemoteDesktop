# Task 4b report: refresh paint baseline, cold-start SPS, and refresh mutual exclusion

## Status

DONE_WITH_CONCERNS

## Scope

Implemented only Task 4b changes:

- `web-client/js/webrtc.js`
  - A new connection attempt clears the previous inbound decoded-frame count,
    decoded-frame timestamp, paint baseline, and painted-frame gate.
  - The refresh DataChannel wait timer is instance-owned and guarded against a
    stale callback settling a newer refresh. Settlement, peer rebuild, refresh,
    disconnect, and viewer supersession clear the timer as appropriate.
  - Non-forced recovery refreshes are rejected while another refresh is active.
    Forced refreshes clear the prior settle/wait timers and stale DataChannel
    rebuild state before starting.
- `web-client/js/webrtc.test.js`
  - Added regressions for a zero inbound baseline, stale DC-wait callbacks, and
    non-forced refresh mutual exclusion.
- `python-host/host.py`
  - Decoder-stall SPS refresh starts unarmed and remains fail-closed when the
    arming field is absent; a healthy 8–25 FPS sample is still required before a
    zero-FPS received-frame sample can request refresh. The existing 12-second
    cooldown and fixed jitter behavior are unchanged.
- `python-host/test_stall_decoder_refresh.py`
  - Added a focused cold-start/healthy-sample regression.

No Task 4 documentation, Terminal, tunnel, TURN, jitter, or service changes
were made.

## TDD red evidence

Before the implementation:

- `node --test --test-name-pattern='refresh attempt compares paint growth|stale pc-connected dc-wait timer|non-forced refresh' web-client/js/webrtc.test.js`
  - 3 failed as intended: the baseline remained `400`, the stale timer set the
    newer `_refreshing` to `false`, and the non-forced refresh closed the PC.
- `PYTHONPATH=. python3 -m pytest -q test_stall_decoder_refresh.py`
  - 1 failed as intended: cold-start `fps=0` requested decoder refresh.

## Verification

- The focused Viewer regressions passed: `3 passed, 0 failed`.
- The focused Host regression passed: `1 passed, 0 failed`.
- `node --test web-client/js/webrtc.test.js`: `197 passed, 0 failed`.
- `node --test web-client/js/*.test.js web-client/css/*.test.js`: `571 passed, 0 failed`.
- `PYTHONPATH=. python3 -m pytest -q` from `python-host/`: `212 passed, 0 failed`; one existing `mss.mss` deprecation warning.
- `git diff --check` passed before staging.

## Concern

Verification is unit-level. Real browser WebRTC/DataChannel timing, hardware
codec SPS behavior, physical-device acceptance, and tunnel/public-path health
remain **NOT RUN**. The Viewer VM fixtures still emit their pre-existing
`fetch is not defined` fallback warnings; the tests completed with zero
failures.

## Fix round 1/5: stale VFC paint gate after refresh

### Root cause

`startVideoFrameTracking()` only called `markMediaAttemptReady()` from its
`requestVideoFrameCallback` handler. A real rendered frame therefore updated
session readiness but never set `hasPaintedFrame`, so a refreshed attempt could
remain `media-pending` even after the browser displayed video. The callback also
only checked the shared video element, allowing an old callback closure to run
after a new attempt reused that same element.

### TDD red evidence

Before the implementation:

- `node --test --test-name-pattern='video frame callback paints only the current refresh attempt' web-client/js/webrtc.test.js`
  - 1 failed as intended: the stale callback incremented `_videoFrameSeq`
    (`actual 1`, `expected 0`) after the refresh replaced its attempt/PC.

### Implementation

The VFC handler now captures the connection attempt id and PeerConnection at
arming time, rejects callbacks whose element, attempt, or PC is no longer
current, and only for a current callback with `video.videoWidth > 0` sets
`hasPaintedFrame` and clears the paint stall. It then uses the existing
`markMediaAttemptReady(attemptId)` seam, which transitions the UI to
`connected` and records the matching session fresh-frame event.

### Verification

- Focused VFC regression after the fix: `1 passed, 0 failed`.
- Related Viewer refresh/paint regressions: `6 passed, 0 failed`.
- `node --test web-client/js/webrtc.test.js`: `198 passed, 0 failed`.
- `node --test web-client/js/*.test.js web-client/css/*.test.js`: `572 passed, 0 failed`.
- `PYTHONPATH=. python3 -m pytest -q` from `python-host/`: `212 passed, 0 failed`; one existing `mss.mss` deprecation warning.
- No Host, tunnel, TURN, jitter, or service files changed in this fix round.

### P1 concern

Real browser VFC scheduling and hardware WebRTC rendering remain **NOT RUN**;
the regression uses a deterministic video element and callback queue. Physical
device and public/tunnel acceptance remain **NOT RUN**.
