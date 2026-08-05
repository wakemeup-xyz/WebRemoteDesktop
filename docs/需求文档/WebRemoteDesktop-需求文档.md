# Web Remote Desktop 需求文档

## 1. 项目概述

CodeHarness学习助手 是一个基于 WebRTC 的浏览器远程桌面系统。用户通过浏览器访问网页，即可实时查看并操控远程 macOS 主机的桌面。

### 核心特点
- **零客户端安装**：viewer 端只需浏览器
- **低延迟**：基于 WebRTC P2P 传输
- **公网可达**：通过 Cloudflare Tunnel 暴露服务
- **输入同步**：鼠标、键盘实时转发到远程主机

### Viewer 启动性能与可恢复性

- 正式公网入口冷启动 Core Interactive P95 <= 5 秒，热加载 P95 <= 2 秒。
- 点击「开始学习助手」必须立即反馈；到 Signal connected P95 <= 3 秒。
- 点击到首个稳定非黑画面 P95 <= 8 秒；超时必须退出连接中状态并允许重试。
- 任一 bootstrap 依赖不得静默阻塞超过 5 秒。
- Terminal/xterm 按需加载，加载失败不得影响 Desktop。
- 以上公网指标至少使用 20 个新浏览器上下文，以 immutable JSON + SHA-256 验收。

---

## 2. 系统架构

```
+------------------+       Socket.IO       +------------------+
|   Web Client     | <-------------------> |  Signal Server   |
|  (Viewer)        |        (信令)          |   (Node.js)      |
+--------+---------+                       +--------+---------+
         | WebRTC P2P: Video + DataChannel          |
         +----------->+----------------+<-----------+
                     |   Python Host    |
                     | (macOS + aiortc) |
                     +------------------+
```

### 2.1 组件说明

| 组件 | 技术栈 | 职责 |
|------|--------|------|
| web-client | HTML5 + Vanilla JS | 视频播放、输入采集、UI 交互 |
| signal-server | Node.js + Express + Socket.IO | WebRTC 信令、输入兜底转发、静态文件服务、认证 |
| python-host | Python 3 + aiortc + MSS + Quartz | 屏幕捕获、视频编码、输入执行 |

### 2.2 数据流

1. **连接建立**：Viewer 和 Host 通过 Signal Server 交换 SDP offer/answer 和 ICE candidate
2. **视频传输**：Host 捕获屏幕 → aiortc 编码 → WebRTC P2P → Viewer 解码播放
3. **输入传输**：Viewer 采集鼠标/键盘事件 → WebRTC DataChannel → Host 执行 Quartz 输入；Socket.IO 仅作为兜底通道

---

## 3. 功能需求

### 3.1 视频流

- [x] **屏幕捕获**：使用 MSS 库实时捕获 macOS 屏幕
- [x] **视频编码**：aiortc 使用 H.264 VideoToolbox 硬件编码（monkey-patch 替换默认编码器）
- [x] **帧率控制**：默认 30fps，带帧间隔 sleep 控制
- [x] **延迟优化**：浏览器端 `jitterBufferTarget = 0`，编码器 GOP 1 秒、禁用 B 帧
- [x] **Codec 优先级**：Viewer offer 与 Host answer 均优先 H.264，避免回落到 VP8 软件编码
- [x] **WebRTC 统计回传**：Viewer 定时回传 codec / FPS / RTT / jitter buffer / 丢包等指标到 Host 日志
- [x] **单一统计采样器**：每个 PeerConnection 只允许一个 1 秒 WebRTC stats sampler；candidate pair 优先采用 transport 的 `selectedCandidatePairId`，媒体统计使用区间 delta，刷新或断开必须取消 sampler 和 video frame callback
- [x] **真实阶段计时**：Host frame timing 使用 `schemaVersion: 2`，只上报实测 `capturePrepareMs` / `frameConvertMs`；尚未建立真实边界的 `encoderMs` / `rtpSendMs` / `endToEndVideoMs` 必须为 `null`，不得用 track return 或 DataChannel 到达时间冒充
- [x] **网络模式选择**：Viewer 支持本地直连、自动穿透、外网直连、外网中继和隧道中继；自动/外网直连默认遵守 Strict STUN，不自动切媒体中继（失败只提示手动切换，不静默改写模式）
- [x] **TURN 双边统一配置**：支持 `TURN_*` env、`signal-server/.env` 与本机 `WRD_TURN_JSON` / `~/.StockHub/turn.json`（env 覆盖 json）；signal-server 与 python-host 使用同一 fingerprint；Host LaunchAgent 注入 `TURN_*`（`scripts/lib-turn-env.sh`）
- [x] **会话级 Host TURN**：`relay` 会话必须装载 TURN；`auto`/`stun` 在 Strict STUN 下仍可省略 TURN；offer 携带 `networkMode`
- [x] **TURN 选择与自检**：网络面板展示配置来源/fingerprint/Host ready；支持一键「测试 TURN」（配置完整性、Allocate、双边一致性）；诊断 snapshot 含 `turnSelfTest`
- [x] **Strict STUN 自适应降载**：Viewer 根据 FPS、RTT、jitter buffer 和丢包识别弱直连链路，自动降为 540p/15fps、480p/12fps、360p/8fps，并通知 Host 调整采集档位
- [x] **自适应恢复**：连续 10 个良好样本且距离上次档位变化至少 15 秒后只升一级；每次降档必须由两个新的退化样本触发，避免旧统计重复决策和频繁振荡
- [x] **目标帧率采集节奏**：Host 按当前 target FPS 动态调整 MSS 抓屏频率并限制在 60 FPS；survival 8 FPS 档最多按 16 FPS 抓屏，降低无效采集和转换开销
- [x] **主动 ICE 恢复**：直连媒体链路持续 0 FPS 或严重退化时，Viewer 在 Strict STUN 模式下最多主动尝试一次 ICE restart；自动恢复耗尽后明确失败并自动上报诊断。自动恢复有界，但不是唯一后续手段：用户可再手动触发端口搜索
- [x] **按需媒体暂停**：切换 Terminal、页面进入后台或用户手动暂停时，Host 停止屏幕 capture、编码和视频 payload；WebRTC 保留 PeerConnection、ICE 和 DataChannel，tunnel 保留控制连接，Terminal Socket、PTY 和 admin 授权不受影响
- [x] **暂停期健康语义**：暂停和恢复中的预期 0 FPS 不触发质量降档、ICE restart 或自动重连；只有匹配当前 connection attempt（含 tunnel 的 connection-attempt-bind 权威）的恢复 ack 与一帧新渲染画面后才重新启用桌面输入。Terminal/page visibility 的自动 reason 不会覆盖 `manual-pause`
- [x] **手动 STUN 端口搜索**：控制栏「搜索端口」按钮是启动最多 500 轮全量 PeerConnection 重建的**唯一**触发；普通 WebRTC 失败不会自动进入该搜索。启动还要求当前 Viewer 持有 ACTIVE 控制租约；只读/切换中/reset-blocked/媒体暂停时严格无副作用。成功需 selected pair + 连续 3 次解码视频采样；UI 只显示数字 UDP 端口与轮次、不显示 IP；耗尽后不自动切 TURN 或 Socket.IO 媒体 tunnel。端口仍由系统分配（浏览器无本地 ICE UDP 端口选择 API，Host `aiortc` 绑定 0），不保证唯一端口，也不覆盖 Strict STUN 策略
- [x] **网络建议浮窗**：右下角浮窗根据当前模式、候选链路和 0 FPS 状态提示适用场景
- [x] **分辨率切换**：支持 540p / 720p / 1080p / 1440p
- [x] **缩放模式**：自适应(contain) / 填充(cover) / 拉伸(fill)
- [x] **状态显示**：顶部状态栏显示 FPS、延迟、分辨率和候选链路类型

