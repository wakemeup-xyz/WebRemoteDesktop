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

## Runtime acceptance (Task 9) — pending

The following rows remain **runtime pending** until dual Viewer / ordinary Chrome / public tunnel evidence is collected on live services:

- Dual Viewer ownership / takeover / reset-blocked UI
- Ordinary-browser keyboard K-01–K-13
- Physical keyboard / OS-reserved shortcuts
- WebRTC first-frame / suspend 15s / resume P95 ≤1500ms
- Tunnel public URL first-frame / suspend / resume P95 ≤2500ms
- Mouse double-click/drag, Terminal coexistence with pause

Labels to use when filled:

- `browser-protocol`
- `physical-keyboard`
- `os-reserved`
- `PASS` / `FAIL` / `BLOCKED` / `NOT RUN`

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
