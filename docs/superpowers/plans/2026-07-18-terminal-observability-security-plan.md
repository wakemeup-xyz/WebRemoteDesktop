# Terminal Observability and Security Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Do not delegate because this session does not authorize subagents. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Terminal latency metrics clock-correct, prevent password echo, remove sensitive input logs, bound log growth, and enforce credentials-file tunnel startup guidance without restarting runtime services.

**Architecture:** Extract optimistic echo into a pure confidence state machine, keep browser RTT entirely in the browser clock domain, and reuse structured redaction before every persisted Signal Server event. Python and Node logging each receive one bounded file sink configured by the same environment names.

**Tech Stack:** Browser JavaScript, Node.js/Socket.IO, Python logging, Node.js test runner, pytest, Bash/launchctl.

**Spec Coverage:** Batch D of `docs/superpowers/specs/2026-07-18-remote-desktop-reliability-latency-remediation-design.md`.

**Truth Source:** `terminal-echo-controller.js` for local-echo confidence; browser pending maps for RTT; `WRD_LOG_MAX_BYTES` and `WRD_LOG_BACKUP_COUNT` for file bounds; structured redactors for persisted fields.

**Compatibility Notes:** Existing Terminal ping/pong/input_ack event names and wall-clock metadata remain on the wire for diagnostics, but browser RTT ignores remote clock values. `WRD_TERMINAL_RECORD_IO=1` remains the only explicit Terminal IO recording opt-in.

**Impact Map:**
- **Truth Source:** One echo state machine, same-clock RTT series, and shared log-bound settings.
- **Backend:** Signal Server sends server processing fields and rotates structured/audit files; Host logs metadata only.
- **Frontend:** Terminal exposes socket RTT, input ack RTT, server processing, and echo confidence without character content.
- **Runtime Proof:** Artificial server clock skew does not change RTT; password input never appears locally; rotated files stay bounded; status warns on `--token` argv without stopping cloudflared.
- **Docs/Skills:** README, safe runbook, service rules, and requirement doc describe credentials-file startup and log limits.
- **Commit Boundary:** Terminal metrics/echo, redaction/rotation, Host wrapper logging, fixed-domain safety warning, tests, and matching docs only.

**Definition of Done:**
- Terminal RTT never subtracts browser and server wall clocks.
- A non-echoing password prompt cannot reveal typed characters through optimistic echo.
- Default Host and Signal logs contain no key, code, text, coordinates, or raw input payload.
- Host and Signal file sinks rotate at configured limits.
- No implementation step stops/restarts cloudflared or local services.

---

### Task 1: Separate Terminal RTT and server processing metrics

**Files:**
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/js/terminal.test.js`
- Modify: `signal-server/websocket/terminal.js`
- Modify: `signal-server/websocket/terminal.test.js`

- [x] **Step 1: Add failing skew tests**

Send an input at browser time 1,000, receive its ack at browser time 1,120, and supply server timestamps around 9,000,000. Assert `inputAck.last === 120` and `serverProcess.last` equals `serverSentAt - serverReceivedAt`, independent of clock offset.

- [x] **Step 2: Verify RED**

Run: `node --test web-client/js/terminal.test.js signal-server/websocket/terminal.test.js`

Expected: FAIL because current `inputAck` subtracts `serverReceivedAt - clientSentAt`.

- [x] **Step 3: Implement same-clock series**

Add `terminalServerProcessLatency`. `handleInputAck()` uses only `Date.now() - pending.clientSentAt` for RTT and separately records a bounded non-negative server duration when both server timestamps are finite. Never trust echoed `payload.clientSentAt` over local pending state.

- [x] **Step 4: Verify GREEN**

Run: `node --test web-client/js/terminal.test.js signal-server/websocket/terminal.test.js`

Expected: skew-safe series and existing wire metadata tests pass.

### Task 2: Introduce password-safe optimistic echo confidence

**Files:**
- Create: `web-client/js/terminal-echo-controller.js`
- Create: `web-client/js/terminal-echo-controller.test.js`
- Modify: `web-client/viewer.html`
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/js/terminal.test.js`

- [x] **Step 1: Write failing state-machine tests**

Assert the first printable character is a probe and is not local output; matching remote output enables echo for subsequent printable characters. No remote echo keeps confidence false. Enter, Ctrl/Escape, alternate-screen, detach, destroy, and reconnect reset confidence.

```javascript
const echo = TerminalEchoController.create();
assert.deepEqual(echo.onInput('s'), { localEcho: '', probe: 's' });
echo.onRemoteOutput('s');
assert.equal(echo.onInput('e').localEcho, 'e');
echo.reset('enter');
assert.equal(echo.snapshot().confident, false);
```

- [x] **Step 2: Verify RED**

Run: `node --test web-client/js/terminal-echo-controller.test.js web-client/js/terminal.test.js`