### 3.2 鼠标输入

- [x] **移动**：Pointer Events 转发，坐标映射到远程屏幕
- [x] **点击**：`pointerdown` / `pointerup` 携带 `clickCount`；双击只产生两组 down/up，不额外发送 `dblclick` 动作
- [x] **滚轮**：wheel 事件转发（deltaX/deltaY）
- [x] **坐标映射**：`contain` 去除黑边、`cover` 反算被裁剪源区域、`fill` 直接线性映射
- [x] **多按钮支持**：左键、右键、中键
- [x] **低延迟传输**：鼠标移动优先通过无序、不可重传的 `input-move` WebRTC DataChannel 发送，避免高频移动事件排队
- [x] **拖拽恢复**：pointer capture 保证画面外释放仍可收到；cancel、失焦、隐藏、停用、断线或 Viewer 消失时通过幂等 `mouse/reset` 释放 Host 按钮状态

**约束**：
- 鼠标坐标使用相对比例 (0-1) 传输，Host 根据屏幕分辨率换算为绝对坐标
- 视频内容区域与元素区域可能不一致，前端必须以 `input-geometry.js` 的 object-fit 公式作为唯一坐标真相
- 鼠标移动事件可丢弃，点击、滚轮、键盘事件不可丢弃
- `Input.sendInput()` 只有在 DataChannel/Socket.IO 接受消息或明确丢弃高频 move 时才返回 input ID；没有可用 transport 时返回 `null`，不得进入延迟 pending map
- Host 可兼容接收旧 `dblclick`，但 Viewer 不再产生该动作；Quartz down/up 的 click state 只由 `clickCount` 驱动

### 3.3 键盘输入

- [x] **单键输入**：字母、数字、标点、功能键 F1-F12
- [ ] **组合键真实验收**：Command/Control/Shift/Alt 的 v2 状态机、batch 与 reset barrier 已有自动化覆盖；真实 macOS Quartz、IME 和长按验收仍待 Task12 执行
- [x] **虚拟按钮**：回车、上下左右方向键、复制(Command+C)、粘贴(Command+V)
- [x] **输入记录**：顶部状态栏实时显示发送的按键信息
- [x] **防重复绑定**：`Input.init()` 通过 `_listenersBound` 标志防止重复注册事件监听器
- [ ] **Windows 访问兼容**：Mac / Windows 模式会把 Windows 左右 Ctrl 归一化为对应 Meta；真实浏览器与 Quartz 组合键验收仍待 Task12 执行
- [x] **DataChannel 输入**：键盘和点击优先通过可靠有序 `input` WebRTC DataChannel 发送，Socket.IO 仅用于兜底

**关键技术约束**：
- 前端使用 `KeyboardEvent.code`（物理键位）映射到 macOS keyCode
- Web `keyCode`（ASCII 值）与 macOS `keyCode`（USB HID）不兼容，不可直接使用
- modifier 键（Control/Shift/Alt/Command）自己的 keydown / keyup **不应携带自己的 modifier flag**
- 虚拟按钮发送组合键时，必须发送完整的 4 步序列：modifier down → char down → char up → modifier up
- 键盘事件必须严格有序；不得以统一固定 sleep 取代状态机。只有 Quartz 实测证明需要时，才允许在 Host adapter 为特定 batch 步骤配置有界间隔
- 单字符映射需同时覆盖 lowercase / uppercase / shifted symbols（如 `a` / `A` / `!`）
- 注意：macOS keycode `0`（字母 `a`）在 Python 中为 falsy 值，判断键是否有效时必须使用显式布尔标志，不能直接用 `if not key_code:`
- 输入链路需记录 `transport` 和端到端发送延迟，便于区分 DataChannel 与 Socket.IO 兜底路径
- 桌面输入执行后必须独立返回 `input_ack`：浏览器用本地 pending 计算 `inputRtt`，Host 只回传同机 `hostExecuteMs`；下一帧 timing 只记录 `visualFeedback`，不得再把等待视频帧混入输入 transport RTT

