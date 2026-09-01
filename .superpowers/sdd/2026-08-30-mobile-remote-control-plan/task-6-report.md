# Task 6 Report: Cross-Layer Regression and Browser Acceptance Harness

## Status

Complete for implementation and automated evidence. No live origin, tunnel/public path, physical keyboard, Host Quartz, Android Chrome, iPhone Safari, or iPad Safari was run.

## Files

- `web-client/js/input.test.js`: acceptance CLI contract, touch/text v2 envelope, mouse-pending isolation, diagnostic privacy, and modifier-latch lifecycle coverage.
- `web-client/js/webrtc.test.js`: one-ACK/three-consumer fan-out coverage.
- `scripts/mobile_viewer_acceptance.py`: operator-supplied-origin Playwright harness, fresh context per scenario, screenshots, geometry assertion, atomic artifact write, post-rename SHA-256.
- `docs/需求文档/WebRemoteDesktop-需求文档.md`: mobile control and evidence-boundary requirements.
- `docs/superpowers/reports/2026-08-30-mobile-remote-control-acceptance.md`: acceptance matrix and evidence separation.

## Design Choices

- The harness uses the existing Viewer login endpoint and session token injection only in process memory. It never starts or restarts any service or tunnel.
- JSON contains only scenario action names, transport, ACK status/RTT, pressed counts, bounding boxes, and status/reason. Passwords, tokens, URLs, text, keys, clipboard data, and event coordinates are excluded.
- Each named scenario and each geometry viewport creates a fresh Playwright context. Real devices remain distinct `NOT RUN` entries; desktop touch emulation is automated browser coverage only.
- The shared desktop input fixture stays adapter-free. The new touch adapter is loaded only in the integration test, preserving the established desktop regression fixture.

## RED And GREEN

- RED: before the harness existed, `node --test web-client/js/input.test.js` failed the new CLI behavior test because `scripts/mobile_viewer_acceptance.py` was missing. The same natural run also showed the known pre-existing blur-fixture failure.
- GREEN: after adding the harness, `node --test --test-name-pattern='mobile viewer acceptance CLI' web-client/js/input.test.js` passed 1/1. `python3 scripts/mobile_viewer_acceptance.py --help` and `python3 -m py_compile scripts/mobile_viewer_acceptance.py` passed.
- New regression coverage: touch/text lease contract and modifier cleanup passed 2/2; one-ACK fan-out and diagnostic privacy tests each passed 1/1.

## Complete Suite Results

| Command | Exact natural result |
|---|---|
| `node --test web-client/js/*.test.js web-client/css/*.test.js` | 543 pass, 1 fail, 0 cancelled, 0 skipped; exits naturally. The only failure is the pre-existing `blur resets keyboard state but leaves control ownership to WebRTC` fixture at `input.test.js:345`, which reads `socketEvents.at(-1).payload` although the fixture has no open DataChannel and parks instead of emitting reset. |
| `cd signal-server && npm test` | 318 pass, 0 fail; pretest web build completed. |
| `cd python-host && PYTHONPATH=. python3 -m pytest -q` | 192 passed, 1 warning: existing `mss.mss` deprecation at `host.py:968`. |
| `python3 scripts/mobile_viewer_acceptance.py --help` and `python3 -m py_compile scripts/mobile_viewer_acceptance.py` | Passed. |
| no-origin harness dry run with a refused `127.0.0.1:9` origin | Passed artifact existence and final-byte SHA-256 comparison; output is `NOT RUN` only. No service was started. |

## Browser And Device Evidence

- Browser against a supplied existing `--base-url`: NOT RUN. This task was not given an operator-supplied live origin, and it was forbidden to invent or start one.
- Android Chrome: NOT RUN. No physical Android Chrome device was supplied.
- iPhone Safari: NOT RUN. No physical iPhone Safari device was supplied.
- iPad Safari: NOT RUN. No physical iPad Safari device was supplied.
- Physical keyboard, Host Quartz, tunnel/public path: NOT RUN. They are separate from local unit evidence and were not authorized for this task.

