# Remote Desktop Reliability Closure Evidence

Date: 2026-07-20  
Branch: `feat/remote-desktop-reliability-closure`  
Final automated commit (pre-runtime): `659e10d82ccd71f68d46d35df68b602c6fcbf476`  
UTC timestamp: 2026-07-19T19:53:12Z

Spec: `docs/superpowers/specs/2026-07-20-remote-desktop-reliability-closure-design.md`  
Plan: `docs/superpowers/plans/2026-07-20-remote-desktop-reliability-closure-plan.md`

## Implementation commits

1. `7d080d9` fix(control): keep failed resets behind barrier  
2. `f234652` feat(control): recover reset barriers safely  
3. `f71af41` fix(viewer): require control lease for port search  
4. `5cbc371` feat(media): authorize activity by control lease  
5. `3a3b07b` feat(host): suspend media capture and sender  
6. `8e12334` feat(viewer): apply media suspension lifecycle  
7. `659e10d` feat(tunnel): suspend relay and stabilize viewport  

## Automated gates (Task 8)

### Node targeted matrix

Command:

```bash
node --test \
  signal-server/lib/desktop-control-lease.test.js \
  signal-server/lib/control-transition-retry.test.js \
  signal-server/lib/media-activity-contract.test.js \
  signal-server/lib/remote-input-contract.test.js \
  signal-server/websocket/signaling.test.js \
  web-client/js/stun-port-search-controller.test.js \
  web-client/js/media-activity-controller.test.js \
  web-client/js/media-activity-lifecycle.test.js \
  web-client/js/media-activity-runtime.test.js \
  web-client/js/remote-keyboard-controller.test.js \
  web-client/js/keyboard-transport.test.js \
  web-client/js/input.test.js \
  web-client/js/latency-monitor.test.js \
  web-client/js/webrtc-stats.test.js \
  web-client/js/webrtc.test.js
```

Result: **227 pass / 0 fail**

### Python targeted matrix

Command:

```bash
python3 -m pytest -q \
  python-host/test_remote_keyboard_state.py \
  python-host/test_input_handler.py \
  python-host/test_offer_epoch.py \
  python-host/test_aiortc_media_sender.py \
  python-host/test_media_suspension.py \
  python-host/test_media_profile.py \
  python-host/test_tunnel_relay.py \
  python-host/test_connection_diagnostics.py
```

Result: **82 pass / 0 fail**

## Automated closure status

| Item | Status | Notes |
|------|--------|-------|
| Reset barrier fail-closed | automated-closed | `failTransition` keeps REVOKING; only applied reset-only enters FREE |
| Bounded reset retry 1s/2s/4s | automated-closed | same-epoch, single timer, `reset-blocked` after 3 |
| Port search ACTIVE lease gate | automated-closed | read-only is strict no-op; control-lost cancels search |
| Media-activity lease contract | automated-closed | Signal validates + authorizes; Host rejects stale/unauthorized |
| Host capture/sender suspend | automated-closed | MSS gated; aiortc replaceTrack(None)/resume+keyframe |
| Viewer applied phase | automated-closed | suspending/suspended/resuming/active; input gated |
| Tunnel production suspend | automated-closed | no capture/JPEG/relay while suspended |
| Tunnel viewport stability | automated-closed | CSS contain box; geometry test with 960/640/480 |

## Runtime acceptance (Task 9)

### Live truth (after loading this branch into local services)

- formal public entry: `https://link.stockhub.wiki` (`/health` ok)
- local health: ok; `hostOnline: true`
- safe signal-server: **running** from worktree
  `.../.worktrees/reliability-closure/signal-server` (pid recorded in `/tmp/wrd-safe-signal.pid`)
- Host: `hostOnline:true` against the same local signal; Host LaunchAgent plist was temporarily pointed at the worktree for acceptance, then restored to the main checkout path for future restarts
- safe URL file: `https://memo-patterns-curve-contacted.trycloudflare.com` (**unchanged** across local restarts)
- safe URL reachability: **http-invalid** → public tunnel media remains BLOCKED by policy (no rebuild)
- security warning: cloudflared token found in process arguments (pre-existing; not mutated)
- served `viewer.html` includes `media-activity-runtime.js` (branch assets confirmed)

Artifacts (local only, not committed):

- report: `/tmp/wrd-acceptance/task9-local-report.json`
- screenshots: `/tmp/wrd-acceptance/A-*.png`, `/tmp/wrd-acceptance/B-*.png`
- harness: `scripts/runtime_reliability_acceptance.py` (two independent Chromium contexts)