#### 3.3.1 键盘协议、映射与兼容契约

- **映射边界**：物理按键只接受 `KeyboardEvent.code`。Host 当前精确支持 `KeyA-KeyZ`、`Digit0-Digit9`、`F1-F20`、Enter/Escape/Backspace/Tab/Space、方向/导航键、左右 Control/Alt/Shift/Meta、常用 ANSI 标点、`IntlBackslash`/`IntlYen`/`IntlRo`/`Lang1`/`Lang2`/`KanaMode` 及小键盘数字/运算键。`ContextMenu`、`Convert`、`NonConvert` 明确返回 `unsupported-code`；任何未列出的 code 也不得回退为字符猜测。文本输入只使用 `keyboard/text` 的 Unicode adapter，不冒充物理按键。
- **v2 envelope**：`schemaVersion: 2` 的键盘消息必须是 `keyboard/key`、`keyboard/text`、`keyboard/batch` 或 `keyboard/reset`，并带有效 `leaseId`、`leaseEpoch`、严格递增 `seq` 和有界 `inputIds`。`key` 使用 `down/up + code + location + repeat + modifiers + locks`；`batch` 在同一个 Host 串行队列中执行；`reset` 释放该 lease 的全部已按下按键并成为后续输入的确认屏障。
- **控制与认证**：Viewer 与 Host Socket.IO 都声明 `inputProtocolVersion`。v2 Viewer 只能在 Host 同样声明 v2 后获得控制；旧 Host 必须收到/返回 `host-protocol-too-old`，不得降级为无租约输入。direct WebRTC offer 和 tunnel Socket 输入都先经过已认证 Viewer 身份及 desktop-control lease；同一时刻只有一个主 Viewer 可写，第二个 legacy Viewer 只读。`relay-viewer` 只是主 Viewer 的媒体 relay companion，不能取得独立桌面控制权或发送输入。
- **长按与释放**：合法长按不以固定 8 秒阈值强制 keyup；lease heartbeat、Viewer/transport teardown、模式切换、失焦和显式 release 都进入同一 reset 路径。v2 接管 legacy controller 时，Host 必须先完成 `legacy-takeover` reset，再发新 grant。
- **v1 迁移**：`LEGACY_INPUT_COMPAT_ENABLED` 当前在 Signal Server 中固定为 `true`，不是环境变量，禁止用部署配置绕过 v2 约束。legacy direct/tunnel 的首个输入惰性申请同一 lease，只有 lease controller 的输入可转发；Host 的单个 `LegacyInputAdapter` 同时处理 legacy DataChannel 与 Socket 输入，transport 变化必须先应用 `transport-change` reset 再处理新事件。移除该常量的条件是：所有受支持 Viewer 和 Host 都声明 v2、连续发布周期内无 v1 连接、direct/tunnel/relay 的 v2 合约与真实 Host 验收均通过；移除后 v1 必须明确拒绝，不能恢复 env 开关。
- **脱敏与运行剩余项**：日志、ack 和诊断只保留协议版本、lease epoch、seq、动作、transport、payload byte count、input ID hash 与本机耗时，不记录 key/code/text、lease token 或坐标。Task12 之前不把真实 Host/Quartz、长按、IME、ISO/JIS 和公网多 Viewer 运行验证标记为已完成。

> 2026-07-19 键盘专项整改：自动化状态机和协议迁移已覆盖 v2 lease、legacy 单控制者与跨 transport reset；完整真实运行证据和剩余门槛见 `docs/superpowers/reports/2026-07-19-remote-keyboard-mapping-stuck-key-systemic-analysis.md`。

### 3.4 控制栏

- [x] **分辨率设置**：弹出模态框选择分辨率
- [x] **暂停/恢复**：暂停视频播放和输入
- [x] **断开连接**：断开 WebRTC 和 Socket.IO 连接
- [x] **缩放切换**：循环切换 contain/cover/fill
- [x] **显示/隐藏控件**：左上角总控按钮隐藏/显示控制栏和虚拟按钮栏
- [x] **诊断日志**：弹出模态框显示浏览器控制台捕获的日志，可一键发送到服务端；连接失败时自动附带网络环境和链路摘要上送一份诊断
- [x] **刷新画面**：手动断开并重连 WebRTC，用于画面卡顿时快速恢复；会取消进行中的手动端口搜索
- [x] **搜索端口**：仅在 `auto` / `stun`、信令与 Host 在线，且当前 Viewer 为 ACTIVE controller 时可用；点击后变为「停止搜索」，最多 500 轮；状态区展示轮次与 Viewer/Host 数字端口（无 IP）；失去控制立即停止
- [x] **全屏控制**：网页端提供全屏按钮，Esc 使用浏览器原生 Fullscreen API 退出
- [x] **自动重连**：WebRTC ICE / PeerConnection 断开或失败后，Viewer 自动重建连接；自动/外网直连模式先降载和 ICE 恢复，自动恢复耗尽后明确失败，不自动切 TURN 或媒体 tunnel，也**不**自动启动 500 轮端口搜索
- [x] **Host 控制面恢复**：Signal Server 重启后，Host 丢弃旧 Socket.IO client，重新登录获取新的 15 分钟 Host token 并自动注册；不得要求人工重启 Host
- [x] **网络模式**：控制栏提供网络模式按钮，切换后自动重连并更新浮窗说明；切换模式会取消手动端口搜索

### 3.5 Host 本机浮动提示

