# Remote Desktop Media Suspension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop remote desktop capture, encoding, and video payload transmission while Terminal is active, the Viewer page is hidden, or manual pause is enabled, then resume the existing media connection with a decodable frame.

**Architecture:** A pure browser `MediaActivityController` owns the active/suspended truth and reason generation. Thin lifecycle, UI, WebRTC, tunnel, Signal, and Host adapters consume that truth; WebRTC pauses by detaching the aiortc sender track and suspending MSS capture, while tunnel reuses `relay-stream-control`. Media health logic explicitly recognizes suspended/resuming states so intentional 0 FPS never triggers degradation or ICE recovery.

**Tech Stack:** Browser JavaScript, Page Visibility/Page Lifecycle events, WebRTC, Socket.IO, Node.js test runner, Python 3.11, aiortc 1.14.0, pytest.

**Spec Coverage:** This plan covers the full approved spec in `docs/superpowers/specs/2026-07-19-remote-desktop-media-suspension-design.md`, including controller truth, lifecycle inputs, WebRTC and tunnel paths, Host capture suspension, ack/generation handling, observability, docs, and runtime acceptance.

**Truth Source:** `MediaActivityController.snapshot()` is the Viewer truth for state/reasons/generation; `WebRemoteHost` stores the applied state scoped to `current_viewer_id`, `connectionAttemptId`, and generation.

**Compatibility Notes:** Existing `media-profile-change`, network mode, desktop control lease, Terminal namespace, and `relay-stream-control` remain long-term interfaces. The aiortc private keyframe request is isolated in `python-host/aiortc_media_sender.py`; failure falls back to the existing `WebRTC.refresh()` path after a bounded resume timeout.

**Impact Map:**
- **Truth Source:** New pure `MediaActivityController`; Host mirrors only the last applied generation for the active Viewer connection.
- **Backend:** Signal validates/routes `media-activity-change` and `media-activity-ack`; Python Host detaches/reattaches the RTP track and pauses/resumes capture.
- **Frontend:** Terminal, Page Visibility, and manual pause write reasons; WebRTC/tunnel, input, status, and diagnostics consume snapshots.
- **Runtime Proof:** Host `captureSeq`, encoder activity, Viewer RTP payload bytes, frame rendering, ICE/reconnect events, and Terminal IO during 15-second suspension windows.
- **Docs/Skills:** Update `README.md` and `docs/需求文档/WebRemoteDesktop-需求文档.md`; safe-startup and tunnel lifecycle docs remain unchanged.
- **Commit Boundary:** Media suspension only. Do not include unrelated keyboard, Terminal composer, tunnel lifecycle, service restart, or existing dirty-worktree changes.

**Definition of Done:**
- Terminal, page-hidden, and manual-pause reasons compose without overwriting one another, and tunnel/Terminal sessions remain alive.
- WebRTC suspension stops new capture and RTP video payloads while PeerConnection/DataChannel stay connected; tunnel suspension stops JPEG relay frames.
- Resume produces a rendered WebRTC frame within 1500ms P95 or performs one bounded refresh fallback; tunnel resumes within 2500ms P95.
- Suspended/resuming states never cause quality degradation, media-stalled classification, ICE restart, or automatic reconnect.
- Targeted automated suites and real Chrome acceptance pass, and active requirements/README describe the shipped behavior.

## Implementation Status (2026-07-20)

The original ten-task design was implemented through the follow-up reliability
closure because the control-lease barrier and media authority had to be made
fail-closed before media commands could safely reach the Host. The current
implementation is recorded by `7f87342`, `1cd965e`, `2fd0b6d`, `d7a96b3`,
`3f07286`, `de8bfa5`, and `9a5388b`.

| Original task | Current status | Evidence |
| --- | --- | --- |
| 1-3 Viewer truth, lifecycle, UI and Terminal intent | Implemented | `media-activity-controller`, `media-activity-lifecycle`, `media-activity-runtime`, `webrtc`, and Terminal tests |
| 4 Signal routing | Implemented | lease-bound `media-activity-change` contract and `signaling.test.js` |
| 5-6 Host sender/capture and generation ownership | Implemented | `aiortc_media_sender`, `ScreenCaptureTrack`, `test_media_suspension.py`, `test_offer_epoch.py` |
| 7-8 WebRTC/tunnel health and relay behavior | Implemented | Viewer, Signal, and Host tunnel regression tests |
| 9 Diagnostics and active docs | Implemented | `README.md`, requirements document, runtime evidence report |
| 10 automated closure | Verified on `9a5388b` | Viewer/CSS 258, Signal 246, Host 116; `git diff --check` clean |
| 10 current-HEAD browser rerun | Not completed | no controllable browser is available in this session; historic reports remain evidence for their recorded commits only |

---

### Task 1: Build the pure media activity truth module

**Files:**
- Create: `web-client/js/media-activity-controller.js`
- Create: `web-client/js/media-activity-controller.test.js`

- [ ] **Step 1: Write failing tests for reason composition and generation**

```javascript
const assert = require('node:assert/strict');
const test = require('node:test');
const { MediaActivityController } = require('./media-activity-controller');

test('media activity suspends for any reason and only increments on changes', () => {
  const changes = [];
  const controller = MediaActivityController.create({ onChange: (value) => changes.push(value) });

  assert.deepEqual(controller.snapshot(), { state: 'active', reasons: [], generation: 0 });
  controller.setReason('terminal-active', true);
  controller.setReason('page-hidden', true);
  controller.setReason('terminal-active', true);

  assert.deepEqual(controller.snapshot(), {
    state: 'suspended',
    reasons: ['terminal-active', 'page-hidden'],
    generation: 2,
  });
  assert.equal(changes.length, 2);
});

test('clearing automatic reasons preserves manual pause', () => {
  const controller = MediaActivityController.create();
  controller.setReason('manual-pause', true);
  controller.setReason('terminal-active', true);
  controller.setReason('terminal-active', false);
  assert.deepEqual(controller.snapshot().reasons, ['manual-pause']);
  assert.equal(controller.snapshot().state, 'suspended');
});

test('unknown reasons are rejected without changing state', () => {
  const controller = MediaActivityController.create();
  assert.throws(() => controller.setReason('network-slow', true), /Unknown media activity reason/);
  assert.equal(controller.snapshot().generation, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test web-client/js/media-activity-controller.test.js`

Expected: FAIL with `Cannot find module './media-activity-controller'`.

- [ ] **Step 3: Implement the pure controller**