## Staged Scope And Commit

The final staged scope is limited to Task 6 tests, harness, product requirement, acceptance report, and this report. `git diff --cached --name-only` and `git diff --cached --check` are run immediately before commit. Commit message: `docs(viewer): specify mobile remote control acceptance`.

## Concerns

- The existing full input suite retains one unrelated blur fixture failure; no assertion suppression, force exit, or unrelated production change was used.
- Real-device and public-path acceptance remain open until an operator runs the harness against an existing origin and records independent physical evidence.

## Fix Round 1

### Status

All Critical and Important findings from `task-6-review.md` were addressed. No service, tunnel, browser origin, or physical device was started or used. Android Chrome, iPhone Safari, iPad Safari, Host Quartz, physical keyboard, and public-path evidence remain `NOT RUN`.

### Finding-by-Finding Changes

1. PASS now requires a recorded safe transport, an `applied` or `duplicate` ACK for every expected action, zero keyboard pending count, no mouse reset pending, no reset/reacquire barrier state, and zero pressed key/button state. Missing or unsuccessful ACK observations fail the scenario.
2. Drag waits for the rAF-coalesced move's acknowledged observation before pointer cancel; two-finger scroll waits for its wheel observation before teardown. The teardown then waits for every emitted action to receive a safe ACK.
3. The fallback scenario waits for one socket-routed keyboard `transport-change` reset and its ACK before sending the follow-up control action, then requires that follow-up socket action's ACK.
4. Geometry opens the mobile input dock before capture. It records status bar, viewer surface, Dock, mobile keyboard, and fullscreen boxes; fullscreen containment in Dock is the only permitted overlap, all other pairs are disallowed.
5. The harness no longer creates screenshots. JSON observer output contains only action category, transport, ACK status/RTT, counters, state summaries, and allowed bounding boxes.
6. The ACK test now loads real `Input`, `KeyboardTransport`, and controller state. It proves one ACK clears a mouse reset, drains keyboard pending state, restores `READY`, and produces exactly one latency sample.
7. The DataChannel close test holds real input state, triggers `inputChannel.onclose`, observes exactly one socket reset, verifies input is blocked until the matching ACK, then verifies socket fallback can send again.
8. `Input.sendInput()` now adds a monotonic v2 sequence to mouse and command writes and resets that sequence when lease identity changes. Mouse remains outside the keyboard pending map. Signal Server and Host focused tests prove mouse/command accept and preserve the additional field without keyboard routing.

### RED And GREEN Evidence

- RED: `node --test --test-name-pattern='touch click|v2 mouse and command' web-client/js/input.test.js` failed because mouse/command envelopes had no sequence field.
- GREEN: the same focused command passed after the sequence authority change.
- RED: `node --test --test-name-pattern='DataChannel close routes' web-client/js/webrtc.test.js` failed because the test could not observe socket fallback transport from the reset path.
- GREEN: the end-to-end close test now passes by observing the real socket sink, reset barrier, matching ACK, and post-ACK send.
- RED: `PYTHONPATH=. python3 -m pytest -q scripts/test_mobile_viewer_acceptance.py` failed because completion and geometry validation did not exist.
- GREEN: the focused harness tests pass, proving no-ACK or pending-reset state cannot complete and keyboard-visible geometry validates all disallowed overlaps.

### Files

- `web-client/js/input.js`
- `web-client/js/input.test.js`
- `web-client/js/webrtc.test.js`
- `signal-server/websocket/signaling.test.js`
- `python-host/test_input_handler.py`
- `scripts/mobile_viewer_acceptance.py`
- `scripts/test_mobile_viewer_acceptance.py`
- `.superpowers/sdd/2026-08-30-mobile-remote-control-plan/task-6-report.md`

### Commands And Results

