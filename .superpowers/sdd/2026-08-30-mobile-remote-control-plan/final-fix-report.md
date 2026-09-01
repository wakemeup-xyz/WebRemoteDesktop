# Mobile Remote-Control Final Fix Report

**Base:** `70dc75e`
**Commit subject:** `fix(mobile-control): enforce reliable desktop writes`
**Commit SHA:** recorded in the final handoff after this report is committed.

## Findings And Root Causes

1. **Cumulative touch movement.** `TouchInputAdapter` overwrote the movement origin on every pointer move, so a sequence of small moves could remain a tap/long press. It now stores immutable `startClientX/startClientY`, compares every move against them, and cancels the long-press path when cumulative distance crosses 8 CSS px. The new regression verifies left drag/move/up rather than right long-press for `10 -> 14 -> 18 -> 22`.
2. **Reliable desktop writes.** Mouse/command v2 envelopes were emitted with a sequence but Socket.IO only strictly validated keyboard writes, while Host executed mouse/command without a lease-scoped sequence ledger. `remote-input-contract.js` now validates typed mouse/command envelopes, preserving unordered `mouse/move`; `ReliableDesktopWriteState` accepts only the next reliable action for the active lease, rejects duplicate/reordered/gapped writes, and does not consume sequence for move. Signal stamps Socket transport. Host ACKs retain optional mouse `appliedSeq` without keyboard pressed/pending fields. Viewer keeps mouse out of `KeyboardTransport` pending.
3. **System-keyboard geometry.** The harness treated `#mobileInputDock` as a system keyboard. It now records the application text Dock separately. A keyboard PASS requires a positive observed layout or `visualViewport` contraction; otherwise it writes `NOT RUN: system-keyboard-geometry-unavailable`. Artifact payloads exclude screenshots, raw layout boxes/coordinates, text, keys, URLs, tokens, and credentials.
4. **Documentation and stale fixture.** The acceptance report and related plan/Task 6/requirement text no longer promise screenshots or label the application Dock as a keyboard. The blur regression now asserts intended parked behavior with no DataChannel: no Socket reset is emitted and keyboard state remains `READY`.

## TDD Evidence

Each RED below was a reversible mutation of the completed production branch; the named real regression failed for the expected missing behavior, then the production line was restored and rerun GREEN.

| Area | RED command and result | GREEN command and result |
|---|---|---|
| Cumulative touch | `node --test --test-name-pattern='cumulative sub-threshold moves start a drag and cancel long press' web-client/js/touch-input-adapter.test.js` -> `0 pass, 1 fail`; prior-pointer comparison emitted right down/up. | Same command -> `1 pass, 0 fail`. |
| Signal desktop contract | `node --test --test-name-pattern='validates reliable desktop writes' lib/remote-input-contract.test.js` -> `0 pass, 1 fail`; missing reset sequence was accepted. | Same command -> `1 pass, 0 fail`. |
| Host ordering | `PYTHONPATH=. python3 -m pytest -q test_remote_desktop_write_state.py test_input_handler.py -k 'reliable_desktop or reliable_mouse_and_command'` -> `2 failed`; duplicate became a sequence gap. | Same command -> `2 passed, 26 deselected`. |
| Keyboard geometry | `PYTHONPATH=. python3 -m pytest -q scripts/test_mobile_viewer_acceptance.py -k system_keyboard` -> `1 failed, 1 passed, 1 deselected`; unchanged viewport was incorrectly PASS. | `PYTHONPATH=. python3 -m pytest -q scripts/test_mobile_viewer_acceptance.py` -> `3 passed`. |

Focused GREEN coverage also passed: cumulative touch `1/1`; Viewer sequence plus blur fixture `2/2`; Viewer DataChannel typed-write/move-isolation `1/1`; Signal contract/signaling `73/73`; Host reliable-write/mouse ACK focus `14 passed, 30 deselected`.

## Fresh Full Verification

- `node --test web-client/js/*.test.js web-client/css/*.test.js`: `549 pass, 0 fail`, natural exit.
- `cd signal-server && npm test`: `322 pass, 0 fail`.
- `cd python-host && PYTHONPATH=. python3 -m pytest -q`: `197 passed`, one existing `mss.mss` deprecation warning.
- Harness: `--help`, `python3 -m py_compile scripts/mobile_viewer_acceptance.py`, and focused harness tests passed. A refused-origin dry run created the JSON atomically and its SHA-256 sidecar matched the final JSON bytes; its only runtime result was `NOT RUN`.
- `git diff --check` passed before staging. Cached scope/check gates are recorded after staging below.

## Files Changed

- Viewer: `web-client/js/input.js`, `input.test.js`, `touch-input-adapter.js`, `touch-input-adapter.test.js`, `webrtc.test.js`.
- Signal: `signal-server/lib/remote-input-contract.js`, its tests, and `signal-server/websocket/signaling.js`, its tests.
- Host: `python-host/remote_desktop_write_state.py`, its tests, `input_handler.py`, `host.py`, and affected Host regressions.
- Harness/docs: `scripts/mobile_viewer_acceptance.py`, its tests, acceptance report, plan, Task 6 report, requirement document, and this report.

## Boundaries And Concerns

No Signal Server, Host, dev server, browser origin, Cloudflare, or tunnel was started, restarted, or rebuilt. Real Android, iPhone, iPad, live-origin, Host Quartz, public path, and physical keyboard evidence remain `NOT RUN`. The only suite warning is the pre-existing `mss.mss` deprecation warning. The report commit SHA cannot be self-referential inside its own one-commit tree; the actual SHA is supplied in the final handoff.

## Staged Scope

The staging gate will contain only this final fix wave: cumulative touch, reliable desktop-write validation/ordering/ACKs, truthful harness evidence, stale-fixture correction, and synchronized docs. No merge, push, service operation, or unrelated worktree change is included.