```javascript
const MediaActivityController = {
  reasons: ['manual-pause', 'terminal-active', 'page-hidden', 'page-hide'],

  create(options = {}) {
    const allowed = new Set(MediaActivityController.reasons);
    const activeReasons = new Set();
    const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
    let generation = 0;

    const snapshot = () => ({
      state: activeReasons.size === 0 ? 'active' : 'suspended',
      reasons: MediaActivityController.reasons.filter((reason) => activeReasons.has(reason)),
      generation,
    });

    return {
      setReason(reason, enabled) {
        if (!allowed.has(reason)) throw new Error(`Unknown media activity reason: ${reason}`);
        const changed = enabled ? !activeReasons.has(reason) : activeReasons.has(reason);
        if (!changed) return snapshot();
        if (enabled) activeReasons.add(reason);
        else activeReasons.delete(reason);
        generation += 1;
        const value = snapshot();
        onChange(value);
        return value;
      },

      hasReason(reason) {
        return activeReasons.has(reason);
      },

      snapshot,
    };
  },
};

if (typeof module !== 'undefined') module.exports = { MediaActivityController };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test web-client/js/media-activity-controller.test.js`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit the controller slice**

```bash
git add web-client/js/media-activity-controller.js web-client/js/media-activity-controller.test.js
git commit -m "feat(viewer): add media activity state controller"
```

### Task 2: Translate Page Visibility and Page Lifecycle events into reasons

**Files:**
- Create: `web-client/js/media-activity-lifecycle.js`
- Create: `web-client/js/media-activity-lifecycle.test.js`

- [ ] **Step 1: Write failing lifecycle adapter tests**

```javascript
const assert = require('node:assert/strict');
const test = require('node:test');
const { MediaActivityLifecycle } = require('./media-activity-lifecycle');

function eventTarget() {
  const listeners = new Map();
  return {
    hidden: false,
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name) { listeners.delete(name); },
    dispatch(name) { listeners.get(name)?.(); },
    listenerCount() { return listeners.size; },
  };
}

test('hidden is debounced and visible cancels pending suspension', () => {
  const documentLike = eventTarget();
  const windowLike = eventTarget();
  const reasons = [];
  let scheduled = null;
  const lifecycle = MediaActivityLifecycle.create({
    documentLike,
    windowLike,
    setTimeoutFn(fn) { scheduled = fn; return 1; },
    clearTimeoutFn() { scheduled = null; },
    setReason(reason, enabled) { reasons.push([reason, enabled]); },
  });

  lifecycle.start();
  documentLike.hidden = true;
  documentLike.dispatch('visibilitychange');
  documentLike.hidden = false;
  documentLike.dispatch('visibilitychange');
  scheduled?.();
  assert.deepEqual(reasons, [['page-hidden', false]]);
});

test('pagehide suspends immediately and pageshow restores', () => {
  const documentLike = eventTarget();
  const windowLike = eventTarget();
  const reasons = [];
  const lifecycle = MediaActivityLifecycle.create({
    documentLike,
    windowLike,
    setReason(reason, enabled) { reasons.push([reason, enabled]); },
  });
  lifecycle.start();
  windowLike.dispatch('pagehide');
  windowLike.dispatch('pageshow');
  lifecycle.stop();
  assert.deepEqual(reasons.slice(-2), [['page-hide', true], ['page-hide', false]]);
  assert.equal(documentLike.listenerCount() + windowLike.listenerCount(), 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test web-client/js/media-activity-lifecycle.test.js`

Expected: FAIL with `Cannot find module './media-activity-lifecycle'`.

- [ ] **Step 3: Implement the lifecycle adapter with cleanup**

```javascript
const MediaActivityLifecycle = {
  create(options = {}) {
    const documentLike = options.documentLike || document;
    const windowLike = options.windowLike || window;
    const setReason = options.setReason;
    const setTimeoutFn = options.setTimeoutFn || setTimeout;
    const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
    const hiddenDelayMs = Number(options.hiddenDelayMs || 750);
    let hiddenTimer = null;

    const clearHiddenTimer = () => {
      if (hiddenTimer !== null) clearTimeoutFn(hiddenTimer);
      hiddenTimer = null;
    };
    const onVisibilityChange = () => {
      clearHiddenTimer();
      if (documentLike.hidden) {
        hiddenTimer = setTimeoutFn(() => {
          hiddenTimer = null;
          setReason('page-hidden', true);
        }, hiddenDelayMs);
      } else {
        setReason('page-hidden', false);
      }
    };
    const onPageHide = () => setReason('page-hide', true);
    const onPageShow = () => setReason('page-hide', false);

    return {
      start() {
        documentLike.addEventListener('visibilitychange', onVisibilityChange);
        windowLike.addEventListener('pagehide', onPageHide);
        windowLike.addEventListener('pageshow', onPageShow);
      },
      stop() {
        clearHiddenTimer();
        documentLike.removeEventListener('visibilitychange', onVisibilityChange);
        windowLike.removeEventListener('pagehide', onPageHide);
        windowLike.removeEventListener('pageshow', onPageShow);
      },
    };
  },
};

if (typeof module !== 'undefined') module.exports = { MediaActivityLifecycle };
```

- [ ] **Step 4: Run lifecycle and controller tests**

Run: `node --test web-client/js/media-activity-controller.test.js web-client/js/media-activity-lifecycle.test.js`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit the lifecycle adapter**

```bash
git add web-client/js/media-activity-lifecycle.js web-client/js/media-activity-lifecycle.test.js
git commit -m "feat(viewer): map page lifecycle to media activity"
```

### Task 3: Route manual pause and Terminal tab changes through the controller

**Files:**
- Modify: `web-client/viewer.html`
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/ui.js`
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/js/webrtc.test.js`
- Modify: `web-client/js/terminal.test.js`

- [ ] **Step 1: Add failing UI and Terminal behavior tests**

Add assertions that the pause button toggles `manual-pause`, Terminal sets `terminal-active`, desktop clears only `terminal-active`, and `showDesktop()` leaves the Terminal socket connected:

```javascript
test('Terminal tab writes only the terminal media reason', () => {
  const reasons = [];
  const { TerminalPanel } = loadTerminal({
    WebRTC: { setMediaActivityReason: (reason, enabled) => reasons.push([reason, enabled]) },
  });
  TerminalPanel.cacheElements();
  TerminalPanel.showTerminal();
  TerminalPanel.showDesktop();
  assert.deepEqual(reasons, [['terminal-active', true], ['terminal-active', false]]);
});

test('pause button delegates manual intent to WebRTC media activity', () => {
  const handlers = new Map();
  const reasons = [];
  const pauseButton = {
    textContent: '',
    addEventListener(name, handler) { handlers.set(name, handler); },
  };
  const video = { play() {}, pause() {}, classList: { add() {}, remove() {} } };
  const { UI } = loadUiContext({
    elements: { pauseBtn: pauseButton, remoteVideo: video },
    WebRTC: {
      getMediaActivitySnapshot: () => ({ state: 'active', reasons: [] }),
      setMediaActivityReason: (reason, enabled) => reasons.push([reason, enabled]),
      disconnect() {},
      requestResolution() {},
    },
  });
  UI.init();
  handlers.get('click')();
  assert.deepEqual(reasons, [['manual-pause', true]]);
});
```

