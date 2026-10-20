# Mouse-move backpressure and recovery review — 2026-10-18

Scope: read-only inspection of frozen source `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`, revision `e684ca494613ba93a7b491042922cf43e97cef31`. No source edits, tests, builds, browser actions, process/service observations, network operations or native input were performed. References below are source line numbers in this frozen tree. The source behavior is established statically; the proposed regression has **NOT RUN**. No production incident is attributed to this finding.

## Actionable finding

**[P2] Mouse moves can fall back into a reliable channel already quarantined for missing ACKs.**

Location: `web-client/js/webrtc.js:5068–5072` (quarantine test and selected-channel fallback); caller `web-client/js/input.js:2544–2583`.

`WebRTC.sendInput()` refuses the quarantined reliable `inputChannel` only for `!isMouseMove`. A move selects the open `inputMoveChannel`, otherwise selects `inputChannel`. Consequently, when the move channel is closed or absent, a move is permitted to select the **same reliable channel whose delivery is already considered unsafe**. If this old channel remains `open`, it either accepts `send()` (buffer at or below 4096 bytes) or returns true without sending (buffer above 4096 bytes). In both cases `Input._sendInput()` receives true, records DataChannel latency submission and returns an input ID before reaching the connected Socket.IO fallback.

Concrete sequence:

1. A current reliable keyboard or mouse down/up write is sent on reliable channel A. A remains `open`, but no ACK arrives. This is an explicitly supported failure condition, not a need to hypothesize that all closed channels are broken: the existing test at `web-client/js/input-recovery.test.js:1523` models an open but silent reliable channel.
2. The owned ACK deadline invokes `_onReliableAckTimeout()` (`web-client/js/input.js:1384–1400`), which calls `quarantineReliableInputChannel()` for A (`web-client/js/webrtc.js:5094–5100`). A is retained, marked quarantined, and keyboard transport is made unavailable on A.
3. The current mouse and keyboard reset barriers complete over connected Socket.IO. `_finishRecoveryIfReady()` marks the cycle recovered and clears pending recovery state (`web-client/js/input.js:1181–1201`). The existing test explicitly demonstrates that the effective input gate reopens at line 1547, while A is still open at line 1535.
4. The separate move channel is closed or absent. This condition does not itself destroy the reliable lease or force a rebuild: Viewer move close/error callbacks only log (`web-client/js/webrtc.js:5041–5047`); Host move close only clears the move reference and returns (`python-host/host.py:3237–3242`). The move channel could have closed before or after the reliable ACK fault.
5. A new mouse move now selects A at `webrtc.js:5070–5072`, bypasses A's quarantine because of `!isMouseMove`, and returns true. `Input._sendInput()` returns early at `input.js:2575–2578`; the connected Socket.IO path at 2580–2583 is never attempted.
6. As long as A stays open and the move channel stays unavailable, each subsequent move repeats this route. Moves have no reliable ACK deadline (`input.js:2510–2513`; existing explicit test `input-recovery.test.js:1684–1689`), so this path supplies no further self-recovery trigger. If A remains non-delivering, pointer movement can remain unavailable even though recovered click/key writes use Socket.IO.

Impact is bounded: this is a partial pointer-motion recovery defect, not proof that keyboard, clicks, webpage or media fail. Down/up have their own fresh coordinates, reliable sequence and ACK. Pointer up carries current/fallback coordinates (`input.js:2931–2939`), and Host posts the release at those coordinates (`python-host/input_handler.py:492–516`). These mitigations can make clicking and the final release work while hover or intermediate drag movement fails.

Narrow correction to evaluate after a pure regression: apply quarantine to the **selected channel object** even when the action is move, so a move cannot use exactly A once A is known unsafe. Returning false then reuses existing Socket.IO fallback. This need not reject a separate still-open move channel, weaken any input gate, replay previous input, rebuild the peer, change transport thresholds or add a move ACK deadline. A retired channel's quarantine must not taint its replacement. This is a proposal, not an implemented or accepted fix.

## The 4 KiB move-drop branch is a different behavior

