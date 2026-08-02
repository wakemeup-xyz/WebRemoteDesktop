# 严格单主桌面 Viewer 设计

日期：2026-08-02  
修订：2026-08-02（架构 review 后）

关联：

- Host 单 PeerConnection（新 offer → `reason=new-offer` 拆旧 PC）
- 控制租约：`signal-server/lib/desktop-control-lease.js`
- 双 Viewer 抢 offer 放大 TURN 卡顿（`back-debug.log` 2026-08-01/02）

## 1. Goal

**严格单人桌面：** 任意新的桌面 Viewer（`role=viewer`）在 Signal 登记成功时，**踢掉所有其他桌面 Viewer**（其他浏览器、设备、同浏览器旧标签）。

旧会话必须：

1. **先**收到 `viewer-superseded`（若连接仍在），**再**被服务端强制断开  
2. 进入 **supersede 终态**：禁止一切应用层与 Socket.IO Manager 自动重连  
3. 从 `connections.viewers` 移除；控制租约走既有 `viewerDisconnected`（可能进入 `REVOKING`，非瞬时 FREE）  
4. UI 全屏说明；不依赖 `window.close()`  
5. 不调用 `Auth.logout()`（重新连接无需重新输密码，除非 token 已失效）

Host 桌面媒体在信令层只对应 **一个** `role=viewer` socket。

## 2. Background

| 事实 | 含义 |
|------|------|
| JWT viewer `sub=viewer-password-login` | 全体桌面 viewer 同一主体 → 全局单主正确，不必 per-user key |
| `connections.viewers` 现允许多个 | 本设计改为稳态 0..1 |
| Host 单 PC | 多 viewer 本就不能并行推流 |
| `manualDisconnect` 门闩多条恢复路径 | supersede 必须覆盖 **全部** 恢复入口 |
| socket.io-client 默认 `reconnection: true` | 仅闸 `scheduleReconnect` **不够**；Manager 会自己重连并反踢 |
| `WebRTC.disconnect()` 会 `Auth.logout()` | supersede **禁止**复用完整 `disconnect()` |
| ACTIVE controller disconnect | lease → `REVOKING` reset barrier，新页短期可能 acquire 失败（非 bug） |

## 3. Product Decisions

1. 策略：严格单主（用户已选）。  
2. **权威仅 Signal**；BroadcastChannel 若做只能提示，**不得**本地 disconnect 抢权威。  
3. 新主默认 **只读**；不自动 `control-acquire` / takeover。  
4. v2 桌面路径保证只读默认；legacy 非 v2 offer 若仍自动 requestControl，本设计 **不扩大修复**（Non-Goal：清理 legacy），但单主仍踢连接。  
5. `relay-viewer` / host / terminal admin 不在策略内。  
6. 持密码者后开即赢 = 已知产品/安全语义，写入 Risks，不当作漏洞返工。

## 4. Non-Goals

- 多路桌面 WebRTC、桌面 observer 旁观推流  
- 保证关标签、`window.close()`  
- 按浏览器实例保留第二路  
- 改 Host 编码 / TURN  
- 重写 legacy offer 自动抢控制（可 follow-up）  
- P1 BroadcastChannel（不阻塞 DoD）

## 5. Architecture

```text
new role=viewer socket
  1. connections.viewers.set(id, socket)     // 先占位
  2. supersedeOtherDesktopViewers(socket) // 同步：emit → remove → disconnect
  3. emit connected + control-state 给新 socket only
```

客户端 supersede 终态：

```text
viewer-superseded  (必先于或并列于 transport close)
  → _superseded=true, manualDisconnect=true
  → socket.io.reconnection(false); 取消一切 timer
  → teardown PC/media（不 logout）
  → overlay；禁止 scheduleReconnect / createSignalingSocket 自动路径
user reclaimDesktopSession()  // 仅按钮
  → 清终态 → 显式再连（自己成为新主）
```

## 6. Server

### 6.1 硬顺序（禁止「或紧后」）

```text
viewers.set(incoming)
supersedeOtherDesktopViewers(incoming)   // 必须同步完成
emit('connected', ...) 给 incoming
emit('control-state', ...) 给 incoming
// 此后才允许客户端发 offer（服务端无法等 offer；只能保证自己不先发 connected）
```

现有 `if (viewers.size > 1) clearAllLegacyRelayCompanions`：在 supersede 之后 size 已为 1，可保留或挪到 supersede 循环内；行为可接受（单主后 legacy companion 条件更常成立）。

