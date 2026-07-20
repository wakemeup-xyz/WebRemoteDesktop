# 远程桌面控制与媒体可靠性闭环设计

日期：2026-07-20

代码基线：`6b731a3b0ff20df411b51ccdf4e314db0833e6ab`

关联设计：

- `docs/superpowers/specs/2026-07-19-remote-keyboard-state-reliability-design.md`
- `docs/superpowers/specs/2026-07-19-review-blockers-closure-design.md`
- `docs/superpowers/specs/2026-07-20-manual-stun-port-search-design.md`
- `docs/superpowers/specs/2026-07-19-remote-desktop-media-suspension-design.md`

## 1. 目标与范围

本设计关闭 committed-history review 中尚未闭环的三个实现缺陷，并在代码闭环后完成真实运行验收：

1. 所有控制租约 transition 在 Host reset 失败、拒绝、超时或 ack 丢失时保持 fail-closed，不允许未知 Host 输入状态下重新发放租约。
2. 手动 STUN 端口搜索只允许当前 `ACTIVE` controller 启动，不得从只读 Viewer 隐式请求或接管控制租约。
3. 完成媒体暂停的 Viewer、Signal、Host、WebRTC、tunnel、输入、健康判断和可观测性链路，真正停止采集、编码和视频 payload。
4. 三项代码整改完成后，分别补齐双 Viewer、普通浏览器键盘、WebRTC/tunnel 媒体暂停及 tunnel 输入运行证据。

部署约束保持不变：没有 TURN、不引入 VPS、不要求 Viewer 客户端、不重建或重启 Cloudflare tunnel。域名和 quick tunnel 只承载网页/信令/tunnel fallback，不改变 WebRTC 媒体可达性事实。

## 2. 当前事实

### 2.1 Reset barrier fail-open

`DesktopControlLease.rejectTransition()` 当前会清空 pending transition 并进入 `FREE`。这意味着 Host 明确报告 reset 失败后，Signal 仍允许下一次 `control-acquire`。

此外，首次 grant 的 `GRANTING` transition timeout 也会进入 `FREE`。如果 Host 已经执行 reset/transition，但 ack 在网络中丢失，Signal 无法判断 Host 当前绑定；直接回到 `FREE` 同样不是安全结论。

### 2.2 端口搜索隐式接管

`startPortSearch()` 当前验证 mode、Socket 和 Host online，但不验证 active lease。它随后调用 `refresh()`，而 `createOffer()` 在无 lease 时调用 `requestControl()`；只读 Viewer 因此可能通过“搜索端口”按钮隐式发起 takeover。

### 2.3 媒体暂停只完成 intent 层

当前已提交：

- `MediaActivityController` 原因集合与 generation；
- Page Visibility/Page Lifecycle adapter；
- Terminal/manual-pause 写入原因。

当前未完成：

- `applyMediaActivity()` 不执行任何副作用；
- Signal 没有 media-activity contract；
- Host 不暂停 RTP sender 和 capture thread；
- tunnel 没有接入统一暂停语义；
- 输入、统计、弱网恢复和 UI 没有消费 suspended/resuming 状态。

因此暂停按钮目前只改变文案，不暂停画面、输入、采集、编码或传输。

## 3. 方案选择

### 方案 A：在现有函数上继续补条件

分别给 `rejectTransition()`、`startPortSearch()` 和 `applyMediaActivity()` 加条件。改动少，但 barrier 恢复、租约 UI、媒体 sender、capture、health、tunnel 和诊断仍散落在页面级 glue 中，容易再次产生重复真相。拒绝。

### 方案 B：保留既有深模块，补齐缺失 adapter 与恢复状态机

继续以 `DesktopControlLease`、`StunPortSearchController`、`MediaActivityController` 为三个真相源；Signal、Viewer、Host 只做各自 adapter。每个状态变化都有 generation/epoch、确认和明确的恢复路径。采用。

### 方案 C：重写为统一远程会话状态机

把租约、媒体、网络搜索、Terminal 和输入合成一个全局 session actor。长期可能减少跨模块协调，但变更面过大，会同时重写已经稳定的输入 v2、Terminal 和网络恢复路径，当前风险不可接受。拒绝。

## 4. 总体架构与真相源

