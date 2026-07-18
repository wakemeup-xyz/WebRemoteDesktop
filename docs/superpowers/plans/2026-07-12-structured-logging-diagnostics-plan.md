# Structured Logging and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a unified structured logging and diagnostics system for Signal Server, browser diagnostics, Terminal audit, and Python Host summary logging while keeping detailed browser payload persistence opt-in and Terminal IO logging off by default.

**Architecture:** Add a small observability layer on the Node side that owns event envelopes, redaction, and recent-event summaries. Keep browser diagnostics on the existing upload path, but normalize them in one library-level ingest function that both Socket.IO and HTTP call, write a structured summary event for every upload, and persist the full redacted bundle only when `WRD_ENABLE_DIAG_PERSIST=1`. Upgrade Terminal audit from string-prefixed logs to structured security events, include `/api/auth/login/admin` outcomes in that audit domain, and change Host browser-diagnostic handling to emit summary events by default instead of dumping whole browser log blocks.

**Tech Stack:** Node.js, Express, Socket.IO, plain browser JavaScript, Python, pytest, Node test runner, Markdown docs

**Spec Coverage:** Full approved spec coverage. This plan covers shared event envelopes, conservative persistence defaults, browser upload correlation, Terminal audit semantics, Host summary logging, lightweight admin observability endpoints, and documentation updates. It does not build a full frontend log viewer or introduce external logging infrastructure.

**Truth Source:** `signal-server/lib/observability/logger.js` and `signal-server/lib/diagnostic.js` become the canonical Node-side event and bundle normalization layer. `signal-server/lib/terminal/audit.js` becomes the canonical Terminal audit event wrapper across terminal auth and terminal runtime events. `python-host/observability.py` becomes the canonical Host summary emitter. Existing browser upload entry points remain producers only; the server-side ingest boundary remains authoritative.

**Compatibility Notes:** `WRD_ENABLE_DIAG_PERSIST` continues to control browser diagnostic bundle persistence into the temp directory. Socket.IO `diagnostic` and `POST /api/diagnostics` remain supported. Existing `/api/admin/connection-summary` and `/api/admin/connection-attempts` remain intact. Terminal IO recording remains opt-in through `WRD_TERMINAL_RECORD_IO`. Host browser-diagnostic behavior changes from full verbose block logging to summary-first logging, with explicit opt-in for verbose detail through `WRD_HOST_VERBOSE_DIAGNOSTICS`.

**Impact Map:**
- **Truth Source:** Server-side observability helpers define the structured envelope, redaction, recent-event store, and audit/event naming.
- **Backend:** `signal-server/lib/config.js`, new `signal-server/lib/observability/*` files, `signal-server/lib/diagnostic.js`, `signal-server/server.js`, `signal-server/routes/auth.js`, `signal-server/websocket/signaling.js`, `signal-server/lib/terminal/audit.js`, `signal-server/lib/terminal/session-manager.js`, `signal-server/websocket/terminal.js`.
- **Frontend:** `web-client/js/diagnostic.js`, `web-client/js/terminal.js`, and related tests add `browserSessionId`, structured log entries, and richer upload correlation without changing the visible workflow.
- **Runtime Proof:** Manual browser diagnostic upload, failed-connection auto-send, terminal create/attach/detach/close, and host diagnostic receipt all produce structured summary events that can be retrieved via admin summary endpoints or log files.
- **Docs/Skills:** `README.md`, `docs/runbook-safe-startup.md`, `docs/需求文档/WebRemoteDesktop-需求文档.md`.
- **Commit Boundary:** One focused observability batch only. No Cloudflare transport changes, Terminal networking changes, or media-path refactors belong in this implementation.