Expected: FAIL because current implementation immediately echoes every printable character.

- [x] **Step 3: Integrate one controller per session**

Replace `pendingLocalEchoBySession` business logic with controllers. The controller returns output to render and remote output after deduplication; `TerminalPanel` owns only session lookup and xterm writes. Diagnostic state exposes booleans/counts, never probe text.

- [x] **Step 4: Verify password and alternate-screen behavior**

Run: `node --test web-client/js/terminal-echo-controller.test.js web-client/js/terminal.test.js`

Expected: normal confirmed shell echo is deduplicated, non-echoing password input stays hidden, and alternate-screen remains disabled.

### Task 3: Remove sensitive desktop and Terminal input logs

**Files:**
- Modify: `python-host/host.py`
- Modify: `python-host/input_handler.py`
- Modify: `python-host/observability.py`
- Modify: `python-host/test_connection_diagnostics.py`
- Modify: `python-host/test_input_handler.py`
- Modify: `signal-server/observability/redact.js`
- Modify: `signal-server/test/observability-logger.test.js`
- Modify: `signal-server/lib/terminal/audit.js`

- [x] **Step 1: Add failing redaction tests**

Capture logs for keyboard, mouse, and Terminal input. Assert sentinel values such as `Secret123`, `KeyA`, and coordinate `987.654` are absent, while action, transport, byte count, hashed input ID, and local execute duration remain.

- [x] **Step 2: Verify RED**

Run: `python3 -m pytest python-host/test_connection_diagnostics.py python-host/test_input_handler.py -q && cd signal-server && node --test test/observability-logger.test.js`

Expected: FAIL because Host logs raw payload/key/code/coordinates and audit file policy is not centralized.

- [x] **Step 3: Implement metadata-only Host logging**

Add helpers that hash input IDs and summarize payload byte count/category. Remove cross-clock `input_delay`, raw payload interpolation, keyboard value logs, and coordinate logs from default info paths. Keep exception stack traces without payload values.

- [x] **Step 4: Enforce redaction before persistence**

Ensure structured logger and Terminal audit both call the same redactor before console, memory store, or file writes. Treat `data`, `key`, `code`, `text`, `payload`, `x`, and `y` as sensitive by default. Do not change the explicit `WRD_TERMINAL_RECORD_IO=1` code path.

- [x] **Step 5: Verify GREEN**

Run: `python3 -m pytest python-host/test_connection_diagnostics.py python-host/test_input_handler.py -q && cd signal-server && node --test test/observability-logger.test.js websocket/terminal.test.js`

Expected: sentinel values are absent and metadata remains useful.

### Task 4: Add bounded Python and Node file sinks

**Files:**
- Modify: `python-host/observability.py`
- Modify: `python-host/host.py`
- Create: `python-host/test_observability.py`
- Modify: `signal-server/observability/logger.js`
- Modify: `signal-server/test/observability-logger.test.js`
- Modify: `signal-server/lib/config.js`
- Modify: `signal-server/test/config.test.js`
- Modify: `signal-server/server.js`
- Modify: `signal-server/lib/terminal/audit.js`
- Modify: `scripts/run-host-launchctl.sh`
- Modify: `scripts/host-launchctl.test.js`

- [x] **Step 1: Add failing rotation/config tests**

Use temporary directories and tiny limits. Assert Python `RotatingFileHandler` and Node rotating sink produce a current file plus at most the configured backup count. Assert defaults are 10 MiB and 3 backups.

- [x] **Step 2: Verify RED**

Run: `python3 -m pytest python-host/test_observability.py -q && cd signal-server && node --test test/config.test.js test/observability-logger.test.js && cd .. && node --test scripts/host-launchctl.test.js`

Expected: FAIL because current sinks append without size limits and Host wrapper output grows indefinitely.

- [x] **Step 3: Implement bounded sinks**

Python reads `WRD_LOG_MAX_BYTES` and `WRD_LOG_BACKUP_COUNT`, defaults to `10 * 1024 * 1024` and `3`, and installs one rotating Host handler without duplicate handlers. Node's file sink rotates `file -> file.1 -> ...` before append when the next line crosses the limit. Terminal audit uses the same sink factory.

- [x] **Step 4: Bound wrapper logs**

Before the launch wrapper appends, preserve at most the newest 1 MiB in `/tmp/wrd-host-launch.log`. Host runtime structured logs go through the rotating handler rather than unbounded `back-debug.log` stdout append.

- [x] **Step 5: Verify GREEN**

Run: `python3 -m pytest python-host/test_observability.py -q && cd signal-server && node --test test/config.test.js test/observability-logger.test.js && cd .. && node --test scripts/host-launchctl.test.js`

Expected: rotation and config tests pass.

### Task 5: Enforce named-tunnel credential and status safety