```text
DesktopControlLease (Signal)
  owns controller authority + transition barrier
       |
       +--> Viewer control UI / input authorization
       +--> Host keyboard binding/reset
       +--> port-search permission gate

MediaActivityController (Viewer)
  owns active/suspended reasons + generation
       |
       +--> WebRTC media adapter --> Signal --> Host sender/capture
       +--> tunnel adapter -------> relay-stream-control
       +--> input adapter --------> Input active/reset
       +--> health/UI/diagnostics

StunPortSearchController (Viewer)
  owns search attempt/status/ports
       |
       +--> may run only while DesktopControlLease says this Viewer is ACTIVE
```

核心不变量：

1. 控制 authority 只来自 Signal 的 `DesktopControlLease`。
2. 媒体需求只来自 Viewer 的 `MediaActivityController.snapshot()`。
3. 端口搜索只拥有搜索进度，绝不拥有或请求控制权。
4. Host 执行结果未知时按未完成处理，不按成功或安全释放处理。
5. 任何旧 epoch、旧 generation、旧 connectionAttemptId 或旧 Viewer 事件都不能修改当前 Host 状态。

## 5. Reset barrier fail-closed

### 5.1 状态语义

```text
FREE -> GRANTING -> ACTIVE -> REVOKING -> FREE
           |                    ^
           +-- uncertain -------+
ACTIVE -> takeover/reset ------>+
```

- `FREE`：Host 已确认没有旧输入绑定，或 Host 已断开并由连接生命周期完成无条件 reset。
- `GRANTING`：正在为候选 Viewer 建立绑定；任何拒绝或 timeout 都转入 reset-only `REVOKING`。
- `ACTIVE`：唯一 active lease 可写。
- `REVOKING`：无 Viewer 可写；等待 Host 对 reset-only transition 的 `applied` ack。

### 5.2 Rejected/timeout 收敛规则

`DesktopControlLease` 新增单一方法：

```javascript
failTransition({ leaseEpoch, reason }) -> effect
```

规则：

1. stale epoch 返回 `stale-transition`，不改变状态。
2. 当前 transition 若已经是 reset-only（`pending.viewerId === null`），保持同一 `REVOKING` barrier，不进入 `FREE`。
3. 当前 transition 若携带候选 Viewer，丢弃候选 leaseId，生成更新 epoch 的 reset-only transition，并进入 `REVOKING`。
4. `transition-timeout`、`reset-failed`、`execution-failed` 和非法 Host ack 都走该方法。
5. 只有 reset-only transition 的 `applied` ack 才进入 `FREE`。
6. Host disconnect/replacement 是例外：Signal 清理旧 Host connection；新 Host 注册前必须执行本机无条件 reset，因此可以释放 Signal 内的旧 barrier。

### 5.3 重试与阻塞

Signal 为当前 reset-only transition 使用有界重发：1 秒、2 秒、4 秒三次，重发同一个 epoch 和无 token payload，不生成多个并行 barrier。三次后保持 `REVOKING` 并广播 `reset-blocked`；不继续定时风暴。

解除方式只有：

- Host 对当前 reset-only epoch 回 `applied`；
- Host socket 断开并重新注册，Host 启动路径完成 unconditional reset；
- 运维显式重启本地 Host。

Viewer 在 `REVOKING/reset-blocked` 下只读，控制按钮显示“等待 Host 输入复位”，不得循环发送 acquire。

### 5.4 Ack 合约

Host ack 仅允许：

```json
{
  "leaseEpoch": 43,
  "status": "applied | rejected",
  "reason": "reset-failed"
}
```

未知 status 按 rejected 处理。reason 进入枚举化诊断，不能包含原始按键、文本、leaseId 或异常正文。

## 6. 端口搜索租约门禁

### 6.1 启动条件

`canStartPortSearch()` 必须同时满足：

- mode 为 `auto` 或 `stun`；
- Signal Socket connected；
- Host online；
- `controlState.state === 'ACTIVE'`；
- `controlState.controller === true`；
- leaseId/leaseEpoch 合法；
- 当前没有 manual disconnect 或 media suspended intent。

不满足时 `startPortSearch()` 返回 `false`，不创建 controller、不清 timer、不关闭 PC、不调用 `refresh()`、不发 `control-acquire`。