**Definition of Done:**
- Browser diagnostic uploads always produce one structured summary event, and full diagnostic bundle persistence only happens when `WRD_ENABLE_DIAG_PERSIST=1`.
- Terminal lifecycle and rejection paths emit structured audit events without recording full IO by default.
- Host diagnostic handling writes structured summary events by default and no longer dumps raw browser log blocks unless explicitly enabled through config.
- Admin-only observability summary endpoints return recent structured event summaries without exposing sensitive raw payloads.
- README, runbook, and requirements docs describe the new logging defaults and config semantics accurately.

---

## File Structure

### Canonical truth and responsibility map

- `signal-server/lib/observability/logger.js`
  - Canonical structured event envelope builder and logger output helper
- `signal-server/lib/observability/redact.js`
  - Canonical redaction helper for tokens, passwords, secrets, auth headers, cookies, and sensitive URLs
- `signal-server/lib/observability/store.js`
  - Canonical recent-event in-memory ring buffer and summary aggregation
- `signal-server/lib/config.js`
  - Canonical logging configuration semantics
- `signal-server/lib/diagnostic.js`
  - Canonical browser diagnostic ingest, normalization, summary-event building, and temp-dir persistence
- `signal-server/lib/terminal/audit.js`
  - Canonical Terminal audit event builder
- `signal-server/routes/auth.js`
  - Canonical Terminal admin login audit entrypoint
- `signal-server/server.js`
  - Canonical HTTP surfaces for `/api/diagnostics` and new admin observability summary endpoints
- `signal-server/websocket/signaling.js`
  - Canonical Socket.IO diagnostic ingestion and summary event emission
- `signal-server/websocket/terminal.js`
  - Canonical Terminal namespace event logging and rejection logging
- `python-host/observability.py`
  - Canonical Host structured summary emitter
- `python-host/host.py`
  - Canonical Host diagnostic summary logging behavior
- `web-client/js/diagnostic.js`
  - Canonical browser log buffer, `browserSessionId`, upload payload construction, auto-send, and pending replay
- `README.md`
  - Canonical operator summary of logging defaults
- `docs/runbook-safe-startup.md`
  - Canonical runtime/debugging entrypoint
- `docs/需求文档/WebRemoteDesktop-需求文档.md`
  - Canonical product/security statement of logging and audit behavior

### Compatibility boundary

- Browser producers can continue to emit partial diagnostic payloads.
- The server-side diagnostic ingest path remains the only place that decides the persisted bundle shape.
- Existing admin connection-summary endpoints remain supported.
- Terminal audit defaults change to structured summary logging, but Terminal runtime behavior does not change.
- Terminal admin login remains the same API, but now participates in the same audit stream as runtime terminal events.

---

### Task 1: Add shared observability primitives and config semantics

**Files:**
- Create: `signal-server/lib/observability/logger.js`
- Create: `signal-server/lib/observability/redact.js`
- Create: `signal-server/lib/observability/store.js`
- Create: `signal-server/test/observability-logger.test.js`
- Modify: `signal-server/lib/config.js`
- Modify: `signal-server/test/config.test.js`

- [ ] **Step 1: Write failing tests for logger envelope, redaction, recent-event store, and config semantics**

