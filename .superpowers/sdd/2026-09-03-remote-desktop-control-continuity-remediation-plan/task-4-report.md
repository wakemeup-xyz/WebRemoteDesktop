# Task 4 report: disconnected recovery, loading hit-testing, and media truth

## Status

DONE_WITH_CONCERNS

## Scope

Implemented only the Task 4 viewer changes in the requested files:

- `web-client/js/webrtc.js`
  - A network-mode switch with a disconnected Socket now re-enters `init()` so
    the normal signaling socket/peer lifecycle is created. Connected sockets
    retain the existing `refresh()` path.
  - Media suspension disables input without opening the keyboard reset barrier,
    releases pointer capture, and conditionally parks a locally pressed or
    reset-required keyboard when the input DataChannel is not open.
  - `setUiPhase('connected')` normalizes to `media-pending` until a real painted
    frame exists; only a painted frame records the session `fresh-frame` event.
  - The desktop input gate requires `uiPhase === 'connected'`, a painted frame,
    active control, a connected signaling socket, and the existing media/input
    readiness checks. A short diagnostic `session.media === 'stalled'` sample
    therefore does not flap input while the UI remains in its TURN chase window.
- `web-client/js/chrome-layout.js`
  - `#loading` receives pointer events only during `signaling`; CTA buttons
    remain explicit pointer targets.
- `web-client/css/viewer.css`
  - Non-signaling stream placeholders do not intercept the video surface, while
    Start/retry buttons remain clickable.
- `web-client/js/webrtc.test.js` and `web-client/js/chrome-layout.test.js`
  - Added regressions for the disconnected mode switch, overlay hit-testing,
    media-suspend reset behavior, unpainted connected state, and the UI-phase
    input gate.

Task 4b refresh/SPS work, Task 5 documentation, terminal/tunnel/service/protocol
changes, and public/physical runtime operations were not performed.

## TDD red evidence

Before the implementation, the focused regressions were run with:

```bash
node --test --test-name-pattern='disconnected mode switch reconnects when socket is down|loading overlay only captures video input while signaling|media suspend does not open a keyboard reset barrier|connected without a painted frame remains pending in the session snapshot|desktop input gate follows uiPhase during transient stalled media' web-client/js/webrtc.test.js web-client/js/chrome-layout.test.js
```

The intended five regressions failed: signaling was not initiated for a dead
Socket, the overlay had no non-signaling pointer gate, suspension called the
keyboard reset path, a false `connected` phase was accepted, and the input gate
closed during a transient stalled session sample.

## Verification

- `node --test web-client/js/webrtc.test.js web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js` — **241 passed, 0 failed**.
- `node --test web-client/css/*.test.js web-client/js/*.test.js` — **567 passed, 0 failed**.
- `node --check web-client/js/webrtc.js` and `node --check web-client/js/chrome-layout.js` — passed.
- `git diff --check` — passed.

The task commit is reported in the parent task handoff after the final staged
scope check.

## Concern

Verification is at the unit/layout level. Real browser WebRTC/DataChannel
timing, macOS input behavior, physical-device acceptance, and tunnel/public-path
health remain **NOT RUN**. Existing VM tests may still print their pre-existing
`fetch is not defined` fixture warnings; the suites completed with zero failures.

## Fix round 1/5: dead-socket recovery race

### Root cause

The disconnected mode-switch path called `init()` while leaving the old
reconnect-enabled Socket in `WebRTC.socket`. `init()` awaited
`loadServerConfig()`. If the old Socket emitted `connect` during that await,
its handler created a PeerConnection; after configuration loaded, `init()`
created another one without closing the first.

### TDD red evidence

Added `dead-socket mode switch ignores an old socket reconnect during config
load` to `web-client/js/webrtc.test.js`. On the pre-fix implementation, the
deterministic old-Socket reconnect fired while configuration was pending and
the test failed because one PeerConnection had already been created before
the replacement init path completed (`1 !== 0`).

### Fix

- `quiesceDisconnectedSocket()` invalidates the old Socket before its
  asynchronous config wait, disconnects it, and leaves `WebRTC.socket` empty
  until the normal `init()` path creates the replacement.
- `setupSocketListeners()` binds handlers to their Socket identity and ignores
  stale events. The async connect handler also rechecks identity after
  diagnostic replay before it can create a PeerConnection.
- Connected Socket mode switches still use the existing manual `refresh()`
  path unchanged.

### Fix-round verification

- `node --test --test-name-pattern='dead-socket mode switch ignores an old socket reconnect during config load' web-client/js/webrtc.test.js` — **1 passed, 0 failed**.
- `node --test web-client/js/webrtc.test.js web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js` — **242 passed, 0 failed**.
- Full viewer CSS/JS suite — **568 passed, 0 failed**.
- Syntax and diff checks passed.

The fix-round commit is reported in the parent task handoff.