### 6.2 控制丢失

搜索期间发生以下事件立即 `stopPortSearch('control-lost')`：

- `control-state.controller=false`；
- `control-revoked`；
- heartbeat rejected；
- transition state 进入 `GRANTING/REVOKING/FREE`；
- Signal disconnect、Host offline、mode switch、manual disconnect。

旧 search generation 的 timer、candidate、answer 和 stats 回调必须无效。搜索停止不释放控制租约；控制租约丢失由既有 control lifecycle 负责。

### 6.3 UI 与文档

- ACTIVE controller：按钮按网络前置条件启用。
- 只读 Viewer：按钮 disabled，title/状态提示“请先请求控制”。
- transition：提示“控制权正在切换”。
- 搜索中失去控制：显示“端口搜索已停止：控制权已失效”。

诊断 snapshot 继续只包含当前轮端口和唯一端口计数，不包含 IP、lease token 或历史无界数组。

## 7. 媒体暂停完整链路

### 7.1 Viewer 状态

沿用既有 snapshot：

```javascript
{
  state: 'active' | 'suspended',
  reasons: ['manual-pause', 'terminal-active', 'page-hidden', 'page-hide'],
  generation: 12,
}
```

Viewer adapter 增加派生 phase：

```text
active -> suspending -> suspended -> resuming -> active
```

phase 是 transport/application 状态，不写回 controller，不形成第二套用户意图。controller snapshot 仍是 desired state 真相。

### 7.2 WebRTC 路径

Viewer 发：

```json
{
  "schemaVersion": 1,
  "state": "suspended",
  "reasons": ["terminal-active"],
  "generation": 12,
  "connectionAttemptId": "wrd-..."
}
```

消息必须携带当前 active lease envelope。Signal 同时校验：

- active Viewer socket；
- active lease；
- state/reasons/generation/connectionAttemptId；
- 同 Viewer + attempt 下 generation 严格递增。

### 7.2.1 connectionAttempt 权威绑定

`connectionAttemptId` 是 opaque 标识；权威再绑定必须携带单调 `connectionAttemptSequence`（epoch），不能只相信随机 attemptId。

Signal 对每个 active Viewer socket 维护：

```text
{ connectionAttemptId, connectionAttemptSequence, generation }
```

规则：

1. Direct WebRTC offer 与显式 `connection-attempt-bind` 汇入同一权威状态。
2. 只有 exact ACTIVE lease + 当前 Viewer socket 可绑定。
3. 同 sequence + 同 attempt 幂等；旧 sequence、或同 sequence 不同 attempt 拒绝。
4. 新 attempt 绑定后 generation 从 0 起算。
5. Host applied:false 只释放“该 generation 的一次有界重试资格”，**不得**删除 attempt 绑定。
6. 旧 attempt 的 control / ack / frame / 重试不能修改新 attempt。
7. takeover、disconnect、旧 Socket 均不能重新绑定。

Tunnel 不发送 SDP offer，因此必须发送 `connection-attempt-bind`；不得依赖虚构 offer，也不得用 `relay-stream-control` 本身发明 attempt 权威。

Signal 附加可信 viewerId 后转发。Host 只接受 current viewer、current connectionAttemptId 和更新 generation。

Host suspended 顺序：

1. freeze media state；
2. `video_sender.replaceTrack(None)`；
3. `ScreenCaptureTrack.set_suspended(true)`；
4. 清空 capture buffer，允许最多一个在途帧；
5. 回 `media-activity-ack { applied:true }`。

Host active 顺序：

1. 唤醒 capture condition；
2. 等待一次新 capture；`wait_for_fresh_capture()` 返回值不是 True 时必须 fail-closed（`applied:false`、`state:suspended`、reason 如 `fresh-capture-timeout`），不得恢复 sender/input 或宣告 active；
3. 仅在 capture 成功后 `replaceTrack(screen_track)`；
4. 经集中 adapter 尽力请求 H.264 keyframe；
5. 回 ack，包含 `keyframeRequested`，不暴露私有对象。

aiortc 私有 keyframe hook 必须隔离在 `python-host/aiortc_media_sender.py`；版本不支持时返回 false，由 Viewer 的一次 resume timeout fallback 处理。

