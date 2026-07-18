# WebRemoteDesktop Reliability and Latency Remediation Design

日期：2026-07-18

## 1. 目标

在不改变当前部署边界的前提下，系统性修复 2026-07-18 诊断报告中发现的入口健康、远程输入、媒体遥测、Terminal 指标、日志安全、资源上限和测试保障问题。

本设计的完成状态必须满足：正确性优先于“看起来更快”，指标必须诚实，长期运行资源有上限，所有修复都能通过稳定接口测试。

## 2. 已确认约束

以下约束是本轮设计输入，不作为待解决问题：

1. 不配置、不部署、不实现 TURN。
2. WebRTC 公网媒体保持 Strict STUN。
3. Strict STUN 失败后明确终止并提示用户手动选择 tunnel，不自动切换媒体 relay。
4. Server 没有公网入站能力。
5. 不引入 VPS、FRP、反向 SSH、Tailscale、Headscale 或客户端软件。
6. Viewer 只使用普通浏览器。
7. `https://link.stockhub.wiki` 继续作为固定公网入口。
8. Cloudflare Tunnel 继续承载页面、API、信令和 Terminal。
9. quick tunnel 只用于 debug/临时排障；JPEG tunnel 只作为用户手动选择的兼容模式。

这些约束意味着：仓库代码不能保证降低当前 Cloudflare/LAX 路径的 `425ms` Terminal RTT。系统必须准确展示这个外部性能上限，并消除自身额外开销和误导指标。

## 3. 被取代的方向

`docs/superpowers/specs/2026-07-11-terminal-direct-wss-design.md` 和对应 plan 依赖公网入站或可控反向代理，不适用于当前部署约束。本设计在当前部署中取代该方向，但不删除历史文档。

## 4. 方案选择

### 方案 A：逐点修补

直接在现有大文件里修复每个问题。短期改动少，但 health、输入、指标和日志规则会继续散落，难以保证长期一致性。

### 方案 B：按深模块分批治理

保留现有 WebRTC、Socket.IO 和 Python Host 协议，在稳定 seam 后建立少量深模块。每个模块有单一真相、纯逻辑测试和薄适配层。该方案兼顾风险、可测试性和长期维护，是本设计采用的方案。

### 方案 C：重写传输协议

同时替换 WebRTC、Socket.IO 或 Terminal transport。该方案超出当前问题边界，会放大回归风险，也无法绕过没有公网入站的事实，因此拒绝。

## 5. 总体架构

本轮建立四个深模块和一个验收层：

1. `PublicEntryHealth`
   - 统一入口“可交付”的业务语义。
   - status 只读，publisher 独占 URL 写入。
2. `RemoteInputController`
   - 统一 pointer 生命周期、object-fit 坐标和 transport 结果。
   - Viewer 与 Host 共享明确的 input action contract。
3. `MediaTelemetry`
   - 统一 WebRTC stats 快照、selected candidate pair、区间指标和回调生命周期。
   - 未测量阶段返回 unavailable，不使用错误名称填充。
4. `TerminalLatencyAndObservability`
   - 统一同一时钟域 RTT、服务端处理、受控乐观回显、输入脱敏和日志轮转。
5. `RuntimeAcceptance`
   - 固化本地/公网/Strict STUN/manual tunnel 的验收矩阵。

模块之间不互相调用内部实现。页面和脚本通过各自接口消费结果，现有事件名和外部操作流程尽量保持兼容。

## 6. PublicEntryHealth

### 6.1 真相源

新增标准库 Python 模块 `scripts/wrd_entry_health.py`，同时提供可导入接口和 JSON CLI：

```python
class EntryHealthResult(TypedDict):
    state: str
    deliverable: bool
    http_status: int | None
    reason: str
    checked_url: str

def check_entry(url: str, *, health_path: str = "/health", timeout: float = 10.0) -> EntryHealthResult:
    ...
```

允许状态：

- `deliverable`
- `dns-unresolved`
- `origin-unreachable`
- `http-invalid`
- `content-invalid`