### 6.2 唯一清理函数 `removeDesktopViewer(socket, reason)`

**禁止**第二套 `applyViewerRemoval` 别名。

```text
function removeDesktopViewer(socket, reason):
  if socket is null: return null
  if connections.viewers.get(socket.id) !== socket:
    return null   // 唯一幂等门闩（兼容 FakeSocket，不依赖 socket.data）
  // 先摘除，防止 re-entry
  connections.viewers.delete(socket.id)
  clearPendingInputs(socket.id)
  mediaActivityProgress.delete(socket.id)
  // pendingOffers 若存在按 viewer 索引一并清
  leaseResult = desktopLease.viewerDisconnected(socket.id)  // 既有 withLeaseExpiry 包装
  clearLegacyRelayCompanion(socket.id, { stop: true })
  legacyRelayOwnerIds.delete(socket.id)
  if legacyControllerViewerId === socket.id: clear it
  if leaseResult.transition: dispatchLeaseEffect(...)
  else: broadcastControlState(reason)
  emitViewerStatus('viewer-disconnected', socket)  // 或带 reason 字段若 API 允许
  socket._wrdRemoved = true  // 可选，辅助 disconnect 短路
  return leaseResult
```

Viewer `disconnect` 处理器：

```text
if connections.viewers.get(socket.id) !== socket and socket._wrdRemoved:
  return  // 已由 supersede 清理
removeDesktopViewer(socket, 'viewer-disconnected')
```

### 6.3 supersedeOtherDesktopViewers(incoming)

```text
for (id, other) of snapshot([...connections.viewers.entries()]):
  if id === incoming.id: continue
  try:
    other.emit('viewer-superseded', {
      reason: 'single-desktop-viewer',
      bySocketId: incoming.id,
      ts: Date.now(),
    })
  catch: ignore
  log [VIEWER] supersede old=id by=incoming.id
  removeDesktopViewer(other, 'viewer-superseded')
  try: other.disconnect(true)  // Socket.IO server kick
  catch: ignore
```

**必须先 emit 再 disconnect**，给尚能收事件的客户端立终态（再靠 transport close 兜底）。

### 6.4 旧客户端 / 丢事件

- 升级客户端：靠 `viewer-superseded` 终态  
- 未升级或丢事件：仍被 `disconnect(true)`；**必须在升级客户端**把「server 主动踢」也当终态——见 §7.5  
- 无法强制未升级客户端不重连；DoD 以 **当前仓库 viewer** 为准。Risks 记录：旧二进制仍可能扰主直到升级。

## 7. Client

### 7.1 禁止复用 `WebRTC.disconnect()`

`disconnect()` 会 `Auth.logout()` 且可能对已死 socket `control-release`。  
`handleViewerSuperseded` 使用 **teardown 子集**：

- 置 `_superseded = true`、`manualDisconnect = true`  
- `socket.io.reconnection(false)`（若 Manager 存在）  
- 清 reconnect/dc/ice/media-resume/port-search 一切 timer  
- PC handlers null + close；input channels null；`stopMediaTelemetry`  
- 本地 `freezeControl`（不 emit release，或 release 失败忽略）  
- `socket.disconnect()` 若仍连  
- **不** `Auth.logout()`  
- `showSupersededUI`

### 7.2 终态门闩（全部恢复入口）

下列路径在 `_superseded === true` 时 **立即 return**：

- `scheduleReconnect`（任何 reason）  
- `refresh` / `createSignalingSocket` 的 **自动**调用（signal disconnect、ICE/PC failed、tunnel signal disconnect、port-search、fresh-frame hard refresh）  
- socket.io `reconnect` / `reconnect_attempt`：在 createSignalingSocket 时 `reconnection: false` 当 `_superseded`，或全局 supersede 后强制关闭 Manager 重连  

**唯一**退出终态：`reclaimDesktopSession()`（用户点击）。

### 7.3 状态机

| 状态 | 含义 | 退出 |
|------|------|------|
| `primary` | 正常主会话或只读观众（唯一 viewer） | supersede 事件 / server kick 识别 |
| `superseded` | 终态；无 socket 或不可用；overlay | 用户 reclaim |
| `reclaiming` | 清旗标，显式 connect | 连上 → primary；失败可回 superseded 或显示错误 |

`reclaimDesktopSession` 最小步骤：

