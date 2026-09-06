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

## Review fix round 1

Base `b75a284`; clarification commit `5ffdab8`.

- Fixed cumulative ACK cleanup losing the current surface down edge, document-level physical keydown bypassing the surface/context gate, public navigation during an unchanged composition, click/pointer focus theft during blocked mobile editing, virtual-modifier release through disabled/stale-ARIA states, and whole-gesture timeout of an already-ACKed down edge.
- Surface confirmation now retains only current down/up IDs, sequences, lease identity, generation, ACK flags, and per-edge deadlines; it does not add a queue or wire data. Late, stale, failed, and old-generation acknowledgements remain fail-closed.
- The VM document listener fixture now dispatches all listeners registered for a type, and touch rejection prevents the native pointer default before consuming the gesture.

### RED evidence

- `node --test web-client/js/mobile-text-input.test.js web-client/js/input.test.js` — **107 pass, 8 fail** for the six adjudicated regressions.
- `node --test --test-name-pattern='touch surface preflight' web-client/js/input.test.js` — **0 pass, 1 fail**.
- `node --test --test-name-pattern='new virtual modifier remains denied when the desktop capability is inactive' web-client/js/input.test.js` — **0 pass, 1 fail**.

### GREEN verification

- `node --test --test-name-pattern='(surface confirmation correlates|document physical keydown|surface-user focus preflight|touch surface preflight|virtual modifier off|new virtual modifier remains denied|surface confirmation does not timeout|surface confirmation starts a fresh up timeout|public navigation rejects)' web-client/js/mobile-text-input.test.js web-client/js/input.test.js` — **9 pass, 0 fail**.
- `node --test --test-name-pattern='(document tracked keyup|surface confirmation ignores stale)' web-client/js/input.test.js` — **2 pass, 0 fail**.
- `node --test web-client/js/mobile-text-input.test.js web-client/js/input.test.js web-client/js/touch-input-adapter.test.js web-client/js/chrome-layout.test.js` — **163 pass, 0 fail**.
- `node --test web-client/js/webrtc.test.js` — **200 pass, 0 fail**.
- `git diff --check && node --check web-client/js/mobile-text-input.js && node --check web-client/js/input.js && node --check web-client/js/touch-input-adapter.js` — pass.

### Review-round concerns and not-run evidence

- Primary-owned offline Chromium focus check against `b527ba6` passed: `python3 .superpowers/sdd/2026-09-06-mobile-input-interaction-remediation-plan/task-4-native-focus-check.py --ref b527ba6`, exit 0, focus retained before/after the actual mouse click. The identical immutable `b75a284` baseline failed. Composition is synthetic, not system IME evidence; Android/iPhone/iPad, system IME, Quartz/native Host behavior, public URL, tunnel, and watcher acceptance remain **NOT RUN**.
- WebRTC VM tests retain the existing offline `fetch is not defined` configuration fallback warnings; no service, browser session, public tunnel, or device was started by this fix round.
- The fix commit SHA is reported in the handoff; this report remains metadata-only and contains no user text, key, coordinate, clipboard, password, token, or payload content.

### Primary verification and scoped re-review

- Independent probes on `b527ba6` passed: reverse successful surface ACKs settle; document physical keydown during surface pending emits no new write; unchanged composition rejects public navigation. Each uses the real Input/controller/transport fixture, not a controller stub.
- Luna/max scoped re-review approved all six fixes with no open Critical/Important findings. The virtual-modifier test's direct invocation of a disabled button handler proves handler logic only; native release-button reachability through capability rendering remains a Task5/7 browser check, not a claimed PASS here.

## Review fix round 2 — cross-input context transaction

Base `48030d7` (including immutable Task5 viewport/layout commit `40e3804`).

### Scope and implementation

- Document-level physical keydowns that are not standalone modifier keys now run through the existing `runMobileEditingAction('context-change', send)` transaction. The real controller send is invoked once; only an accepted remote-changing keydown clears the mobile accepted-history baseline.
- Standalone physical modifier keydowns retain the existing direct controller path so local history is not cleared before a later chord; document keyup remains unconditional and continues the existing tracked-key release path.
- No protocol field, lease, queue, duplicate send, transport, viewport, layout, Host, Terminal, or service behavior was added or changed.

### RED evidence

- `node --test --test-name-pattern='(accepted physical navigation|accepted physical printable|accepted physical chord|ignored physical input|rejected physical input|modifier-only physical)' web-client/js/input.test.js` — **3 pass, 3 fail** before the production change. The three accepted physical context cases retained `abc` instead of invalidating the hidden mobile baseline; ignored-local, rejected-send, and modifier-only/key-up cases passed.

### GREEN verification

- `node --test --test-name-pattern='(accepted physical navigation|accepted physical printable|accepted physical chord|ignored physical input|rejected physical input|modifier-only physical)' web-client/js/input.test.js` — **6 pass, 0 fail**.
- `node --test web-client/js/input.test.js` — **95 pass, 0 fail**.
- `node --test web-client/js/input.test.js web-client/js/mobile-text-input.test.js web-client/js/remote-keyboard-controller.test.js web-client/js/keyboard-transport.test.js` — **167 pass, 0 fail**.

### Review-round concerns and not-run evidence

- Android/iPhone/iPad, system IME, Quartz/native Host, public URL, tunnel, and live watcher acceptance remain **NOT RUN**. Parent-owned native Chromium focus verification remains separate evidence.
- New regressions use the real `RemoteKeyboardController` and `KeyboardTransport` loaded by `loadInput`, ACK each emitted envelope, and apply an ephemeral in-memory remote text/cursor model; no service or browser session was started.
- This appendix and the implementation remain metadata-only regarding user data: no user text, key, coordinate, clipboard, password, token, or payload is persisted.