- [x] **连接提示**：Host 本机右下角显示浮动窗口，展示访问者和在线用户数
- [x] **输入提示**：实时显示接收到的键盘指令
- [x] **动效**：连接和输入提示支持淡入淡出
- [x] **降级运行**：可通过 `WRD_DISABLE_OVERLAY=1` 禁用浮动提示

### 3.6 认证

- [x] **密码登录**：Viewer 通过网页登录，服务端使用 bcrypt 校验输入密码
- [x] **JWT Token**：Viewer 登录后签发 24h token；Host 使用独立接口签发 15m host token
- [x] **Socket.IO 认证**：连接时校验 Bearer token，服务端以 JWT 内的角色为准
- [x] **角色区分**：Viewer 与 Host 使用不同认证入口和不同角色令牌
- [x] **WebRTC 配置鉴权**：`/api/webrtc-config` 需要已登录的 Bearer token 才可访问

### 3.7 Web Terminal

- 说明：本节中 `[x]` 表示当前共享 Terminal 已落地的运行语义；`[ ]` 表示仍保留为后续增强项或独立交付项。

- [x] **Terminal tab**：在现有 Viewer 页面中增加 Terminal tab，用户无需离开当前网页
- [x] **二次授权**：Viewer 登录后，Terminal 需要单独的 admin 二次授权
- [x] **共享授权入口**：完成 Terminal admin 二次授权的浏览器可以接入共享 shell session pool，不把 PTY 绑定到单一浏览器
- [ ] **完整 shell**：Terminal 直接连接本机完整 shell，不限制在项目目录
- [x] **共享会话附着**：多个浏览器可同时附着到同一个共享 Terminal 会话，输入立即作用到同一个 shell
- [ ] **断网重连**：浏览器断网后自动重连到原来的 Terminal，会话和上下文保留
- [x] **浏览器断开不销毁**：关闭 Terminal tab、关闭 Viewer 页面、桌面 `断开连接` 或网络模式切换，都只会断开当前浏览器，不会销毁共享 PTY
- [x] **手动关闭才销毁**：共享 Terminal 会话默认一直保留，直到显式关闭或服务重启
- [x] **资源保护**：会话数超过软阈值时提示；默认硬上限为 8 个 PTY session，达到上限拒绝新建但不影响现有会话。每会话 replay 默认 256 KiB，可配置 idle timeout 回收超时且无人附着的会话
- [x] **环境确定性**：PTY 使用 allowlist 环境和 no-rc interactive shell；PATH 固定包含 Homebrew Python 3.11 libexec，`WRD_TERMINAL_PATH_EXTRA` 仅允许已存在绝对目录，服务密钥和代理/API 凭据不继承
- [x] **PTY 生命周期**：`starting/running/exited/failed/closed` 状态独立于 observer presence；非 running 状态禁止输入和成功 ack，spawn/timeout/exit/close 使用稳定错误码和一次性通知
- [x] **流控与背压**：每 observer 输入 token bucket、64 KiB 单消息限制和 ack 驱动输出队列；慢 observer 单独 detach，replay 保留完整 chunk，其他 observer 与共享 PTY 不受影响
- [x] **有界指标**：admin-only `/api/admin/terminal/metrics` 返回固定计数器、有界 latency p50/p95、transport 分桶和 pool 容量，不包含原始 IO。`WRD_TERMINAL_RECORD_IO=1` 仅开启 metadata 记录
- [x] **传输策略**：默认 WebSocket-only；`WRD_TERMINAL_ALLOW_POLLING=1` 才启用 polling，两个 transport 的延迟样本分开统计
- [x] **同钟延迟指标**：`socketRtt`、`inputAckRtt` 只使用浏览器本地 pending 时钟；`serverProcessMs` 只在 Signal Server 内部相减，不混用浏览器与服务端 wall clock
- [x] **密码安全回显**：首批普通输入只作为隐藏 probe；确认远端 shell 实际回显后才允许后续本地回显。Enter、控制键、alternate-screen、断线和重连均清零 confidence
- [x] **关闭竞态保护**：session 关闭后的迟到 input/resize 返回稳定 `terminal_session_not_found` 并记录脱敏拒绝元数据，不得终止 Signal Server 或影响新 session
- [ ] **开发映射**：开发页应通过受保护的 `https://dev.link.stockhub.wiki` 访问同一套 Terminal 服务；部署细节和代理契约以部署文档为准，更强的运行时隔离仍是后续工作
- [x] **审计日志**：Signal Server 记录 Terminal admin 登录、socket 连接、创建、附着、断开、关闭、拒绝和错误的结构化审计事件
- [ ] **独立实现**：优先使用 `@xterm/xterm` + `node-pty` + Socket.IO 的内嵌方案，不默认引入 WeTTY / ttyd 独立服务

**Terminal 安全约束**：
- Terminal 默认关闭，必须显式开启
- Terminal 使用独立 admin 密码，不复用普通 Viewer 密码
- admin 授权只保存在浏览器 session 内，不默认写入持久 localStorage；已授权浏览器仅获得共享会话的附着权限，不拥有浏览器私有 PTY
- Terminal **默认**不走 STUN / TURN / WebRTC DataChannel，只走 HTTPS / WebSocket（Socket.IO）
- [x] **可选** Terminal 传输 `webrtc-turn`（DataChannel + 与桌面同一 TURN，`node-datachannel` 网关）：须显式选择、可测试；失败必须明确报错，不得静默回退或假装在线
- 不默认记录完整命令和输出内容，避免泄露密钥
- 如果 shell 启动失败、权限不足或资源压力过高，必须明确报错或提示，不允许静默降级

