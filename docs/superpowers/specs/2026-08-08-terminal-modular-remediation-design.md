# Terminal 模块化拆分与 P0/P1 契约修复设计

**日期：** 2026-08-08  
**状态：** 已复核（设计 v3，待实施）  
**代码基线：** 当前工作树；审查基线见 `docs/superpowers/reports/2026-08-08-terminal-systemic-review.md`  
**关联：**  
- `docs/superpowers/specs/2026-07-07-shared-web-terminal-design.md`  
- `docs/superpowers/specs/2026-07-19-terminal-hardening-design.md`  
- `docs/superpowers/reports/2026-07-19-terminal-hardening-review.md`  
- 工作区已存在但未提交：`web-client/js/shell-guard.js` DOMContentLoaded 竞态修复  

## 1. 目标

在不破坏 shared-terminal 产品语义、admin 二次授权、现有 `terminal:*` 事件与 alias 兼容的前提下：

1. **深度拆分** Terminal 前后端中与正确性相关的边界，使不变量可单测、可审查。  
2. 关闭 2026-08-08 审查中的 **P0 + P1** 缺陷。  
3. 以 **行为锁定优先于搬文件** 为硬门闩，避免「只是挪了代码」的假完成。  
4. **Phase 1（P0）可单独发布**；Phase 2（P1）在同一 design/plan 内紧随，但有独立 DoD。

完成后必须满足：

| ID | 必须为真 |
|----|----------|
| G-01 | Viewer 冷启动后 Terminal tab 可点（ShellGuard 不在 `installCore` 之后再禁用 core controls） |
| G-02 | 同一 `socketId` 的 Socket.IO + `webrtc:${socketId}` observer 在 session detach / socket disconnect 时 **全部** 移除；单独 `webrtc_close` 只移除 bridge |
| G-03 | 进入 PTY 的 cols/rows 只经统一 geometry 边界（10–300 / 5–100）；仅字段缺省可取默认值，显式空值/非法值必须拒绝 |
| G-04 | preferred=webrtc-turn 时：activate 会 rebind；DC 未就绪时输入 **硬拒绝**，绝不静默 `terminal:input` |
| G-05 | attach/close 结果按 `action + sessionId + operationId` 关联并释放 pending，可重试；无关 error 不得误清另一操作 |
| G-06 | 输入路径（xterm + composer）要求 `attached ∧ processStatus==='running'`；失败无乐观回显 |
| G-07 | `WRD_TERMINAL_MAX_IN_FLIGHT_*` 从 env 贯通到 output dispatcher |
| G-08 | PTY cleanup 有信号升级；server shutdown 以有界、可等待、幂等流程收割 terminal sessions，并报告失败摘要 |
| G-09 | bootstrap 仅成功缓存；processStatus→running 后补 fit+resize |

## 2. 范围与非目标

### 2.1 Phase 1 — P0（必须先完成）

| 来源 | 项 |
|------|-----|
| F-0 | ShellGuard deferred `installCore` vs DOMContentLoaded 竞态（工作区已修，本方案首个提交入库） |
| B-01 | 双 observer detach 不全 |
| B-02 | create/attach 绕过尺寸校验 |
| F-01 | TURN 切会话不 rebind / 错误 suppress Socket.IO 输出 |
| F-02 | TURN 未就绪静默回退 Socket.IO 输入 |
| F-03 | `pendingClose` 在 not_attached 等错误下粘死 |
| F-04 | `pendingAttach` 在失败下粘死 |
| F-05 / F-10 | 未附着或非 running 仍可输入 / composer 可点 |

### 2.2 Phase 2 — P1（Phase 1 全绿后）

| 来源 | 项 |
|------|-----|
| B-03 | maxInFlight 配置链路断裂 |
| B-05 | kill 无升级、shutdown 不收割 PTY |
| F-08 | bootstrap 失败被当成成功缓存 |
| F-09 | starting 阶段 fit/resize 丢弃，running 后无补偿 |

### 2.3 明确非目标 / Residual（不写入本轮 DoD）

