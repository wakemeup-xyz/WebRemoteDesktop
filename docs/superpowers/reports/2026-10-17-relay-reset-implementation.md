# Relay reset protocol implementation report

Status: COMPLETE (source and offline validation only).
Base: 8f6c3ab8b2adb7285ecf3c34b74e4074022222fe.
Source commit: d057853a1f4c18fa730039456d10ae74c9ed31ea.

## Implementation

- Input.setActive uses optional local meta.keyboardResetReason only for resetKeyboard. releasePointer and lifecycle retain reason; default and resetKeyboard:false policies remain unchanged.
- WebRTC.invalidateRelayInputProof supplies existing protocol reason deactivated for active reset and already-inactive pressed/RESET_REQUIRED fallback; clean inactive still does not reset.
- Signal/Host validator/schema, timeout, queue, media freshness and admission logic unchanged. The metadata never enters the envelope.
- Added five actual VM Input/KeyboardTransport continuity regressions; changed two existing M6 lastKeyboardResetReason assertions to the actual protocol reason.

## RED/GREEN evidence and exact commands

1. `node --test --test-name-pattern='relay reset protocol|Input reset metadata' web-client/js/input-signaling-continuity.test.js`
   - Before production patch, after correcting test-only lease fixture to meet unchanged validator minimum length: tests 5, pass 1, fail 4. Each failing desired accepted assertion reports `{"ok":false,"code":"INVALID_RESET_REASON"}`. Raw RED output: /tmp/relay-reset-red.log.
   - After patch: tests 5, pass 5, fail 0. Raw GREEN output: /tmp/relay-reset-green.log.
2. `node --test web-client/js/input-signaling-continuity.test.js`
   - Tests 38, pass 38, fail 0. /tmp/relay-reset-continuity.log.
3. `node --test web-client/js/input.test.js web-client/js/keyboard-transport.test.js web-client/js/webrtc.test.js web-client/js/input-backpressure.test.js web-client/js/input-recovery.test.js web-client/js/input-signaling-continuity.test.js`
   - First regression identified four existing M6 assertions still expecting the old invalid reset reason; updated only their expected protocol reason.
   - Final: tests 529, pass 529, fail 0; duration 25579.360223 ms. /tmp/relay-reset-regression.log.
4. `node --check web-client/js/input.js`; `node --check web-client/js/webrtc.js`; `git diff --check`; `git diff --cached --check`
   - All exit 0.

## Protocol and barrier coverage

Actual emitted envelopes pass unchanged pure Signal validateRemoteInput; only fixture channel metadata is removed. A valid fixture lease is used before authenticating current relay scope and actual image onload. Active stale timer and actual startTunnelRelay(sendRequest:false) are exercised. Emitted reset retains leaseId/epoch, positive seq and generated inputIds; first stale reset seq is exactly 1, pressed fallback seq exactly 2. A repeated RESET_REQUIRED fallback coalesces the existing seq/inputIds and ACK completes that same barrier. Clean inactive invalidation emits nothing.

Both prerequisite orderings are covered: current reset ACK alone cannot unlock stale media, and fresh current image alone cannot unlock pending keyboard reset. Wrong reset inputIds at the current seq and old lease epoch ACK remain stale and leave gate closed. Original local relay-frame-stale/relay-start lifecycle reasons and stale UI reason are observed while lastKeyboardResetReason records deactivated. Non-M6 explicit window-blur and default/no-reset behavior remain covered. Existing M6 suite retains rejected/timeout, pointer, old origin and production integration gate checks.

## Self-review and limitations

Reviewed staged production diff: exactly one changed Input line and two WebRTC lines, confined to specified paths. No validator changes. No service, tunnel, browser, native input, network, dependency, build/pretest or primary-checkout actions performed. The required existing webrtc suite includes its own offline Python relay protocol bridge; no native input is simulated.

Unrelated tracked README/runbook/requirements/review-anchor dirty changes and untracked signal-server/node_modules symlink remain untouched and uncommitted. Commit includes only the four owned source/test files. Report remains in controller-provided ignored directory as requested. No runtime deployment or public/long-session acceptance claim is made; 5.2-second media stall root cause remains outside this narrow fix.

Source and Git index ownership released to controller; index clean after commit.