**安全约束**：
- `JWT_SECRET` 必须通过环境变量配置，禁止提交示例占位值或继续依赖仓库内泄露旧值
- Viewer 登录密码读取 `VIEWER_ACCESS_PASSWORD`，兼容回退到 `ACCESS_PASSWORD`
- Host 独立凭据读取 `HOST_SHARED_SECRET`，兼容回退到 `HOST_PASSWORD` / `ACCESS_PASSWORD`
- Input relay 与 diagnostic relay 仅允许 viewer 派生角色发送
- Host 端默认开启 TLS 校验；仅本地开发场景可通过 `WRD_INSECURE_SKIP_TLS_VERIFY=1` 放宽 localhost 校验
- 诊断日志默认不落仓库；若开启 `WRD_ENABLE_DIAG_PERSIST=1`，仅写入系统临时目录并使用脱敏后的内容
- Signal Server 默认记录结构化运行日志；Viewer 诊断、Terminal 审计、Host 摘要应共享稳定的事件包结构和关联 ID
- Terminal 默认只记录结构化审计事件，不记录完整 IO 原文；仅在 `WRD_TERMINAL_RECORD_IO=1` 时允许详细 IO 记录
- Host 默认只记录浏览器诊断摘要；仅在 `WRD_HOST_VERBOSE_DIAGNOSTICS=1` 时允许逐行输出 Viewer 详细日志
- Viewer、Host 和 Signal Server 默认不记录 key、code、文本、鼠标坐标或完整 input payload；只保留 action、transport、payload byte count、input ID hash 和本机耗时。Viewer 控制台与自动诊断日志同样只保留输入元数据
- `inputProtocolVersion`、lease epoch 和 seq 可作为不含秘密的协议诊断元数据记录；lease token、键值、文本和坐标仍必须脱敏
- Host/Signal/Terminal audit file 使用 `WRD_LOG_MAX_BYTES` / `WRD_LOG_BACKUP_COUNT` 轮转，默认 10 MiB / 3 个备份
- `host_event_loop_lag` 只记录有界状态/资源摘要，20ms 为 warning、100ms 为 critical，普通告警按 5 秒聚合

---

## 4. 部署需求

### 4.1 环境变量

| 变量 | 所属组件 | 说明 |
|------|---------|------|
| `JWT_SECRET` | signal-server | JWT 签名密钥 |
| `VIEWER_ACCESS_PASSWORD` | signal-server | Viewer 网页登录密码 |
| `HOST_SHARED_SECRET` | signal-server / python-host | Host 登录 `/api/auth/login/host` 使用的共享密钥 |
| `ACCESS_PASSWORD` | signal-server / python-host | 兼容回退密码，仅用于兼容旧配置，不建议继续作为正式开源配置 |
| `HOST_PASSWORD` | signal-server / python-host | Host 凭据兼容回退项，仅用于旧环境迁移 |
| `PORT` | signal-server | 服务端口，默认 8080 |
| `SERVER_URL` | python-host | Host 连接 Signal Server 的地址，默认 `http://127.0.0.1:8080` |
| `WRD_DISABLE_OVERLAY` | python-host | 设置为 `1` 时禁用 Host 本机浮动提示 |
| `WRD_INSECURE_SKIP_TLS_VERIFY` | python-host | 仅本地开发时允许放宽 localhost 的 TLS 校验 |
| `WRD_ENABLE_DIAG_PERSIST` | signal-server | 设置为 `1` 时把脱敏后的诊断日志写入系统临时目录 |
| `WRD_LOG_LEVEL` | signal-server | 结构化运行日志级别，默认 `info` |
| `WRD_LOG_FORMAT` | signal-server | 结构化运行日志格式，默认 `jsonl` |
| `WRD_LOG_DIR` | signal-server | 可选运行日志目录配置；不改变默认 stdout/stderr 输出语义 |
| `WRD_LOG_MAX_BYTES` | signal-server / python-host | 单个运行日志文件上限，默认 `10485760`（10 MiB） |
| `WRD_LOG_BACKUP_COUNT` | signal-server / python-host | 日志备份数量，默认 `3` |
| `STUN_URLS` | signal-server / python-host | 逗号分隔的 STUN URL，默认使用 Google STUN |
| `TURN_URLS` | signal-server / python-host | 逗号分隔的 TURN/TURNS URL，用于外网中继；须与 Host 一致 |
| `TURN_USERNAME` | signal-server / python-host | TURN 用户名 |
| `TURN_CREDENTIAL` | signal-server / python-host | TURN 密码/凭证 |
| `WRD_TURN_JSON` | signal-server / python-host（注入） | 可选本机 TURN JSON 绝对路径；默认可读 `~/.StockHub/turn.json`；优先级低于已设置的 `TURN_*` |
| `WRD_ENABLE_TERMINAL` | signal-server | 是否启用网页 Terminal，默认 `0` |
| `WRD_TERMINAL_ADMIN_PASSWORD` | signal-server | Terminal 二次授权密码 |
| `WRD_TERMINAL_SHELL` | signal-server | 默认 shell，推荐 `/bin/zsh` |
| `WRD_TERMINAL_CWD` | signal-server | Terminal 默认工作目录 |
| `WRD_TERMINAL_SOFT_WARN_SESSION_COUNT` | signal-server | 会话数软提示阈值，默认 `4` |
| `WRD_TERMINAL_MAX_SESSIONS` | signal-server | PTY session 硬上限，默认 `8` |
| `WRD_TERMINAL_REPLAY_BUFFER_BYTES` | signal-server | 每个 session replay buffer 上限，默认 `262144`（256 KiB） |
| `WRD_TERMINAL_IDLE_TIMEOUT_MS` | signal-server | 会话空闲超时，默认 `0` 表示不自动销毁 |
| `WRD_TERMINAL_STARTUP_TIMEOUT_MS` | signal-server | PTY 启动超时 |
| `WRD_TERMINAL_AUDIT_LOG` | signal-server | 可选 Terminal 独立审计 JSONL 文件路径；为空时仍进入统一运行日志 |
| `WRD_TERMINAL_PATH_EXTRA` | signal-server | 冒号分隔的已存在绝对 PATH 目录；重复、空项和非法路径启动时拒绝 |
| `WRD_TERMINAL_ALLOW_POLLING` | signal-server | 是否允许 Terminal Socket.IO polling fallback，默认 `0` |
| `WRD_TERMINAL_INPUT_BYTES_PER_SECOND` | signal-server | 每 observer 输入 token bucket 速率，默认 `65536` |
| `WRD_TERMINAL_INPUT_BURST_BYTES` | signal-server | 每 observer 输入 burst，默认 `131072` |
| `WRD_TERMINAL_MAX_OBSERVER_QUEUE_BYTES` | signal-server | 每 observer ack 驱动输出队列，默认 `524288` |
| `WRD_TERMINAL_RECORD_IO` | signal-server | 是否记录 metadata（不记录原始命令/输出），默认 `0` |
| `WRD_HOST_VERBOSE_DIAGNOSTICS` | python-host | 是否额外逐行输出 Viewer 诊断日志，默认 `0` |