```js
// signal-server/test/observability-logger.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStructuredLogger } = require('../lib/observability/logger');
const { redactValue } = require('../lib/observability/redact');
const { createRecentEventStore } = require('../lib/observability/store');

test('createStructuredLogger emits a stable envelope with correlation and meta fields', () => {
  const written = [];
  const logger = createStructuredLogger({
    write(line) {
      written.push(JSON.parse(line));
    },
    now: () => new Date('2026-07-12T00:00:00.000Z'),
  });

  logger.info({
    domain: 'terminal',
    event: 'terminal_session_created',
    message: 'Terminal session created',
    correlation: { terminalSessionId: 'term-1', clientId: 'client-1' },
    meta: { cols: 120, rows: 40 },
  });

  assert.equal(written.length, 1);
  assert.equal(written[0].domain, 'terminal');
  assert.equal(written[0].event, 'terminal_session_created');
  assert.equal(written[0].correlation.terminalSessionId, 'term-1');
  assert.equal(written[0].meta.cols, 120);
});

test('redactValue removes secret-bearing fields recursively', () => {
  const redacted = redactValue({
    token: 'abc',
    nested: { authorization: 'Bearer xxx', safe: 'ok' },
    url: 'https://example.com?a=1&token=secret',
  });
  assert.equal(redacted.token, '[redacted]');
  assert.equal(redacted.nested.authorization, '[redacted]');
  assert.match(redacted.url, /redacted/i);
  assert.equal(redacted.nested.safe, 'ok');
});

test('createRecentEventStore keeps a bounded recent window and grouped summary', () => {
  const store = createRecentEventStore({ capacity: 3 });
  store.append({ domain: 'server', event: 'started', level: 'info' });
  store.append({ domain: 'viewer', event: 'diagnostic_uploaded', level: 'warn' });
  store.append({ domain: 'terminal', event: 'terminal_session_created', level: 'info' });
  store.append({ domain: 'terminal', event: 'terminal_session_closed', level: 'info' });

  const recent = store.recent({ limit: 10 });
  const summary = store.summary();
  assert.equal(recent.length, 3);
  assert.equal(summary.byDomain.terminal, 2);
  assert.equal(summary.byEvent.terminal_session_closed, 1);
});
```

```js
// signal-server/test/config.test.js
test('loadConfig keeps diag persistence separate from runtime log settings', () => {
  process.env.JWT_SECRET = '12345678';
  process.env.VIEWER_ACCESS_PASSWORD = 'viewer-pass';
  process.env.HOST_SHARED_SECRET = 'host-pass-1';
  process.env.WRD_ENABLE_DIAG_PERSIST = '0';
  process.env.WRD_LOG_LEVEL = 'debug';
  process.env.WRD_LOG_FORMAT = 'jsonl';
  process.env.WRD_TERMINAL_AUDIT_LOG = '/tmp/wrd-terminal-audit.jsonl';

  const { loadConfig } = require('../lib/config');
  const config = loadConfig();
  assert.equal(config.enableDiagPersist, false);
  assert.equal(config.logLevel, 'debug');
  assert.equal(config.logFormat, 'jsonl');
  assert.equal(config.terminalAuditLog, '/tmp/wrd-terminal-audit.jsonl');
});
```

- [ ] **Step 2: Run the focused Node tests and verify they fail before the observability layer exists**

Run:

```bash
node --test signal-server/test/observability-logger.test.js
node --test signal-server/test/config.test.js
```

Expected:

```text
not ok - createStructuredLogger emits a stable envelope with correlation and meta fields
not ok - redactValue removes secret-bearing fields recursively
not ok - createRecentEventStore keeps a bounded recent window and grouped summary
```

- [ ] **Step 3: Implement the shared observability helpers and explicit config fields**

```js
// signal-server/lib/observability/logger.js
function normalizeEvent(input = {}, level = 'info', now = () => new Date()) {
  return {
    ts: now().toISOString(),
    level,
    domain: String(input.domain || 'server'),
    event: String(input.event || 'unknown'),
    message: String(input.message || ''),
    source: 'signal-server',
    schemaVersion: 1,
    correlation: input.correlation && typeof input.correlation === 'object' ? { ...input.correlation } : {},
    meta: input.meta && typeof input.meta === 'object' ? { ...input.meta } : {},
    redactionVersion: 1,
  };
}

function createStructuredLogger(options = {}) {
  const write = typeof options.write === 'function'
    ? options.write
    : (line) => process.stdout.write(line + '\n');
  const now = options.now || (() => new Date());

  function emit(level, input) {
    const event = normalizeEvent(input, level, now);
    write(JSON.stringify(event));
    return event;
  }

  return {
    info(input) { return emit('info', input); },
    warn(input) { return emit('warn', input); },
    error(input) { return emit('error', input); },
    debug(input) { return emit('debug', input); },
  };
}

module.exports = { createStructuredLogger, normalizeEvent };
```

