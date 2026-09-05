# Task 4 report — mobile navigation and context orchestration

## Scope and implementation

- Implemented R9 tracked-keyup safety, R10 shared surface `settled/pending/uncertain` ACK gate, R11 ordinary text-modal bridge, and R12 readonly virtual-modifier classification.
- Added cursor-aware safe diffing: duplicate insertion after repeated left navigation is accepted at the known cursor; arbitrary accepted-history edits before that cursor remain fail-closed; bounded deletion, retry/drain, scalar safety, and 4096-scalar limits remain intact.
- Unified textarea, toolbar, touch, mouse/pen, and right-click orchestration through the existing controller, `_desktopWritePending`, `acceptMouseAck`, and existing keyboard/mouse seq/ACK paths. No new wire fields, lease, protocol, or reliable queue were added.
- Fixed ChromeLayout idle classification to consume `hasPending`/`status` instead of the stale `pending` field, and exposed blocked mobile text state through the existing WebRTC capability snapshot. No media, Terminal, or layout geometry behavior was changed.

## TDD evidence

RED regressions were established before each focused fix:

- `chrome-layout.test.js`: stale `snapshot.pending` returned `off` instead of `pending` (23 pass / 1 fail).
- Surface-reset regression: pending surface remained `pending` instead of becoming independent `uncertain` after mouse reset (76 pass / 1 fail).
- WebRTC capability regression: blocked mobile state returned `visible` (199 pass / 1 fail).
- Cursor regression: a duplicate-character insertion after repeated left navigation was incorrectly rejected by greedy diff; the first focused run returned the wrong accepted-history outcome.

## GREEN verification

- `node --test web-client/js/mobile-text-input.test.js web-client/js/input.test.js web-client/js/touch-input-adapter.test.js web-client/js/chrome-layout.test.js` — **151 pass, 0 fail**.
- `node --test web-client/js/webrtc.test.js` — **200 pass, 0 fail**.
- `git diff --check` and `node --check` for all changed JavaScript files — pass.

The WebRTC VM suite emits the existing offline `fetch is not defined` WebRTC-config fallback warnings; no live service, browser, public tunnel, or physical device was used.

## Changed files

- `web-client/js/mobile-text-input.js` and `mobile-text-input.test.js`
- `web-client/js/input.js` and `input.test.js`
- `web-client/js/touch-input-adapter.js` and `touch-input-adapter.test.js`
- `web-client/js/chrome-layout.js` and `chrome-layout.test.js`
- `web-client/js/webrtc.js` and `webrtc.test.js`

## Concerns and not-run evidence

- Android/iPhone/iPad, system IME, Quartz/native Host behavior, live WebRTC, public URL, tunnel, and watcher acceptance remain **NOT RUN**.
- The WebRTC change is limited to deriving the existing `mobileInputMode: 'blocked'` capability field from adapter metadata; media/Terminal/session lifecycle code was not changed.
- The final commit SHA is reported in the handoff; this report is intentionally metadata-only and contains no user text, key, coordinate, clipboard, password, token, or payload content.