`LEGACY_INPUT_COMPAT_ENABLED` 是 Signal Server 源码中的迁移常量，不是环境变量；不得在运行配置中添加同名开关。

### 4.2 启动顺序

1. 启动防睡眠服务：`scripts/install-awake-keeper.sh`（一次性安装）或 `scripts/run-awake-keeper.sh`
2. 启动 Signal Server：`node server.js`
3. 启动 Cloudflare Tunnel（暴露 `127.0.0.1:8080`）
4. 启动 Python Host：`python host.py`（使用 `HOST_SHARED_SECRET`，兼容回退到 `HOST_PASSWORD` / `ACCESS_PASSWORD`）
5. 浏览器访问页面，输入 Viewer 密码登录
6. 每次本地服务启动或重启后，运维侧必须从运行配置回报 `VIEWER_ACCESS_PASSWORD` 和 `WRD_TERMINAL_ADMIN_PASSWORD`

默认推荐使用：

```bash
./scripts/start-safe-wrd.sh
```

该脚本只会复用或启动当前仓库自己的 `signal-server`、Host LaunchAgent、safe quick tunnel。

入口口径需要明确区分：

1. 正式公网入口统一使用 `https://link.stockhub.wiki`
2. safe quick tunnel / `trycloudflare` 仅用于调试、临时排障和固定域名不可用时的辅助验证
3. 用户不应保存或依赖临时 quick tunnel URL 作为长期访问地址

其中 Host 的启动语义为：

1. `scripts/start-safe-wrd.sh` 与 `scripts/restart-host.sh` 都会安装并启用 `com.webremotedesktop.host` LaunchAgent
2. LaunchAgent 先运行 `scripts/run-host-launchctl.sh`
3. wrapper 先等待 `signal-server /health` 成功
4. wrapper 再预检 `HOST_SHARED_SECRET` 对 `/api/auth/login/host` 的认证成功
5. 只有上述前置条件都满足，才真正启动 `python-host/host.py`

因此在 signal-server 未就绪或 Host 凭据不正确时，不会再反复拉起 `host.py` 与本机浮窗，只会停留在 wrapper 等待阶段。

若只需要本机访问、不需要公网入口，再改用：

```bash
./scripts/restart-host.sh
```

这条路径同样会重新注册并 kickstart `com.webremotedesktop.host` LaunchAgent；这是当前产品设计的一部分，而不是异常副作用。

停止该安全链路时，使用：`./scripts/stop-safe-wrd.sh`。它只会停止安全启动脚本记录过的 PID，不会清理其他项目进程。
查看该安全链路状态时，使用：`./scripts/status-safe-wrd.sh`。它只读取安全 PID / URL 文件，并检查本地 `8080` 与公网 `/health`；不得调和 PID 文件或从 archive/log 恢复当前 URL。

当前 safe quick tunnel 调试地址会写入：

```bash
/tmp/wrd-safe-current-url.txt
```

由于 trycloudflare quick tunnel 没有稳定性保证，`scripts/run-safe-quicktunnel.sh` 会在检测到 `Unauthorized: Tunnel not found` 时重建 quick tunnel 并更新当前安全地址文件。
同时，`scripts/run-safe-quicktunnel.sh` 是 safe URL 的唯一 publisher：拿到 trycloudflare URL 后，必须先确认 `/health` 返回 2xx 且 JSON `status=ok`，才允许原子写入 `/tmp/wrd-safe-current-url.txt` 与 archive。3xx、404、429、5xx 或错误内容均不可交付。

需要特别说明：地址文件中已经写出 trycloudflare URL，只能说明 `cloudflared` 已拿到一个临时地址，**不能直接视为公网可用**。对外提供前仍应检查：

1. tunnel 进程仍然存活
2. trycloudflare 子域名已经可以解析
3. 该 URL 能返回 HTTP 响应
4. 若 `curl -I -L` 返回 `Could not resolve host` 或 `HTTP 530`，都按“当前 quick tunnel 入口不可交付”处理，不应误判成 `signal-server` 或 Host 的本地故障

若本机同时运行 `/Users/macstudio1/AI/Claude/StockHub`，推荐优先使用 `scripts/run-safe-quicktunnel.sh`。该脚本只写入 `/tmp/wrd-safe-quicktunnel.pid`、`/tmp/wrd-safe-quicktunnel.log`、`/tmp/wrd-safe-current-url.txt`，不会清理其他项目的进程；当 quick tunnel 过期时，也会自动重建并刷新安全地址文件。

若在短生命周期自动化 shell 中执行 safe quick tunnel，后台子进程可能在父 shell 结束后被回收；此时应改为在用户自己的常驻终端中执行，或改用固定域名隧道。

