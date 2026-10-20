# Task1 implementation report — 2026-10-19

Source base 9deab6e. Only two allowed source/test files changed. Root owns staging, commits and runtime. Existing four dirty documentation paths were preserved. No services, build, browser, network, native, primary checkout or tunnel operations were performed.

## Implementation

`reconcileConfiguredControlMedia()` joins configured init and accepted grant. Configuration-deferred fencing also lives at actual `createPeerConnection()` and `createOffer()` boundaries. Init may allocate a configured peer without control, as before, but offers only through the eligibility join. Parallel signaling/config/admission, grant heartbeat and tunnel grant tail remain intact.

The shared join reads real Input's existing `activeControlLease` identity, `_recoveryControlReacquireRequired`, and `keyboardTransport.getSnapshot().state`. It never replays `setControlLease` or clears safety state. Mismatch/unavailable state uses existing `requestControlRecovery(Input._recoveryCycle?.generation)`. Grant's actual `Input.init()` and `setControlLease(...) === false` gate remain in place before its media tail. The delayed test drives actual keyboard transport `acceptAck(invalid-input)` then real duplicate grant, verifies reacquire-required/false acceptance, and sees no post-init offer.

Duplicate suppression applies only in the shared join while the peer has pending local offer SDP, current peer attempt/lease, and `_wrdEmittedOffer` matching current socket/attempt/sequence. This small peer-owned record is written only after actual socket emit returns and `ownsOffer()` still holds. Peer replacement naturally removes it; changed socket/attempt/lease or stable completed signaling no longer matches. Direct createOffer/recovery semantics remain unchanged. No generic authority cache or global completed-offer flag was added. Existing ownsOffer fences and stale-answer listener are unchanged.

## Verification

Node: `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node`.

Focused command: `NODE --test --test-name-pattern='startup config join' web-client/js/webrtc.test.js`.

- Initial DOM fixture errors (`window.addEventListener`, then `document.querySelectorAll`) were browser fake shape deficiencies, separately identified; first retained in task-1-fixture-error.log. They are not behavior RED.
- Actual unchanged-production behavioral RED: 2 tests, ready control passes, delayed fails `1 !== 0` at deferred peer fence. Node exit 1, runner duration 731.750 ms; task-1-red.log. This is desired-invariant RED, unlike prior characterization exit0.
- Final focused GREEN: 7/7, exit 0, 987.838 ms; task-1-green.log. Includes both arrival orders, duplicate grant while offer pending and after lock clears, matching answer on one peer, stable completed-session regrant reoffers, no-control, real Input reacquire gate, cancellation, supersession and changed auth. No fake frame/gate enabling.

Affected command: `NODE --test web-client/js/webrtc.test.js web-client/js/input.test.js web-client/js/input-recovery.test.js web-client/js/bootstrap-controller.test.js scripts/passive-session-sampler.test.js`.

- First affected run: 559/561, Node exit 1, 31390.602 ms. Two preexisting Input mocks returned no accepted lease state; shared join correctly rejected them. Preserved task-1-affected-before-fixture-update.log. Updated those two and the adjacent live-peer mock setControlLease implementations to store their accepted lease and return true; actual production Input is still used by all new positive scenarios.
- Necessary rerun after fixture correction: 561/561 PASS, Node exit 0, 39337.240 ms; task-1-affected.log. Includes existing stale async offer completion, refresh, tunnel/JPEG, admission/bootstrap ownership and Input recovery suites. No broad repeat after PASS.
- `git diff --check`: exit 0.

The new fixture reuses loadWebRTC, real bootstrap controller, actual startViewer/admission/socket/listener/init/grant/PC/offer/answer methods. Only platform fetch/RTC/socket/timers/DOM/Auth are fake. Transparent wrappers record actual entries without replacing method bodies; no product readiness, lease or gate fields assigned to manufacture ordering. Fake answer applications verify local signaling only. Six input metrics and visible/native/business acceptance remain NOT_RUN/null.

## Files and hashes

- `web-client/js/webrtc.js` SHA256 `4fde802193ca0057203a6fdf40a0c9a37ef64626444cb33bcde6bb8f82052924`.
- `web-client/js/webrtc.test.js` SHA256 `014419a505c6f2170bb3d91fc3f53e00e31bcb1ad5d86398eb66b0f2200eff8c`.

Self-review: no offer owner/answer guard removal, no authority/reset bypass, no timing budget/ICE/network/quality policy changes. New regression tests include real Input positive and negative branches. Remaining runtime/long-session qualification is outside this source task.
