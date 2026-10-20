# Bounded adjacent keyboard reset reason review

2026-10-17, Asia/Shanghai. Read-only source review of /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop, HEAD8f6c3ab with concurrent M6-only wire-reason edits visible. No production/native/browser/service/network operation. Only this report and one private offline snippet were written, both0600. The accepted M6 relay-start/relay-frame-stale fix is excluded from the finding below.

## Proven adjacent protocol mismatch, with limited impact claim

Two lifecycle callers still pass diagnostic reasons into the strict keyboard wire protocol without normalization:

1. WebRTC.freezeControl(reason, reset=true), webrtc.js:3864–3883, explicitly calls Input.resetKeyboard(reason || 'control-lost') while the local lease is still installed, then clears the lease. Five concrete reasons below are absent from both endpoint allowlists.
2. The recovery control button's actual click handler, input.js:2069–2080, calls releaseControl('input-recovery-user') when the Viewer has active control. releaseControl at webrtc.js:3946–3954 calls Input.resetKeyboard(reason) before freezing/releasing. input-recovery-user is also absent from both allowlists. This is the strongest normal UI producer: an active Viewer and connected Socket can submit the invalid reset before submitting control-release.

Actual-method offline reproduction loaded the existing input-signaling-continuity.test.js fixture definition without registering/running its tests. It executed real WebRTC/Input/RemoteKeyboardController/KeyboardTransport, with fake DOM, fake Socket, fake clock and no network. A fresh valid synthetic lease/no pending barrier was used. The actual recovery button click emitted keyboard reset reason=input-recovery-user followed by control-release; the real Signal validator returned INVALID_RESET_REASON. It then cleared the local lease and left KeyboardTransport revoked. Real freezeControl invocations emitted one keyboard reset with each listed unsupported reason, followed by revoked state. Actual Host validate_remote_input rejected the same reasons. No real IDs, tokens or input content were persisted.

This proves the reset packet cannot obtain the intended strict-schema keyboard application. It does not prove stuck native keys, lasting input unavailability or bypass of formal control cleanup. In the user-release path, the following control-release still calls DesktopControlLease.beginRelease and dispatches the formal Host reset-only transition. In the normal server-driven freeze paths the old authority is already gone. Do not weaken authorization to make these packets apply.

## Complete freezeControl call-site inventory

All calls are in current webrtc.js. reset defaults true. A keyboard reset can actually send only with a local controller lease, a usable adapter (reset prefers Socket), no existing barrier/reacquire latch, and a successful local adapter submission. A pending barrier may instead be reused; no-lease calls produce no wire reset. Every non-suspended freeze clears Input's lease synchronously after attempting reset.

| Line / actual trigger | Argument | reset policy | Wire outcome if fresh local lease/connected Socket | Authority/context limitation |
| --- | --- | --- | --- | --- |
|3514 host-status online=false|host-offline|default true|INVALID_RESET_REASON|Server1940–1944 first nulls Host, calls hostDisconnected and broadcasts state; no live Host/current server lease remains. State broadcast may already have cleared local lease, then no reset sends.|
|3580 current Socket disconnect|signal-disconnect|default true|ordinary owned lease is suspended, zero reset|suspendControlLease preserves sequence while Socket is offline; not an invalid reason producer in this path.|
|3599 control-revoked event|control-revoked|default true|allowed keyboard reason|Server revocation/transition authority rules still apply.|
|3600 control-transition-failed event|control-transition-failed|default true|INVALID_RESET_REASON|Listener is present, but no current production Signal emitter for this event was found. Conditional compatibility path, not a demonstrated current incident.|
|3601 control-heartbeat-rejected event|control-heartbeat-rejected|default true|INVALID_RESET_REASON|Signal1224 emits only when DesktopControlLease.heartbeat cannot authorize the submitted identity. No current matching authority proven.|
|3771 handleControlState readonly|data.reason or control-readonly|explicit false|no keyboard reset|Generic reason is diagnostic/pointer only here.|
|3798 invalid control-grant fields|invalid-control-grant|default true|INVALID_RESET_REASON if older local lease exists|Defensive malformed-grant branch. Current Signal sendGrant emits well-formed authoritative lease; no normal malformed producer proven.|
|3953 releaseControl|caller reason|explicit false|no reset INSIDE freezeControl|releaseControl separately resets unless preserveAcquireIntent, see below.|
|6803 handleViewerSuperseded|viewer-superseded|explicit true|INVALID_RESET_REASON if Socket still connected/lease retained|PC/DC already closed locally; Socket not disconnected until after freeze. Signal supersedes/removes old owner then disconnects it; cannot assume old authority still valid.|

The fallback control-lost in freezeControl is also not in the allowlist, but every actual current call supplies a reason. It is a defensive API fallback, not another demonstrated production trigger.

## Release/reset callers outside freezeControl