固定域名与开发子域要求：

- 正式入口保持 `https://link.stockhub.wiki -> 127.0.0.1:8080`
- 可选开发入口使用 `https://dev.link.stockhub.wiki -> 127.0.0.1:5173`
- `dev.link.stockhub.wiki` 必须单独受 Cloudflare Access 保护
- `5173` 不是正式入口，也不是启动阻塞依赖；正式服务仍以 `8080` 为唯一主入口
- `dev` 页面对接同一套 `8080` 后端能力，因此当前阶段提供的是入口隔离，不是运行时隔离

### 4.3 目录结构

```
WebRemoteDesktop/
├── launchd/              # macOS LaunchAgent 配置
│   └── com.webremotedesktop.awake.plist
├── scripts/              # 启动和运维脚本
│   ├── install-awake-keeper.sh
│   ├── run-awake-keeper.sh
│   ├── run-host-launchctl.sh
│   └── run-quicktunnel.sh
├── signal-server/       # Node.js 信令服务器
│   ├── server.js
│   ├── routes/auth.js
│   ├── websocket/signaling.js
│   └── .env
├── python-host/         # Python 屏幕捕获 + 输入执行
│   ├── host.py
│   ├── input_handler.py
│   ├── h264_videotoolbox_encoder.py  # H.264 硬件编码器 (monkey-patch)
│   └── requirements.txt
├── web-client/          # 浏览器前端
│   ├── index.html       # 登录页
│   ├── viewer.html      # 控制台
│   ├── css/
│   └── js/
│       ├── auth.js
│       ├── webrtc.js
│       ├── input.js
│       ├── ui.js
│       └── diagnostic.js      # 日志捕获 + 诊断模态框
└── docs/需求文档/
    └── WebRemoteDesktop-需求文档.md
```

---

## 5. 已知限制

- **平台限制**：Host 端仅支持 macOS（依赖 Quartz 和 MSS）
- **编码性能**：已切换为 H.264 VideoToolbox 硬件编码，CPU 占用大幅降低
- **辅助功能权限**：Host 需要 macOS 辅助功能权限才能执行输入
- **浏览器限制**：某些系统级快捷键（如 Command+Tab）无法被浏览器捕获
- **视频延迟**：WebRTC 浏览器端 jitter buffer 默认较大，已通过 `jitterBufferTarget = 0` 优化
- **跨网络访问**：Cloudflare Tunnel 只承载网页和信令，WebRTC 媒体默认仍尝试直连；跨 NAT/防火墙环境需要配置 TURN 并**手动**选择外网中继才能稳定投屏
- **当前部署策略**：正式入口仍是 `link.stockhub.wiki`。公网媒体默认 Strict STUN；自动恢复有界耗尽后明确失败。用户可手动：① 外网中继（TURN，须 Viewer+Host 双边配置）② JPEG tunnel fallback ③ `auto`/`stun` 下「搜索端口」最多 500 轮。固定域名与媒体是否直连/是否走 TURN 无关。TURN 全链路设计见 `docs/superpowers/specs/2026-07-20-turn-integration-design.md`
- **系统分配端口**：浏览器没有选择本地 ICE UDP 端口的 API；Host `aiortc`/`aioice` 绑定端口 `0` 由 OS 分配。手动端口搜索不保证唯一端口，也不能替代可控的 Host UDP 端口范围与路由器转发方案
- **Cloudflare Tunnel**：trycloudflare 临时域名会过期；safe 模式需读取 `/tmp/wrd-safe-current-url.txt` 获取最新地址，旧脚本模式则读取 `/tmp/wrd-current-url.txt`；生产应切换命名隧道和固定域名
- **开发子域**：`dev.link.stockhub.wiki` 只作为可选开发入口；其边缘访问由 Cloudflare Access 单独保护，但默认仍通过 proxy 复用 `8080` 后端能力
- **Terminal 权限**：网页 Terminal 默认关闭；启用后必须使用独立 admin 密码，且同一浏览器会话内的多个 Terminal 共享授权
- **Terminal 会话**：Terminal 是共享 shell session pool。多个浏览器可以同时附着到同一个会话并共享输入；关闭 Viewer 页面、桌面断开连接或切换网络模式都不会销毁 PTY，但服务重启会结束这些内存态共享会话
- **重启语义**：在 safe quick tunnel 仍存活时，单纯重启 `signal-server` / `python-host` 默认复用现有 tunnel，因此公网地址通常不变；只有显式停 tunnel、tunnel 失效重建或切换入口模式时才变化
- **运维约束**：默认不要主动重启 `trycloudflare` / `scripts/run-safe-quicktunnel.sh` / 对应 `cloudflared` 进程；当前有效公网地址以 `/tmp/wrd-safe-current-url.txt` 为准，只有用户明确要求或 tunnel 已失效时才重建
- **可达性校验**：trycloudflare 地址写入文件后，仍需额外校验进程存活、DNS 解析和 `/health` 2xx JSON 内容，不能仅凭“拿到 URL”或“任意 HTTP 响应”判断公网入口成功
- **状态只读**：`status-safe-wrd.sh` 和 service helper 的 status 只检查，不恢复 URL、不调和 PID；URL 只能由 tunnel supervisor 验证后发布
- **自动化环境**：在短生命周期自动化 shell 中启动 quick tunnel 时，后台子进程可能被父 shell 退出连带回收；需要常驻终端或固定域名隧道
- **系统睡眠**：远程桌面依赖实时屏幕采集，Host 必须通过 `caffeinate -dims` 防止系统/显示/磁盘睡眠；手动睡眠、断电、合盖仍可能强制中断

---