Extend the existing `loadTerminal()` VM context so the test and real `terminal.js` consume the same global interface:

```javascript
WebRTC: overrides.WebRTC || {},
```

Add this helper beside the existing VM-based UI smoke test; it evaluates the real `ui.js` rather than copying UI behavior:

```javascript
function loadUiContext(overrides = {}) {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const elements = new Map(Object.entries(overrides.elements || {}));
  const fallback = {
    textContent: '', style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, focus() {}, play() {}, pause() {},
  };
  const context = {
    console,
    document: {
      body: fallback,
      fullscreenElement: null,
      addEventListener() {},
      querySelector() { return fallback; },
      querySelectorAll() { return []; },
      getElementById(id) { return elements.get(id) || null; },
    },
    Input: { setActive() {} },
    WebRTC: overrides.WebRTC,
    confirm: () => true,
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, 'ui.js'), 'utf8');
  vm.runInContext(`${source}\nglobalThis.__UI = UI;`, context);
  return { UI: context.__UI, elements };
}
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run: `node --test web-client/js/webrtc.test.js web-client/js/terminal.test.js`

Expected: FAIL because `setMediaActivityReason()` is not called.

- [ ] **Step 3: Load the new modules and initialize one controller**

Insert before `webrtc.js` in `viewer.html`:

```html
<script src="js/media-activity-controller.js"></script>
<script src="js/media-activity-lifecycle.js"></script>
<script src="js/webrtc.js"></script>
```

Add to `WebRTC`:

```javascript
mediaActivityController: null,
mediaActivityLifecycle: null,

initializeMediaActivity() {
  if (this.mediaActivityController) return;
  this.mediaActivityController = MediaActivityController.create({
    onChange: (snapshot) => this.applyMediaActivity(snapshot),
  });
  this.mediaActivityLifecycle = MediaActivityLifecycle.create({
    setReason: (reason, enabled) => this.setMediaActivityReason(reason, enabled),
  });
  this.mediaActivityLifecycle.start();
},

setMediaActivityReason(reason, enabled) {
  this.initializeMediaActivity();
  return this.mediaActivityController.setReason(reason, Boolean(enabled));
},

getMediaActivitySnapshot() {
  this.initializeMediaActivity();
  return this.mediaActivityController.snapshot();
},
```

Call `WebRTC.initializeMediaActivity()` synchronously in the existing `DOMContentLoaded` handler before asynchronous config loading.

- [ ] **Step 4: Replace local UI and Terminal pause state**

In `ui.js`, remove local `isPaused` and use controller truth:

```javascript
pauseBtn?.addEventListener('click', () => {
  const snapshot = WebRTC.getMediaActivitySnapshot();
  const manuallyPaused = snapshot.reasons.includes('manual-pause');
  WebRTC.setMediaActivityReason('manual-pause', !manuallyPaused);
});
```

In `terminal.js`:

```javascript
showDesktop() {
  this.isVisible = false;
  if (typeof WebRTC !== 'undefined') {
    WebRTC.setMediaActivityReason?.('terminal-active', false);
  }
  // Preserve the existing panel, tab, and Terminal socket behavior.
},

showTerminal() {
  this.isVisible = true;
  if (typeof WebRTC !== 'undefined') {
    WebRTC.setMediaActivityReason?.('terminal-active', true);
  }
  // Preserve the existing authorization, render, fit, and focus behavior.
},
```

- [ ] **Step 5: Run UI and Terminal regression tests**

Run: `node --test web-client/js/media-activity-controller.test.js web-client/js/media-activity-lifecycle.test.js web-client/js/webrtc.test.js web-client/js/terminal.test.js`

Expected: PASS; the existing “Terminal socket stays alive” test remains green.

- [ ] **Step 6: Commit the Viewer intent wiring**

```bash
git add web-client/viewer.html web-client/js/webrtc.js web-client/js/ui.js web-client/js/terminal.js web-client/js/webrtc.test.js web-client/js/terminal.test.js
git commit -m "feat(viewer): unify desktop pause intents"
```

### Task 4: Add validated Signal media activity routing

**Files:**
- Modify: `signal-server/websocket/signaling.js`
- Modify: `signal-server/websocket/signaling.test.js`

- [ ] **Step 1: Write failing protocol and routing tests**

```javascript
test('media activity is sanitized, generation ordered, and forwarded with trusted viewer id', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);

  viewer.trigger('media-activity-change', {
    schemaVersion: 1,
    state: 'suspended',
    reasons: ['terminal-active', 'terminal-active', 'invalid'],
    generation: 2,
    viewerId: 'forged',
    connectionAttemptId: 'attempt-1',
  });
  viewer.trigger('media-activity-change', { state: 'active', reasons: [], generation: 1 });

  const messages = host.sent.filter((entry) => entry.event === 'media-activity-change');
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].data, {
    schemaVersion: 1,
    state: 'suspended',
    reasons: ['terminal-active'],
    generation: 2,
    viewerId: 'viewer-1',
    connectionAttemptId: 'attempt-1',
  });
});

test('a new connection attempt may resync the same generation', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);
  viewer.trigger('media-activity-change', {
    state: 'suspended', reasons: ['manual-pause'], generation: 4,
    connectionAttemptId: 'attempt-1',
  });
  viewer.trigger('media-activity-change', {
    state: 'suspended', reasons: ['manual-pause'], generation: 4,
    connectionAttemptId: 'attempt-2',
  });
  assert.equal(
    host.sent.filter((entry) => entry.event === 'media-activity-change').length,
    2,
  );
});

test('host media activity ack is routed only to its viewer', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  const other = new FakeSocket('viewer-2', 'viewer');
  io.connect(host);
  io.connect(viewer);
  io.connect(other);
  host.trigger('media-activity-ack', { viewerId: 'viewer-1', state: 'suspended', generation: 3, applied: true });
  assert.equal(viewer.sent.some((entry) => entry.event === 'media-activity-ack'), true);
  assert.equal(other.sent.some((entry) => entry.event === 'media-activity-ack'), false);
});

