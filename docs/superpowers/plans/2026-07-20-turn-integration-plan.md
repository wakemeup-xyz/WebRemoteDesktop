# TURN Full-Path Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load TURN from `~/.StockHub/turn.json` (or env), inject the same config into signal-server and python-host, make desktop `relay` truly work with session-scoped Host ICE, add select+self-test UX, and optionally add Terminal `webrtc-turn` DataChannel transport.

**Architecture:** One shared TURN loader produces `urls/username/credential/source/fingerprint`. signal-server exposes it via `/api/webrtc-config` and optional self-test; Host LaunchAgent exports the same env and builds ICE per session mode; Viewer keeps manual modes and adds a pure `TurnSelfTest` module; Terminal keeps Socket.IO default and gains an optional gateway-backed DataChannel path in Phase 2.

**Tech Stack:** Node.js, Express, Socket.IO, vanilla browser JavaScript, Python aiortc, shell LaunchAgent scripts, Node test runner, optional Node WebRTC (`wrtc`) for TerminalGateway.

**Spec Coverage:** Full coverage of `docs/superpowers/specs/2026-07-20-turn-integration-design.md`.

**Truth Source:**
- Secret config: `WRD_TURN_JSON` / `~/.StockHub/turn.json` or env `TURN_*` (env wins)
- Capability contract: `/api/webrtc-config` (+ Host signaling capability)
- Desktop mode truth: Viewer `wrdNetworkMode` (manual)
- Terminal transport truth: Viewer terminal transport preference (default `socketio`)

**Compatibility Notes:**
- Strict STUN still does not auto-switch to TURN/tunnel
- Manual STUN port search remains auto/stun-only and never auto-TURN
- Terminal default Socket.IO path must not regress
- Credentials never committed or logged

**Impact Map:**
- **Truth Source:** New `turn-config` loader; Host env injection; session ICE policy
- **Backend:** `signal-server/lib/turn-config.js`, `lib/config.js`, `server.js`, signaling capability, optional TerminalGateway
- **Host:** `python-host/host.py` session ICE; `scripts/run-host-launchctl.sh` env load
- **Frontend:** `turn-selftest.js`, `webrtc.js`, `viewer.html`, terminal transport UI
- **Runtime Proof:** `/api/webrtc-config`, browser Allocate, relay desktop frame, optional Terminal DC
- **Docs:** README, runbook, requirements, `.env.example`
- **Commit Boundary:** Phase 0 config path → Phase 1 self-test UI → Phase 2 terminal → Phase 3 docs (docs may land with this plan)

**Definition of Done:**
- Desktop: `relay` yields `selectedCandidateType=relay`, FPS>0, matched fingerprints
- Self-test: one-click reports config / allocate / host match with clear FAIL codes
- Terminal: default socketio unchanged; `webrtc-turn` optional and explicit on failure
- Secrets: no password in git, logs, or diagnostic JSON

---

## File Structure

### Canonical truth and responsibility map

- `signal-server/lib/turn-config.js` — parse/merge/fingerprint TURN (new)
- `signal-server/lib/config.js` — integrate turn loader into `loadConfig` / status
- `signal-server/server.js` — webrtc-config fields, optional turn-status/selftest routes
- `signal-server/websocket/signaling.js` — host capability fan-out if needed
- `scripts/lib-turn-env.sh` or inline in `run-host-launchctl.sh` — Host env inject
- `python-host/host.py` — session-scoped `build_ice_servers(mode)`, capability report
- `web-client/js/turn-selftest.js` — browser Allocate + result shaping (new)
- `web-client/js/webrtc.js` — panel status, test buttons, mode copy alignment
- `web-client/js/terminal.js` — optional transport selection (Phase 2)
- `web-client/viewer.html` — UI hooks
- `signal-server/.env.example` — document `WRD_TURN_JSON` + TURN_*
- `docs/*` — operator truth

### Compatibility boundary

- Empty TURN config ⇒ existing behavior
- `wrdNetworkMode` key unchanged
- No auto mode rewrite

---

### Task 1: Shared TURN config loader (signal-server)

**Files:**
- Create: `signal-server/lib/turn-config.js`
- Create: `signal-server/test/turn-config.test.js`
- Modify: `signal-server/lib/config.js`
- Modify: `signal-server/test/config.test.js`

- [x] **Step 1: Write failing tests**

Cover at least:

```js
test('loads turn.json shape into urls/username/credential', () => {
  // write temp json with host/port/username/password/transport=udp
  // loadTurnFromJsonFile(path) => urls includes turn:host:port?transport=udp
});

test('env overrides json', () => {
  // TURN_URLS in env wins over json urls
});

test('fingerprint ignores password and is stable', () => {
  // same urls+username => same fingerprint; password change does not change it
});

test('partial credentials => misconfigured not configured', () => {
  // urls without username/credential
});
```

- [x] **Step 2: Run tests — expect FAIL (module missing)**