业务成功必须同时满足：

1. URL 和 DNS 合法。
2. TLS/HTTP 能建立。
3. `<origin>/health` 返回 2xx。
4. JSON body 的 `status` 为 `ok`。

任何 3xx 到未知站点、404、410、429、5xx 或非预期内容都不可交付。

对 `*.trycloudflare.com` 必须保留现有公共 DNS fallback：本机 resolver 失败时可以用公共 DNS 得到候选 IP，并用正确的 TLS SNI/Host 做同一套 `/health` 校验。公共 DNS 只解决解析问题，不能放宽 HTTP status 或内容规则。

### 6.2 所有权

- `scripts/run-safe-quicktunnel.sh` 是 safe URL 唯一 publisher。
- publisher 只有在 `check_entry()` 成功后才能原子写入 `/tmp/wrd-safe-current-url.txt` 和 archive。
- `scripts/status-safe-wrd.sh` 和 `wrd_service.py status` 只读取并检查，绝不创建、恢复、删除或改写 URL 文件。
- status 可报告 archive/log 中存在候选 URL，但不能把候选提升为当前真相。

### 6.3 兼容

Shell 通过 `scripts/check-entry-health.sh` 薄适配器调用 Python CLI。现有三态文字保留为兼容展示，但新增 `http-invalid` 和 `content-invalid`，并输出实际 HTTP status。

## 7. RemoteInputController

### 7.1 Pointer 生命周期

Viewer 改用 Pointer Events：

- `pointerdown` 后调用 `setPointerCapture(pointerId)`。
- `pointerup`、`pointercancel`、window blur、visibility hidden、Input deactivate 和 WebRTC disconnect 都进入同一个 `releasePointer()`。
- release 在本地没有活动按钮时幂等。
- transport 不可用时保留一次 pending reset；下一次可用时先 reset 再接受新输入。

Host 增加 `mouse/reset` action，释放已记录的所有鼠标按钮。Viewer 不依赖“再点一下”恢复。

### 7.2 双击

删除额外 `mouse/dblclick` 生成路径。Viewer 在原有 down/up payload 中携带 `clickCount`，来自 Pointer/Mouse event 的 `detail`。Host 在 Quartz down/up 上设置 click-state 字段。

一次浏览器双击只产生两组 down/up，第二组 `clickCount=2`，不额外生成第三、第四次点击。

### 7.3 坐标

新增纯模块 `web-client/js/input-geometry.js`：

```javascript
mapClientPoint({ clientX, clientY, rect, sourceWidth, sourceHeight, objectFit })
  -> { relX, relY, inside }
```

分别实现 `contain`、`cover` 和 `fill`：

- contain：扣除 letterbox，落在黑边时 `inside=false`。
- cover：计算被裁剪源区域，再映射到完整源坐标。
- fill：按显示矩形直接线性映射。

UI 只负责提供当前 object-fit，不复制公式。

### 7.4 传输结果

`Input.sendInput()` 只在 DataChannel 接受、Socket.IO emit 或明确的 mouse-move backpressure drop 时返回 input ID。无可用 transport 时返回 `null`，不进入 latency pending map，并记录结构化 `input-not-sent` 事件。

## 8. MediaTelemetry

### 8.1 Stats sampler

新增 `web-client/js/webrtc-stats.js`。它是 RTCPeerConnection stats 的唯一解释模块：

```javascript
createWebRtcStatsSampler({ getStats, now, intervalMs })
selectActiveCandidatePair(stats)
deriveIntervalMediaStats(previous, current)
```

规则：

- 每个 PC 最多一个 sampler。
- 默认 1000ms 采样一次。
- 所有消费者读取同一个 snapshot，不自行调用 `pc.getStats()`。
- refresh/disconnect 必须 stop sampler 并取消 video frame callback。
- selected pair 优先使用 transport `selectedCandidatePairId`，再兼容 nominated succeeded pair。
- 丢包、字节、帧和 jitter 使用区间 delta；不使用会话累计平均驱动短期控制。