test('offer forwards the trusted connection attempt id to host', () => {
  resetConnections();
  const io = makeIo();
  setupSignaling(io);
  const host = new FakeSocket('host-1', 'host');
  const viewer = new FakeSocket('viewer-1', 'viewer');
  io.connect(host);
  io.connect(viewer);
  viewer.trigger('offer', {
    offer: { type: 'offer', sdp: 'v=0' },
    epoch: 1,
    connectionAttemptId: 'attempt-1',
  });
  assert.equal(
    host.sent.find((entry) => entry.event === 'offer').data.connectionAttemptId,
    'attempt-1',
  );
});
```

- [ ] **Step 2: Run the Signal tests to verify failure**

Run: `cd signal-server && node --test websocket/signaling.test.js`

Expected: FAIL because no `media-activity-change` or ack handler exists.

- [ ] **Step 3: Implement validation, generation ordering, and ack routing**

Inside `setupSignaling()` add a per-socket generation map and handlers:

```javascript
const mediaActivityGenerations = new Map();
const allowedMediaReasons = new Set(['manual-pause', 'terminal-active', 'page-hidden', 'page-hide']);

socket.on('media-activity-change', (data = {}) => {
  if (role !== 'viewer' || !isActiveViewerSocket(socket)) return;
  const generation = Number(data.generation);
  if (!Number.isSafeInteger(generation) || generation < 0) return;
  const connectionAttemptId = String(data.connectionAttemptId || '').slice(0, 96);
  if (!connectionAttemptId) return;
  const generationKey = `${socket.id}:${connectionAttemptId}`;
  const previous = mediaActivityGenerations.get(generationKey) ?? -1;
  if (generation <= previous) return;
  const state = data.state === 'active' || data.state === 'suspended' ? data.state : null;
  if (!state) return;
  const reasons = Array.from(new Set(Array.isArray(data.reasons) ? data.reasons : []))
    .filter((reason) => allowedMediaReasons.has(reason))
    .slice(0, 4);
  mediaActivityGenerations.set(generationKey, generation);
  connections.host?.emit('media-activity-change', {
    schemaVersion: 1,
    state,
    reasons,
    generation,
    viewerId: socket.id,
    connectionAttemptId,
  });
});

socket.on('media-activity-ack', (data = {}) => {
  if (role !== 'host') return;
  const target = connections.viewers.get(data.viewerId);
  if (target) target.emit('media-activity-ack', data);
});
```

Extend `forwardOffer()` so the Host and later media command share one connection identity:

```javascript
connectionAttemptId: String(data.connectionAttemptId || '').slice(0, 96),
```

In the existing Viewer disconnect branch, delete every generation key for that socket so stale attempt state cannot accumulate:

```javascript
for (const key of mediaActivityGenerations.keys()) {
  if (key.startsWith(`${socket.id}:`)) mediaActivityGenerations.delete(key);
}
```

- [ ] **Step 4: Run Signal tests**

Run: `cd signal-server && node --test websocket/signaling.test.js`

Expected: PASS, including invalid role/payload, generation dedupe, disconnect cleanup, and targeted ack tests.

- [ ] **Step 5: Commit the Signal contract**

```bash
git add signal-server/websocket/signaling.js signal-server/websocket/signaling.test.js
git commit -m "feat(signal): route media activity state"
```

### Task 5: Isolate aiortc sender control and suspend the capture thread

**Files:**
- Create: `python-host/aiortc_media_sender.py`
- Create: `python-host/test_media_suspension.py`
- Modify: `python-host/host.py`

- [ ] **Step 1: Write failing sender adapter and capture suspension tests**

```python
from aiortc_media_sender import resume_sender, suspend_sender
from host import ScreenCaptureTrack


class FakeSender:
    def __init__(self):
        self.tracks = []
        self.keyframes = 0

    def replaceTrack(self, track):
        self.tracks.append(track)

    def _send_keyframe(self):
        self.keyframes += 1


def test_sender_adapter_detaches_and_requests_keyframe_on_resume():
    sender = FakeSender()
    track = object()
    suspend_sender(sender)
    requested = resume_sender(sender, track)
    assert sender.tracks == [None, track]
    assert requested is True
    assert sender.keyframes == 1


def test_capture_suspension_clears_buffer_and_resets_frame_pacing():
    track = object.__new__(ScreenCaptureTrack)
    track._activity_condition = __import__('threading').Condition()
    track._suspended = False
    track._capture_buffer = object()
    track._last_img = object()
    track._capture_seq = 4
    track._last_frame_time = 123
    baseline = track.set_suspended(True)
    assert baseline == 4
    assert track._suspended is True
    assert track._capture_buffer is None
    assert track._last_img is None
    track.set_suspended(False)
    assert track._last_frame_time == 0
```

- [ ] **Step 2: Run Python tests to verify failure**

Run: `python3 -m pytest python-host/test_media_suspension.py -q`

Expected: FAIL because `aiortc_media_sender` and `set_suspended()` do not exist.

- [ ] **Step 3: Implement the aiortc adapter**

```python
import logging

logger = logging.getLogger(__name__)


def suspend_sender(sender) -> None:
    sender.replaceTrack(None)


def request_keyframe(sender) -> bool:
    callback = getattr(sender, "_send_keyframe", None)
    if not callable(callback):
        logger.warning("aiortc sender has no keyframe request hook")
        return False
    callback()
    return True


def resume_sender(sender, track) -> bool:
    sender.replaceTrack(track)
    return request_keyframe(sender)
```

- [ ] **Step 4: Add capture condition state to `ScreenCaptureTrack`**

Initialize:

```python
self._activity_condition = threading.Condition()
self._suspended = False
```

At the top of every capture-loop iteration:

```python
with self._activity_condition:
    while self._suspended and self._capture_running:
        self._activity_condition.wait(timeout=1.0)
    if not self._capture_running:
        break
```

After storing a fresh capture and incrementing `_capture_seq`, notify waiters without holding `_capture_lock`:

```python
with self._activity_condition:
    self._activity_condition.notify_all()
```

Add the interface:

```python
def set_suspended(self, suspended):
    suspended = bool(suspended)
    with self._activity_condition:
        self._suspended = suspended
        self._activity_condition.notify_all()
    if suspended:
        with self._capture_lock:
            self._capture_buffer = None
            self._last_img = None
    else:
        self._last_frame_time = 0
    return self._capture_seq

def wait_for_fresh_capture(self, after_seq, timeout=0.5):
    deadline = time.monotonic() + max(0.0, float(timeout))
    with self._activity_condition:
        while self._capture_running and self._capture_seq <= after_seq:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            self._activity_condition.wait(timeout=remaining)
    return self._capture_seq > after_seq