```bash
cd signal-server && node --test test/turn-config.test.js
```

- [x] **Step 3: Implement `turn-config.js` + wire `loadConfig()`**

1. Parse json `turnServer` fields
2. Merge priority: env > dotenv already loaded > json path (`WRD_TURN_JSON` or default home path only if file exists)
3. Export helpers used by `getTurnStatus` extensions: `turnSource`, `turnFingerprint`
4. Never log credential

- [x] **Step 4: Run tests — expect PASS**

```bash
cd signal-server && node --test test/turn-config.test.js test/config.test.js
```

- [x] **Step 5: Commit**

```bash
git add signal-server/lib/turn-config.js signal-server/lib/config.js \
  signal-server/test/turn-config.test.js signal-server/test/config.test.js
git commit -m "feat(signal): load TURN from turn.json with env override"
```

---

### Task 2: Expose extended capability on `/api/webrtc-config`

**Files:**
- Modify: `signal-server/server.js`
- Modify: `signal-server/test/config.test.js` or HTTP-level test if present
- Modify: `signal-server/.env.example`

- [x] **Step 1: Extend response contract**

Add fields (backward compatible):

```json
{
  "turnConfigured": true,
  "turnMisconfigured": false,
  "turnStatus": "configured",
  "turnSource": "json|env|none",
  "turnFingerprint": "…",
  "hostTurnReady": false,
  "hostTurnFingerprint": null,
  "turnUrls": ["turn:…"],
  "iceServers": [/* stun + turn when configured */]
}
```

`hostTurn*` may start as unknown until Host reports capability (Task 4).

- [x] **Step 2: Document `WRD_TURN_JSON` in `.env.example`**

- [x] **Step 3: Unit/integration assert fields present and secrets not duplicated beyond iceServers credential for authorized clients**

- [x] **Step 4: Commit**

```bash
git commit -m "feat(signal): expose turn source and fingerprint in webrtc-config"
```

---

### Task 3: Inject TURN into Host LaunchAgent path

**Files:**
- Modify: `scripts/run-host-launchctl.sh`
- Optional Create: `scripts/lib-turn-env.sh`
- Test: shell test or document manual verify; add `scripts/*test*` only if repo already patterns allow

- [x] **Step 1: Add loader that exports TURN_*/STUN_* for Host process**

Priority must match signal-server (env already set > parse `signal-server/.env` > `WRD_TURN_JSON` / `~/.StockHub/turn.json`).

- [x] **Step 2: Log non-secret summary to host launch log**

```text
TURN env: configured=1 source=json fingerprint=…
```

- [x] **Step 3: Manual verify after restart**

```bash
./scripts/restart-host.sh
# back-debug.log or /tmp/wrd-host-launch.log shows TURN relay configured
```

- [x] **Step 4: Commit**

```bash
git commit -m "fix(host): inject TURN env for LaunchAgent path"
```

---

### Task 4: Session-scoped Host ICE (do not ignore TURN on relay)

**Files:**
- Modify: `python-host/host.py`
- Create/Modify: host unit tests if present for ice builders

- [x] **Step 1: Change `build_ice_servers` to accept mode/policy**

```python
def build_ice_servers(mode="auto"):
    # include TURN when mode in {"relay"} or allow_turn flag
    # strict-stun only strips TURN for stun/auto strict attempts, not for relay
```

- [x] **Step 2: On offer, pass Viewer networkMode / iceMode into PC rebuild**

If signaling does not yet forward mode, add a minimal field on offer payload or companion event; prefer existing metadata if any.

- [x] **Step 3: Host reports capability on connect**

```json
{ "turnReady": true, "turnFingerprint": "…", "supportsSessionTurn": true }
```

Signal-server caches last host capability for `/api/webrtc-config`.

- [x] **Step 4: Tests for “relay includes TURN even if default media policy is strict-stun”**

- [x] **Step 5: Commit**

```bash
git commit -m "fix(host): enable session-scoped TURN for relay mode"
```

---

### Task 5: Browser TURN self-test module

**Files:**
- Create: `web-client/js/turn-selftest.js`
- Create: `web-client/js/turn-selftest.test.js`

- [x] **Step 1: Failing tests for pure logic**

```js
test('classify: no turn servers => turn-config-missing', () => {});
test('classify: zero relay candidates after gather => turn-allocate-failed', () => {});
test('classify: fingerprint mismatch => turn-fingerprint-mismatch', () => {});
test('summarize includes step statuses without secrets', () => {});
```

- [x] **Step 2: Implement `TurnSelfTest.run({ iceServers, hostFingerprint, timeoutMs })`**

Uses injectable `RTCPeerConnection` factory in tests; real browser in acceptance.

Steps A/B/D at minimum (config, allocate, fingerprint).

- [x] **Step 3: `node --test web-client/js/turn-selftest.test.js` PASS