1. 隐藏 overlay  
2. `_superseded=false`；`manualDisconnect=false`  
3. 复位 reconnect 计数（可选）  
4. `createSignalingSocket(true)` 且 **reconnection 按正常会话策略**（连上后仍只要单主）  
5. 走与 init 一致的后续：`beginConnectionAttempt`、非 tunnel 时建 PC/等 host-status——与现网「登录后进桌面」对齐，避免只建 socket 黑屏  

### 7.4 UI

- 文案：`桌面已在其他窗口打开，本页已断开。`  
- 按钮：`在此页重新连接` → `reclaimDesktopSession`  
- 说明：控制权需再次「请求控制」  

### 7.5 Server kick 识别（升级客户端）

若先收到 transport `disconnect` 且 reason 表明 server 踢（如 `io server disconnect`），且当时仍认为自己是桌面会话：进入与 supersede **相同终态**（防丢事件）。  
若先收到 `viewer-superseded`，再 transport close：保持终态，不重连。

### 7.6 控制空窗（预期）

旧 controller 被踢 → lease `REVOKING` → Host reset ack 前，新页 `requestControl` 可能失败。  
UI 保持「请求控制」；用户重试。**禁止**因此自动 takeover。

## 8. 场景表

| 场景 | 期望 |
|------|------|
| 单标签 F5 | 旧断新连；最终 size=1；新页是 primary，无卡死 overlay |
| 两标签 | 后登记为胜；先页 superseded；map size=1 |
| 同时开 | 以完成 `set`+supersede 的为准；最终 1 |
| 旧页 auto-reconnect | 被终态禁止；无互踢环 |
| 用户 reclaim | 本页变新主，对方被踢 |
| Host / relay-viewer | 不受影响 |

## 9. Testing

### Signal

1. A then B → size===1，仅 B；A 收到 `viewer-superseded` 且 disconnect  
2. A ACTIVE controller，B 连 → controller 不是 A；lease 不 ACTIVE 在 A（允许 REVOKING/FREE 按既有）  
3. remove 后再 trigger disconnect → 无二次 dispatchLeaseEffect / 无双份错误状态  
4. host + single viewer + relay-viewer 可共存；第二 viewer 只踢 desktop viewer  
5. **改编/退役** 所有依赖「两主 viewer 同时在线」的旧测试（takeover 改为：单会话内 grant，或先断后连）

### Viewer

1. supersede → manualDisconnect、`_superseded`、reconnection 关、scheduleReconnect 不建 timer  
2. tunnel/signal disconnect 路径在终态下不重连  
3. reclaim 清终态并可再连  
4. 不调用 logout（Auth.token 仍在）  

## 10. Files

| 文件 | 变更 |
|------|------|
| `signal-server/websocket/signaling.js` | removeDesktopViewer + supersede 硬序 |
| `signal-server/websocket/signaling.test.js` | 新用例 + 改写多 viewer 旧测 |
| `web-client/js/webrtc.js` | 终态、门闩、reclaim、socket 选项 |
| `web-client/viewer.html` | overlay |
| `web-client/js/webrtc.test.js` | 客户端用例 |
| 本文 + plan | 文档 |

## 11. Risks

| 风险 | 说明 |
|------|------|
| 持密者互踢 | 产品选择 |
| F5 闪断 | 接受 |
| 控制 REVOKING 空窗 | 接受；重试请求控制 |
| 未升级客户端扰主 | 升级后消失；DoD 不覆盖旧包 |
| Host 短时双 offer | new-offer 覆盖 |

## 12. DoD

1. 第二 desktop viewer 连接后 `viewers.size === 1`  
2. 当前仓库 viewer 被踢后 **不** Manager/app 自动重连  
3. 无互踢死循环（自动化：A 连 B 连，稳定 1；B 保持）  
4. 租约不指向已移除 socket 为 ACTIVE controller  
5. 相关测试 GREEN（含改编后的原多 viewer 测）  
6. 手动两标签：后开可用，先开停在说明页  

## 13. Architecture review resolution

| Review 问题 | 决议 |
|-------------|------|
| 互踢死循环 | 终态 + 关 Manager reconnection + 先 emit 再 kick |
| 顺序模糊 | 硬序 set → supersede → connected |
| 幂等 | map 身份守卫唯一入口 |
| disconnect() logout | 禁止复用；独立 teardown |
| reclaim 不清 | 状态机 §7.3 |
| P1 BC 双杀 | P1 禁止本地 disconnect |
| 旧测双 viewer | plan 强制改编 |