| Caller | Keyboard wire reason / behavior |
| --- | --- |
|Input recovery control button2080 -> releaseControl|input-recovery-user; unsupported when a new reset is emitted; subsequent control-release remains formal cleanup.|
|beforeunload4013 and manual disconnect6711 -> releaseControl|viewer-disconnect; allowed. Actual unload delivery remains unverified.|
|requestControlRecovery3680 -> releaseControl|input-recovery-timeout with preserveAcquireIntent=true; skips pre-release keyboard reset, freeze reset=false. No unsupported keyboard wire reason from this caller.|
|Input blur1899 / visibility1912 and WebRTC visibility3968|window-blur / visibility-hidden, both allowed. When DC closed, the relevant paths park local state instead.|
|Input.setActive(false) default|deactivated only if shouldResetKeyboard; with retained active lease default does not reset. Explicit resetKeyboard=false never resets. M6 explicit override is excluded/already owned by its fix.|
|requestInputRecovery1302–1310|automatic diagnostic automatic-recovery maps to transport-change; user diagnostic user-recovery maps to manual. Both keyboard wire reasons allowed.|
|RemoteKeyboardController internal recovery|transport-change / batch-failed / keyboard-mode-change; allowed. reset() default manual allowed.|
|KeyboardTransport internal resets|transport-change; resetBarrier() default unspecified. Both allowed.|
|MobileTextInput.reset('lease-changed') and park/invalidate calls|local editor/context operations, not keyboard wire reset producers.|

No additional current non-test caller was found passing an unsupported keyboard reason after the above lifecycle paths. The public Input.resetKeyboard/Controller.reset/Transport.resetBarrier APIs still accept arbitrary strings; arbitrary direct calls and synthetic test reasons are not themselves production reachability evidence.

## Exact endpoint distinction

Signal signaling.js:1394 calls validateRemoteInput before forwarding. remote-input-contract.js:17–22 defines the strict keyboard reason set, and164–165 rejects an unlisted keyboard reset with INVALID_RESET_REASON. Host input_handler.py projects v2 protocol fields in apply_keyboard, then remote_keyboard_state.py:227–230 applies validate_remote_input; its19–24 set matches Signal, with rejection at188–193. This is protocol parity, not a Signal/Host disagreement.

The mouse/pointer reset contract is different: Signal validateDesktopWrite at108–110 accepts syntactically safe reason strings matching /^[a-z][a-z0-9-]{0,63}$/. Thus pointer reasons such as sequence-gap, pointer-up-failed, media-suspended or these lifecycle labels cannot be used to infer keyboard legality. Pointer release and keyboard release are not interchangeable. No pointer-contract defect is asserted.

## Rejection and reacquisition behavior

Signal invalid-input validation currently records a sanitized signal_input_rejected event and returns; emitInputEvent only appends/logs, it does not emit a negative input ACK. For an active, retained lease with an unsupported reset pending, KeyboardTransport therefore stays blocked until its monotonic3000ms ACK deadline, then requireReacquire clears the barrier, keeps the same-lease latch and calls the timeout callback. Offline real-transport test confirms blocked -> reacquire-required at3000ms and same-lease setLease cannot clear it. A matching invalid-input ACK, if received from Host, immediately produces reacquire-required. New input remains blocked in both cases. No automatic positive ACK is invented.

That retained-lease rule must NOT be projected onto freezeControl/releaseControl: these methods immediately setControlLease(null), which clears the pending transport timer/barrier and transitions to revoked. Offline actual methods confirm revoked after each freeze. This is withdrawal semantics, not a proven failure to force reacquire. A later authoritative grant is responsible for establishing new ownership; release-driven Host safety cleanup belongs to the formal reset-only transition, not the cancelled Viewer ACK timer. No new defect is asserted solely because a withdrawn invalid reset's local deadline is cancelled.

There is no source-proven normal case here where a still-authorized current controller retains its lease, emits one of these newly identified invalid reasons, and consequently leaves Host keys stuck without another required cleanup boundary. The normal input-recovery-user click does submit while active, but deliberately relinquishes that lease immediately and starts formal cleanup. Invalid-control-grant and un-emitted control-transition-failed need synthetic/unproven triggers. Do not inflate this audit into an additional observed availability failure.

## Smallest correction and regression boundary

Normalize only lifecycle safety reset wire reasons; preserve original control/UI/trace diagnostic reason and the formal control-release reason. A narrow choice is an existing control-revoked or deactivated wire reason for freezeControl, and deactivated for the explicit pre-release reset. Keep signal-disconnect suspension and reset=false paths intact. There is no need to enlarge the strict shared protocol allowlists for these UI lifecycle labels, globally rewrite arbitrary reset reasons, change reset timeout or alter authority/lease fencing.

Tests should exercise actual freezeControl methods and actual recovery control button click through real Input/Controller/Transport, pass the emitted keyboard envelope through BOTH real validators, verify unchanged reset=false/suspension behavior, and ensure original lifecycle reason remains observable. Also preserve event order/reset-only release behavior and null-lease revoked semantics. Existing transport tests with fake positive ACKs to arbitrary focus-lost strings verify barrier mechanics but cannot establish protocol validity; retain those mechanics tests and add the actual-caller validation boundary.

Reproducer: /tmp/wrd-keyboard-reset-adjacent-offline.cjs (0600), run with node. It uses no production connections. Pure Host validation was run with PYTHONDONTWRITEBYTECODE=1 and synthetic envelopes; no source/cache file writes. Existing broad suites were not run because no code was changed. No live recovery or native-key-release claim is made.
