# Strict STUN 连接诊断日志实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 WebRemoteDesktop 增加结构化连接遥测、自动诊断上报和后端持久化，从而能够区分 STUN 出站失败、候选交换失败、NAT 不兼容、媒体首帧超时和策略违规。

**Architecture:** Viewer 端新增轻量连接追踪器，统一记录一次连接尝试的事件流与快照；`webrtc.js` 负责采集 ICE / candidate / media 状态，`diagnostic.js` 负责组装 payload、自动上报和本地补发。Signal Server 接收 schemaVersion 2 的诊断报告，统一脱敏、落盘和打印摘要；Host 继续接收实时诊断，并补充一条可 grep 的 `WRD_STUN_FAILURE` 摘要日志。

**Tech Stack:** Vanilla JavaScript, Socket.IO, Node.js test runner, Node HTTP server, Python logging

---

## 文件结构

| 文件 | 责任 |
|------|------|
| `web-client/js/connection-trace.js` | **新建** 结构化连接事件缓冲、快照构建、失败分类辅助函数 |
| `web-client/js/webrtc.js` | 记录 ICE / candidate / media 事件，产生 `connectionAttemptId`，触发 terminal failure |
| `web-client/js/diagnostic.js` | 组装诊断 payload、自动上报、补发队列、UI 状态文案 |
| `web-client/viewer.html` | 挂载新脚本，保证追踪器在 `webrtc.js` / `diagnostic.js` 之前可用 |
| `web-client/js/webrtc.test.js` | Viewer 侧结构化事件和失败分类行为测试 |
| `web-client/js/diagnostic.test.js` | 自动上报、payload 结构、补发队列测试 |
| `signal-server/lib/diagnostic.js` | 诊断 payload 脱敏、schemaVersion 2 规范化、持久化前裁剪 |
| `signal-server/websocket/signaling.js` | 接收 viewer 诊断、写盘、摘要日志、补充 `host-ice-summary` 转发 |
| `signal-server/server.js` | 增加 `/api/diagnostics` HTTP 接口，和 Socket.IO 共享同一条落库路径 |
| `signal-server/test/diagnostic.test.js` | 脱敏、schemaVersion 2、持久化和重试相关测试 |
| `signal-server/websocket/signaling.test.js` | Socket.IO 诊断转发、摘要字段、host/viewer 事件测试 |
| `signal-server/test/config.test.js` | 新增诊断接口开关或 payload 兼容性测试 |
| `python-host/host.py` | 记录本地 candidate 摘要并输出 `WRD_STUN_FAILURE` |
| `python-host/test_connection_diagnostics.py` | Host 诊断摘要与 TURN 忽略日志测试 |
| `README.md` | 同步更新 Strict STUN、TURN / tunnel 手动模式和日志排障说明 |
| `docs/runbook-safe-startup.md` | 明确网页入口与媒体可达性的边界 |
| `docs/需求文档/WebRemoteDesktop-需求文档.md` | 同步需求层面的网络模式和诊断日志说明 |

---

### Task 1: Viewer 连接追踪器和事件流

**Files:**
- Create: `web-client/js/connection-trace.js`
- Modify: `web-client/viewer.html`
- Modify: `web-client/js/webrtc.js`
- Test: `web-client/js/webrtc.test.js`

- [ ] **Step 1: Write the failing tests for structured event capture**

Add tests that assert the viewer can record and expose a trace like:

```js
const trace = ConnectionTrace.create('auto', 'strict-stun');
trace.record('session-start', { url: 'https://example.com' });
trace.record('stun-probe-result', { url: 'stun:stun.l.google.com:19302', status: 'timeout' });
trace.record('terminal-failure', { reason: 'candidate-check-failed' });

const payload = trace.buildPayload({ pcState: 'failed' });
assert.equal(payload.connectionAttemptId.startsWith('wrd-'), true);
assert.equal(payload.events.at(-1).event, 'terminal-failure');
assert.equal(payload.failureCategory, 'candidate-check-failed');
```