### 8.2 指标语义

Host timing schema 升级为 v2，只保留真实边界：

- `capturePrepareMs`
- `frameConvertMs`
- `hostInputExecuteMs`

以下字段在没有真实 hook 时为 `null`：

- `encoderMs`
- `rtpSendMs`
- `endToEndVideoMs`

Viewer 独立展示：

- candidate RTT
- interval jitter buffer
- decoded/rendered FPS
- frame paint gap

禁止把 `VideoStreamTrack.recv()` return 前的时间标成 encode 或 packet send。

### 8.3 自适应质量

保留 high/medium/low/survival 四档，增加带迟滞恢复：

- 连续 2 个 degraded 样本降一档。
- critical 连续 2 个样本降到 survival，并最多主动 ICE restart 一次。
- 连续 10 个 good 样本、且上次变档至少 15 秒后升一档。
- 每次只升一档，避免振荡。

Host capture loop 每轮读取当前 target FPS，并以 `min(60, max(targetFps * 2, targetFps + 5))` 作为抓屏频率。survival 8 FPS 时抓屏不超过 16 FPS。

### 8.4 Desktop input acknowledgement

Host 在处理带 `inputIds` 的桌面输入后立即发送独立 `input_ack`。DataChannel 路径直接返回 Viewer，Socket.IO fallback 由 Signal Server 按 `viewerId` 路由回原 Viewer。Viewer 的 `inputRtt` 只使用本地 pending send time，ack 携带同机 `hostExecuteMs`；保留下一帧 timing 的 `visualFeedback` 作为画面可见性指标，不能把它当 transport RTT。

## 9. TerminalLatencyAndObservability

### 9.1 延迟指标

Terminal 页面维护三个独立 series：

- `socketRttMs = clientAckAt - clientSentAt`
- `inputAckRttMs = clientAckAt - localPending.clientSentAt`
- `serverProcessMs = serverSentAt - serverReceivedAt`

浏览器永远不跨机器相减 wall clock。Host 桌面输入也停止输出伪单向 `input_delay`；日志改为 transport 和同机 execute/queue 指标。

### 9.2 安全乐观回显

新增纯状态模块 `web-client/js/terminal-echo-controller.js`：

- 默认 `confidence=false`。
- Enter、控制键、alternate-screen enter、detach 和 reconnect 将 confidence 清零。
- confidence=false 时，第一个普通字符不本地回显，只作为 probe 等待远端 echo。
- 只有远端实际回显该字符后，才在当前输入行开启后续本地回显。
- 远端不回显时保持关闭，因此 password prompt 不显示密码。
- alternate-screen 始终禁用。
- UI/诊断可以展示 echo mode，但不记录字符内容。

### 9.3b Shared Terminal resource ceiling

Session pool 默认最多 8 个 PTY，`WRD_TERMINAL_MAX_SESSIONS` 可配置；达到上限返回稳定 `terminal_session_limit`，不 kill 或影响现有会话。每 session replay 默认 256 KiB（`WRD_TERMINAL_REPLAY_BUFFER_BYTES`），`WRD_TERMINAL_IDLE_TIMEOUT_MS>0` 时自动回收超时且无人附着的 detached session。Pool snapshot 只暴露容量计数和上限，不暴露 shell 内容。

### 9.3 日志安全

- Host 和 Signal Server 默认日志不记录 key、code、文本、鼠标坐标或完整 input payload。
- 只记录 action、transport、input ID hash、payload byte count 和耗时分桶。
- Terminal `WRD_TERMINAL_RECORD_IO=1` 仍是唯一允许记录 Terminal IO 的显式开关。
- structured redactor 作为唯一脱敏实现，Host 使用等价字段策略。

### 9.3c Event-loop lag context

Host 以 1 秒 deadline drift 测量 event-loop lag；20ms 以上为 warning，100ms 以上为 critical。日志只携带 lag 聚合值、媒体档位、PC/ICE 状态、capture/input/relay/task/thread 计数、CPU 秒数、RSS 和 load1 等固定有界字段；普通 warning 至少 5 秒聚合一次，critical 立即发送。不得记录 task 名称、线程栈或输入内容。