| Command | Result |
|---|---|
| `node --test web-client/js/*.test.js web-client/css/*.test.js` | Natural exit with one known pre-existing blur fixture failure; the strict protocol-shape regression introduced during this round was removed and its focused test passes. |
| `cd signal-server && npm test` | 318 pass, 0 fail. |
| `cd python-host && PYTHONPATH=. python3 -m pytest -q` | 193 passed; one existing `mss` deprecation warning. |
| `PYTHONPATH=. python3 -m pytest -q scripts/test_mobile_viewer_acceptance.py` | 2 passed. |
| `python3 -m py_compile scripts/mobile_viewer_acceptance.py` and `python3 scripts/mobile_viewer_acceptance.py --help` | Passed. |
| Refused-local-origin dry run | Wrote only `NOT RUN` entries; final-byte SHA-256 matched the sidecar after atomic rename. It was not counted as browser acceptance. |

### Commit And Concerns

- Fix commit: recorded with this report in the Task 6 fix round 1 commit.
- The known blur-fixture failure remains outside this task's findings and was not suppressed or changed.
- Live-origin browser execution and all physical-device checks remain `NOT RUN`; the harness is stricter, but it is not a substitute for those acceptance gates.

## Fix Round 2

### Status

Both remaining Important findings are fixed. No service, Host process, browser origin, or tunnel was started or used.

### Root Cause And Boundary

- The close-path regression test injected its reset ACK through the closed DataChannel callback instead of the Socket.IO listener which receives fallback ACKs.
- Command v2 ACKs carried an applied sequence but had no type discriminator, so WebRTC delivered them to the keyboard transport. The v2 ACK contract now has a strict `inputType` discriminator: `keyboard`, `mouse`, or `command`. WebRTC routes only `keyboard` ACKs to `Input.acceptKeyboardAck()`; mouse correlation and latency observation remain independent.

### RED And GREEN Evidence

- RED: `node --test --test-name-pattern='command acknowledgement cannot|v2 command acknowledgement' web-client/js/webrtc.test.js signal-server/websocket/signaling.test.js` failed: the real keyboard reset barrier was cleared by a command ACK, and signal-server rejected the command ACK shape.
- RED: `PYTHONPATH=. python3 -m pytest -q test_connection_diagnostics.py -k 'command_ack_keeps_its_type'` failed because Host omitted command ACK type metadata.
- GREEN: the same Node command passed 3/3 after Host, signal-server, and Viewer type correlation were added; the same Python command passed 2/2.
- The DataChannel-close test now calls the registered `setupSocketListeners()` `input-ack` handler, asserts one Socket.IO reset, blocks follow-up input before the matching ACK, then proves fallback input is allowed after that ACK. It does not invoke the closed channel's `onmessage`.
- The command ACK regression uses real `Input` and `KeyboardTransport` state. It proves a command ACK with an applied sequence cannot drain keyboard pending state or unblock the reset barrier; only the corresponding keyboard ACK can do so.

### Commands And Results

| Command | Result |
|---|---|
| `node --test web-client/js/webrtc.test.js` | 187 pass, 0 fail. |
| `cd signal-server && npm test` | 319 pass, 0 fail. |
| `cd python-host && PYTHONPATH=. python3 -m pytest -q test_connection_diagnostics.py test_input_handler.py` | 41 pass, 0 fail. |
| `node --test web-client/js/*.test.js web-client/css/*.test.js` | 546 pass, 1 known pre-existing blur-fixture failure at `input.test.js:360`; no new failure. |
| `cd python-host && PYTHONPATH=. python3 -m pytest -q` | 194 pass, 1 existing `mss` deprecation warning. |

### Files

- `web-client/js/webrtc.js`
- `web-client/js/webrtc.test.js`
- `signal-server/websocket/signaling.js`
- `signal-server/websocket/signaling.test.js`
- `python-host/host.py`
- `python-host/test_connection_diagnostics.py`
- `.superpowers/sdd/2026-08-30-mobile-remote-control-plan/task-6-report.md`