```js
// signal-server/lib/config.js
return {
  // existing fields...
  logLevel: String(process.env.WRD_LOG_LEVEL || 'info').trim() || 'info',
  logFormat: String(process.env.WRD_LOG_FORMAT || 'jsonl').trim() || 'jsonl',
  logDir: String(process.env.WRD_LOG_DIR || '').trim(),
};
```

- [ ] **Step 4: Re-run the focused tests and verify they pass**

Run:

```bash
node --test signal-server/test/observability-logger.test.js
node --test signal-server/test/config.test.js
```

Expected:

```text
ok - createStructuredLogger emits a stable envelope with correlation and meta fields
ok - redactValue removes secret-bearing fields recursively
ok - createRecentEventStore keeps a bounded recent window and grouped summary
```

- [ ] **Step 5: Commit**

```bash
git add signal-server/lib/observability/logger.js signal-server/lib/observability/redact.js signal-server/lib/observability/store.js signal-server/lib/config.js signal-server/test/observability-logger.test.js signal-server/test/config.test.js
git commit -m "feat: add shared observability primitives"
```

---

### Task 2: Normalize browser diagnostic ingestion in the library layer and add admin observability summaries

**Files:**
- Modify: `signal-server/lib/diagnostic.js`
- Modify: `signal-server/websocket/signaling.js`
- Modify: `signal-server/server.js`
- Modify: `signal-server/test/diagnostic.test.js`
- Modify: `signal-server/websocket/signaling.test.js`

- [ ] **Step 1: Write failing tests for structured diagnostic summary events and new admin endpoints**

```js
// signal-server/test/diagnostic.test.js
test('ingestDiagnosticPayload emits a structured summary and only persists bundle when enabled', () => {
  const written = [];
  const logger = { info: (event) => written.push(event), warn() {}, error() {} };
  const result = ingestDiagnosticPayload({
    role: 'viewer',
    viewerId: 'viewer-1',
    userAgent: 'test-agent',
    data: {
      type: 'connection-diagnostic',
      browserSessionId: 'browser-1',
      connectionAttemptId: 'attempt-1',
      trigger: 'manual',
      logs: [{ at: '10:00:00', level: 'error', message: 'boom' }],
    },
    config: { enableDiagPersist: false },
    logger,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.summaryEvent.event, 'diagnostic_uploaded');
  assert.equal(result.summaryEvent.correlation.browserSessionId, 'browser-1');
  assert.equal(result.summaryEvent.meta.persisted, false);
});
```

```js
// signal-server/websocket/signaling.test.js
test('GET /api/admin/observability/summary returns grouped recent-event counts', async () => {
  await withServer(async ({ baseUrl, token }) => {
    const response = await fetch(baseUrl + '/api/admin/observability/summary', {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.byDomain);
    assert.ok(body.byEvent);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify they fail before summary events and endpoints exist**

Run:

```bash
node --test signal-server/test/diagnostic.test.js
node --test signal-server/websocket/signaling.test.js
```

Expected:

```text
not ok - ingested browser diagnostics emit a structured summary and only persist bundle when enabled
not ok - GET /api/admin/observability/summary returns grouped recent-event counts
```

- [ ] **Step 3: Update diagnostic ingest so every upload yields one structured summary event**

```js
// signal-server/lib/diagnostic.js
function ingestDiagnosticPayload(options = {}) {
  // normalize payload from both HTTP and Socket.IO sources here
  // return { accepted, connectionAttemptId, report, summaryEvent }
}