```

In `shutdown()`, set `_capture_running=False` and call `notify_all()` before joining the thread.

- [ ] **Step 5: Run media profile and suspension tests**

Run: `python3 -m pytest python-host/test_media_suspension.py python-host/test_media_profile.py -q`

Expected: PASS; capture profile pacing tests remain unchanged.

- [ ] **Step 6: Commit the sender/capture seam**

```bash
git add python-host/aiortc_media_sender.py python-host/test_media_suspension.py python-host/host.py
git commit -m "feat(host): suspend media sender and capture"
```

### Task 6: Apply media activity generations in the Python Host

**Files:**
- Modify: `python-host/host.py`
- Modify: `python-host/test_media_suspension.py`
- Modify: `python-host/test_connection_diagnostics.py`

- [ ] **Step 1: Write failing Host ownership, generation, and ack tests**

```python
import pytest
from host import WebRemoteHost


class FakeSocket:
    def __init__(self):
        self.events = []

    async def emit(self, event, payload):
        self.events.append((event, payload))


class FakeTrack:
    def __init__(self):
        self.suspended = False
        self.waited_after = None

    def set_suspended(self, value):
        self.suspended = bool(value)
        return 10

    def wait_for_fresh_capture(self, after_seq, timeout=0.5):
        self.waited_after = after_seq
        return True


@pytest.mark.asyncio
async def test_host_applies_only_current_viewer_media_activity():
    host = object.__new__(WebRemoteHost)
    host.sio = FakeSocket()
    host.current_viewer_id = "viewer-1"
    host.current_connection_attempt_id = "attempt-1"
    host.media_activity_generation = -1
    host.media_activity_state = "active"
    host.video_sender = FakeSender()
    host.screen_track = FakeTrack()

    await host.on_media_activity_change({
        "viewerId": "viewer-2", "connectionAttemptId": "attempt-2",
        "state": "suspended", "generation": 1, "reasons": ["page-hidden"],
    })
    assert host.media_activity_state == "active"
    assert host.sio.events[-1][1]["applied"] is False

    await host.on_media_activity_change({
        "viewerId": "viewer-1", "connectionAttemptId": "attempt-1",
        "state": "suspended", "generation": 2, "reasons": ["page-hidden"],
    })
    assert host.media_activity_state == "suspended"
    assert host.video_sender.tracks[-1] is None
    assert host.screen_track.suspended is True
```

- [ ] **Step 2: Run Host suspension tests to verify failure**

Run: `python3 -m pytest python-host/test_media_suspension.py python-host/test_connection_diagnostics.py -q`

Expected: FAIL because Host state and handler do not exist.

- [ ] **Step 3: Add Host state, event registration, and reset rules**

Initialize in `WebRemoteHost.__init__()`:

```python
self.video_sender = None
self.media_activity_state = "active"
self.media_activity_reasons = []
self.media_activity_generation = -1
self.current_connection_attempt_id = None
```

Register the Socket.IO handler:

```python
sio.on('media-activity-change', self.on_media_activity_change)
```

In `on_offer()`, capture the connection attempt and sender:

```python
self.current_connection_attempt_id = data.get("connectionAttemptId")
self.media_activity_state = "active"
self.media_activity_reasons = []
self.media_activity_generation = -1
self.video_sender = self.pc.addTrack(self.screen_track)
```

In `_close_peer_connection()`, clear `video_sender`, media state, generation, and connection attempt after track shutdown.

- [ ] **Step 4: Implement the Host activity handler and ack**

```python
async def on_media_activity_change(self, data):
    viewer_id = data.get("viewerId")
    attempt_id = data.get("connectionAttemptId")
    generation = int(data.get("generation", -1))
    state = data.get("state")
    applied = (
        viewer_id == self.current_viewer_id
        and attempt_id == self.current_connection_attempt_id
        and generation > self.media_activity_generation
        and state in {"active", "suspended"}
        and self.video_sender is not None
        and self.screen_track is not None
    )
    keyframe_requested = False
    if applied:
        if state == "suspended":
            suspend_sender(self.video_sender)
            self.screen_track.set_suspended(True)
        else:
            baseline = self.screen_track.set_suspended(False)
            await asyncio.to_thread(
                self.screen_track.wait_for_fresh_capture,
                baseline,
                0.5,
            )
            keyframe_requested = resume_sender(self.video_sender, self.screen_track)
        self.media_activity_state = state
        self.media_activity_reasons = list(data.get("reasons") or [])
        self.media_activity_generation = generation

    await self.sio.emit("media-activity-ack", {
        "viewerId": viewer_id,
        "connectionAttemptId": attempt_id,
        "state": state,
        "generation": generation,
        "applied": applied,
        "keyframeRequested": keyframe_requested,
    })
```

Import `resume_sender` and `suspend_sender` from the new adapter. Log applied and ignored transitions with metadata only.

- [ ] **Step 5: Extend Host diagnostics**

Add to the event-loop summary returned by Host diagnostics:

```python
"mediaActivityState": str(getattr(self, "media_activity_state", "active")),
"mediaActivityGeneration": int(getattr(self, "media_activity_generation", -1)),
```

Update `test_connection_diagnostics.py` to assert these fields without changing existing timing semantics.

- [ ] **Step 6: Run Host tests**

Run: `python3 -m pytest python-host/test_media_suspension.py python-host/test_media_profile.py python-host/test_connection_diagnostics.py -q`

Expected: PASS.

- [ ] **Step 7: Commit the Host control path**

```bash
git add python-host/host.py python-host/test_media_suspension.py python-host/test_connection_diagnostics.py
git commit -m "feat(host): apply viewer media activity generations"
```

### Task 7: Suspend WebRTC media without triggering recovery

**Files:**
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`
- Modify: `web-client/js/link-quality-controller.js`

- [ ] **Step 1: Write failing Viewer WebRTC suspension tests**