### 7.3 Tunnel 路径

tunnel 先通过 `connection-attempt-bind` 建立 attempt 权威，再复用带 active lease 的 `relay-stream-control`：

- suspended：`enabled:false`，Host 停止 capture/encode/send；清理 pending object URL 和 FPS sampler，但保留主 Viewer Socket 和 Terminal。
- active：用当前 resolution/profile 发 `enabled:true`；收到并渲染新 relay frame 后 phase 回到 active。
- Host 对 tunnel media control 回 `relay-stream-control-ack`（Signal 可 dual-route 到 `media-activity-ack`）；Viewer 必须对同一 Host ack 只应用一次。

同一状态变化不得同时发送 `media-activity-change` 和 tunnel relay control。networkMode 是 adapter 选择真相。

#### Tunnel 渲染尺寸稳定性

Host 的 tunnel adaptive profile 可以根据 ack latency、in-flight frame 和链路状态在 960×540、640×360、480×270 等源分辨率间切换。这是降低编码、传输和排队延迟的必要能力，不应为了 Viewer 视觉稳定而关闭。

Viewer 必须在布局边界隔离源分辨率变化：`remoteVideo` 和 `relayImage` 共用一个尺寸稳定的 media container，渲染元素填满容器并用当前 `contain/cover/fill` 策略决定内容映射，不能让图片 intrinsic width/height 反向改变容器。源帧尺寸变化不得触发 offer、refresh、reconnect 或输入坐标系重建；鼠标映射继续以实际 rendered content rect 为准。

### 7.4 输入与搜索

suspending 立即：

- `Input.setActive(false)`；
- release pointer；
- 触发 keyboard reset barrier；
- 停止 active port search。

恢复输入必须同时满足：desired state active、phase active、桌面 tab 可见、当前 Viewer 持有 active lease、没有 manual disconnect。返回桌面但仍有 `manual-pause` 时不得恢复输入。

### 7.5 健康判断与恢复

suspended/resuming 期间：

- 不累计 `noMediaTicks`；
- 不把 0 FPS 送入 LinkQualityController；
- 不降档、不 ICE restart、不 scheduleReconnect；
- 停止 rendered-frame sampler；
- 保留 PC/ICE/candidate/DataChannel 基础状态。

恢复时重置 stats delta baseline、noMediaTicks 和短期质量计数。WebRTC 在 1500ms、tunnel 在 2500ms 内没有首个 rendered frame 时，同一 generation 只允许一次 `refresh()`；refresh 仍不得改变用户选择的网络模式。

## 8. 多 Viewer 所有权

当前架构只支持一个 active controller 和一个 Host media PeerConnection。媒体 activity 是 controller-scoped，不是所有观察者投票：

- 只读 Viewer 不能暂停 Host capture；
- 只读 Viewer 不能启动端口搜索；
- takeover 完成后旧 Viewer 的 media/search generation 全部失效；
- 新 controller 获取 lease 后从自己的 current media snapshot 同步一次；
- 未来如果支持多 Viewer 同时观看，才引入 viewer-demand 聚合，本轮不做。

## 9. 旧媒体分支的集成边界

现有 `feat/remote-desktop-media-suspension` 分支分叉自较旧基线，包含可参考的 sender/capture/Signal/Viewer 实现，但也会删除或回退后续键盘 v2、Terminal composer、STUN 端口搜索和文档。

因此实施时禁止整体 merge 或批量 cherry-pick。只允许在当前基线上按 TDD 重新落地媒体职责；复用代码前逐文件对照当前接口，保留当前租约、输入 v2、Terminal 和 diagnostics 合约。

## 10. 可观测性

新增/收紧事件：

- Signal：`control_transition_failed_closed`、`control_reset_retry`、`control_reset_blocked`。
- Viewer：`port_search_rejected_no_lease`、`port_search_stopped_control_lost`。
- Viewer/Signal/Host：`media_activity_requested`、`media_activity_forwarded`、`host_media_suspended`、`host_media_resumed`、`media_resume_timeout`。

只记录 epoch/generation、枚举 reason、state、attemptId、PC 状态、captureSeq、pressed count 和 modifier mask；不记录 leaseId、按键、文本、密码、SDP、candidate IP 或 Terminal IO。