The branch at `webrtc.js:5078–5080` intentionally drops a high-frequency move and returns true. The requirement explicitly allows mouse moves to be dropped and allows an input ID on an explicit move drop (`docs/需求文档/WebRemoteDesktop-需求文档.md:105,111–112`). `input-move` is unordered with zero retransmissions (`webrtc.js:4924–4928`). This branch alone is therefore **not** a new product bug under the current contract.

`Input.queueMouseMove()` coalesces to one latest rAF slot and clears it before calling the transport (`input.js:2633–2656`). There is no `bufferedamountlow` listener or retained last-position retry in the inspected Viewer code; setting `bufferedAmountLowThreshold` is not such a listener. If the last hover move encounters backpressure and the user stops, that position is not automatically sent when the buffer drains. The next eligible pointer move sends the newer position. This matches the permissive drop contract; guaranteeing eventual final hover position would be a separate behavior decision with lease, geometry and lifecycle invalidation requirements.

If a move-only channel remains open but persistently buffers, no move-specific timeout/fallback is present. The reliable-channel watchdog observes channel opening, and the 15-second keepalive sends on the reliable channel without an ACK (`webrtc.js:4297–4311`). These facts justify a focused recovery diagnostic/experiment, but do not prove that such a persistent move-only browser/SCTP failure has occurred. It must not be reported as the cause of the historical user incident without runtime evidence.

## Measurement issue, kept separate

The accepted boolean covers both an actual `channel.send()` and an intentional move drop. `Input._sendInput()` records `transport-send accepted:true` and `recordLatency()` for either (`input.js:2564–2578`); `recordLatency()` forwards a submission timestamp at `input.js:414–426`. Thus this high-level return cannot prove actual transport submission for a controlled latency sample. A future collector must observe real accepted `channel.send`/Socket.IO `emit` and retain separate drop/coalescing outcomes. Fixing measurement does not by itself fix the quarantine routing defect, and changing the move-drop contract is not necessary to measure correctly.

## Existing coverage and narrowly meaningful next verification

Relevant current tests (read, not executed):

- `web-client/js/webrtc.test.js:756`: reliable ordered channel vs separate unordered move channel, under zero buffering.
- `web-client/js/input-recovery.test.js:1499`: closed DC, successful Socket dual reset, fresh click/key writes.
- `web-client/js/input-recovery.test.js:1523–1562`: open but silent reliable DC, owned Socket resets, no replay, fresh click/key fallback. It does **not** send a move after recovery. The fixture initially aliases the move channel to the reliable channel (`:178`), so the quarantine bypass can also be represented without creating any real browser.
- `web-client/js/input-recovery.test.js:1564–1583`: Socket-carried or retired-channel faults cannot quarantine an unrelated current DC.
- `web-client/js/input-recovery.test.js:1684`: move must not create a reliable timeout/reset cycle.
- `web-client/js/input-backpressure.test.js`: shared reliable budget and wheel coalescing; it substitutes `WebRTC.sendInput`, so it does not cover the actual 4 KiB selector or quarantine behavior.

Small pure real-function regression proposal: extend the existing open-but-silent recovery case, retain actual `Input._sendInput` and `WebRTC.sendInput`, use fake channels/socket/clock only, close/null the move channel, complete the same current reset ACKs, then issue a new move. Require exactly one Socket `input` event, no send on quarantined A, no reliable sequence/pending growth and no click replay. This assertion is expected to fail on F from direct branch inspection; it remains **NOT RUN**.

Necessary neighboring cases: separate healthy open move channel remains usable; quarantined retired A does not block replacement B; no connected fallback returns null without new latency pending; intentional 4 KiB dropping on a non-quarantined channel retains the existing contract; a new lease/attempt or geometry invalidation never flushes an old move. Do not add native input, forced focus, real network loss, browser control or any isolation-guard waiver to this test.

## Decision limits

One actionable static routing finding; no change to the intentionally lossy move policy is recommended as a prerequisite. The finding does not invalidate historical ACK-race fixes, does not establish the first cause of historical disconnects, and does not constitute runtime acceptance. Actual input-to-picture/physical-effect metrics remain null / NOT RUN until their separately authorized isolated native environment and matching evidence exist.