```javascript
test('suspended WebRTC emits activity and suppresses quality recovery', () => {
  const emitted = [];
  let observed = 0;
  const { WebRTC, context } = loadWebRTC({ Input: { setActive() {} } });
  context.document.getElementById('remoteVideo').pause = () => {};
  WebRTC.networkMode = 'auto';
  WebRTC.mediaSessionStarted = true;
  WebRTC.currentConnectionAttemptId = 'attempt-1';
  WebRTC.socket = { connected: true, emit: (event, payload) => emitted.push({ event, payload }) };
  WebRTC.linkQualityController = { observe() { observed += 1; } };

  WebRTC.applyMediaActivity({ state: 'suspended', reasons: ['page-hidden'], generation: 2 });
  WebRTC.handleReceiverStats({ fps: 0, selectedCandidateType: 'srflx' });

  assert.equal(emitted.at(-1).event, 'media-activity-change');
  assert.equal(WebRTC.mediaState, 'suspended');
  assert.equal(observed, 0);
});

test('resume timeout refreshes at most once for one generation', () => {
  let refreshes = 0;
  const { WebRTC } = loadWebRTC();
  WebRTC.mediaActivitySnapshot = { state: 'active', reasons: [], generation: 4 };
  WebRTC.refresh = () => { refreshes += 1; };
  WebRTC.beginMediaResume({ generation: 4, keyframeRequested: false });
  WebRTC.handleMediaResumeTimeout(4);
  WebRTC.handleMediaResumeTimeout(4);
  clearTimeout(WebRTC.mediaResumeTimer);
  assert.equal(refreshes, 1);
});

test('view changes before start do not establish media', () => {
  let tunnelStarts = 0;
  const { WebRTC } = loadWebRTC();
  WebRTC.mediaSessionStarted = false;
  WebRTC.networkMode = 'tunnel';
  WebRTC.startTunnelRelay = () => { tunnelStarts += 1; };
  WebRTC.applyMediaActivity({ state: 'active', reasons: [], generation: 1 });
  assert.equal(tunnelStarts, 0);
  assert.equal(WebRTC.pc, null);
});

test('desktop input activates only after active media renders', () => {
  const states = [];
  const { WebRTC } = loadWebRTC({ Input: { setActive: (value) => states.push(value) } });
  WebRTC.mediaSessionStarted = true;
  WebRTC.mediaActivitySnapshot = { state: 'active', reasons: [], generation: 2 };
  WebRTC.mediaState = 'resuming';
  WebRTC.pc = { connectionState: 'connected' };
  WebRTC.syncDesktopInputActivity();
  WebRTC.completeMediaResume();
  assert.deepEqual(states, [false, true]);
});

test('link quality reset clears pre-suspension samples', () => {
  const { LinkQualityController } = loadLinkQualityController();
  const controller = LinkQualityController.create();
  controller.degradedCount = 2;
  controller.criticalCount = 1;
  controller.goodCount = 8;
  controller.lastPacketsLost = 20;
  controller.lastFramesDecoded = 40;
  controller.resetTransientSamples();
  assert.equal(controller.degradedCount, 0);
  assert.equal(controller.criticalCount, 0);
  assert.equal(controller.goodCount, 0);
  assert.equal(controller.lastPacketsLost, null);
  assert.equal(controller.lastFramesDecoded, null);
});
```

- [ ] **Step 2: Run focused Viewer tests to verify failure**

Run: `node --test web-client/js/webrtc.test.js`

Expected: FAIL because media state methods and guards do not exist.

- [ ] **Step 3: Implement WebRTC state transitions and wire ack**

Add fields:

```javascript
mediaState: 'active',
mediaActivitySnapshot: { state: 'active', reasons: [], generation: 0 },
mediaActivityAckGeneration: -1,
mediaResumeTimer: null,
mediaResumeRefreshGeneration: -1,
mediaResumeTimeoutCount: 0,
mediaSessionStarted: false,
```

Add the WebRTC adapter:

```javascript
applyMediaActivity(snapshot) {
  this.mediaActivitySnapshot = snapshot;
  const suspended = snapshot.state === 'suspended';
  this.mediaState = suspended ? 'suspended' : 'resuming';
  const video = document.getElementById('remoteVideo');
  if (suspended) {
    this.stopVideoFrameTracking();
    video?.pause();
    if (typeof Input !== 'undefined') Input.setActive(false);
  }
  if (!this.mediaSessionStarted) {
    this.updateMediaActivityUI();
    return;
  }
  if (this.networkMode === 'tunnel') {
    this.applyTunnelMediaActivity(snapshot);
    return;
  }
  if (this.socket?.connected) {
    this.socket.emit('media-activity-change', {
      schemaVersion: 1,
      ...snapshot,
      connectionAttemptId: this.currentConnectionAttemptId,
    });
  }
  if (!suspended && this.pc) this.beginMediaResume({ generation: snapshot.generation });
  this.updateMediaActivityUI();
  this.syncDesktopInputActivity();
},

handleMediaActivityAck(data = {}) {
  if (data.connectionAttemptId !== this.currentConnectionAttemptId) return;
  if (Number(data.generation) < this.mediaActivitySnapshot.generation) return;
  this.mediaActivityAckGeneration = Number(data.generation);
  if (data.state === 'active' && data.applied) {
    this.beginMediaResume(data);
  }
},
```

Register `media-activity-ack` on the main Viewer socket. After new offer/connection, call `applyMediaActivity(getMediaActivitySnapshot())` to synchronize current intent.

Set `mediaSessionStarted=true` at the beginning of `init()` after authentication succeeds, and reset it to false in explicit `disconnect()`. Terminal/page toggles before the user clicks “开始学习助手” must update reasons without establishing a media connection.

- [ ] **Step 4: Guard health logic and reset baselines on resume**

At the start of `handleReceiverStats()` and every 0 FPS/no-media recovery branch:

```javascript
if (this.mediaState === 'suspended' || this.mediaState === 'resuming') return;
```

Add a reset method to `LinkQualityController`:

```javascript
resetTransientSamples() {
  this.degradedCount = 0;
  this.criticalCount = 0;
  this.goodCount = 0;
  this.lastPacketsLost = null;
  this.lastFramesDecoded = null;
  this.startupGraceSamplesRemaining = 2;
},
```

Call it when resuming, set `noMediaTicks=0`, reset the WebRTC stats interval baseline, and restart `startVideoFrameTracking()`. On the first rendered frame, clear the resume timer and set `mediaState='active'`.

Replace unconditional `Input.setActive(true)` calls in WebRTC connected and tunnel-start handlers with one adapter:

```javascript
syncDesktopInputActivity() {
  if (typeof Input === 'undefined') return;
  const transportConnected = this.networkMode === 'tunnel'
    ? Boolean(this.tunnelRelayActive)
    : this.pc?.connectionState === 'connected';
  const shouldActivate = Boolean(
    this.mediaSessionStarted
    && transportConnected
    && this.mediaState === 'active'
    && this.mediaActivitySnapshot.state === 'active'
  );
  Input.setActive(shouldActivate);
},

completeMediaResume() {
  clearTimeout(this.mediaResumeTimer);
  this.mediaResumeTimer = null;
  this.mediaState = 'active';
  this.noMediaTicks = 0;
  this.linkQualityController?.resetTransientSamples?.();
  this.syncDesktopInputActivity();
  this.updateMediaActivityUI();
},
```

Call `completeMediaResume()` from the first accepted WebRTC video frame callback. Suspended and resuming states must keep input inactive.