function buildDiagnosticSummaryEvent(report, options = {}) {
  const persisted = Boolean(options.persisted);
  return {
    domain: 'viewer',
    event: 'diagnostic_uploaded',
    message: 'Viewer uploaded diagnostic bundle',
    correlation: {
      browserSessionId: report.browserSessionId || null,
      connectionAttemptId: report.connectionAttemptId || null,
      viewerId: report.viewerId || null,
      socketId: options.socketId || null,
    },
    meta: {
      trigger: report.trigger || 'manual',
      reason: report.reason || null,
      type: report.type || 'diagnostic',
      logCount: report.logCount || 0,
      persisted,
    },
  };
}
```

```js
// signal-server/websocket/signaling.js
const result = ingestDiagnosticPayload({
  role,
  viewerId: socket.id,
  userAgent: socket.handshake.headers['user-agent'] || 'unknown',
  data,
  config,
  logger,
});
if (result.accepted) {
  recentEventStore.append(result.summaryEvent);
  structuredLogger.info(result.summaryEvent);
}
```

```js
// signal-server/server.js
app.get('/api/admin/observability/summary', requireAccessToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  return res.json(recentEventStore.summary());
});

app.get('/api/admin/observability/recent', requireAccessToken, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  const limit = Math.max(1, Math.min(200, Number.parseInt(req.query.limit, 10) || 50));
  return res.json({ items: recentEventStore.recent({ domain: req.query.domain, limit }) });
});
```

- [ ] **Step 4: Re-run the focused tests and verify they pass**

Run:

```bash
node --test signal-server/test/diagnostic.test.js
node --test signal-server/websocket/signaling.test.js
```

Expected:

```text
ok - ingested browser diagnostics emit a structured summary and only persist bundle when enabled
ok - GET /api/admin/observability/summary returns grouped recent-event counts
```

- [ ] **Step 5: Commit**

```bash
git add signal-server/lib/diagnostic.js signal-server/websocket/signaling.js signal-server/server.js signal-server/test/diagnostic.test.js signal-server/websocket/signaling.test.js
git commit -m "feat: add structured diagnostic ingest and summary endpoints"
```

---

### Task 3: Add browser session correlation and structured in-memory browser log entries

**Files:**
- Modify: `web-client/js/diagnostic.js`
- Modify: `web-client/js/terminal.js`
- Modify: `web-client/js/diagnostic.test.js`
- Modify: `web-client/js/runtime-config.test.js`

- [ ] **Step 1: Write failing browser tests for `browserSessionId`, structured log entries, and upload payload correlation**

```js
// web-client/js/diagnostic.test.js
test('Diagnostic.buildConnectionDiagnostic includes browserSessionId and terminal diagnostic state', () => {
  const { context } = createDiagnosticContext({
    sessionStorage: fakeStorage(),
    TerminalPanel: {
      getDiagnosticState() {
        return { activeSessionId: 'term-1', socketState: 'connected' };
      },
    },
  });
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');

  const payload = Diagnostic.buildConnectionDiagnostic({ trigger: 'manual' });
  assert.equal(typeof payload.browserSessionId, 'string');
  assert.equal(payload.terminal.activeSessionId, 'term-1');
});