Also assert that `webrtc.js` emits the following events into the trace at runtime:
`session-start`, `config-loaded`, `socket-connected`, `peer-created`, `offer-created`, `answer-received`, `ice-gathering-state`, `ice-connection-state`, `pc-connection-state`, `selected-candidate-pair`, `first-video-frame`, `zero-fps-window`, `ice-restart`, `full-reconnect`, `terminal-failure`, `policy-violation`.

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
node --test web-client/js/webrtc.test.js
```

Expected: FAIL because `ConnectionTrace` and the new event hooks do not exist yet.

- [ ] **Step 3: Implement the trace helper and wire it into viewer boot**

Add `web-client/js/connection-trace.js` with a small API:

```js
const ConnectionTrace = {
  create(mode, mediaPolicy) { return {}; },
  record(event, data = {}) { return undefined; },
  snapshot() { return {}; },
  buildPayload(extra = {}) { return {}; }
};
```

Wire `viewer.html` to load it before `webrtc.js` and `diagnostic.js`, then have `webrtc.js` call `ConnectionTrace.record(...)` when:
- the socket connects
- `RTCPeerConnection` is created
- ICE gathering / connection state changes
- `selectedCandidatePair` changes
- first video frame arrives
- tunnel or relay policy violations happen

- [ ] **Step 4: Re-run the tests and verify they pass**

Run:

```bash
node --test web-client/js/webrtc.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-client/js/connection-trace.js web-client/viewer.html web-client/js/webrtc.js web-client/js/webrtc.test.js
git commit -m "feat: add viewer connection trace events"
```

---

### Task 2: Viewer 自动上报与补发队列

**Files:**
- Modify: `web-client/js/diagnostic.js`
- Modify: `web-client/js/webrtc.js`
- Test: `web-client/js/diagnostic.test.js`

- [ ] **Step 1: Write failing tests for payload shape and retry behavior**

Add tests that assert:

```js
const payload = Diagnostic.buildConnectionDiagnostic({
  trigger: 'auto-failure',
  reason: 'candidate-check-failed',
});