## 6. 变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-05-10 | 创建需求文档，汇总当前已实现功能 |
| 2026-05-10 | 修复键盘 `is_modifier` NameError 导致大量按键失效；新增诊断日志对话框和刷新画面按钮；优化视频延迟（jitterBufferTarget=0、GOP 1s）；HOST_PASSWORD 支持默认值 fallback；更新 Cloudflare Tunnel URL |
| 2026-05-11 | 项目网页名称更新为 CodeHarness学习助手；新增 Host 本机浮动提示、全屏按钮、Windows 键盘兼容、WebRTC 自动重连；输入链路改为 WebRTC DataChannel 优先（可靠 `input` + 不可靠 `input-move`），Socket.IO 兜底；新增 Viewer WebRTC stats 回传；新增防睡眠 LaunchAgent（`caffeinate -dims`）；新增 quick tunnel 自恢复并将当前访问地址写入 `/tmp/wrd-current-url.txt` |
| 2026-05-11 | 新增 WebRTC 网络模式选择和右下角网络建议浮窗；Signal Server 提供 `/api/webrtc-config`；Host 与 Viewer 均支持 `STUN_URLS` / `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL`；自动模式可在 TURN 已配置时从直连降级到中继；外网中继模式仅在 TURN 配置完整时启用 |
| 2026-06-02 | 补充公网启动约束：trycloudflare URL 写入文件不等于公网已可用；safe quick tunnel 交付前需验证进程存活、DNS 解析和 HTTP 可达性；短生命周期自动化 shell 中需避免把临时后台进程误判为常驻服务 |
| 2026-06-06 | 同步开源前安全加固现状：Viewer 与 Host 分离认证、`/api/webrtc-config` 需要 Bearer token、TLS 默认校验开启、诊断日志默认不落仓库，仅在显式开启时写入系统临时目录 |
| 2026-06-06 | 明确 safe quick tunnel 重启语义：仅重启本地服务时默认复用现有 quick tunnel，公网地址通常不变；停止 safe 链路或 tunnel 失效重建时地址才变化 |
| 2026-06-14 | 明确 Host 由 `com.webremotedesktop.host` LaunchAgent 托管；`restart-host.sh` / `start-safe-wrd.sh` 会重新注册 LaunchAgent；`run-host-launchctl.sh` 新增 signal-server health 与 host auth 双重预检，避免 Host 在前置条件未满足时反复失败拉起 |
| 2026-07-18 | 完成远程连接与延迟整改：入口健康真相、Pointer 输入契约、媒体 stats/timing v2、自适应恢复、独立桌面 input ack、Terminal 同钟 RTT 与密码安全 echo、session/replay/idle 资源保护、输入日志脱敏与 10 MiB/3 份轮转、named tunnel credentials-file 安全告警及 event-loop lag 上下文 |
| 2026-07-19 | 完成真实普通浏览器验收；修复 Chromium 双击计数、首轮媒体预热/profile 同步、Terminal 关闭后迟到事件崩溃和 Signal 重启后的 Host 过期 token 重连；保留首帧 P50 与公网 Terminal RTT 未达目标的诚实结论 |
| 2026-07-19 | 完成键盘映射与卡键专项审计；确认 Windows Ctrl -> Command、tracked keyup、跨 transport reset、左右 modifier、Host per-key watchdog、fresh tunnel 控制租约和国际键盘映射仍需整改，不再把组合键与 Windows 模式标记为完整验收 |
| 2026-07-19 | 补齐键盘 v1/v2 迁移契约：Host/Viewer 版本能力协商、旧 Host 拒绝 v2 激活、legacy 单 controller 与 transport-change reset；真实 Host/Quartz 运行验收保留至 Task12 |
| 2026-07-20 | 补充手动 STUN 端口搜索：仅按钮触发最多 500 轮全量重建；成功需 selected pair + 连续 3 次解码采样；UI 只显示数字端口；不覆盖 Strict STUN，耗尽不自动 TURN/tunnel；端口仍由系统分配 |
| 2026-07-20 | 立项 TURN 全链路接入：`turn.json`/env 双源、Host 注入与会话级 relay ICE、页面选择与自检、Terminal 默认 Socket.IO + 可选 `webrtc-turn`；设计 `docs/superpowers/specs/2026-07-20-turn-integration-design.md`，计划 `docs/superpowers/plans/2026-07-20-turn-integration-plan.md` |
| 2026-07-20 | 可靠性闭环：reset barrier fail-closed + 1s/2s/4s 有界重试与 reset-blocked；端口搜索租约门禁；媒体暂停端到端（WebRTC sender/capture + tunnel JPEG + Viewer applied phase/输入门禁/健康抑制）；tunnel 自适应分辨率下外层 viewport 稳定 |
| 2026-07-20 | 可靠性闭环 review 整改：ACTIVE controller disconnect 不再 FREE 窗口、媒体绑定 connectionAttemptId、resume 需真实新帧、tunnel Host applied ack（禁 synthetic applied）、Host 媒体 apply 失败 fail-closed、launchctl fixture 修复；真实验收 P95/双 Viewer/Terminal 重新标为 NOT RUN，不以旧 synthetic 结论宣称 PASS |
| 2026-07-21 | 可靠性闭环后续：tunnel connectionAttempt 权威绑定（connectionAttemptSequence）、attempt binding 与 generation progress 拆分、Host fresh-capture false fail-closed、Viewer 有界重试/双 ack/stale frame 硬化；真实验收仍标 NOT RUN/BLOCKED，禁止伪造 PASS |
| 2026-08-01 | 可靠性 review 修复：Host 仅在 applied 成功后推进 media generation；旧 attempt 负 ack 不再消耗当前恢复预算；新 attempt/控制权丢失后输入等待当前画面；tunnel PASS 强制 attempt 不变；双 Viewer 在缺少 Signal/Host 拒绝证据时只标 PARTIAL；runtime 报告增加不可覆盖的时间戳文件与 SHA-256 |