1. B-04 Admin 密码 constant-time / 接入死代码 bcrypt。  
2. B-06 close 失败 quarantine 策略重做。  
3. B-07 服务端强制 websocket-only。  
4. B-08/B-09 WebRTC metrics allowlist、burst≥单包 配置脚枪（可另开）。  
5. F-11 alt-screen 跨 chunk、F-12 replay mode 重置、深度 UX 打磨。  
6. 不保证杀光 PTY 内全部作业进程组（仅对本 PTY 主进程做信号升级）。  
7. 不改 Cloudflare tunnel / Host / 公网入口；runtime 验收不得重建 tunnel。  
8. 不引入 OS 用户隔离或容器。  
9. 不记录 raw 命令/输出。

### 2.4 已确认产品策略

| 主题 | 决策 |
|------|------|
| TURN 失败 | **硬拒绝不回退**：`preferredTransport==='webrtc-turn'` 且 DC 不可发送时，拒绝输入并提示；禁止隐式 `socket.emit('terminal:input')` |
| 关闭未附着会话 | **清 pending + 提示**；不自动 attach；不放宽服务端「close 需 observer」 |
| 实施方案 | **方案 B · 深度拆分**，但依赖单向、行为测试先于搬文件 |
| 交付 | Phase 1 / Phase 2 分期 DoD；commit 分类禁止混装 |

## 3. 架构

### 3.1 总图

```text
Browser                                 Signal Server
───────                                 ─────────────
TerminalPanel (DOM / xterm 编排)
  ├─ TerminalSessionFsm                 TerminalSessionManager (PTY/session 编排)
  ├─ TerminalInputGate                    ├─ geometry.js          (纯函数)
  ├─ TerminalSocketTransport              ├─ presence.js          (纯 observer 集合操作)
  ├─ TerminalTurnTransport                ├─ lifecycle.js         (扩展 async kill/shutdown)
  ├─ TerminalComposer (既有)              ├─ flow-control.js      (消费 maxInFlight)
  ├─ TerminalEchoController (既有)        ├─ environment.js       (既有)
  └─ TerminalLoader (既有)                ├─ webrtc-gateway.js    (成对清理)
                                          └─ websocket/terminal.js (协议适配)
ShellGuard (viewer 入口，非 terminal 包内)
```

### 3.2 设计原则

1. **服务端是权限与 PTY 真相**；前端是 UI、传输偏好与 pending 状态机。  
2. **事件名与 alias 兼容层保留**在 socket adapter / panel 边界；内部模块只认 canonical 语义一次。  
3. **拆分服务于不变量**，禁止借机重写无关 desktop/WebRTC 媒体路径。  
4. **每个新模块**必须能回答：对外 API 是什么、依赖什么、单测如何证明不变量。  
5. **行为锁定优先于搬文件**：先失败测试，再 extract/fix。

## 4. 后端设计

### 4.1 `geometry.js`（新建）

**职责：** Terminal PTY 几何的唯一规范化入口。

```js
// 契约（示意）
const COLS = { min: 10, max: 300 };
const ROWS = { min: 5, max: 100 };

function normalizeTerminalSize(input, fallback = { cols: 80, rows: 24 })
// 仅字段不存在时使用 fallback；字段存在但为 ''/null/非整数/越界时拒绝
// 返回 { cols, rows }，非法则 throw makeTerminalError('terminal_invalid_size', ...)

function assertTerminalSize(cols, rows) // resize 路径：非法 throw
```

**调用点（必须全部改走此模块）：**

- `session-manager.createSession`  
- `session-manager.attachSession`（presenter re-attach 带 cols/rows 时）  
- `session-manager.resizeSession`  
- `websocket/terminal.js` 的 create/attach/resize 可做早期校验，但 **不能** 作为唯一校验  
- `webrtc-gateway` DC resize 与上者共用同一函数  

**策略：** 越界 **reject**，不静默 clamp——避免「以为 99999 生效」。create 缺省尺寸仍为 80×24；attach 若 cols/rows 均缺省则不 resize，若任一字段出现则要求两者均合法。attach 必须在 `addObserver` 前完成 geometry 校验，避免错误响应后 observer 已被部分附着。

`geometry.js` 内部统一抛 `terminal_invalid_size`；`websocket/terminal.js` 的既有 resize 协议继续映射为 `terminal_resize_out_of_range`，并补齐 `action/sessionId`，以免破坏已存在的客户端错误码契约。WebSocket/DC adapter 可早拒绝，但 manager 仍是最终防线。