- [x] **Step 4: Commit**

```bash
git commit -m "feat(viewer): add TURN self-test helper"
```

---

### Task 6: Wire self-test + status into network panel

**Files:**
- Modify: `web-client/viewer.html`
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/css/viewer.css` (minimal)
- Modify: `web-client/js/webrtc.test.js`

- [x] **Step 1: UI**

- Show `turnSource`, short fingerprint, Host ready
- Button `测试 TURN`
- Result list bound to `TurnSelfTest` summary
- Fix mode copy: auto does **not** auto-fallback to TURN

- [x] **Step 2: On test click**

1. Refresh `/api/webrtc-config`
2. Run browser self-test
3. Update `networkTurnStatus` + recommendation codes if FAIL
4. Attach summary into diagnostic snapshot field `turnSelfTest`

- [x] **Step 3: Focused webrtc tests for status string builders / no auto mode rewrite

- [x] **Step 4: Commit**

```bash
git commit -m "feat(viewer): TURN status panel and one-click self-test"
```

---

### Task 7: Optional server-side `POST /api/turn-selftest`

**Files:**
- Modify: `signal-server/server.js`
- Create: probe helper if a lightweight approach exists without heavy deps; otherwise mark optional and skip if dependency cost is high

- [x] **Step 1: Auth + rate limit + no credential echo**

- [x] **Step 2: Return `{ ok, rttMs?, error?, urlsTried[] }`**

- [x] **Step 3: Wire as step C in UI when available**

- [x] **Step 4: Commit or document skip with reason**

---

### Task 8: Phase 0 runtime proof (desktop relay)

**Manual / scripted acceptance (operator):**

- [x] Ensure `~/.StockHub/turn.json` present and readable
- [x] Restart signal-server and `./scripts/restart-host.sh`
- [x] Login viewer; `GET /api/webrtc-config` → `turnConfigured: true`
- [x] Host log contains TURN configured / turnReady
- [x] Select **外网中继** → stats show TURN/relay → FPS > 0
- [x] Click **测试 TURN** → Allocate PASS + fingerprint match
- [x] Negative: stop TURN service or wrong password → FAIL with coded reason

Record results in session notes; do not commit secrets.

---

### Task 9: Terminal `webrtc-turn` transport (Phase 2)

**Files:**
- Create: `signal-server/lib/terminal/webrtc-gateway.js` (name flexible)
- Modify: `signal-server/websocket/terminal.js` or routes
- Modify: `web-client/js/terminal.js`, `viewer.html`
- Tests: gateway unit + terminal UI transport state

- [x] **Step 1: Spike `wrtc` (or chosen stack) on this macOS host; if blocked, document sidecar alternative and stop Phase 2 implementation pending decision**

- [x] **Step 2: Session API `POST /api/terminal/webrtc-session`**

Returns iceServers (same loader) + signaling handles for offer/answer/candidates.

- [x] **Step 3: Bridge DC frames to SessionManager I/O**

- [x] **Step 4: Frontend transport radio + test button (step F)**

- [x] **Step 5: Failure must set explicit status; no silent socketio fallback**

- [x] **Step 6: Commit**

```bash
git commit -m "feat(terminal): optional WebRTC DataChannel over TURN"
```

---

### Task 10: Docs and requirements sync (Phase 3 / can land early)

**Files:**
- Modify: `README.md` (TURN section: turn.json, dual inject, self-test, session policy)
- Modify: `docs/runbook-safe-startup.md` (media fail path: test TURN then relay)
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md` (capabilities + changelog)
- Modify: `docs/project-memory.md` (TURN secret path + Host inject rule)
- Modify: `signal-server/.env.example`

- [x] **Step 1: Align all docs with “env overrides json”, “relay needs bilateral TURN”, “Terminal optional webrtc-turn”**

- [x] **Step 2: Explicitly correct any “auto falls back to TURN” wording**

- [x] **Step 3: Commit**

```bash
git commit -m "docs: TURN integration design, plan, and operator truth"
```

---

## Execution Order (recommended)

1. Task 1–2 (server config contract)
2. Task 3–4 (Host inject + session ICE) → **first time desktop relay can work**
3. Task 5–6 (self-test UX)
4. Task 8 (runtime proof)
5. Task 7 if cheap
6. Task 9 only after desktop green
7. Task 10 continuous / final pass

## Risk Checklist

| Risk | Mitigation |
|---|---|
| Host still strict-strips TURN | Session mode gate + tests |
| Only Viewer has TURN | Host inject + fingerprint |
| UDP 3478 blocked | Document TCP URL option; self-test shows allocate fail |
| Terminal WebRTC native dep | Spike first; keep socketio default |
| Secret leakage | Redaction tests; never log password |

## Out of Scope for Implementers

- Rotating production TURN passwords without user request
- Rebuilding Cloudflare tunnels
- Auto-switching network modes
- Moving PTY into python-host
