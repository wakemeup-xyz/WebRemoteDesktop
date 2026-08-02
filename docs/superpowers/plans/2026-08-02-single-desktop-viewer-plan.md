# 严格单主桌面 Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Track steps with `- [ ]`.

**Goal:** 全局最多一个 `role=viewer`；新连接同步 supersede 旧连接；旧页进入终态且不自动重连（含 socket.io Manager）。

**Architecture:** Signal `removeDesktopViewer` 唯一清理；connect 硬序 set→supersede→connected。Viewer `handleViewerSuperseded` 独立 teardown（不 logout），`_superseded` 闸所有恢复路径，`reconnection(false)`。

**Spec:** `docs/superpowers/specs/2026-08-02-single-desktop-viewer-design.md`（review 修订版）

**DoD:** spec §12。

---

## Task 0: 盘点并改编「双主 Viewer」旧测试（先于功能，避免假 GREEN）

**Files:** `signal-server/websocket/signaling.test.js`

- [ ] **Step 1:** 列出所有 `io.connect` 两个 `role: 'viewer'` 且断言二者同时在线 / 同时收事件的用例（takeover、legacy companion、input 路由等）。

- [ ] **Step 2:** 逐个改编策略（写在测试注释里）：
  - **Takeover：** 改为单 viewer 会话内 grant/release，或「A disconnect 完成后再 B connect + acquire」，不再假设 A、B 同时在 `connections.viewers`。
  - **必须两 socket 的：** 一为 viewer、一为 `relay-viewer` 或 host，避免两 desktop viewer。
  - **无法改编的：** 删除或改名为历史文档测试并 skip，附 reason=`single-desktop-viewer-policy`。

- [ ] **Step 3:** 在实现 supersede **之前**跑测试，记录当前基线；实现后必须全绿。

---

## Task 1: Signal `removeDesktopViewer` + supersede

**Files:** `signaling.js`, `signaling.test.js`

- [ ] **Step 1: 可粘贴失败测试**（按现有 FakeSocket harness：`resetConnections` / `makeIo` / `setupSignaling` / `FakeSocket` / `io.connect`）

```js
test('second desktop viewer supersedes the first', () => {
  // resetConnections(); const io = makeIo(); setupSignaling(io);
  // const a = new FakeSocket({ role viewer token }); io.connect(a);
  // const b = new FakeSocket({ role viewer token }); io.connect(b);
  // assert.equal(connections.viewers.size, 1);
  // assert.equal(connections.viewers.has(b.id), true);
  // assert.equal(connections.viewers.has(a.id), false);
  // assert.ok(a.sent.some(e => e[0] === 'viewer-superseded'));
  // assert.equal(a.disconnected, true);
});

test('removeDesktopViewer is idempotent under disconnect after supersede', () => {
  // A connect, B connect (A removed)
  // count broadcastControlState / lease effects if instrumented OR
  // trigger a.disconnect again → viewers.size still 1, no throw
});

test('host and relay-viewer survive desktop supersede', () => {
  // host + relay-viewer + viewerA + viewerB
  // host still connections.host, relay-viewer still in relayViewers, desktop size 1
});
```

实现时把注释换成与文件内现有测试同构的真实代码（复制邻近 test 的 token/connect 写法）。

- [ ] **Step 2: RED**

```bash
node --test signal-server/websocket/signaling.test.js
```

- [ ] **Step 3: 实现硬序与唯一 remove**

```js
function removeDesktopViewer(socket, reason = 'viewer-disconnected') {
  if (!socket) return null;
  if (connections.viewers.get(socket.id) !== socket) return null;
  connections.viewers.delete(socket.id);
  // ... full cleanup mirroring current viewer disconnect body ...
  socket._wrdRemoved = true;
  return leaseResult;
}

function supersedeOtherDesktopViewers(incoming) {
  const others = [...connections.viewers.entries()].filter(([id]) => id !== incoming.id);
  for (const [id, other] of others) {
    try {
      other.emit('viewer-superseded', {
        reason: 'single-desktop-viewer',
        bySocketId: incoming.id,
        ts: Date.now(),
      });
    } catch (_e) {}
    console.log(`[VIEWER] supersede desktop viewer old=${id} by=${incoming.id}`);
    removeDesktopViewer(other, 'viewer-superseded');
    try { other.disconnect(true); } catch (_e) {}
  }
}

// role === 'viewer':
connections.viewers.set(socket.id, socket);
supersedeOtherDesktopViewers(socket);
// ONLY THEN:
socket.emit('connected', { ... });
socket.emit('control-state', { ... });
```