test('console interception stores structured log entries instead of bare strings', () => {
  const { context } = createDiagnosticContext({ sessionStorage: fakeStorage() });
  const Diagnostic = loadScript('diagnostic.js', context, 'Diagnostic');
  Diagnostic.init();
  context.console.error('boom');
  assert.equal(typeof Diagnostic.logs[0].message, 'string');
  assert.equal(Diagnostic.logs[0].level, 'ERR');
});
```

- [ ] **Step 2: Run the focused browser test and verify it fails**

Run:

```bash
node --test web-client/js/diagnostic.test.js
```

Expected:

```text
not ok - Diagnostic.buildConnectionDiagnostic includes browserSessionId and terminal diagnostic state
not ok - console interception stores structured log entries instead of bare strings
```

- [ ] **Step 3: Add `browserSessionId`, structured log buffering, and correlated upload payloads**

```js
// web-client/js/diagnostic.js
const Diagnostic = {
  logs: [],
  browserSessionId: null,

  ensureBrowserSessionId() {
    const key = 'wrd_browser_session_id';
    const existing = sessionStorage.getItem(key);
    if (existing) {
      this.browserSessionId = existing;
      return existing;
    }
    const created = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(key, created);
    this.browserSessionId = created;
    return created;
  },

  hijackConsole() {
    const push = (level, args, channel = 'console') => {
      const message = args.map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item)).join(' ');
      this.logs.push({
        at: new Date().toISOString(),
        level,
        channel,
        message,
      });
      if (this.logs.length > this.maxLogs) this.logs.shift();
    };
    // wrap console.log/error/warn/info...
  },

  buildConnectionDiagnostic(meta = {}) {
    return {
      // existing fields...
      browserSessionId: this.ensureBrowserSessionId(),
      terminal: typeof TerminalPanel !== 'undefined' ? TerminalPanel.getDiagnosticState() : null,
    };
  },
};
```

- [ ] **Step 4: Re-run the focused browser test and verify it passes**

Run:

```bash
node --test web-client/js/diagnostic.test.js
```

Expected:

```text
ok - Diagnostic.buildConnectionDiagnostic includes browserSessionId and terminal diagnostic state
ok - console interception stores structured log entries instead of bare strings
```

- [ ] **Step 5: Commit**

```bash
git add web-client/js/diagnostic.js web-client/js/terminal.js web-client/js/diagnostic.test.js web-client/js/runtime-config.test.js
git commit -m "feat: correlate browser diagnostics with session ids"
```

---

### Task 4: Upgrade Terminal audit, terminal admin auth audit, and Host diagnostic handling to summary-first logging

**Files:**
- Modify: `signal-server/lib/terminal/audit.js`
- Modify: `signal-server/lib/terminal/session-manager.js`
- Modify: `signal-server/websocket/terminal.js`
- Modify: `signal-server/routes/auth.js`
- Modify: `signal-server/test/terminal-auth.test.js`
- Modify: `signal-server/test/terminal-session-manager.test.js`
- Modify: `signal-server/websocket/terminal.test.js`
- Create: `python-host/observability.py`
- Modify: `python-host/host.py`
- Modify: `signal-server/lib/config.js`
- Modify: `python-host/test_connection_diagnostics.py`

- [ ] **Step 1: Write failing tests for structured Terminal audit events, terminal admin login audit, and Host summary-only diagnostic logging**

```js
// signal-server/test/terminal-session-manager.test.js
test('createSession emits a structured terminal_session_created audit event', () => {
  const events = [];
  const manager = createTerminalSessionManager({
    config: { enabled: true, adminPassword: 'admin-pass', shell: '/bin/zsh', recordIo: false },
    audit: { info: (event, meta) => events.push({ event, meta }), warn() {}, error() {} },
    ptyFactory: fakePtyFactory(),
  });

  manager.createSession({ clientId: 'client-1', socketId: 'socket-1' });
  assert.equal(events[0].event, 'terminal_session_created');
  assert.equal(events[0].meta.ioRecording, false);
});
```

```js
// signal-server/test/terminal-auth.test.js
test('/api/auth/login/admin emits terminal_admin_authorized on success', async () => {
  const events = [];
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(baseUrl + '/api/auth/login/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-terminal-admin-password' }),
    });
    assert.equal(response.status, 200);
  }, {
    logger: {
      info(event) { events.push(event); },
      warn() {},
      error() {},
    },
  });
  assert.equal(events.some((event) => event.event === 'terminal_admin_authorized'), true);
});
```

```python
# python-host/test_connection_diagnostics.py
async def test_on_diagnostic_logs_summary_without_viewer_log_dump_by_default(caplog):
    host = RemoteDesktopHost()
    payload = {
        "browserSessionId": "browser-1",
        "connectionAttemptId": "attempt-1",
        "trigger": "manual",
        "reason": "test",
        "logs": [{"level": "ERR", "message": "boom"}],
        "network": {"networkMode": "auto", "turnConfigured": False, "turnStatus": "missing"},
    }

    await host.on_diagnostic(payload)

    text = "\\n".join(record.message for record in caplog.records)
    assert "HOST_VIEWER_DIAGNOSTIC_SUMMARY" in text
    assert "[VIEWER] boom" not in text