### 4.2 `presence.js`（新建）

**职责：** session 上 observers 的附着/分离不变量，不拥有 PTY。

```js
// 示意 API；observer 构造与 dispatcher 接线仍由 manager 拥有
removeObservers(observers, { observerId?, socketId?, clientId? })
// 返回 removed observer descriptors；socketId/clientId 路径删除全部匹配项
hasObserver(observers, { observerId?, socketId?, clientId? })
```

**B-01 修复：**  
`webrtc-gateway` 使用 `observerId = webrtc:${socketId}` 且 `socketId` 与 Socket.IO 相同。今日 `detachObserver` 按 socketId 循环首次匹配即 `break`，留下 WebRTC observer → idle reaper / presence 失真。新 presence **按 socketId 删除全部**。

**副作用归属：** presence 只维护 observer Map 并返回 `removed[]`，不接受 callback/hook，不知道 dispatcher、audit、metrics 或 presenter。`session-manager` 是副作用编排者：对每个 removed observer 调 `outputDispatcher.detach(observerId)`，只记一次 detach 操作指标，随后基于剩余 observers 重新计算 presenter 和 presence。若被删 client 仍有其他 observer，不得误清 presenter。

**清理语义不能合并：** `webrtcGateway.closePeer` / `terminal:webrtc_close` 只按精确 `observerId=webrtc:${socketId}` 删除 WebRTC output bridge，保留 Socket.IO observer；显式 **session detach** 与 socket disconnect 才按 `socketId` 删除该 session 下全部 observer。测试必须同时锁住这两个方向，避免修 B-01 时破坏 transport 切换。

### 4.3 `lifecycle.js`（扩展既有）

保持现有 `PROCESS_STATUS` / `assertProcessWritable` / `transitionProcessState`。

**新增（Phase 2）：**

- `planPtyKillSignals()` → 带等待预算的 `SIGHUP → SIGTERM → SIGKILL` 冻结步骤表  
- `cleanupPtyWithEscalation(pty, { waitForExit, isAlive, steps })` → `Promise<CleanupResult>`；可注入，单测不依赖真进程  
- 不把 OS 进程组保证写入 DoD  

**session-manager `cleanupPty`：** 改为走异步升级辅助；只有已观察到 `onExit` / `isAlive===false` 才能记为 confirmed，`pty.kill()` 未抛错不等于已退出。必须把「已观察到 PTY exit」与「是否向 observer 发过 exit 通知」拆成独立 latch：`exitObserved/exitPromise` 在每次 node-pty `onExit` 最先完成，close 只能抑制通知，不能阻断 cleanup 的退出确认。`closeSession`、idle reaper、quarantine retry 与 websocket close handler 相应改为 async/await；同一 session 的并发 close/retry 共享一个 `cleanupPromise`，不得启动两条信号链。失败继续进入既有 quarantine（本轮不重做 B-06）。

当前 `createSession` 会同步触发 `retryCleanupQuarantine/reapIdleSessions`。异步迁移后不能 fire-and-forget：将 `createSession` 一并改为 async，并在容量判断前 await 两类回收；websocket create handler 与直接调用测试同步迁移。这样保留「先回收空闲/隔离项，再判断 maxSessions」的既有语义。

**shutdown：** `sessionManager.closeAllAsSystem('system:shutdown')` 返回可等待的摘要 `{ closedSessionIds, failures }`。terminal setup 暴露幂等 `async close()`：停止 idle reaper、关闭 WebRTC peers、await 全部 session cleanup；`server.js` 的 graceful shutdown 只调用这一条 owner 路径并设置总超时。失败写审计并进入摘要，不能用 optional chaining/fire-and-forget 假装已收割。

### 4.4 Config 贯通（Phase 2 / B-03）

| 层 | 要求 |
|----|------|
| `lib/terminal/config.js` | 已解析 `maxInFlightChunks/Bytes` — 保持 |
| `lib/config.js` `loadConfig()` | **映射** `terminalMaxInFlightChunks/Bytes` |
| `session-manager` 本地 config 归一化 | 读取上述字段并传入 `TerminalOutputDispatcher` |
| 测试 | env 设为 7 时 dispatcher 窗口为 7，而非默认 32 |

### 4.5 协议与权限（不改语义）

