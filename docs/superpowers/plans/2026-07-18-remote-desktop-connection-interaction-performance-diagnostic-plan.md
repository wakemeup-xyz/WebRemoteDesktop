# Remote Desktop Connection and Interaction Performance Diagnostic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this diagnostic plan task-by-task. Do not delegate because this repository session does not authorize subagents.

**Goal:** Produce a current, evidence-backed diagnosis of remote desktop connectivity, interaction quality, performance, and latency without changing service or tunnel state.

**Architecture:** Treat desktop media, desktop input, signaling/control, tunnel fallback, and Web Terminal as separate paths, then correlate their measurements at explicit component boundaries. Distinguish current runtime evidence from current code facts and historical samples throughout the report.

**Tech Stack:** Node.js, Express, Socket.IO, browser WebRTC APIs, Python, aiortc, MSS, VideoToolbox, Quartz, Cloudflare Tunnel, shell/HTTP probes, repository test suites.

**Spec Coverage:** This plan covers the full diagnostic design in `docs/superpowers/specs/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic-design.md`.

**Truth Source:** Current worktree code for behavior, live process/HTTP/browser evidence for runtime state, and `/tmp/wrd-safe-current-url.txt` for the current safe quick-tunnel URL.

**Compatibility Notes:** Existing fixed-domain and safe quick-tunnel paths are observed only. No compatibility behavior is changed.

**Impact Map:**
- **Truth Source:** Current code, runtime status, live metrics, and timestamped report evidence.
- **Backend:** Read-only inspection of Signal Server, Python Host, Socket.IO, node-pty, logs, and runtime endpoints.
- **Frontend:** Read-only inspection of Viewer WebRTC/input/diagnostic/Terminal code plus non-destructive browser verification.
- **Runtime Proof:** Process status, health/status responses, entrypoint timing, Socket.IO probes, browser connection/statistics, logs, and focused tests.
- **Docs/Skills:** Create the diagnostic design, this plan, and the final report; preserve service/tunnel runbook constraints.
- **Commit Boundary:** The three diagnostic Markdown artifacts only. Do not commit unless the user separately requests it.

**Definition of Done:**
- The final report distinguishes current measurements, current code facts, historical evidence, and unverified items.
- Local, fixed-domain, and current safe quick-tunnel entrypoints have reachability and latency evidence.
- Desktop media, desktop input, recovery, and Terminal paths each have an end-to-end diagnosis and measurable recommendations.
- Relevant focused tests are run and exact failures are reported without modifying implementation code.
- No service, Host, or Cloudflare tunnel process is restarted or reconfigured.

---

### Task 1: Capture Repository and Runtime Baseline

**Files:**
- Read: `README.md`
- Read: `docs/runbook-safe-startup.md`
- Read: `.agents/skills/webremote-service/references/service-rules.md`
- Read: `docs/需求文档/WebRemoteDesktop-需求文档.md`
- Modify: `docs/superpowers/reports/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic.md`

- [x] **Step 1: Record repository state and recent changes**

Run: `git status --short && git log -8 --oneline`

Expected: A dirty-worktree inventory and recent commit list that identify implementation drift affecting the audit.

- [x] **Step 2: Capture service state through the repository-safe status helper**

Run: `python skills/webremote-service/scripts/wrd_service.py status`

Expected: Signal Server, Host, local health, Host online, and safe tunnel status without any restart.

- [x] **Step 3: Capture process, port, and URL-file evidence**

Run: `lsof -nP -iTCP:8080 -sTCP:LISTEN; pgrep -fal 'host.py|cloudflared|run-safe-quicktunnel'; test -f /tmp/wrd-safe-current-url.txt && sed -n '1p' /tmp/wrd-safe-current-url.txt`

Expected: The active owners of port 8080, Host/tunnel process identities, and the URL fact source.

### Task 2: Measure Entrypoints and Runtime APIs

**Files:**
- Read: `signal-server/server.js`
- Read: `signal-server/routes/auth.js`
- Read: `signal-server/lib/config.js`
- Modify: `docs/superpowers/reports/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic.md`

- [x] **Step 1: Probe local health and Host status repeatedly**

Run: `curl -fsS http://127.0.0.1:8080/health; curl -fsS http://127.0.0.1:8080/api/status`

Expected: HTTP success and a structured Host-online response, or exact current failure evidence.

- [x] **Step 2: Measure HTTP timing for all current entrypoints**

Run: `curl -o /dev/null -sS -L -w '%{http_code} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' <url>` for the local, fixed-domain, and URL-file targets.

Expected: Multiple timing samples per entrypoint with status code, connect, TLS, TTFB, and total time.

- [x] **Step 3: Inspect Cloudflare metrics without changing tunnel state**

Run: Discover existing local cloudflared metrics listeners with `lsof`, then read their `/metrics` endpoints.

Expected: Current edge location, tunnel connection RTT, reconnect counters, and transport protocol where exposed.

### Task 3: Audit Desktop Connection and Media Pipeline

**Files:**
- Read: `web-client/js/webrtc.js`
- Read: `web-client/js/diagnostic.js`
- Read: `web-client/js/ui.js`
- Read: `python-host/host.py`
- Read: `python-host/h264_videotoolbox_encoder.py`
- Read: `signal-server/websocket/signaling.js`
- Modify: `docs/superpowers/reports/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic.md`

- [x] **Step 1: Trace offer/answer, ICE, recovery, and mode transitions**