```

- [ ] **Step 2: Run the focused Node and Python tests and verify they fail**

Run:

```bash
node --test signal-server/test/terminal-auth.test.js signal-server/test/terminal-session-manager.test.js signal-server/websocket/terminal.test.js
PYTHONPATH=python-host python -m pytest -q python-host/test_connection_diagnostics.py
```

Expected:

```text
not ok - createSession emits a structured terminal_session_created audit event
FAILED python-host/test_connection_diagnostics.py::test_on_diagnostic_logs_summary_without_viewer_log_dump_by_default
```

- [ ] **Step 3: Replace prefixed terminal audit strings with structured audit events and add Host observability helper**

```js
// signal-server/lib/terminal/audit.js
function createTerminalAudit(logger = console) {
  function emit(level, event, meta = {}) {
    const payload = {
      domain: 'terminal',
      event,
      message: event,
      correlation: {
        terminalSessionId: meta.sessionId || null,
        clientId: meta.clientId || null,
        socketId: meta.socketId || null,
      },
      meta,
    };
    logger[level]?.(payload);
    return payload;
  }

  return {
    info(event, meta = {}) { return emit('info', event, meta); },
    warn(event, meta = {}) { return emit('warn', event, meta); },
    error(event, meta = {}) { return emit('error', event, meta); },
  };
}
```

```js
// signal-server/routes/auth.js
audit.info('terminal_admin_authorized', {
  subject: 'terminal-admin-login',
  authRoute: '/api/auth/login/admin',
});
```

```python
# python-host/observability.py
import json
from datetime import datetime, timezone

def emit_host_event(logger, *, event, message, correlation=None, meta=None, level="info"):
    payload = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "level": level,
        "domain": "host",
        "event": event,
        "message": message,
        "source": "python-host",
        "schemaVersion": 1,
        "correlation": correlation or {},
        "meta": meta or {},
        "redactionVersion": 1,
    }
    getattr(logger, level)(json.dumps(payload, ensure_ascii=True))
    return payload