- close 仍需 observer；前端未附着关闭只清 pending + 提示。  
- `clientId = socket.id` 服务端拥有；DC 内 clientId 仅 label。  
- 输入仍 per-observer rate limit；输出背压仍只 detach 慢 observer。

## 5. 前端设计

### 5.1 依赖方向（硬约束）

```text
TerminalPanel (DOM/xterm/composer orchestration)
  ├─ TerminalSessionFsm (single browser session-state owner)
  ├─ TerminalInputGate  (pure decision; reads FSM + selected transport)
  ├─ TerminalSocketTransport ─┐
  └─ TerminalTurnTransport   ──┴─ TerminalInputTransport seam (select exactly one)

TerminalPanel → Composer / Echo / Loader（既有）
```

- **SessionFsm** 是现有 `createTerminalState` 的替代/迁移目标，不得与旧 state 并存为两个真相源；它不知 xterm、不知 RTCPeerConnection 细节。  
- **TurnTransport** 禁止调用 `socket.emit('terminal:input')`。  
- **SocketTransport** 不直接改 sessions 业务规则（可通知 fsm 事件）。  
- **SocketTransport / TurnTransport** 是同一输入传输 seam 的两个 adapter，不得互相调用；选择由 Panel 的 transport selector 完成。  
- **InputGate** 是唯一「是否允许发出输入」决策点（xterm onData 与 composer 共用），返回稳定 reason，且不执行发送/echo/pending 副作用。

### 5.2 `TerminalSessionFsm`

**状态：** 迁移并独占现有 sessions、activeSessionId、attachedSessionIds、processStatus 投影；另持有 pending operations。服务端 snapshot/event 仍是权威，FSM 只保存浏览器投影。

**小接口：** `applySnapshot(snapshot)`、`setActive(sessionId)`、`beginOperation(action, sessionId)`、`applyEvent(event)`，以及只读 `getSession/isAttached/activeSessionId`。Panel 不得直接修改内部 Map/Set。

每个 attach/close 请求生成 `operationId`；adapter 在成功/失败 payload 中回传 `action + sessionId + operationId`。FSM 只结束精确匹配的 pending operation。legacy alias 仍可接收；没有 operationId 的 legacy 响应只在该 session 恰有一个同 action pending 时降级匹配。

关闭事件有两层语义：所有客户端都必须应用服务端广播的 session closed 生命周期结果；只有发起者的 matching operation 才清对应 pending。不得因为 operationId 不匹配而忽略 authoritative close event。

**必须行为：**

| 事件 | 行为 |
|------|------|
| attach 成功 | 加 attached，结束精确匹配的 pendingAttach |
| attach error（含 not_found 等） | 服务端必须回 `action='attach' + sessionId + operationId`；结束匹配 pendingAttach |
| close 成功 / closed 事件 | 清 pendingClose、attached、销毁 term 由 Panel 执行 |
| close error：`terminal_session_not_attached`、`terminal_session_not_found`、以及现有 cleanup failed 码 | 仅结束匹配 pendingClose；not_attached/not_found 提示用户先打开会话 |
| 无关 resize/input/bootstrap error | 不得清 pendingAttach/pendingClose |
| activate | setActive + requestAttach；attach 成功后再通知 TurnTransport.rebind（若 preferred=turn） |

### 5.3 `TerminalTurnTransport`

| API | 语义 |
|-----|------|
| `start()` / `stop(reason)` | PC/DC 生命周期 |
| `rebind(sessionId)` | DC open 时发送 `{t:'bind', sid, preferDcOutput:true}` |
| `canSendInput()` | adapter 自身 readiness：ready ∧ dc.open；不读取 preferred |
| `sendInput(frame)` | 仅 DC；失败抛错/返回 false，**不**回退 |
| `shouldSuppressSocketOutput(sessionId)` | 仅当 preferred=turn ∧ boundSid===sessionId===active ∧ outputReady ∧ dc.open |

**F-01：** activate 先 requestAttach；attach 成功后若 preferred=turn 且 dc open → `rebind`。若该 session 已 attached，activate 可直接 rebind。  
**闷死窗口：** `rebind` 发送前先清 `outputReady/boundSid`；只有收到服务端 `output_bound`（或等价 ack）后才能 suppress Socket.IO 输出。  
**F-02：** Panel/InputGate：若 preferred=turn 且 `!canSendInput()` → 拒绝，status 明确「TURN 未就绪/已断开，未回退 Socket.IO」。

