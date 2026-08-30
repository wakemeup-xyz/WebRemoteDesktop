# Viewer Desktop Session State Owner Convergence Design

**状态：** 已确认，待实施
**范围：** Viewer 内部连接、媒体、控制状态的单一 owner 收敛
**明确排除：** 网络模式产品抽象、WebRTC/Socket/Terminal 外部协议、Host adapters、UI 文案重写、真实公网链路运维

## 1. 价值与合理性审查

当前 `web-client/js/webrtc.js` 同时写入 `DesktopSessionState` 和
`DesktopSessionCoordinator`。两者分别维护连接、媒体和控制的相近但不兼容
模型；生产 UI 读取前者，后者仅由 facade 和自身测试使用。短期没有已知行为故障，
但每个连接/媒体/控制事件都存在漏同步和状态分歧风险，且新开发者无法判断哪个
快照是事实来源。

本次收敛的价值是减少一个完整的可变状态图、降低事件迁移回归面，并让
`canInput`、attempt 隔离和媒体首帧门闩拥有一个可审计的 owner。删除未被外部
使用的 coordinator 是合理的，因为它没有第二个真实 adapter，也没有独立产品
能力；保留它只会增加抽象和同步成本。代价是删除已有内部测试 seam，并需要把
其有效行为覆盖迁移到 `DesktopSessionState` 契约测试中。该代价可控，因为两套
状态目前没有对外 API，且迁移可以一次性回滚。

## 2. 目标架构

`DesktopSessionState` 是 Viewer 连接 session 的唯一 snapshot/reducer owner。
`WebRTC` 继续作为公开 facade 和副作用事件 owner，但所有连接、媒体、控制状态
更新只通过以下 API 进入 state：

- `beginAttempt(attemptId, { socket })`
- `applyConnection({ attemptId, state, socket })`
- `applyMedia({ attemptId, event/state, fresh })`
- `applyControl({ attemptId, state, blocked })`
- `snapshot()`

`webrtc.js` 的本地字段（例如 `controlState`、`uiPhase`、`hasPaintedFrame`）仍可
作为协议和 DOM facade 的运行缓存；它们不再被包装成第二个 session snapshot，也
不再由 coordinator 镜像。UI capability 和 ShellGuard 继续读取
`getDesktopSessionSnapshot()`，因此调用方不变。

删除以下重复实现及其生产引用：

- `web-client/js/desktop-session-coordinator.js`
- `web-client/js/desktop-session-coordinator.test.js`
- `viewer.html` 中 coordinator script 标签
- `signal-server/scripts/web-asset-graph.js` 中 coordinator 条目
- `webrtc.js` 中 `sessionCoordinator` 字段、初始化方法和所有 coordinator 调用

不删除或改名 `DesktopSessionState`，不改变其 snapshot 字段和事件语义。

## 3. 事件迁移规则

| 现有 coordinator 事件 | 唯一 owner 的替代调用 |
| --- | --- |
| `transitionConnection({ type: 'signaling' })` | `applyConnection({ state: 'signaling' })`，由 `beginAttempt` 后调用 |
| `beginMedia(attemptId)` | `beginAttempt` 已重置 `media: 'none'`；不再额外调用 |
| `setUiPhase(phase)` | 现有 `setUiPhase` 内的 `DesktopSessionState.apply*` 映射保留 |
| `noteMediaDecoded(count)` | 仅为诊断计数，不进入 session snapshot；删除调用 |
| `noteMediaPainted(meta)` | `applyMedia({ event: 'fresh-frame', fresh: true })` |
| `markMediaStalled(reason)` | `applyMedia({ state: 'stalled' })` |
| `applyControlLease(controlState)` | `applyControl({ state, blocked })` |
| `clearControlLease(reason)` | `applyControl({ state: 'free'/'blocked', blocked })` |

迁移后，每个 attempt 必须继续满足：

1. 旧 attempt 的连接、媒体、控制事件不能改变当前 snapshot。
2. 只有当前 attempt 的 fresh frame 才把媒体置为 `live` / phase `connected`。
3. `canInput` 只有 `control=active`、`media=live`、`socket=online` 同时成立时为 true。
4. 媒体 stalled 或 socket offline 时输入立即 fail-closed。
5. 手动断开和 superseded viewer 仍最终写入 `disconnected` / `offline`。

## 4. 测试与验收

新增或迁移的测试必须证明“单一 owner”而不是只证明文件存在：

- `desktop-session-state.test.js` 保留初始 fail-closed、首帧、旧 attempt 隔离、
  输入三条件测试，并增加控制状态迁移和媒体 stalled 后恢复测试。
- 新增 `desktop-session-state-owner.test.js`，读取 `webrtc.js`、
  `viewer.html` 和 `web-asset-graph.js`，断言生产文本不包含
  `sessionCoordinator`、`DesktopSessionCoordinator`、`initializeSessionCoordinator`、
  `ControlLeaseView`、`MediaPaintGate`、`ConnectionSession`，且资源清单只包含
  `desktop-session-state.js`。
- 运行受影响 Viewer 测试、Signal 全套测试和 web asset build；禁止以真实运行
  尚未执行来替代自动化证据。

## 5. 兼容、回滚与停止条件

- 不改变公开 JS 方法、Socket 事件、WebRTC SDP/ICE、网络模式枚举或认证流程。
- 不新增 npm/Python 依赖。
- 不修改 Host、Signal runtime 行为；Signal 只重新构建静态 Viewer asset。
- 若迁移导致现有 `webrtc.test.js` 连接、媒体、输入或 attempt 测试失败，停止
  扩大范围，优先恢复等价的 `DesktopSessionState` 事件映射。
- 回滚边界为本次提交涉及的 coordinator 删除、facade 引用清理和契约测试；不
  回滚用户已有未跟踪运行产物。

## 6. 完成标准

静态检查显示生产代码只有 `DesktopSessionState` 作为 session snapshot owner；
受影响 Node 测试、Signal 测试和 web build 通过；`git diff --check` 通过。真实
浏览器、双 Viewer、物理输入、公网 tunnel 和睡眠唤醒仍单独标记为 `NOT RUN`，
不得据此宣称运行链路已验收。