**Files:**
- Modify: `scripts/start-fixed-domain.sh`
- Modify: `scripts/status-safe-wrd.sh`
- Modify: `scripts/tunnel-launchctl.test.js`
- Modify: `scripts/status-safe-wrd.test.js`

- [x] **Step 1: Add failing source/behavior tests**

Assert fixed-domain startup uses `--config ... run <name>` with a config containing `credentials-file`, never accepts a token variable, and status emits a security warning when injected process args contain `cloudflared ... --token ...` without calling kill/launchctl remove.

- [x] **Step 2: Verify RED**

Run: `node --test scripts/tunnel-launchctl.test.js scripts/status-safe-wrd.test.js`

Expected: status warning coverage fails; startup must remain credentials-file based.

- [x] **Step 3: Add read-only argv warning**

Inspect matching fixed-domain cloudflared argv, print only `security warning: cloudflared token found in process arguments`, and never print the token itself. Do not stop, restart, or rewrite any process/URL state.

- [x] **Step 4: Verify GREEN**

Run: `node --test scripts/tunnel-launchctl.test.js scripts/status-safe-wrd.test.js`

Expected: credential-source and read-only warning tests pass.

### Task 6: Synchronize operations and security documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `skills/webremote-service/references/service-rules.md`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`

- [x] **Step 1: Document metric, echo, logging, and credential rules**

State that public Terminal RTT is external transport RTT, echo activates only after confirmed shell echo, default logs exclude input values, files rotate at 10 MiB/3 backups, and named tunnel uses config plus credentials file. Explicitly say status only warns about token argv and does not restart cloudflared.

- [x] **Step 2: Run documentation and scope checks**

Run: `git diff --check && rg -n 'WRD_LOG_MAX_BYTES|credentials-file|password.*echo|inputAckRtt' README.md docs/runbook-safe-startup.md skills/webremote-service/references/service-rules.md docs/需求文档/WebRemoteDesktop-需求文档.md`

Expected: active documentation matches implementation and contains no secret values.

### Task 7: Separate desktop input ack from visual feedback

**Files:** `python-host/host.py`, `signal-server/websocket/signaling.js`, `web-client/js/webrtc.js`, `web-client/js/latency-monitor.js` and focused tests.

- [x] **Step 1: Add failing Host/Signal/Viewer ack tests**
- [x] **Step 2: Verify that current RTT still waits for frame timing**
- [x] **Step 3: Send independent DataChannel/Socket input ack and keep frame IDs for visual feedback**
- [x] **Step 4: Verify browser RTT, Host execute, and visual feedback are independent**

### Task 8: Bound shared Terminal resources

**Files:** Terminal config, session manager, websocket/UI integration, and focused tests.

- [x] **Step 1: Add failing hard-limit, replay-budget, idle-reap, and UI capacity tests**
- [x] **Step 2: Verify RED**
- [x] **Step 3: Implement default 8-session ceiling, 256 KiB replay budget, detached idle reap, and capacity snapshot**
- [x] **Step 4: Verify stable `terminal_session_limit` and existing-session continuity**

### Task 9: Add bounded event-loop lag context

**Files:** `python-host/host.py`, `python-host/test_connection_diagnostics.py`, requirement/spec/report docs.

- [x] **Step 1: Add a failing bounded-context test**
- [x] **Step 2: Replace `sleep(0)` timing with 1-second deadline drift**
- [x] **Step 3: Add 20/100ms severity, five-second warning aggregation, and fixed resource/status fields**
- [x] **Step 4: Verify no task names, stacks, or input values are logged**

### Task 10: Contain late Terminal events after session close

**Files:**
- Modify: `signal-server/websocket/terminal.test.js`
- Modify: `signal-server/websocket/terminal.js`
- Modify: `docs/superpowers/reports/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic.md`

- [x] **Step 1: Add the failing close-race regression**

Create a shared session, close it, then trigger late `terminal:input` and `terminal:resize` events for the closed ID. Assert neither trigger throws, both return `terminal:error` with `code=terminal_session_not_found`, and the audit stream contains `terminal_input_rejected` / `terminal_resize_rejected` without input data.

- [x] **Step 2: Verify RED**

Run: `cd signal-server && node --test --test-name-pattern='late Terminal events' websocket/terminal.test.js`

Expected: FAIL because `isObserverAttached()` throws before the current input/resize rejection branches.

- [x] **Step 3: Add the minimal WebSocket error boundary**

Wrap the attachment check used by each handler in the same local error conversion used by attach/close/write operations. Preserve strict `session-manager` exceptions, emit the stable session-not-found error, and log only session/client/socket IDs plus the rejection reason.

- [x] **Step 4: Verify GREEN and browser reproduction**

Run: `cd signal-server && node --test websocket/terminal.test.js`

Then repeat the ordinary Chromium close/create/input sequence. Expected: Signal PID remains unchanged, the new PTY receives its command, no session remains after explicit close, and no page error or unhandled server exception is emitted.