- [ ] **Step 5: Implement one bounded resume fallback**

```javascript
beginMediaResume(data = {}) {
  const generation = Number(data.generation);
  clearTimeout(this.mediaResumeTimer);
  this.mediaState = 'resuming';
  this.noMediaTicks = 0;
  this.linkQualityController?.resetTransientSamples?.();
  const playResult = document.getElementById('remoteVideo')?.play?.();
  playResult?.catch?.(() => {});
  this.mediaResumeTimer = setTimeout(() => this.handleMediaResumeTimeout(generation), 1500);
},

handleMediaResumeTimeout(generation) {
  if (this.mediaState !== 'resuming') return;
  if (generation !== this.mediaActivitySnapshot.generation) return;
  if (this.mediaResumeRefreshGeneration === generation) return;
  this.mediaResumeRefreshGeneration = generation;
  this.mediaResumeTimeoutCount += 1;
  this.refresh();
},
```

Clear timers on refresh, disconnect, failed connection, and new rendered frame.

Also include the connection identity in every offer so Host ownership can match later media commands:

```javascript
this.socket.emit('offer', {
  offer: this.pc.localDescription,
  epoch,
  connectionAttemptId: this.currentConnectionAttemptId,
});
```

- [ ] **Step 6: Run Viewer recovery suites**

Run: `node --test web-client/js/media-activity-controller.test.js web-client/js/media-activity-lifecycle.test.js web-client/js/webrtc-stats.test.js web-client/js/webrtc.test.js`

Expected: PASS; suspended stats produce no degradation, ICE restart, or reconnect.

- [ ] **Step 7: Commit WebRTC suspension behavior**

```bash
git add web-client/js/webrtc.js web-client/js/webrtc.test.js web-client/js/link-quality-controller.js
git commit -m "feat(viewer): suspend WebRTC media safely"
```

### Task 8: Apply the same activity truth to tunnel relay

**Files:**
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`
- Modify: `python-host/test_tunnel_relay.py`
- Modify: `signal-server/websocket/signaling.test.js`

- [ ] **Step 1: Write failing tunnel suspension and resume tests**

```javascript
test('tunnel suspension stops relay without emitting WebRTC activity control', () => {
  const mainEvents = [];
  let stops = 0;
  const { WebRTC, context } = loadWebRTC({ Input: { setActive() {} } });
  context.document.getElementById('remoteVideo').pause = () => {};
  WebRTC.networkMode = 'tunnel';
  WebRTC.mediaSessionStarted = true;
  WebRTC.socket = { connected: true, emit: (event) => mainEvents.push(event) };
  WebRTC.stopTunnelRelay = () => { stops += 1; };
  WebRTC.applyMediaActivity({ state: 'suspended', reasons: ['terminal-active'], generation: 3 });
  assert.equal(stops, 1);
  assert.equal(mainEvents.includes('media-activity-change'), false);
});

test('active tunnel restarts relay and becomes active on first frame', () => {
  let starts = 0;
  const { WebRTC, context } = loadWebRTC({ Input: { setActive() {} } });
  const relayImage = context.document.getElementById('relayImage');
  WebRTC.networkMode = 'tunnel';
  WebRTC.mediaSessionStarted = true;
  WebRTC.startTunnelRelay = () => { starts += 1; WebRTC.tunnelRelayActive = true; };
  WebRTC.applyTunnelMediaActivity({ state: 'active', reasons: [], generation: 4 });
  assert.equal(starts, 1);
  assert.equal(WebRTC.mediaState, 'resuming');
  WebRTC.handleRelayFrame({ frameId: 1, data: 'AA==', mime: 'image/jpeg' });
  relayImage.onload();
  assert.equal(WebRTC.mediaState, 'active');
});
```

- [ ] **Step 2: Run tunnel tests to verify failure**

Run: `node --test web-client/js/webrtc.test.js && python3 -m pytest python-host/test_tunnel_relay.py -q`

Expected: FAIL because tunnel activity adapter does not exist.

- [ ] **Step 3: Implement tunnel activity adapter**

```javascript
applyTunnelMediaActivity(snapshot) {
  if (!this.mediaSessionStarted) return;
  if (snapshot.state === 'suspended') {
    this.stopTunnelRelay();
    this.mediaState = 'suspended';
    return;
  }
  this.mediaState = 'resuming';
  this.startTunnelRelay();
  clearTimeout(this.mediaResumeTimer);
  this.mediaResumeTimer = setTimeout(
    () => this.handleMediaResumeTimeout(snapshot.generation),
    2500,
  );
},
```

Call the Task 7 `completeMediaResume()` from `ackLoadedFrame()` after the first accepted relay image fires `onload`. The shared method is the only place that marks media active and re-enables desktop input.

- [ ] **Step 4: Preserve stale-viewer relay protections**

Extend Python and Signal tests to prove:

```python
assert relay.viewer_id == "viewer-current"
await host.on_relay_stream_control({"enabled": False, "viewerId": "viewer-stale"})
assert relay.enabled is True
```

Do not change the existing Host viewerId check or disconnect semantics.

- [ ] **Step 5: Run tunnel and Signal suites**

Run: `node --test web-client/js/webrtc.test.js signal-server/websocket/signaling.test.js && python3 -m pytest python-host/test_tunnel_relay.py -q`

Expected: PASS; tunnel suspension emits only relay control and current-viewer protection remains green.

- [ ] **Step 6: Commit tunnel integration**

```bash
git add web-client/js/webrtc.js web-client/js/webrtc.test.js python-host/test_tunnel_relay.py signal-server/websocket/signaling.test.js
git commit -m "feat(viewer): suspend tunnel media on inactive views"
```

### Task 9: Expose honest paused state and synchronize active documentation

**Files:**
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/diagnostic.test.js`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`
- Modify: `README.md`

- [ ] **Step 1: Write failing diagnostic snapshot and UI tests**

```javascript
test('network snapshot reports media activity without classifying pause as failure', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.mediaState = 'suspended';
  WebRTC.mediaActivitySnapshot = {
    state: 'suspended', reasons: ['page-hidden'], generation: 7,
  };
  WebRTC.mediaActivityAckGeneration = 7;
  WebRTC.mediaResumeTimeoutCount = 0;
  WebRTC.noMediaTicks = 0;
  const snapshot = WebRTC.collectNetworkSnapshot();
  assert.deepEqual(snapshot.mediaActivity, {
    state: 'suspended', reasons: ['page-hidden'], generation: 7,
    ackGeneration: 7, resumeTimeoutCount: 0,
  });
  assert.equal(snapshot.noMediaTicks, 0);
});