### 9.4 日志轮转

Host Python logger 使用 `RotatingFileHandler`：

- 默认单文件 10MiB。
- 默认保留 3 个备份。
- wrapper/LaunchAgent 日志单独写 `/tmp/wrd-host-launch.log`，启动前保留最近 1MiB。
- Host stdout 不再长期 append 到 `back-debug.log`。

Signal Server 继续使用现有 structured logger，并为 file sink 应用相同 size/backup 配置。配置项以 `WRD_LOG_MAX_BYTES`、`WRD_LOG_BACKUP_COUNT` 为真相。

### 9.5 Cloudflare 凭据

正式 named tunnel 只允许 `config.yml + credentials-file` 启动。状态检查发现 `--token` 出现在 argv 时输出安全告警，但本轮代码实施不自动停止或重启现有 cloudflared。

## 10. 测试与运行验收

### 10.1 自动测试

- Entry health：200/JSON ok、404、429、500、DNS failure、timeout、redirect。
- Input：完整双击序列、pointer capture/release、blur/disconnect reset、三种 object-fit 九宫格。
- Media：selected pair、多 candidate、interval delta、sampler lifecycle、50 次 refresh 不累积。
- Adaptive：降档、critical restart、good upshift、cooldown。
- Terminal：跨时钟偏移不影响 RTT、password no-echo、alternate screen、reconnect reset。
- Desktop input：独立 `input_ack`、Host execute 与 visual feedback 分离、Socket fallback 路由。
- Terminal resource：session hard ceiling、replay budget、idle detached-session reap。
- Logging：input payload redaction、rotation、bootstrap child error、event-loop lag context。

### 10.2 运行验收

不主动启动或重启服务。代码完成后由用户明确授权本地 restart，随后执行：

1. local health/status。
2. fixed-domain HTTP/Terminal RTT 对照。
3. 当前 safe URL 必须是 2xx/JSON ok，否则明确 unavailable。
4. 浏览器真实 WebRTC 连接、selected pair、FPS 和 callback count。
5. mouse double-click、drag-out release、cover/fill grid。
6. Terminal normal shell、password prompt、alternate-screen。

Cloudflare RTT 只作为当前外部事实记录，不把未下降视为代码回归；应用新增延迟和错误指标必须满足验收。

## 11. 分批与提交边界

### Batch A：入口健康与运维真相

只包含 EntryHealth、status/publisher、bootstrap test path 和文档。

### Batch B：桌面输入正确性

只包含 Viewer/Host input contract、geometry、pointer lifecycle 和测试。

### Batch C：媒体遥测与长期性能

只包含 sampler、timing schema、candidate selection、adaptive upshift 和 capture pacing。

### Batch D：Terminal、日志与安全

包含同钟指标、安全 echo、输入脱敏、日志轮转、tunnel argv 告警，以及独立桌面 input ack、shared Terminal hard ceiling/idle reap 和 event-loop lag context。

每批必须独立通过自己的 focused tests 和相关全量回归。用户未要求 commit，因此实现阶段不自动提交。

## 12. 完成标准

1. 诊断报告中除“不引入 TURN”和不可控 Cloudflare RTT 外的代码/配置问题都有对应实现或明确运行授权阻塞。
2. `cd signal-server && npm test`、Viewer JS、scripts、Python Host 和 service helper 全部通过。
3. safe status 对 404 不再误报，且 status 不改 URL 文件。
4. 双击、拖拽释放和三种 object-fit 坐标测试通过。
5. 没有跨时钟延迟计算，没有虚假 encode/send 指标。
6. reconnect 不增加 stats sampler 或 frame callback 数量。
7. Terminal password prompt 不本地回显。
8. 默认日志不包含键值/文本/坐标，且文件大小有上限。
9. 文档明确 direct-WSS/VPS/TURN 不属于当前部署方案。