assert.equal(payload.type, 'connection-diagnostic');
assert.equal(payload.schemaVersion, 2);
assert.equal(Array.isArray(payload.events), true);
assert.equal(Array.isArray(payload.probeResults), true);
assert.equal(payload.redaction.sdp, 'omitted');
assert.equal(payload.redaction.tokens, 'omitted');
```

Add another test that simulates a send failure and checks that the report is stored in `localStorage.wrdPendingDiagnostics`, then replayed after the next socket connection.

- [ ] **Step 2: Run the diagnostic tests and verify they fail**

Run:

```bash
node --test web-client/js/diagnostic.test.js
```

Expected: FAIL because `buildConnectionDiagnostic()` and retry queue behavior are not implemented yet.

- [ ] **Step 3: Implement auto-send, direct upload, and retry queue**

Extend `diagnostic.js` so it:
- reads trace data from `ConnectionTrace`
- sends on terminal failure, policy violation, 10-second media timeout, and manual button click
- uses Socket.IO first
- falls back to `POST /api/diagnostics`
- persists failed payloads in `localStorage.wrdPendingDiagnostics`
- replays at most 2 queued reports when the next socket connection succeeds

Keep the payload redacted: no full SDP, no tokens, no keyboardDebug, no raw input coordinates.

- [ ] **Step 4: Re-run the diagnostic tests and verify they pass**

Run:

```bash
node --test web-client/js/diagnostic.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web-client/js/diagnostic.js web-client/js/webrtc.js web-client/js/diagnostic.test.js
git commit -m "feat: auto send viewer diagnostics with retry"
```

---

### Task 3: Signal Server 诊断接收、脱敏和持久化

**Files:**
- Modify: `signal-server/lib/diagnostic.js`
- Modify: `signal-server/websocket/signaling.js`
- Modify: `signal-server/server.js`
- Test: `signal-server/test/diagnostic.test.js`
- Test: `signal-server/websocket/signaling.test.js`
- Test: `signal-server/test/config.test.js`

- [ ] **Step 1: Write failing tests for schemaVersion 2 diagnostics and HTTP upload**

Add tests that assert the server accepts a payload like:

```js
{
  type: 'connection-diagnostic',
  schemaVersion: 2,
  connectionAttemptId: 'wrd-20260627-abc123',
  failureCategory: 'candidate-check-failed',
  networkProfile: { onLine: true, effectiveType: '4g' },
  probeResults: [{ url: 'stun:stun.l.google.com:19302', status: 'srflx' }],
  events: [{ event: 'terminal-failure', data: { reason: 'candidate-check-failed' } }]
}
```

and that:
- `redactDiagnosticPayload()` preserves `connectionAttemptId`, `failureCategory`, `candidateSummary`, `selectedCandidatePair`, `events`, `pc`, `traceSummary`
- `persistDiagnostic()` writes the full redacted report into `os.tmpdir()/wrd-diag`
- the HTTP endpoint returns the same behavior as Socket.IO ingestion

- [ ] **Step 2: Run the server tests and verify they fail**

Run:

```bash
node --test signal-server/test/diagnostic.test.js signal-server/websocket/signaling.test.js signal-server/test/config.test.js
```

Expected: FAIL because schemaVersion 2 and `/api/diagnostics` are not handled yet.

- [ ] **Step 3: Implement a shared ingestion path**

Update the server so Socket.IO `diagnostic` and HTTP `POST /api/diagnostics` both call the same helper:

```js
handleDiagnosticUpload({ socketId, viewerId, payload, transport });
```

The helper should:
- redact the payload
- persist it only when `WRD_ENABLE_DIAG_PERSIST=1`
- log a single-line `WRD_STUN_FAILURE ...` summary
- keep old schemaVersion 1 compatibility intact

- [ ] **Step 4: Re-run the server tests and verify they pass**

Run:

```bash
node --test signal-server/test/diagnostic.test.js signal-server/websocket/signaling.test.js signal-server/test/config.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add signal-server/lib/diagnostic.js signal-server/websocket/signaling.js signal-server/server.js signal-server/test/diagnostic.test.js signal-server/websocket/signaling.test.js signal-server/test/config.test.js
git commit -m "feat: accept and persist structured diagnostics"
```

---

### Task 4: Host 侧摘要日志和候选计数

**Files:**
- Modify: `python-host/host.py`
- Test: `python-host/test_connection_diagnostics.py`

- [ ] **Step 1: Write failing tests for host summary logging**

Add a test that feeds a schemaVersion 2 diagnostic payload into `on_diagnostic()` and asserts the host emits a summary line containing:

```text
WRD_STUN_FAILURE
connectionAttemptId=
failureCategory=
pc=
ice=
candidate=
```

Also add a test that TURN env present in strict STUN mode triggers:

```text
WRD_POLICY_WARNING turn_ignored_strict_stun
```

- [ ] **Step 2: Run the host tests and verify they fail**

Run:

```bash
pytest -q python-host/test_connection_diagnostics.py
```

Expected: FAIL because the new summary fields are not emitted yet.

- [ ] **Step 3: Implement the host summary and candidate count reporting**

Update `on_diagnostic()` so it logs a one-line summary with:
- `connectionAttemptId`
- `failureCategory`
- `candidateSummary`
- `selectedCandidatePair`
- `pc` and `ice` states

If TURN env is configured while the strict STUN policy is active, log the policy warning and ignore TURN for the default path.

- [ ] **Step 4: Re-run the host tests and verify they pass**

Run:

```bash
pytest -q python-host/test_connection_diagnostics.py
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add python-host/host.py python-host/test_connection_diagnostics.py
git commit -m "feat: add host diagnostic summary logging"
```

---

### Task 5: Docs 和 runbook 同步

**Files:**
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`

- [ ] **Step 1: Update docs to match the new telemetry and mode semantics**

Document:
- Strict STUN is the default automatic path
- TURN / tunnel remain explicit manual modes, not automatic fallbacks
- viewer logs connection attempts automatically
- failed attempts are uploaded to the server with redacted structured events
- the server prints `WRD_STUN_FAILURE` summaries for fast grep-based debugging

- [ ] **Step 2: Run a doc consistency check**

Verify the text no longer claims that no-TURN public origin automatically switches to tunnel, and that the runbook says the tunnel only covers the web entrypoint, not the media path.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/runbook-safe-startup.md docs/需求文档/WebRemoteDesktop-需求文档.md
git commit -m "docs: sync strict stun diagnostics behavior"
```

---

## Self-Review

1. Spec coverage: viewer telemetry, automatic upload, server ingestion/persistence, host summary logging, and docs are each mapped to a task.
2. Placeholder scan: no `TBD`, `TODO`, or vague “handle edge cases” steps remain.
3. Type consistency: the plan uses one diagnostic shape centered on `connectionAttemptId`, `schemaVersion: 2`, `candidateSummary`, `probeResults`, `traceSummary`, and `WRD_STUN_FAILURE`.
4. Residual gap: if the team decides to keep `/api/diagnostics` out of scope, Task 3 can fall back to Socket.IO-only upload without changing the viewer trace design.