test('diagnostic network snapshot preserves media activity metadata', () => {
  const { context } = createDiagnosticContext();
  context.WebRTC.collectNetworkSnapshot = () => ({
    mediaActivity: {
      state: 'suspended', reasons: ['terminal-active'], generation: 3,
      ackGeneration: 3, resumeTimeoutCount: 0,
    },
  });
  context.WebRTC.classifyCandidateHealth = () => 'candidate-check-needed';
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  assert.equal(Diagnostic.getNetworkSnapshot().mediaActivity.state, 'suspended');
});
```

- [ ] **Step 2: Run diagnostic tests to verify failure**

Run: `node --test web-client/js/diagnostic.test.js web-client/js/webrtc.test.js`

Expected: FAIL because `mediaActivity` is absent.

- [ ] **Step 3: Add state to diagnostics and status UI**

Extend `collectNetworkSnapshot()`:

```javascript
mediaActivity: {
  state: this.mediaState,
  reasons: this.mediaActivitySnapshot.reasons.slice(),
  generation: this.mediaActivitySnapshot.generation,
  ackGeneration: this.mediaActivityAckGeneration,
  resumeTimeoutCount: this.mediaResumeTimeoutCount,
},
```

Update UI from one method:

```javascript
updateMediaActivityUI() {
  const pauseButton = document.getElementById('pauseBtn');
  const fps = document.getElementById('fpsDisplay');
  const manuallyPaused = this.mediaActivitySnapshot.reasons.includes('manual-pause');
  if (pauseButton) pauseButton.textContent = manuallyPaused ? '恢复' : '暂停';
  if (fps && this.mediaState === 'suspended') fps.textContent = '已暂停';
}
```

Keep `connectionStatus` connected during suspended/resuming states.

- [ ] **Step 4: Update active requirements and README**

Add to video/control requirements:

```markdown
- [x] **按需媒体暂停**：切换 Terminal、页面进入后台或手动暂停时，Host 停止屏幕采集、编码和视频 payload；保留信令、ICE、DataChannel 和 Terminal 会话。
- [x] **暂停期健康语义**：预期 0 FPS 不触发质量降档、ICE restart 或自动重连；恢复首帧超时只允许一次 refresh fallback。
```

Add to README Web Terminal/remote desktop behavior:

```markdown
- 切换到 Terminal 或浏览器页面进入后台会暂停远程桌面媒体，不会关闭 Terminal shared session。
- 返回桌面后自动恢复画面；用户手动暂停时保持暂停，直到手动恢复。
```

- [ ] **Step 5: Run diagnostic and UI suites**

Run: `node --test web-client/js/diagnostic.test.js web-client/js/webrtc.test.js web-client/js/terminal.test.js`

Expected: PASS.

- [ ] **Step 6: Commit diagnostics and docs**

```bash
git add web-client/js/webrtc.js web-client/js/diagnostic.test.js README.md docs/需求文档/WebRemoteDesktop-需求文档.md
git commit -m "feat(viewer): expose media suspension status"
```

### Task 10: Run closure checks and real-browser acceptance

**Files:**
- Verify only; no planned source file creation
- Runtime evidence: `back-debug.log`, browser WebRTC stats/diagnostics, Signal logs

- [ ] **Step 1: Run all targeted browser and Signal tests**

Run:

```bash
node --test \
  web-client/js/media-activity-controller.test.js \
  web-client/js/media-activity-lifecycle.test.js \
  web-client/js/webrtc-stats.test.js \
  web-client/js/webrtc.test.js \
  web-client/js/input.test.js \
  web-client/js/diagnostic.test.js \
  web-client/js/terminal.test.js \
  signal-server/websocket/signaling.test.js
```

Expected: PASS with zero failures.

- [ ] **Step 2: Run Python Host tests**

Run:

```bash
python3 -m pytest \
  python-host/test_media_suspension.py \
  python-host/test_media_profile.py \
  python-host/test_tunnel_relay.py \
  python-host/test_connection_diagnostics.py -q
```

Expected: PASS with zero failures.

- [ ] **Step 3: Run full repository test scopes and diff checks**

Run:

```bash
(cd signal-server && npm test)
python3 -m pytest python-host -q
git diff --check
```

Expected: all tests PASS and `git diff --check` produces no output.

- [ ] **Step 4: Ask the user to start local services for browser acceptance**

Per repository policy, do not start new frontend/backend services automatically. Ask the user to start the documented local Signal Server and Host in their own terminals. Do not stop, restart, rebuild, or rotate cloudflared/quick tunnel for this feature acceptance.

Expected: user confirms the current code is running locally; if a local restart is explicitly requested, follow `README.md`, `docs/runbook-safe-startup.md`, and the mandatory `webremote-service` skill while preserving the current tunnel.

- [ ] **Step 5: Verify WebRTC suspension in real Chrome**

Use the in-app browser skill against the user-started local Viewer:

1. Connect desktop in a WebRTC mode and record `captureSeq`, inbound video bytes, FPS, PC state, ICE state, and DataChannel state.
2. Switch to Terminal for 15 seconds and run a harmless command such as `printf 'media-suspend-ok\n'`.
3. Confirm Terminal output arrives, `captureSeq` changes by at most one, inbound RTP video payload bytes stay flat, and PC/DataChannel remain connected.
4. Return to desktop and measure first rendered frame; require at most 1500ms at P95 across five repetitions.
5. Repeat with browser visibility hidden for 15 seconds and with persistent manual pause.

Expected: no `media-stalled`, quality downgrade, ICE restart, or reconnect events during intentional suspension.

- [ ] **Step 6: Verify tunnel suspension in real Chrome**

Manually choose tunnel mode without touching the Cloudflare tunnel process. Switch to Terminal for 15 seconds, confirm relay frames and Host JPEG encoding stop, then return to desktop and require a fresh relay frame within 2500ms at P95 across five repetitions.

Expected: Terminal remains attached; only relay media pauses and resumes.

- [ ] **Step 7: Review the implementation against the approved spec**

Check every spec section against code/tests/runtime evidence. Specifically verify:

- one Viewer truth source;
- Host state scoped to current viewer/attempt/generation;
- no duplicate WebRTC and tunnel commands;
- no control lease or Terminal authorization semantic changes;
- no tunnel lifecycle changes;
- resume fallback limited to one refresh per generation.

Expected: no uncovered spec requirement and no unrelated files staged.

- [ ] **Step 8: Close any evidence-driven defect through its owning task**

If browser acceptance exposes a defect, return to the owning task above, add the smallest failing regression test in that task's named test file, make the narrow fix in that task's named implementation file, rerun Steps 1-7, and use that task's exact `git add` boundary. If no defect is found, do not create an empty final commit.