### 5.4 `TerminalSocketTransport`

- 小接口：`start({ token, onEvent, onStatus })`、`stop(reason)`、`sendCommand({ action, ...payload })`，以及输入 seam 所需的 `isReady()/sendInput(frame)`；create/attach/close/resize 由 canonical action 编码，alias 只在 adapter 内去重/兼容。  
- implementation 隐藏 connect/disconnect、bootstrap、Socket.IO event names、alias 去重分发、ping/metrics。  
- **bootstrap：** promise/cache 均按 token 建键；仅 HTTP 成功且策略解析成功后设置成功 token。失败可采用 websocket-only 作为本次连接默认值，但不得缓存为成功；新 token 不得复用旧 token 的 in-flight promise（F-08）。  
- 默认 websocket-only；allowPolling 仅来自 bootstrap。

### 5.5 `TerminalInputGate`

```text
allow = socketConnected
     && sessionId
     && attached.has(sessionId)
     && processStatus === 'running'
     && transportAllows  // turn? canSendInput : true
```

- gate 失败：返回稳定 `{ allowed:false, reason }`；调用方**不**写 pendingInputAcks、**不** optimistic echo。  
- gate 成功后的发送事务：发送前登记 pending（防同步 ack 先到），`sendInput` 抛错/返回 false 时立即删除 pending；只有 adapter 确认已接受发送后才 optimistic echo。此项作为 F-06 的 Phase 1 最小修复。  
- Composer `isComposerReady` 与 Gate 使用同一谓词（外加 draft/ack pending UI）。

### 5.6 `TerminalPanel`

- DOM、xterm 创建/dispose、fit、render tabs、调用 fsm/gate/transports。  
- **F-09（Phase 2）：** 当某 session `processStatus` 从 starting→running（或 attach 完成且 running）时，对 active term `fit` + 发 `terminal:resize`。  
- 桌面 tab 切换不销毁 terminal socket（既有语义）。

### 5.7 ShellGuard

已实现：`DOMContentLoaded` 仅当 `!coreInstalled` 时 `setCoreControlsDisabled(true)`。  
本方案 **Task 0** 提交源码 + 测试 + `build:web` 产物策略按仓库惯例（通常 commit 源文件，dist 由 start/build 生成；若仓库要求 dist 可重建则勿强行提交 dist 垃圾）。

## 6. 测试策略

### 6.1 门闩

1. 每个 P0/P1 缺陷：**先写失败测试**。  
2. extract 类 commit：理想为测试全绿的行为保持重构。  
3. 禁止「先搬文件再补测试」作为唯一路径。

### 6.2 模块单测（最低集）

| 模块 | 关键用例 |
|------|----------|
| geometry | 合法边界；缺省取默认；显式空/partial/999999/-5 reject；attach 拒绝时 observer Map 不变 |
| presence | 两 observer 同 socketId，一次 detach 后 size=0；removed descriptors 驱动 dispatcher 全 detach；presenter 重算正确 |
| lifecycle kill | mock pty：记录信号顺序、exit 确认、并发 close 共用 promise、总超时 |
| maxInFlight | env=7 贯通 config；行为测试证明 dispatcher 同时最多发 7 个未 ack chunk |
| SessionFsm | 只按 action/sessionId/operationId 清 pending；resize/input error 不误清 |
| TurnTransport | attach/activate rebind；rebind 先撤 suppression；收到 output_bound 才恢复；未 open canSend false |
| InputGate | unattached/exited/turn-not-ready 返回 reason；发送异常回滚 pending 且无 echo |
| Socket bootstrap | 失败不锁定 token；成功后同 token 可短路；不同 token 不共用 in-flight promise |
| ShellGuard | 既有：installCore 后 DCL 不禁用；未 install 时 DCL 仍禁用 |
| Panel/集成 | 保留现有 `terminal.test.js` 主路径；新增失败路径 |

### 6.3 运行时

