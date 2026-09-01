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