Run: `rg -n 'createOffer|setLocalDescription|setRemoteDescription|icecandidate|connectionstatechange|restartIce|refresh|networkMode|tunnel' web-client/js/webrtc.js python-host/host.py signal-server/websocket/signaling.js`

Expected: A complete connection state-machine map with fallback boundaries and attempt limits.

- [x] **Step 2: Trace capture, encode, packet, decode, and paint timing**

Run: `rg -n 'CAPTURE_STATS|VideoToolbox|getStats|jitterBuffer|framesPerSecond|packetsLost|roundTripTime|requestVideoFrameCallback|captureStart|packetSend' web-client/js python-host`

Expected: A metric-coverage map identifying which latency segments are measured and which remain blind.

- [x] **Step 3: Inspect live Host and Signal Server logs**

Run: Read bounded tails from `back-debug.log`, `/tmp/signal-server.log`, and configured structured logs after redacting secrets.

Expected: Current connection attempts, candidate health, capture FPS, encode/capture timing, errors, reconnects, and diagnostic summaries.

### Task 4: Audit Desktop Input and Interaction

**Files:**
- Read: `web-client/js/input.js`
- Read: `web-client/js/webrtc.js`
- Read: `python-host/input_handler.py`
- Read: `python-host/host.py`
- Read: `signal-server/websocket/input.js`
- Modify: `docs/superpowers/reports/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic.md`

- [x] **Step 1: Trace mouse and keyboard event flow**

Run: `rg -n 'mousemove|mousedown|mouseup|wheel|keydown|keyup|sendInput|input-move|createDataChannel|handle_input|20' web-client/js python-host signal-server/websocket`

Expected: Transport selection, reliability, buffering, serialization, coordinate mapping, and fallback behavior.

- [x] **Step 2: Validate automated interaction coverage**

Run: `node --test web-client/js/input.test.js web-client/js/webrtc.test.js` and `python -m pytest python-host/test_input_handler.py python-host/test_latency_timing.py -q`

Expected: Exact pass/fail counts and any behavior not protected by tests.

- [x] **Step 3: Perform browser interaction verification within the approved boundary**

Run: Open the live Viewer, inspect connection/mode/statistics UI, exercise non-destructive controls, and send real Host input only if the user explicitly authorizes it.

Observed: The original 2026-07-18 diagnostic run had no browser instance. The 2026-07-19 follow-up used ordinary headless Chromium through Python Playwright after explicit user authorization and completed the media, 50-refresh, input, Terminal and recovery matrix recorded in report section 13.6.

### Task 5: Diagnose Web Terminal Separately

**Files:**
- Read: `web-client/js/terminal.js`
- Read: `signal-server/websocket/terminal.js`
- Read: `signal-server/lib/terminal/session-manager.js`
- Read: `docs/superpowers/reports/2026-07-11-terminal-performance-analysis.md`
- Modify: `docs/superpowers/reports/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic.md`

- [x] **Step 1: Re-check latency metric semantics in current code**

Run: `rg -n 'terminal:ping|terminal:pong|input_ack|performance.now|Date.now|serverReceivedAt|clientSentAt|optimistic|alternate' web-client/js/terminal.js signal-server/websocket/terminal.js`

Expected: A clock-domain and local-echo correctness assessment against current dirty-tree code.

- [x] **Step 2: Run focused Terminal tests**

Run: `node --test web-client/js/terminal.test.js signal-server/websocket/terminal.test.js signal-server/test/terminal-session-manager.test.js signal-server/test/terminal-auth.test.js`

Expected: Exact pass/fail counts and regressions affecting shared sessions, latency or auth.

- [x] **Step 3: Compare current entrypoint timing with historical Terminal samples**

Run: Correlate current HTTP/Cloudflare metrics and any permitted Socket.IO samples with the 2026-07-11 report.

Expected: A clearly labeled current-vs-historical conclusion without reusing old values as current measurements.

### Task 6: Run Focused Regression Suite and Produce Report

**Files:**
- Read: `signal-server/package.json`
- Read: `python-host/requirements.txt`
- Create: `docs/superpowers/reports/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic.md`
- Modify: `docs/superpowers/specs/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic-design.md` only if an actual scope contradiction is found
- Modify: `docs/superpowers/plans/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic-plan.md` only to mark execution evidence

- [x] **Step 1: Run the complete relevant Node test suite**

Run: `cd signal-server && npm test`

Observed: Signal Server 65/67 passed; two bootstrap tests fail under the package working directory because the child path resolves to `signal-server/signal-server/server.js`. The same file passes 3/3 from the repository root. Viewer 78/78 and operations 43/43 passed.

- [x] **Step 2: Run the complete relevant Python test suite**

Run: `python -m pytest python-host -q`

Observed: Python Host 26/26 passed with one MSS deprecation warning; service helper 3/3 passed.

- [x] **Step 3: Classify findings and root causes**

Severity order: P0 unavailable/data-loss/security boundary, P1 major connection or interaction failure, P2 material performance/reliability weakness, P3 observability/maintainability gap.

Expected: Each finding includes evidence, impact, root cause confidence, recommendation, and measurable acceptance target.

- [x] **Step 4: Write and self-review the final report**

Run: `rg -n 'TBD|TODO|待补|待确认|应该|似乎' docs/superpowers/reports/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic.md`

Expected: No placeholders or unsupported completion language; limitations are explicit facts rather than vague qualifiers.

- [x] **Step 5: Verify repository scope**

Run: `git diff --check && git status --short`

Expected: No whitespace errors; only the three diagnostic Markdown files are added by this task, while all pre-existing user changes remain untouched.