- `node --test`：terminal 相关 + 新模块全绿。  
- `scripts/terminal-runtime-probe.js`：env/python/exited（需用户或 agent 用 admin token，不改 tunnel）。  
- Playwright webtest（复用 ignored artifact `artifacts/terminal-webtest-2026-08-08/terminal_webtest.py` 生成本轮证据；它不是版本化真相）：  
  - Phase 1：可点 Terminal、授权、命令、多会话、关未附着可恢复、exited composer disabled  
  - Phase 2：抽检 resize/bootstrap（本地）

## 7. 交付与 Commit 边界

### 7.1 分类

- `fix(viewer):` ShellGuard  
- `test(terminal):` 行为锁定  
- `refactor(terminal):` 抽取模块（行为不变）  
- `fix(terminal):` 契约修复  
- `docs(terminal):` spec/plan/report  

### 7.2 禁止混入

- 旋转日志、`.playwright-mcp`、无关 viewer bootstrap 实验  
- 未关联的 desktop 媒体大改  

### 7.3 建议切片顺序

0. ShellGuard 入库  
1. geometry + 测试 + manager/ws 接线（B-02）  
2. presence + 测试 + manager/gateway disconnect（B-01）  
3. 前端 InputGate + SessionFsm pending/门闩（F-03/04/05/10）— 可先在 `terminal.js` 内修再 extract，或 extract 时测试已红  
4. TurnTransport rebind + 硬拒绝（F-01/02）  
5. Phase 1 release gate（先证明 G-01…G-06）  
6. SocketTransport 抽取 + Panel 变薄（结构收尾，不阻塞 Phase 1 发布）  
7. Phase 2：maxInFlight、lifecycle kill/shutdown、bootstrap、resize  
8. Docs closure；复用现有 webtest artifact，不默认提交一次性脚本

（Plan 文档将展开为可执行 checkbox 步骤。）

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 深度拆分淹没 bug fix | 分期 DoD；测试先红；refactor/fix 分 commit |
| `terminal.js` 2000 行搬迁回归 | 保留并扩展 `terminal.test.js`；模块测 + 面板测双层 |
| presence 与 outputDispatcher 不同步 | presence 返回完整 removed descriptors；manager 对每项 detach 后统一更新 presenter/presence |
| TURN 硬拒绝伤可用性 | UI 明确提示；用户可手动切回 Socket.IO（既有 select） |
| kill 升级在 node-pty 行为差异 | async 可注入 mock；仅 exit/isAlive 证实退出；总超时与失败摘要 fail-closed |
| 服务未重建 dist | Task 0 后 `npm run build:web`；webtest 前确认 dist 含 shell-guard 修复 |

## 9. Definition of Done

### Phase 1

- [ ] G-01…G-06 有自动化证据  
- [ ] ShellGuard + geometry + presence + 前端 gate/fsm/turn 相关测试通过  
- [ ] 现有 terminal 单测全绿  
- [ ] Playwright：Terminal 可点、命令成功、pending close 可恢复、exited composer disabled  
- [ ] 不改变 `/tmp/wrd-safe-current-url.txt`（若做 runtime）  

### Phase 2

- [ ] G-07…G-09 有自动化证据  
- [ ] maxInFlight / kill / bootstrap / resize 测试通过  
- [ ] shutdown 路径单测证明 await 系统 close、幂等、超时与失败摘要；不得只证明“调用过”  
- [ ] residual 列表仍成立且未假装完成  

## 10. 文档同步

实施结束时更新（Phase 收尾任务）：

- 本 spec 状态 → 已实施  
- `docs/superpowers/reports/2026-08-08-terminal-systemic-review.md` 增加「修复跟踪」节或另写 closure report  
- `signal-server/.env.example` 与 `docs/需求文档/WebRemoteDesktop-需求文档.md` 的 maxInFlight 说明与真实贯通一致  
- 不修改 skill 缓存目录  

## 11. Spec 自检记录

| 检查 | 结果 |
|------|------|
| Placeholder / TBD | 无故意 TBD；residual 已显式列出 |
| 与审查报告一致 | P0/P1 对齐；非目标对齐 |
| 内部一致 | TURN 硬拒绝、精确关联 pending、geometry reject、presence 全删、async shutdown 前后端一致 |
| 分期 | Phase 1/2 DoD 分离 |
| 过度设计 | 未要求拆 spawn/replay/desktop；manager 保留编排 |
| 兼容 | 事件名/alias/shared pool/admin 二次授权保留 |