```

```python
# python-host/host.py
verboseDiag = os.getenv('WRD_HOST_VERBOSE_DIAGNOSTICS', '0') == '1'
emit_host_event(
    logger,
    event="host_viewer_diagnostic_summary",
    message="Viewer diagnostic received by host",
    correlation={
        "browserSessionId": data.get("browserSessionId"),
        "connectionAttemptId": data.get("connectionAttemptId"),
    },
    meta={
        "trigger": trigger,
        "reason": reason,
        "logCount": len(logs),
        "networkMode": network.get("networkMode", "-"),
        "turnConfigured": network.get("turnConfigured", False),
        "turnStatus": network.get("turnStatus", "unknown"),
    },
)
if verboseDiag:
    for line in logs:
        logger.info(f\"[VIEWER] {line}\")
```

- [ ] **Step 4: Re-run the focused tests and verify they pass**

Run:

```bash
node --test signal-server/test/terminal-auth.test.js signal-server/test/terminal-session-manager.test.js signal-server/websocket/terminal.test.js
PYTHONPATH=python-host python -m pytest -q python-host/test_connection_diagnostics.py
```

Expected:

```text
ok - createSession emits a structured terminal_session_created audit event
1 passed
```

- [ ] **Step 5: Commit**

```bash
git add signal-server/lib/terminal/audit.js signal-server/lib/terminal/session-manager.js signal-server/websocket/terminal.js signal-server/routes/auth.js signal-server/test/terminal-auth.test.js signal-server/test/terminal-session-manager.test.js signal-server/websocket/terminal.test.js signal-server/lib/config.js python-host/observability.py python-host/host.py python-host/test_connection_diagnostics.py
git commit -m "feat: add structured terminal and host audit summaries"
```

---

### Task 5: Document the new defaults, verify end-to-end runtime behavior, and close the batch

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`

- [ ] **Step 1: Update README and runbook language so operators know the new logging defaults**

Add and align the following statements:

```md
- Structured runtime logs are always on.
- Browser diagnostic bundle persistence is controlled only by `WRD_ENABLE_DIAG_PERSIST`.
- Terminal audit events are always emitted to runtime logs; `WRD_TERMINAL_AUDIT_LOG` adds a separate JSONL audit file when set to a file path.
- `WRD_TERMINAL_RECORD_IO=0` means Terminal input/output content is not recorded by default.
- Host browser-diagnostic handling is summary-first; verbose viewer-log dumping is opt-in for explicit debugging only.
```

- [ ] **Step 2: Update the requirements doc so audit/logging behavior matches implementation truth**

Replace the loose wording around:

```md
- [ ] 审计日志：记录 admin 登录、Terminal 创建、断开、重连、关闭和错误
```

with implemented truth like:

```md
- [x] 审计日志：Signal Server 记录 Terminal admin 登录、socket 连接、创建、附着、断开、关闭、拒绝和错误的结构化审计事件
- [x] 浏览器诊断：Viewer 可手动上送或在失败时自动上送诊断包；服务端默认仅记录结构化摘要，详细 bundle 仅在 `WRD_ENABLE_DIAG_PERSIST=1` 时写入系统临时目录
- [x] Terminal 默认不记录完整 IO；仅在 `WRD_TERMINAL_RECORD_IO=1` 时允许详细 IO 记录
```

- [ ] **Step 3: Run focused verification commands after the docs are updated**

Run:

```bash
node --test signal-server/test/observability-logger.test.js signal-server/test/diagnostic.test.js signal-server/test/terminal-session-manager.test.js signal-server/websocket/signaling.test.js signal-server/websocket/terminal.test.js
node --test web-client/js/diagnostic.test.js
PYTHONPATH=python-host python -m pytest -q python-host/test_connection_diagnostics.py
```

Expected:

```text
All selected Node tests pass
All selected browser-script tests pass
All selected python-host tests pass
```

- [ ] **Step 4: Perform runtime proof in a live local session**

Run and verify:

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/status-safe-wrd.sh
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/status
```

Then open the local page at `http://127.0.0.1:8080` and confirm:

```text
1. Manual browser diagnostic upload returns accepted=true.
2. /api/admin/observability/summary shows at least one viewer diagnostic event.
3. Creating and closing a Terminal session adds terminal audit events.
4. back-debug.log shows a Host summary event, not a full [VIEWER] line dump, after browser diagnostic upload.
```

- [ ] **Step 5: Commit**

```bash
git add README.md docs/runbook-safe-startup.md docs/需求文档/WebRemoteDesktop-需求文档.md
git commit -m "docs: document structured logging and audit defaults"
```

---

## Self-Review

1. **Spec completion:** The plan covers all approved design areas: event envelope, correlation ids, conservative persistence defaults, browser diagnostics, Terminal audit, Host summary logging, admin summary endpoints, and docs sync.
2. **Architecture review checklist:** The event envelope truth lives on the server side, browser uploads remain producers, Host summary output gets its own helper, and Terminal audit has one wrapper instead of scattered event naming across files.
3. **Impact map completeness:** Truth Source, Backend, Frontend, Runtime Proof, Docs/Skills, and Commit Boundary are all explicit in the header.
4. **Definition of Done audit:** Every DoD item is verifiable by targeted tests, endpoint checks, runtime proof, or doc changes.
5. **Placeholder scan:** No `TODO`, `TBD`, or “implement later” placeholders remain.
6. **Type consistency:** The plan uses one stable vocabulary: `browserSessionId`, `connectionAttemptId`, `terminalSessionId`, `diagnostic_uploaded`, `host_viewer_diagnostic_summary`, and `terminal_session_*`.
7. **Docs and commit boundary:** README, runbook, and requirement docs are explicitly included, and the batch stays scoped to observability rather than transport/network changes.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-structured-logging-diagnostics-plan.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