## 11. 测试策略

### 11.1 自动化

1. Signal lease：rejected、grant timeout、reset timeout、lost ack、late ack、Host reconnect、retry boundedness。
2. Viewer port search：no lease、readonly、transition、control lost、stale timer/candidate/stats。
3. Media controller/adapters：reason composition、phase、ack、attempt/generation ownership。
4. Signal media routing：schema、lease、trusted viewerId、generation、directed ack。
5. Host：sender detach/attach、capture condition、shutdown wake、stale viewer/attempt/generation。
6. Health/input：suspended 0 FPS 不恢复、resume baseline、input disable/enable gates。
7. Tunnel：stop/resume、首帧、旧 Viewer 不能停止当前 relay。
8. Tunnel viewport：不同 adaptive source resolution 下外层渲染尺寸、scale mode 和 pointer geometry 保持稳定。

### 11.2 真实运行验收

运行验收分四层，不互相冒充：

1. Playwright 双 Viewer：控制排他、显式 takeover、readonly port-search gate、旧 Viewer 事件失效。
2. 普通 Chrome + 真实 Host：WebRTC/tunnel 首帧、非黑画面、FPS/jitter、pause captureSeq/payload、resume P95。
3. 普通浏览器键盘：组合键、左右 modifier、tracked keyup、长按、双击与拖拽释放、Terminal 密码输入与 alternate-screen。
4. 实体键盘/系统保留快捷键：只有实际硬件和人工可见结果才能标记通过；Playwright synthetic events 只作为协议证据。

如果 quick tunnel URL 不可达，只把公网 tunnel 会话标记为环境阻断；不得自动重建 tunnel。可用本地 `127.0.0.1:8080` 验证 tunnel media adapter，但不能把本地结果写成公网可达证明。

## 12. 验收门槛

- 任意 reset rejected/timeout 后，新 acquire 均保持 blocked，直到当前 reset applied 或 Host 重连 reset。
- 只读 Viewer 点击或调用 port search 不产生 `control-acquire`、PC close、refresh 或 timer。
- suspended 15 秒内 Host captureSeq 增量为 0，允许切换时最多一个在途帧。
- WebRTC 视频 RTP payload bytes 暂停期间不增长；ICE/DTLS/RTCP 保活不计入。
- tunnel 暂停期间没有新 `relay-frame`，Host 不执行新 JPEG encode。
- tunnel 源分辨率切换不改变 Viewer 外层 viewport，不触发 offer/reconnect，且鼠标坐标映射保持正确。
- WebRTC 恢复首帧 P95 不超过 1500ms；tunnel 不超过 2500ms。
- 暂停期间没有 quality degrade、ICE restart、media-stalled 或 reconnect。
- 双 Viewer 下始终只有一个 active writer；旧 Viewer 的 keyboard/mouse/command/media/search 写操作全部失败。
- K-01 至 K-13 只有在对应自动化和真实运行案例都通过后才改为已闭环。

## 13. 文档与提交边界

实施完成后更新：

- `docs/需求文档/WebRemoteDesktop-需求文档.md`；
- `README.md`；
- `docs/runbook-safe-startup.md` 中只读诊断/验收命令，不改变 tunnel 生命周期；
- `docs/superpowers/reports/2026-07-19-remote-keyboard-runtime-acceptance.md`；
- 新增统一运行验收报告。

实现按四个逻辑 slice；执行计划可为了 TDD、审查和回滚安全进一步拆成更窄 commit：

1. reset barrier fail-closed；
2. port search active-lease gate；
3. media suspension end-to-end；
4. runtime evidence/docs closure。

不得提交 `.env`、密码、日志、URL 文件、`.agents/skills` 缓存、临时截图、Playwright trace 或其他 Agent 的冲突内容。

## 14. 非目标

- TURN/VPS/Viewer 客户端。
- 重启、重建或旋转 Cloudflare tunnel。
- 固定或指定浏览器/aiortc UDP 端口。
- 多 Viewer 同时观看/多路媒体广播。
- 重写完整输入协议、Terminal 或网络模式状态机。
- 用低 FPS profile 冒充媒体暂停。
- 用 synthetic keyboard event 冒充实体键盘和系统保留快捷键验收。
