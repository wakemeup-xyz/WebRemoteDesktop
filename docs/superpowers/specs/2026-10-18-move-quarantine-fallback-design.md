# Mouse move fallback respects the selected channel quarantine

2026-10-18. Bounded correction within the existing authorized reliability implementation. The user already selected brainstorming plus writing-plans and requested implementation and acceptance without repeated planning confirmation.

## Problem and evidence

Read-only review of F=e684ca494613ba93a7b491042922cf43e97cef31 found that WebRTC.sendInput checks the reliable inputChannel quarantine only for non-move events. A move selects the open inputMoveChannel, or falls back to inputChannel. After a reliable ACK timeout quarantines open but silent channel A and Socket.IO dual reset reopens the input gate, a missing/closed move channel can therefore route every move back through A. Returning true prevents the existing Input Socket.IO fallback. Moves have no reliable ACK deadline, so that route need not trigger another recovery.

This is a concrete static condition, not evidence that it caused a recorded production incident. The existing real-function open-but-silent test already exercises the timeout and successful recovery, but asserts only fresh click/key writes. A regression must establish failure on unchanged F before implementing the fix.

The 4096-byte move drop is separate intentional behavior permitted by requirements. This work must not promise final-hover delivery, introduce move ACK deadlines or alter drop/coalescing semantics.

## Selected approach and alternatives

Apply quarantine to the actual selected channel object after channel selection, before ready-state/backpressure/send. A quarantined selected channel returns false, allowing the existing connected Socket.IO fallback. A separate healthy move channel remains usable; a replacement reliable channel B is not tainted by A's quarantine identity.

Routing all movement through Socket after any reliable fault would unnecessarily discard a healthy independent move channel. Closing/rebuilding the PeerConnection would disturb media and add recovery work. Changing the permissive move-drop contract is unrelated to the proven routing gap. The selected check is the smallest correction.

## Required behavior

- A current quarantined channel is never used for move or reliable writes, regardless of bufferedAmount. No send call and no successful drop return may bypass this rule.
- After the existing successful dual reset, new moves use connected Socket.IO when their selected DC is quarantined. No old input is replayed.
- A healthy separate open move channel still handles moves. Healthy reliable fallback still handles moves when no dedicated move channel exists. An unrelated retired quarantined object does not block the current replacement.
- If Socket.IO is unavailable and the selected DC is quarantined, high-level dispatch returns null, without claiming accepted transport or creating new latency/reliable pending work.
- Movement retains no reliable sequence/deadline. Healthy-channel 4 KiB drops retain true/no send/no Socket fallback. Reliable backpressure remains 512 KiB.
- Keep all leases, reset barriers, attempt/source fences, privacy rules and input admission gates unchanged.

## Global constraints

- Implementation modifies only web-client/js/webrtc.js and web-client/js/input-recovery.test.js. Root owns this spec, its plan and review records.
- Use actual Input and WebRTC methods in the existing VM fixture with fake channel/socket/clock only. No browser, network, native input, process inspection, service/build/install or runtime configuration actions by workers.
- Preserve sampler/ordinary runner/supervisor/qualification predicates and all recovery budgets, quality, codec, FPS, resolution, bitrate and network policy.
- Preserve the four pre-existing dirty documents, node_modules metadata/link, primary index, W2 four paths, tunnel/watch/quick URL and every earlier failed attempt and marker.
- Source F and R3 operations remain immutable historical artifacts. No R3 execution is allowed for later source; root must derive and independently review a new frozen source/operations context.
- Native/business/visible/physical acceptance remains NOT_RUN. Offline fake inputs do not establish real input-to-picture latency.

## Verification and release

Demonstrate actual RED on the missed post-recovery move case, then GREEN with the selected-object check. Cover closed, missing and aliased move channels; zero and >4096 buffering; healthy separate move, healthy reliable fallback, replacement identity, no Socket and intentional healthy move drops. Use observable channel/socket calls and existing pending/sequence state; no source-text assertions or validator replacements.

Run the affected input-recovery, WebRTC, Input, input-backpressure and passive sampler suites once after the fix. Record exact results and any expected diagnostic noise. Task review and final increment review must be independent. Runtime remains on dfb product/tool59 until a new reviewed deployment; fresh baseline and recovery/continuity cases start at zero. Do not carry previous INCOMPLETE duration forward.