Viewer `disconnect` handler：仅 `removeDesktopViewer(socket, 'viewer-disconnected')`。

- [ ] **Step 4: GREEN** 含 Task 0 改编后的全文件  
- [ ] **Step 5: Commit** `feat(signal): single desktop viewer supersedes all prior viewers`

---

## Task 2: Viewer supersede 终态

**Files:** `webrtc.js`, `viewer.html`, `webrtc.test.js`

- [ ] **Step 1: 测试（断言不可自相矛盾）**

```js
test('viewer-superseded enters terminal state and blocks scheduleReconnect', () => {
  const { WebRTC } = loadWebRTC();
  // stub pc/socket/timers as needed
  WebRTC.handleViewerSuperseded({ reason: 'single-desktop-viewer', bySocketId: 'other' });
  assert.equal(WebRTC.manualDisconnect, true);
  assert.equal(WebRTC._superseded, true);
  assert.equal(WebRTC.reconnectTimer, null);
  // Do NOT wrap scheduleReconnect to increment before early-return
  WebRTC.scheduleReconnect('ice-failed');
  assert.equal(WebRTC.reconnectTimer, null);
  WebRTC.scheduleReconnect('signal-disconnected');
  assert.equal(WebRTC.reconnectTimer, null);
});

test('reclaimDesktopSession clears supersede flags', () => {
  const { WebRTC } = loadWebRTC();
  WebRTC.handleViewerSuperseded({ reason: 'single-desktop-viewer' });
  let started = 0;
  WebRTC.createSignalingSocket = () => { started += 1; };
  WebRTC.reclaimDesktopSession();
  assert.equal(WebRTC._superseded, false);
  assert.equal(WebRTC.manualDisconnect, false);
  assert.equal(started, 1);
});
```

- [ ] **Step 2: 实现**

`createSignalingSocket`：

```js
this.socket = io(url, {
  auth: { ... },
  reconnection: !this._superseded, // normal true; superseded sessions must pass false
  // ...
});
this.socket.on('viewer-superseded', (data) => this.handleViewerSuperseded(data));
this.socket.on('disconnect', (reason) => {
  if (this._superseded) return;
  if (reason === 'io server disconnect') {
    // server kick without event: same terminal state
    this.handleViewerSuperseded({ reason: 'server-kick', bySocketId: null });
    return;
  }
  // existing disconnect handling
});
```

`handleViewerSuperseded`：§7.1 teardown；若 `this.socket?.io?.reconnection` 存在则 `this.socket.io.reconnection(false)`。

`scheduleReconnect` / 自动 `refresh` 入口：`if (this._superseded) return;`

`reclaimDesktopSession`：§7.3。

`viewer.html`：`#viewerSupersededOverlay.hidden` + 按钮。

- [ ] **Step 3: GREEN** `node --test web-client/js/webrtc.test.js`  
- [ ] **Step 4: Commit** `feat(viewer): terminal supersede state without logout or auto-reconnect`

---

## Task 3: 文档与手工验收

- [ ] `docs/project-memory.md` 一行：严格单主桌面 viewer；新连接踢旧  
- [ ] 提交 spec+plan（若未提交）  
- [ ] 手工：两标签，后开为主，先开 overlay；第三标签再踢第二  

```bash
git add docs/superpowers/specs/2026-08-02-single-desktop-viewer-design.md \
  docs/superpowers/plans/2026-08-02-single-desktop-viewer-plan.md \
  docs/project-memory.md
git commit -m "docs(remote): single desktop viewer spec and plan"
```

---

## Author self-review (post adversarial review)

| 原 blocking | 计划修订 |
|-------------|----------|
| 互踢环 / Manager 重连 | Task 2 `reconnection(false)` + 全路径 `_superseded` |
| 顺序模糊 | Task 1 硬序 |
| 幂等 / FakeSocket | map 守卫，不依赖 `socket.data` |
| 双 viewer 旧测 | Task 0 强制改编 |
| 测试自相矛盾 | 不断言 wrap 计数 |
| logout | 禁止走 disconnect() |
| reclaim 过瘦 | §7.3 最小步骤 |

**Architecture：** Signal 权威；lease 单路径；媒体主会话 ≠ 自动控制权；与 host 单替对称。