### Runtime rows

Primary local dual-viewer harness: `/tmp/wrd-acceptance/task9-local-report.json`  
Extended timing/input/formal harness: `/tmp/wrd-acceptance/task9-extended-report.json`  
Scripts: `scripts/runtime_reliability_acceptance.py`, `scripts/runtime_reliability_acceptance_ext.py`

| Gate | Status | Evidence / reason |
|------|--------|-------------------|
| 9A Dual Viewer single writer | **PASS** (`browser-protocol`) | A ACTIVE controller + lease; B read-only on same Host |
| 9A read-only port search no-op | **PASS** | B `startPortSearch()=false`, no `control-acquire`, no timers/search |
| 9A read-only port-search button disabled | **PASS** | B button disabled |
| 9A controller canStartPortSearch | **PASS** | A predicate true while ACTIVE controller |
| 9A takeover stops old search | **PASS** | A started search; B takeover; A loses controller and search stops |
| 9A reset-blocked fault injection | **NOT RUN** | no safe runtime fault hook; automated unit/integration only |
| 9B WebRTC connected | **PASS** (`browser-protocol`) | Chromium PeerConnection path runs after Start |
| 9B media suspend applied phase | **PASS** | controller enters `suspending`/`suspended`, health suppressed, input/search gated |
| 9B media resume applied phase | **PASS** | returns to `resuming`/`active` after clear + rendered-frame note |
| 9B WebRTC suspend 15s payload stop | **PASS** (`browser-protocol`) | after applied `suspended` + drain, 15s hold: phase stays suspended, health suppressed, input gated, RTP `bytesReceived` growth ≤32KiB (payload stopped). `framesDecoded` may still lag on buffered frames |
| 9B resume latency (single sample) | **PASS** | request→active ≈220–320ms local; formal ≈550–650ms. **Not** full 20-run P95 |
| 9B resume P95 over 20 runs | **NOT RUN** | only single-sample latency collected |
| 9B mouse double-click / drag | **PASS** (`browser-protocol`) | synthetic mouse down/up/move path observed (18 events); Host open/select visual assertion not claimed |
| 9C keyboard controller ready | **PASS** (`browser-protocol`) | Input module + active lease present |
| 9C keyboard browser-protocol subset | **PASS** | left/right modifiers + common keys dispatched; full K-01–K-13 ordinary-Chrome matrix still open |
| 9C keyboard K-01–K-13 ordinary Chrome full matrix | **NOT RUN** | full matrix not completed as product sign-off |
| 9C physical-keyboard | **NOT RUN** | requires user physical presses |
| 9C os-reserved | **NOT RUN** | OS/browser may intercept before page |
| 9C Terminal UI + pause coexistence | **PASS** | Terminal UI present; `terminal-active` suspend keeps socket connected |
| 9D trycloudflare safe URL media | **BLOCKED** | `/tmp/wrd-safe-current-url.txt` health `http-invalid`/404; tunnel not rebuilt by policy |
| 9D formal fixed-domain media smoke | **PASS** | `https://link.stockhub.wiki` deliverable; control + suspend/resume smoke OK |
| 9D formal entry health | **PASS** | `https://link.stockhub.wiki/health` ok |

Honest labels kept: open rows remain **NOT RUN** / **BLOCKED**, not rewritten as full product acceptance.

### Host media-stop hardening during acceptance

While closing 15s payload evidence, Host suspend path was hardened on this branch:

- `ScreenCaptureTrack.recv()` blocks while suspended (no blank encoded frames)
- `AiortcMediaSender` also sets transceiver direction `inactive`/`sendonly` when PC is bound
- all current PC video senders are suspended on media-activity suspend

These changes are part of the reliability-closure branch commits after initial Task 5.

## Constraints preserved

- No TURN/VPS/native Viewer client/fixed UDP port introduced by this closure
- Cloudflare tunnel not rebuilt/restarted by implementation work
- Lease tokens, passwords, key values, SDP, candidate addresses, and image payloads are not logged by the new events

## Log safety check

Structured events introduced/used:

- `control_transition_failed_closed`
- `control_reset_retry`
- `control_reset_blocked`
- `media_activity_requested`
- `host_media_suspended`
- `host_media_resumed`

Bounded fields only: epoch, generation, attemptId, reason enums, captureSeq, sender flags. No lease token / input text / SDP / candidate IP / JPEG body.
