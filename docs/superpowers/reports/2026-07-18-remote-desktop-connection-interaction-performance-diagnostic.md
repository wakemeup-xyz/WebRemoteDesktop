# WebRemoteDesktop 远程桌面连接、交互与性能诊断报告

日期：2026-07-18
仓库：`/Users/macstudio1/AI/Claude/WebRemoteDesktop`
诊断方式：只读运行态检查、当前工作树审计、自动化测试、非破坏性浏览器验证
状态：诊断与代码整改完成；新代码运行态验收待本地服务重启授权

## 1. 诊断口径

本报告把证据分为四类：

- **当前实测**：本次诊断期间在当前机器上取得的命令、HTTP、进程、日志、指标或浏览器证据。
- **当前代码事实**：当前工作树实现。工作树在诊断开始前已有大量未提交改动，因此这些结论不等同于仅针对 `HEAD`。
- **历史样本**：仓库内已有报告中的历史数据，只用于趋势对比。
- **未验证**：由于认证、外部网络或非破坏性边界而没有取得当前样本。

第 1-12 节记录诊断快照：该阶段不重启 Signal Server、Host 或 Cloudflare tunnel，不修改产品代码，也不变更当前网络入口。随后完成的代码整改和最终验证单独记录在第 13 节，避免把整改后的事实回写成诊断当时已经具备。

## 2. 当前环境与基线

### 2.1 主机环境

| 项目 | 当前值 | 证据类型 |
|---|---|---|
| 操作系统 | macOS 13.7.6, x86_64 | 当前实测 |
| CPU | Intel Core i7-9750H 2.60GHz | 当前实测 |
| 内存 | 32 GiB | 当前实测 |
| 运行时长 | 34 天 5 小时 | 当前实测 |
| 系统负载 | 3.30 / 3.35 / 3.18 | 当前实测 |
| 防空闲睡眠 | 当前存在 `PreventUserIdleSystemSleep`，但不是仓库 `caffeinate` 进程提供 | 当前实测 |

### 2.2 仓库状态

- 当前分支：`feat/single-public-entry-manual-fallback`。
- 当前 `HEAD`：`c0334ee feat: correlate browser diagnostics with session ids`。
- 诊断开始前工作树已有 21 个受跟踪文件发生变化，合计约 `+1046/-134`，并已有多份未跟踪代码和文档。
- 关键未提交变化覆盖 `python-host/host.py`、`web-client/js/webrtc.js`、`web-client/js/terminal.js`、`signal-server/websocket/terminal.js` 和认证/诊断模块。这意味着必须以当前文件内容和当前运行进程分别取证，不能默认运行进程已加载全部工作树修改。

### 2.3 本地服务基线

2026-07-18 19:28:01 +08:00 的只读状态结果：

| 组件 | 当前状态 | 证据类型 |
|---|---|---|
| Signal Server | PID 55750，监听 `*:8080` | 当前实测 |
| 本地 `/health` | 正常 | 当前实测 |
| Python Host | PID 55784，进程存活 | 当前实测 |
| `/api/status` Host 状态 | `hostOnline: true` | 当前实测 |
| safe quick-tunnel supervisor | 进程存在 | 当前实测 |
| safe quick-tunnel cloudflared | 进程存在 | 当前实测 |
| `/tmp/wrd-safe-current-url.txt` | 初始缺失；运行状态脚本后被脚本恢复为历史 URL | 当前实测 |
| fixed-domain cloudflared | 进程存在 | 当前实测 |

### 2.4 基线异常

#### P1：safe 状态检查把 404 地址恢复并标记为可达

初始 `wrd_service.py status` 返回 `safe_url: ""`、`safe_url_reachable: false`，同时 safe quick-tunnel supervisor 和 `cloudflared` 进程存在。随后运行 `scripts/status-safe-wrd.sh` 时，脚本的 `recover_safe_url_file()` 从 archive/log 中取出历史 URL，只用 `curl -I -L` 的进程退出码判断可达，随后重建 `/tmp/wrd-safe-current-url.txt`。

该地址的 12 次 GET 全部返回 HTTP 404；quick-tunnel metrics 也显示累计 `47,701` 个请求全部是 404、成功响应为 0。脚本仍输出 `safe url reachability: ok`。因此这个“status”命令并非纯只读，而且其健康判断把任何可建立 HTTP 连接的 4xx 响应当成可交付入口。

影响：自动化和人工排障会得到明确的假阳性；失效 URL 会被重新写回唯一真相文件；后续调用方可能持续向坏入口重试。状态检查应把恢复候选先按预期页面或 `/health` 的 2xx 响应校验，只有通过后才能写回 URL 文件。

#### P1：Cloudflare named-tunnel 凭据通过进程参数暴露

当前 named-tunnel 进程把认证 token 放在命令行参数中。任何有权限查看该进程参数的本机主体都可能读取该凭据。本报告不记录 token 内容。

影响：这是独立于性能的入口安全风险；凭据泄露后可能被用于启动未授权 connector。应轮换现有 token，并改用不通过进程参数暴露秘密的凭据加载方式。

## 3. 当前入口可达性与公网延迟

### 3.1 测量结果

每个入口连续请求 12 次。表中的 P50 为总请求时长中位数，长尾为本批次最大值。

| 入口 | HTTP 结果 | P50 | 批次长尾 | 结论 |
|---|---:|---:|---:|---|
| 本地 `127.0.0.1:8080/health` | 12/12 为 200 | `1.43ms` | `17.84ms` | 本地 Signal Server 响应正常 |
| 固定域名 `/` | 12/12 为 200 | `860ms` | `1,510ms` | 可用，但公网入口首字节很慢且抖动大 |
| 固定域名 `/health` | 200 | `861ms` | 单样本 | 与静态页面相同量级，慢点在公网/tunnel 路径 |
| 固定域名 `/api/status` | 200 | `904ms` | 单样本 | Host 在线，但公网控制面响应慢 |
| safe quick tunnel `/` | 12/12 为 404 | `1,101ms` | `2,293ms` | 当前不可交付；状态脚本误报为可达 |

本地 `/api/status` 当前返回 `hostOnline: true`、`viewerCount: 0`、`relayViewerCount: 0`。运行服务在取样时没有 Viewer 会话，不存在并发 Viewer 负载导致上述 HTTP 延迟的证据。

### 3.2 固定域名慢的当前根因证据

named-tunnel 当前有 4 条 HA connector，全部落在美国洛杉矶边缘：`lax01`、`lax08`、`lax09`、`lax01`。4 条 QUIC connector 的平滑 RTT 分别为 `203ms`、`184ms`、`210ms`、`182ms`。

固定域名样本的 TCP connect P50 约 `70ms`、TLS P50 约 `149ms`，但总时延 P50 约 `860ms`。这说明慢点不只是浏览器到就近 Cloudflare 边缘的 TLS 握手，Cloudflare 到本机 connector 的跨太平洋路径和应用往返占据主要成本。当前 metrics 已累计 50 次 tunnel 注册失败和 35 次成功，说明 connector 还存在明显的历史重连/注册波动。

### 3.3 quick tunnel 当前状态

quick tunnel 只有 1 条 HA 连接，使用 HTTP/2，当前落在 `lax10`。12 次样本 TCP connect P50 约 `191ms`、TLS P50 约 `420ms`、总时延 P50 约 `1,101ms`，且全部为 404。

这条 quick tunnel 既比固定域名更慢，也没有成功转发内容。按运行规范，本次诊断没有重启或重建它。

### 3.4 当前配置边界

对 `.env` 只检查“是否配置”，不读取或记录凭据值：

- `TURN_URLS`、`TURN_USERNAME`、`TURN_CREDENTIAL` 均未配置。
- `STUN_URLS` 未显式配置，运行时依赖代码默认 STUN 列表。
- Web Terminal 已开启。
- 诊断持久化、Host verbose diagnostics 和 Terminal IO 记录均关闭。

因此公网桌面媒体没有 TURN 兜底。外网 Viewer 要么通过 STUN 建立真实 WebRTC 直连，要么由用户手动切换到高延迟的 tunnel JPEG relay；固定域名只保证网页和信令可达，不能保证媒体直连成功。

## 4. 桌面连接、媒体与恢复链路

### 4.1 当前实现路径

Viewer 登录后读取 `/api/webrtc-config`，按网络模式构造 `RTCPeerConnection`：

- `lan`：不配置 ICE server。
- `stun`：只使用 STUN。
- `auto`：STUN 加已配置的 TURN；当前没有 TURN，所以实际是 Strict STUN。
- `relay`：强制 `iceTransportPolicy: relay`；当前配置会进入“TURN 不可用”状态。
- `tunnel`：关闭 WebRTC，改走 Socket.IO JPEG frame relay。

输入 DataChannel 在 offer 前创建；普通直连使用 trickle ICE，TURN relay 才额外等待最多 8 秒 ICE gathering。ICE/PC 进入 disconnected 后有 5 秒观察期，失败时最多先做一次 ICE restart，然后完整 refresh。没有 TURN 时不会自动切换 tunnel，而是明确失败并提示用户手动选择，这与当前 Strict STUN 需求一致。

### 4.2 正向能力

- Viewer 记录本地/远端 candidate 类型、地址族、协议和 RTT，并能把失败摘要关联到 connection attempt。
- 视频优先 H.264，Host 运行日志确认 aiortc H.264 encoder 已替换为 VideoToolbox。
- Host 屏幕处理在独立单线程 executor 中执行，屏幕抓取也在后台线程中进行，空闲时 Signal Server 和 Host 当前 CPU 都接近 0%。
- Viewer 依据 FPS、RTT、jitter 和丢包做档位降级；媒体停滞时最多触发一次主动 ICE restart。
- 输入使用独立 DataChannel，不依赖 Socket.IO 信令 RTT；鼠标移动另用无序、不可重传通道。

### 4.3 发现的问题

#### P1：端到端视频延迟面板的阶段名称和时间边界不真实

`python-host/host.py:811-929` 在 `VideoStreamTrack.recv()` 内完成屏幕数组处理和 `av.VideoFrame` 构造，随后把 `t3` 标成 `encodeEnd`、把 return 之前的 `t4` 标成 `packetSend`。真正的 H.264 VideoToolbox 编码、RTP packetization 和网络发送发生在 `recv()` 返回之后，代码没有在这些真实边界打点。

`python-host/host.py:931-965` 又通过可靠 input DataChannel 单独发送 timing JSON。`web-client/js/latency-monitor.js:73-113` 把 timing JSON 到达 Viewer 的时刻减去伪 `packetSend`，显示成“Network”。该值包含未测量的 H.264 编码和 DataChannel 自身传输，而且 timing 消息没有与浏览器实际渲染的视频帧关联。

影响：面板中的 Capture/Encode/Network 不能用于定位真实的视频端到端瓶颈；尤其“Encode”基本只是 frame conversion，“Network”也不是媒体网络时延。当前系统可以观察 WebRTC RTT、FPS、jitter buffer 和丢包，但不能准确回答“某一帧从屏幕变化到浏览器显示用了多久”。

#### P2：浏览器统计采样过密，并会在重连后叠加

每次 PC 连接成功时，`web-client/js/webrtc.js:771-780` 都注册一个递归 `requestVideoFrameCallback`，但 refresh/disconnect 没有保存 callback ID 或调用 `cancelVideoFrameCallback`。每次重连都会再增加一条永久帧回调链。

每个渲染帧回调都会触发 `LatencyMonitor._estimatePlayoutBuffer()`；每个 Host `frame_timing` 消息也再触发一次。`web-client/js/latency-monitor.js:133-163` 的每次估算都会完整调用 `pc.getStats()`。以 20 FPS 计算，首次连接约 40 次 `getStats()`/秒，重连后按帧回调链数量继续增长，另外还有 `WebRTC.startStats()` 的周期采样。

影响：长时间使用或反复刷新后，Viewer 主线程、WebRTC stats 枚举和垃圾回收开销会无上限增加，反过来损害画面平滑度并污染 jitter/延迟数据。

#### P2：候选对展示不保证是浏览器实际选中的 candidate pair

`web-client/js/webrtc.js:1512-1541` 遍历所有 `state === "succeeded"` 的 candidate-pair，并让最后一个匹配项覆盖前面的值；没有优先使用 transport report 的 `selectedCandidatePairId`，也没有检查 nominated/selected 标志。

影响：存在多个成功候选对或 ICE 切换时，页面和诊断上报可能显示错误的 host/srflx/relay 类型、地址和 RTT，进而把直连、TURN 或 IPv4/IPv6 根因判断带偏。

#### P2：自适应降载不会自动恢复画质

`web-client/js/link-quality-controller.js:63-85` 在连续两个差样本后逐级降档，critical 时直接到 survival；良好样本只会清零计数并保持当前档位，没有任何升档条件。一次瞬时高 RTT 或停帧可能让会话长期停留在 360p/8 FPS，直到重新连接。

影响：它能降低弱网压力，但不是完整的自适应码率/清晰度控制。用户在网络恢复后仍会持续看到低清晰度和低帧率。

#### P2：媒体档位降 FPS 后，后台屏幕抓取仍固定约 60 FPS

`python-host/host.py:759-777` 在 capture thread 启动时一次性计算 `_min_interval = 1 / max(target_fps * 3, 60)`。初始目标 20 FPS 时是 60 FPS；`set_target_fps()` 只更新 WebRTC track 的 `_frame_interval`，不更新 capture loop 的间隔。

影响：降到 15/12/8 FPS 只能减少输出帧，MSS 仍以约 60 FPS 抓取并覆盖 buffer，持续占用 CPU、内存带宽和 WindowServer 资源。弱网降载没有同步降低采集端成本。

#### P3：运行日志存在事件循环阻塞，但缺少归因上下文

当前 Host 进程启动后记录过 `24–142ms` 的 event-loop lag warning。取样时没有 Viewer、Host CPU 接近 0%，日志也没有记录同一时间窗的任务/线程/GC/系统负载，无法归因到屏幕处理、网络、日志或系统调度。

### 4.4 tunnel relay 的已有性能证据

当前没有 Viewer，无法取得本次实时 tunnel frame 样本。2026-07-12 的历史日志显示旧实现曾出现：

- 1280x720 JPEG 编码约 `54–150ms/帧`。
- 实际 relay FPS 多数只有 `1.3–5.8`。
- 多个连续窗口 `acked=0`，说明客户端消费/ack 严重落后。
- 同期 Socket.IO 输入日志显示表面 `input_delay` 为 `241–604ms`，但该字段混用了 Viewer/Host 时钟，只能说明存在高延迟现象，不能作为可信单向测量；Quartz 实际执行为 `0.3–2.6ms`。

当前工作树已增加 relay backpressure 和 profile downshift，但没有本次实时 Viewer 样本证明新逻辑已经把 tunnel 模式提升到可交互水平。即使该逻辑生效，当前 fixed-domain 公网 P50 已约 860ms，JPEG relay 仍只能作为兼容兜底，不能作为“低延迟远程桌面”主路径。

## 5. 鼠标、键盘与交互链路

### 5.1 当前实现路径

- 鼠标移动由 `requestAnimationFrame` 合并到最多约 60Hz，优先走无序、`maxRetransmits: 0` 的 `input-move` DataChannel；buffer 超过 4KiB 时主动丢弃新 move。
- 点击、滚轮、键盘和命令优先走可靠有序 `input` DataChannel；buffer 超过 512KiB 或通道未打开时退回共享 Signal Socket.IO。
- Host 对所有输入做类型、坐标和当前 Viewer 校验，再通过单一 async lock 和单线程 executor 串行执行 Quartz 事件。
- 键盘有本地按下状态、8 秒 stuck-key watchdog、页面失焦/隐藏释放和显式 reset；专项测试覆盖重复按键、修饰键、reset 去重、滚轮和锁竞争。

### 5.2 专项测试结果

- `node --test web-client/js/input.test.js web-client/js/webrtc.test.js`：34/34 通过。
- `python -m pytest python-host/test_input_handler.py python-host/test_latency_timing.py -q`：9/9 通过，另有 1 个 MSS API deprecation warning。

测试证明现有单元行为没有回归，但没有覆盖下面的浏览器事件组合和实际视觉反馈。

### 5.3 发现的问题

#### P1：浏览器双击会在 Host 生成两次完整双击

`web-client/js/input.js:639-659` 会对浏览器双击过程中的两轮 mousedown/mouseup 分别发送事件；同文件 `151-167` 又在 `dblclick` 事件上额外发送 `mouse/dblclick`。Host 收到 `dblclick` 后，`python-host/input_handler.py:479-500` 再人工生成两轮 down/up。

影响：一次用户双击会先完成浏览器自然产生的两次 click，再额外执行一个双击，即总计四击。文件、窗口、按钮或列表项可能被打开/触发两次。当前前后端测试均没有覆盖完整 DOM 双击序列。

#### P1：拖拽在画面外释放时可能让 Host 鼠标按钮永久保持按下

mouse up 只绑定在 video/relay image 元素自身（`web-client/js/input.js:651-659`），没有 window/document 级 mouseup、pointer capture、mouseleave/cancel 恢复，也没有类似 keyboard reset 的 mouse-button reset。Host 的 `_pressed_mouse_button` 只在收到 `up` 时清空。

影响：用户按住按钮拖出画面后释放、浏览器失焦、连接中断或切换 tab，都可能丢失 up，Host 后续 move 会继续生成 dragged 事件。恢复通常需要再次发送鼠标事件或人工操作 Host。

#### P1：Cover/Fill 显示模式的远程坐标映射错误

`web-client/js/input.js:296-325` 永远按“保持宽高比并 letterbox”的 contain 模型计算内容尺寸和 offset。Viewer 的 `web-client/js/ui.js` 支持 cover 和 fill 显示模式：cover 会裁剪画面，fill 会拉伸画面，两者都不符合该坐标公式。

影响：用户在 cover/fill 下看到的位置与 Host 收到的位置不一致，越靠近边缘偏差越大；点击、框选和拖拽会命中错误目标。需要让坐标换算读取当前 object-fit 模式，并分别处理 contain/cover/fill。

#### P2：没有传输通道时仍返回“已发送”的 input ID

`web-client/js/input.js:443-492` 在 DataChannel 和 Socket.IO 都不可用时仍返回生成的 input ID。上层日志、键盘 debug 和 latency map 会把它当作一次已发送输入，直到 10 秒后被清理，没有立即失败状态或用户反馈。

影响：断线窗口内的按键/点击会静默丢失，诊断却留下发送 ID；操作员容易把“输入没生效”误判为 Host/Quartz 慢，而不是浏览器没有任何可用传输。

#### P2：Host 日志中的 `input_delay` 混用两台机器的时钟

Viewer 在 `web-client/js/input.js:443-449` 写入 `Date.now()`；Host 在 `python-host/host.py:1143-1158` 直接用自己的 wall clock 相减。远程 Viewer 与 Host 的系统时钟没有保证同步，虽然系统有 DataChannel clock sync，但这个日志字段没有应用 offset。

影响：`input_delay` 可因时钟偏差变成负值或虚高，不能作为单向传输延迟。可信指标应使用同一时钟域的 round trip，或把已估计的 offset/不确定度显式应用到单向测量。

#### P2：输入确认依赖下一次 frame timing，而不是独立 ack

Host 执行输入后把 input ID 暂存在 ScreenCaptureTrack，下一次 video track `recv()` 才把它附到 timing DataChannel 消息；Viewer 以这条消息到达时间计算 `inputRtt`。暂停视频、媒体卡住、track 尚未创建或 tunnel 模式下，这条确认链会延迟或消失。

影响：输入本身可能已经执行，但面板无法及时确认；同时该 RTT 包含等待下一帧的 0–50ms 及 timing DataChannel 延迟。建议独立返回同一 Viewer 时钟域可测的 input ack，并把“Host 排队/执行”和“视觉反馈”分开。

### 5.4 浏览器验证限制

本次尝试连接内置浏览器时，可用浏览器列表为空。因此没有取得当前会话的截图、真实 WebRTC candidate pair、实时 FPS/jitter、控制台错误或非破坏性交互反馈，也没有发送真实远程键鼠输入。

这不影响上述代码路径和自动化测试结论，但意味着“当前浏览器能否成功显示实时桌面”和“当前输入体感”没有在本次运行态中闭环验收。

## 6. Web Terminal 独立诊断

### 6.1 当前数据路径

Terminal 是 `xterm.js -> Socket.IO /terminal -> signal-server -> node-pty -> shell`，不经过 WebRTC、STUN、TURN、VideoToolbox 或桌面 Input DataChannel。任何 Terminal 延迟必须单独按 HTTPS/WebSocket 路径解释。

当前实现具备 shared session pool、断开不销毁 PTY、replay buffer、admin 二次授权、结构化审计、浏览器 RTT 探针、输入 ack、乐观本地回显和 alternate-screen 保护。

### 6.2 当前实测

只进行了 admin 授权和 `terminal:ping/pong`，没有创建 PTY、没有附着现有会话、没有发送 shell 输入。

| 指标 | 本地入口 | 固定域名 | 放大量级 |
|---|---:|---:|---:|
| admin HTTP 登录 | `34.3ms` | `2,769.1ms` | `~81x` |
| `/terminal` WebSocket 建连 | `6.2ms` | `1,351.8ms` | `~218x` |
| ping RTT P50 | `0.6ms` | `425.3ms` | `~709x` |
| ping RTT P95 | `3.8ms` | `683.6ms` | `~180x` |
| ping RTT 平均 | `0.8ms` | `468.6ms` | `~586x` |

固定域名通过浏览器 User-Agent 可以正常完成 admin 授权；非浏览器默认 User-Agent 被 Cloudflare 以 error 1010 拒绝。产品本身是浏览器入口，因此后者主要影响 CLI/自动化探针，不是当前浏览器用户的主故障。

### 6.3 与历史样本的对比

2026-07-11 报告中的固定域名 Terminal ping RTT P50 为 `414.6ms`，本次为 `425.3ms`，只相差约 11ms。两次相隔一周仍稳定在 400ms 以上，且 named-tunnel connector 仍全部落在 LAX，证明这不是瞬时 Node 事件循环或 PTY 抖动，而是持续的公网拓扑问题。

本地 ping P50 `0.6ms` 进一步排除了 Signal Server 本地处理。由于本次没有发送 shell 命令，不能把历史的 node-pty/首输出数据冒充当前样本；但当前 focused tests 和本地 Socket RTT 都没有显示本地 Terminal 栈的系统性退化。

### 6.4 专项测试

`node --test web-client/js/terminal.test.js signal-server/websocket/terminal.test.js signal-server/test/terminal-session-manager.test.js signal-server/test/terminal-auth.test.js`：52/52 通过。

覆盖 shared session、replay、reattach、admin auth、审计、ping、input ack、乐观回显、控制序列和 alternate screen。通过并不代表下面的指标语义与密码提示行为正确，因为测试当前固化了现有实现。

### 6.5 发现的问题

#### P1：Terminal `inputAck` 指标仍混合浏览器和服务端时钟

`web-client/js/terminal.js:515-529` 用 `serverReceivedAt - clientSentAt` 记录“输入”时延。前者来自 Signal Server `Date.now()`，后者来自浏览器 `Date.now()`；两台机器时钟没有共同基准。当前 dirty-tree 修改没有修复 2026-07-11 报告已经指出的问题。

影响：页面可能继续显示不可能的超大、偏小或被 `Math.max(0)` 截成 0 的输入延迟。正确的浏览器 input ack RTT 应是浏览器收到 ack 的 `Date.now()` 减本地 pending send time；服务端处理时间应单独用 `serverSentAt - serverReceivedAt`。

#### P1：乐观本地回显会暴露 Terminal 密码输入

`web-client/js/terminal.js:847-917` 对普通可打印字符直接写入 xterm，只在 alternate-screen 模式禁用。它不知道远端 PTY 是否关闭 ECHO，因此在 `sudo`、`ssh`、数据库密码等提示中仍会把密码明文显示在浏览器屏幕上。

影响：破坏终端密码输入语义，造成肩窥/录屏泄露；由于远端不会回显，pending local echo 还会保留 3 秒并干扰后续输出去重。乐观回显必须感知 PTY echo mode，或限制为明确安全的行编辑场景并提供关闭开关。

#### P1：正式公网入口的 400ms+ RTT 是交互主瓶颈

当前 app-level RTT P50 `425ms`，意味着没有本地回显的控制键、补全、TUI 操作、密码输入和输出确认至少承受约一个 RTT；P95 已接近 `684ms`。这无法通过优化 node-pty、xterm render 或事件循环消除。

根因是本机 connector 长期连接到 LAX。优先级最高的整改不是继续微调 JavaScript，而是让 connector/入口落到亚洲近端，或为 Terminal 提供不绕 LAX 的专用直连 WebSocket/私网 overlay 路径。

#### P2：公网认证和首次连接成本过高

本次 admin 登录 2.77 秒、WebSocket 建连 1.35 秒。即使后续 ping 稳定，用户首次打开 Terminal 或 token 过期重授权时会经历明显等待。认证接口与静态页面同走远端 connector，且 auth route 还有统一限流。

#### P2：shared Terminal 只有软告警，没有资源上限

需求明确允许不限会话并只做软提示。实现确实如此，但每个会话都是 PTY/shell，replay 和 observer 状态也占内存。管理员误操作或凭据被滥用时，会话数量可以持续增长并影响 Signal Server、系统进程数和整机负载。

建议保留产品语义但增加可配置的高水位保护、空闲回收和资源指标，而不是只依赖前端“会话较多”提示。

## 7. 可观测性、日志与测试保障

### 7.1 已具备的能力

- Viewer 可以上报 connection attempt、candidate summary、PC/ICE 状态、推荐模式和输入状态。
- Signal Server 有结构化 runtime event store，Terminal auth/session/error 也有审计事件。
- Host 有 capture stats、input execution、event-loop lag、tunnel relay stats 和 Viewer failure summary。
- Viewer、Signal Server、Host 和运维脚本都有相当规模的单元/契约测试。

### 7.2 当前回归结果

| 测试族 | 结果 | 说明 |
|---|---:|---|
| Signal Server `npm test` | 65/67 通过 | 2 个 bootstrap 启动测试因 cwd 路径错误失败 |
| Viewer JS | 78/78 通过 | 包含 WebRTC、输入、诊断、Terminal UI |
| 运维脚本 | 43/43 通过 | 包含 safe start/status/tunnel/Host lifecycle |
| Python Host | 26/26 通过 | 1 个 MSS API deprecation warning |
| `webremote-service` helper | 3/3 通过 | status/restart 语义测试 |

总计 217 项，215 项通过、2 项失败。失败不是随机超时：`signal-server/test/terminal-bootstrap.test.js:49` 在 `npm test` 的标准 cwd `signal-server/` 下启动 `signal-server/server.js`，实际路径成为 `signal-server/signal-server/server.js`。同一测试从仓库根目录运行时 3/3 通过。

#### P2：标准 `npm test` 不能全绿，且隐藏了子进程错误

测试 helper 收集 child stdout/stderr 到 `output`，但 `waitForHealthy()` 超时时没有把 output 附到异常，也没有在启动失败路径显式清理 child。当前根因只是路径错误，但未来真实启动错误也会被压缩成统一的 `server_failed_to_start`，增加诊断时间。

### 7.3 日志风险

#### P1：桌面键盘与控制 payload 被明文写入日志

`python-host/host.py:1149-1161` 对所有 keyboard 和非 move 输入打印完整 payload；Socket.IO fallback 还会在 `signal-server/websocket/signaling.js:181-183` 打印完整 JSON。密码、聊天、命令、快捷键和输入 ID 都可能被持久化。

当前 `back-debug.log` 约 47MB、490,532 行，累计包含 16,617 条 `Input received` 和 7,527 条 `Keyboard executed`。本报告没有摘录实际键值。

影响：这是输入隐私泄露，同时高频同步日志会增加 Host/Signal Server I/O 和 event-loop 压力。默认日志应只保留事件类型、transport、redacted input ID 和分桶后的耗时，绝不能保留键值和文本。

#### P2：Host 日志没有轮转

Host 当前 stdout/stderr 长期 append 到版本库根目录 `back-debug.log`，没有 size/time rotation。该文件已有 24,042 条 tunnel stats、20,582 条 capture stats 和 418 条 event-loop lag warning。

影响：长期运行会持续增长，占用磁盘、拖慢搜索/诊断，并在高频输入或 relay 会话中增加写放大。Signal Server 当前日志只有约 3KB，不是同级问题。

### 7.4 关键测试缺口

- 没有真实浏览器 WebRTC smoke/acceptance，单元测试无法证明解码画面不黑、candidate pair 正确或实际 FPS。
- 没有 DOM 级双击、拖出元素释放、blur 时鼠标复位、cover/fill 坐标映射测试。
- 没有 reconnect 后 `requestVideoFrameCallback` 和 `getStats()` 数量不增长的长时间测试。
- 没有真实弱网/丢包/断网下的降档、升档、ICE restart 和手动 tunnel 验收。
- 没有 Terminal echo-off 密码提示测试。
- safe URL 测试只断言脚本调用 reachability helper，没有用 HTTP 404/410 验证“不可发布”的业务语义。

## 8. 问题清单与总体评级

### 8.1 严重度汇总

本次没有发现 P0 级立即数据破坏或整套本地服务不可用问题。

| ID | 级别 | 问题 | 当前证据 |
|---|---|---|---|
| F-01 | P1 | safe status 恢复并发布 404 URL | 12/12 为 404，累计 47,701 次 404，脚本仍报 ok |
| F-02 | P1 | 固定公网入口和 Terminal RTT 过高 | HTTP P50 860ms；Terminal RTT P50 425ms/P95 684ms |
| F-03 | P1 | 公网桌面没有 TURN | TURN 三项均未配置，只能 STUN 或手动 JPEG tunnel |
| F-04 | P1 | 视频阶段延迟指标边界错误 | encode/packetSend 时间戳均在真实编码/RTP 前 |
| F-05 | P1 | 双击被执行两次 | DOM down/up 加 dblclick，Host 再生成完整双击 |
| F-06 | P1 | 拖拽 release 可丢失 | mouseup 只绑定画面元素，无 pointer capture/reset |
| F-07 | P1 | cover/fill 坐标错误 | 坐标公式固定按 contain/letterbox |
| F-08 | P1 | Terminal inputAck 跨时钟 | serverReceivedAt 减 clientSentAt |
| F-09 | P1 | Terminal 密码被乐观回显 | 未感知 PTY ECHO，只排除 alternate screen |
| F-10 | P1 | 键盘 payload 明文落日志 | 47MB Host 日志包含大量完整 input payload |
| F-11 | P1 | named-tunnel token 暴露在 argv | 当前进程参数可见；报告已脱敏 |
| F-12 | P2 | 重连累积帧回调和 stats 开销 | callback 不取消；初次连接约 40 次 getStats/s |
| F-13 | P2 | candidate pair 可能选错 | 遍历所有 succeeded pair，未用 selected ID |
| F-14 | P2 | 自适应只降不升 | 好样本仅 hold，不能恢复画质 |
| F-15 | P2 | 降 FPS 不降低 MSS 抓屏频率 | capture loop 启动时固定约 60 FPS |
| F-16 | P2 | 无输入传输仍返回成功 ID | DataChannel/Socket 都失败后仍返回 inputId |
| F-17 | P2 | Host 日志无轮转 | 约 47MB/49 万行并持续 append |
| F-18 | P2 | 标准 Signal Server 测试不全绿 | cwd 相关路径错误导致 2/67 失败 |
| F-19 | P2 | shared Terminal 无资源高水位 | 只有软告警，无 session/内存/进程保护 |
| F-20 | P3 | 事件循环 lag 无上下文 | 当前启动后见 24–142ms，无法归因 |

### 8.2 总体评级

| 维度 | 评级 | 判断 |
|---|---|---|
| 本地服务可用性 | B | Signal Server/Host 健康，本地 HTTP 与 Terminal Socket 为毫秒级 |
| 公网页面/控制面 | D | 可达但 TTFB P50 约 860ms，长尾 1.5s |
| 公网 WebRTC 媒体 | D/未闭环 | 无 TURN，真实浏览器本次未验证，受限网络成功率不可保证 |
| tunnel JPEG fallback | F | 当前 URL 全部 404；历史性能也只有约 1–6 FPS |
| 鼠标键盘正确性 | C | 主链路设计合理，但存在双击、拖拽释放和缩放坐标硬错误 |
| 本地 Terminal | A- | Socket P50 0.6ms，专项测试完整；未做本次 PTY 命令样本 |
| 公网 Terminal | D | P50 425ms、P95 684ms，靠乐观回显掩盖部分体感 |
| 指标可信度 | D | RTT/FPS 有价值，但视频阶段、input_delay、Terminal inputAck 有错误语义 |
| 长时间运行稳定性 | C- | 回调/stats 可累积，Host 日志无轮转，资源保护不足 |

诊断快照结论：**本地核心服务和本地 Terminal 是快的；当时主要用户体验问题集中在公网入口绕 LAX、没有 TURN、失效的 quick tunnel、输入边界错误，以及不可信/高开销的延迟埋点。该运行版本不能被判定为“稳定低延迟公网远程桌面”。** 当前工作树的代码整改状态见第 13 节；由于运行进程尚未重启，不能用整改后的单元测试替代真实公网会话验收。

## 9. 根因归纳

1. **公网拓扑而非本地业务处理**：固定域名 connector 全在 LAX，Terminal 当前/历史两次测量都在 415–425ms；本地仅 0.6ms。
2. **连接策略缺少可靠中间层**：Strict STUN 在 UDP/NAT 受限时没有 TURN，只能失败或手动跳到低帧率 JPEG tunnel。
3. **fallback 健康契约错误**：safe helper 把“curl 能收到任意 HTTP 响应”等同于“入口可交付”，404 被写回真相文件。
4. **浏览器事件语义没有端到端建模**：DOM dblclick、元素边界 release 和 object-fit 模式没有映射为唯一 Host 行为。
5. **测量边界和时钟域不统一**：多个指标使用错误阶段名、不同机器 wall clock 或不相关的 DataChannel 作为媒体代理。
6. **长期运行资源没有闭环**：帧回调/getStats、日志文件和 Terminal session 都缺少明确上限或回收策略。

## 10. 整改顺序与验收指标

### 第一批：恢复正确性和可信诊断

1. 让 `status-safe-wrd.sh` 只读；URL 恢复/发布只归 tunnel supervisor 所有。候选 URL 必须通过已知页面或 `/health` 2xx 内容校验，404/410/5xx 一律不可发布。
2. 移除所有明文键盘/文本 payload 日志，轮换 Cloudflare token，改用不暴露在 argv 的凭据加载方式；为 Host 日志加 rotation。
3. 修复双击、window/pointer mouseup/reset 和 contain/cover/fill 坐标映射，并增加 DOM 级测试。
4. 立即修正 Terminal inputAck 和 Host input delay 的时钟语义；UI 分开显示 browser RTT、server queue/process 和 Host execute。
5. 修复 bootstrap 测试路径并在启动失败时输出 child stderr。

验收：

- safe URL 连续 20 次返回预期 2xx；注入 404 URL 时状态为不可达且不写文件。
- 日志扫描找不到实际 key/text/password payload；单文件大小有明确上限并能轮转。
- 双击恰好 2 次 down/up；拖出画面/blur/disconnect 后 Host 无 pressed mouse；三种 object-fit 模式九宫格点位误差不超过 1%。
- 同一公网样本中 Terminal 页面 RTT 与独立 ping P50 误差不超过 10%；不同系统时钟偏移不改变结果。
- `cd signal-server && npm test` 为 67/67 通过。

### 第二批：解决公网链路

1. 排查 cloudflared 为什么从当前网络出口连接 LAX，目标是 HKG/NRT/SIN 等亚洲近端；检查本机 VPN/proxy/路由和 ISP 到 Cloudflare anycast 的实际路径。
2. 为 WebRTC 配置位于目标用户附近的 TURN/TURNS，并验证 relay candidate；TURN 只转发加密媒体，不做 JPEG 转码。
3. Terminal 使用不绕 LAX 的专用 WSS、私网 overlay 或近端 connector；保持 WebRTC 媒体与 Terminal 传输策略独立。
4. quick tunnel 仅保留 debug fallback，不再作为性能或正式入口基线。

验收：

- 固定域名 HTTP TTFB P50 <250ms、P95 <500ms。
- Terminal app RTT P50 <100ms、P95 <200ms；admin 登录和 WebSocket 建连各自 P95 <1s。
- 外网受限网络能选出 TURN relay，连接成功率 >=99%，不自动退到 JPEG tunnel。
- 真实浏览器首次桌面出帧 P50 <3s、P95 <5s。

### 第三批：重建媒体与长期性能观测

1. 把真实 capture、conversion、H.264 encode、RTP send、browser receive/decode/paint 分开；不能再把 track return 当作 encode/send。
2. `getStats()` 固定低频采样并共享快照；每帧回调只处理 paint metadata，refresh/disconnect 必须取消旧 callback。
3. candidate pair 使用 transport `selectedCandidatePairId`；统计使用区间 delta，不用会话累计平均驱动短期控制。
4. 自适应增加带迟滞的升档；capture loop 随目标 FPS 调整，不在 survival 档继续 60 FPS 抓屏。
5. Terminal 乐观回显增加 echo-off 安全机制、用户开关和密码提示测试；shared sessions 增加资源指标、可配置高水位和空闲回收。

验收：

- 连续 50 次 refresh 后仍只有一条 video frame callback 链，`getStats()` 不超过 2 次/秒。
- 高档稳定画面 >=18 FPS；survival 档 MSS 抓屏频率不超过输出 FPS 的 2 倍。
- 5 分钟弱网后恢复 2 分钟，画质能逐级回到 high，且无频繁升降振荡。
- 视频阶段指标能通过可控 synthetic frame marker 校准，端到端误差不超过 20ms。
- echo-off 密码提示中浏览器不显示输入字符，alternate-screen/TUI 无重复回显。

## 11. 本次限制

- 浏览器运行时没有可用实例，因此未取得当前实时桌面画面、candidate pair、FPS/jitter、浏览器 CPU 或真实键鼠反馈。
- 未获得明确真实输入授权，且浏览器不可用，所以没有向 Host 发送鼠标、键盘或 shell 命令。
- 当前没有 Viewer；本次 tunnel relay 性能只能引用明确标注的 2026-07-12 历史日志。
- safe status 命令本身把 archive/log 中的 URL 写回 `/tmp/wrd-safe-current-url.txt`；本次没有删除该文件或重建 tunnel。
- 诊断快照阶段未修改产品代码、未重启服务、未轮换凭据。此后已按第 13 节完成代码整改，但仍未重启服务或轮换正在使用的凭据。

## 12. 关键证据索引

- 服务：`python skills/webremote-service/scripts/wrd_service.py status`
- safe 状态：`./scripts/status-safe-wrd.sh`
- 入口：本地/fixed/safe URL 的 12 次 curl timing 样本
- Cloudflare：`127.0.0.1:20242/metrics` 和 `127.0.0.1:20244/metrics`
- Terminal：本地与固定域名各 12 次 `/terminal` ping/pong
- 日志：`back-debug.log`、`/tmp/signal-server.log`
- 测试：Signal Server、Viewer、scripts、Python Host、webremote-service helper
- 设计：`docs/superpowers/specs/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic-design.md`
- 计划：`docs/superpowers/plans/2026-07-18-remote-desktop-connection-interaction-performance-diagnostic-plan.md`

## 13. 整改实施台账

> 本节是在原始诊断快照之后追加的实施记录。第 1-12 节保留诊断当时的运行态证据和结论，不因后续代码整改而回写为“当时已修复”。

### 13.1 已完成的代码与自动化验证

| 批次 | 覆盖问题 | 当前整改状态 |
|---|---|---|
| Batch A：公网入口健康真相 | F-01、F-18 | `/health` 必须返回 2xx JSON 且 `status=ok`；3xx、404、429、5xx 和错误内容均不可发布。`status-safe-wrd.sh` 与 service helper 已只读，safe URL 仅由 tunnel supervisor 原子发布；Signal Server 标准 cwd 测试路径已修复。Host launchctl 测试的固定等待预算从 2 秒放宽到 5 秒，消除并发全量运行时的时序假失败。 |
| Batch B：输入正确性 | F-05、F-06、F-07、F-16 | Viewer 使用 Pointer Events、pointer capture、幂等 `mouse/reset` 和 contain/cover/fill 唯一坐标映射；双击只由两组 down/up + `clickCount` 表达；无 transport 时不再创建延迟 pending。Host 在连接失败、Viewer 离线和停止时释放按键。 |
| Batch C：媒体遥测与性能 | F-04、F-12、F-13、F-14、F-15 | 每个 PeerConnection 只有一个 1 秒 stats sampler，并在 teardown 取消 sampler 与 video callback；selected pair 优先使用 `selectedCandidatePairId`；统计使用区间 delta。Host timing schema v2 只把实测 `capturePrepareMs` / `frameConvertMs` 作为可用值，`encoderMs` / `rtpSendMs` / `endToEndVideoMs` 保持 `null`。自适应支持带迟滞升档，capture pacing 随 target FPS 变化，8 FPS survival 档最多 16 FPS 抓屏。 |
| Batch D：Terminal、输入确认、日志与凭据安全 | F-08、F-09、F-10、F-11、F-17、F-19、F-20，以及 P2 输入确认缺口 | Terminal socket/input ack RTT 只使用浏览器本地 pending 时间，`serverProcessMs` 单独计算；密码回显首字符 probe 默认隐藏，确认远端回显后才启用后续本地回显。Viewer/Host/Signal 默认日志只保留元数据并统一脱敏，Python/Node/Terminal audit file 默认 10 MiB/3 份轮转，wrapper 日志保留最近 1 MiB。named tunnel 启动验证 `credentials-file` 并清除 `TUNNEL_TOKEN`，status 对 argv token 只读告警。桌面输入新增独立 `input_ack`，与下一帧 `visualFeedback` 分离；shared Terminal 默认 8 session 硬上限、256 KiB/session replay 预算和可配置 detached idle 回收；event-loop lag 改为 deadline drift、20/100ms 分级和有界上下文聚合。 |

Batch C 的自动化生命周期测试覆盖连续 50 次 start/stop 后无残留 sampler 或 frame callback。以上为当前工作树的代码和单元测试状态，不等同于正在运行的 Host/Signal Server 已加载这些修改。

### 13.2 方案边界与待运行态验收

- F-02 的核心是当前 Cloudflare connector 到 LAX 的公网拓扑，不是 `link.stockhub.wiki` 这个域名字符串。按本轮决定不引入 VPS，保留现有固定入口；仓库代码无法承诺消除当前约 425ms 的公网 Terminal RTT。
- F-03 作为当前明确接受的部署约束保留：不配置 TURN，不把它继续列为待实现代码缺陷。公网媒体严格 STUN，失败后只允许用户手动选择 JPEG tunnel fallback。
- Batch D 已完成上述 Terminal、输入 ack、日志、凭据、session 资源和 event-loop lag 整改。
- F-19 的硬 session ceiling、replay resource budget、detached idle reap 和容量 snapshot 已落地；F-20 已改为 deadline drift + 有界上下文，仍不能仅凭日志断言某个具体阻塞根因。
- 桌面输入 ack 已从下一帧 timing 中拆出：浏览器 RTT、Host execute 和 visual feedback 分别记录；旧 Host 无 ack 时保留 legacy frame RTT 兼容读取。
- 本轮实施没有重启 Signal Server、Host 或 `cloudflared`。真实浏览器 candidate pair、首次出帧、画面非黑、实际 FPS/jitter、输入手感和弱网恢复仍必须在获得重启授权、让运行进程加载新代码后验收。
- 已确认的部署边界保持不变：固定入口继续使用 `link.stockhub.wiki + Cloudflare Tunnel`；公网桌面媒体严格 STUN，失败后只允许用户手动切换 JPEG tunnel fallback；不引入 TURN、VPS 或 Viewer 客户端登录。

### 13.3 最终自动化验证

2026-07-18 的最终全量回归结果：

| 测试族 | 命令 | 结果 |
|---|---|---:|
| Signal Server | `cd signal-server && npm test` | 75/75 通过 |
| Viewer、CSS、运维脚本 | `node --test web-client/css/*.test.js web-client/js/*.test.js scripts/*.test.js` | 157/157 通过 |
| Python Host、入口健康、service helper | `PYTHONPATH=python-host python3 -m pytest -q python-host scripts/test_wrd_entry_health.py skills/webremote-service/scripts/wrd_service_test.py` | 55/55 通过；1 条既有 MSS deprecation warning |

合计 **287/287 通过**。默认并发 Node 全量首次运行曾暴露 Host launchctl 测试的 2 秒固定等待竞争；聚焦测试连续 11 次和串行全量均通过，放宽测试等待预算后默认并发 157 项再次全量通过。另新增 Viewer 输入日志脱敏回归，确保 key/code/text 不进入控制台或自动诊断链路。`git diff --check` 无空白错误。

### 13.4 main 合并验证

2026-07-19 将整改分支合并到 `main` 时，同时保留了 main 已有的受 Cloudflare Access 保护的 `dev.link.stockhub.wiki` 可选开发入口，以及本轮 named tunnel `credentials-file` 强制规则。合并结果验证为：

| 测试族 | 结果 |
|---|---:|
| Signal Server | 75/75 通过 |
| Viewer、CSS、运维脚本（含 main 的 5 条开发子域契约测试） | 162/162 通过 |
| Python Host、入口健康、service helper | 55/55 通过；1 条既有 MSS deprecation warning |

合并后合计 **292/292 通过**。这仍是代码和自动化契约验收；本轮没有重启 Signal Server、Host 或 `cloudflared`，因此第 13.2 节列出的真实浏览器与公网运行态验收仍然待用户授权。

### 13.5 2026-07-19 重启后运行态验收

本节记录 `main@aee1f02` 合并、推送并获得用户授权后执行的本地重启验收。重启命令仅作用于 Signal Server 和 Host；没有停止、重启或重建任何 `cloudflared`/tunnel 进程。

#### 服务与 tunnel 保持性

| 项目 | 重启后结果 |
|---|---|
| Signal Server | PID `81849`，`/health` 为 200/`status=ok` |
| Host | PID `81890`，`hostOnline=true`，Host ID `NsreA0B4-V9f-7bMAAAB` |
| Host 新代码启动证据 | 日志确认 VideoToolbox H.264 patch、aioice consent/retry patch、input handler 和 overlay 均已加载，Host 认证及 signaling 连接成功 |
| safe URL | 仍为 `https://memo-patterns-curve-contacted.trycloudflare.com` |
| safe URL 文件 | 重启前后 SHA-256 均为 `db9e24d63c80c44591b3da933379de5cb4ab9d59e92b29741b3e5891aac46214` |
| cloudflared | 重启前后 PID 集合均为 `398`、`5567`、`90866` |

上述证据证明本地 restart 没有造成 URL 轮换或 tunnel 进程 churn。当前 safe quick tunnel 连续 3 次 `/health` 均返回 404；新 status 逻辑正确分类为 `http-invalid`，没有把它误报为可交付入口，也没有改写 URL 文件。该地址继续只作为不可用的 debug quick tunnel 记录，不影响固定正式入口。

#### 入口、认证与配置

下表的 HTTP 分位数采用 12 个独立 curl 冷连接样本的 nearest-rank 口径：

| 入口 | 成功率 | connect P50/P95 | TLS P50/P95 | TTFB P50/P95 | total P50/P95 |
|---|---:|---:|---:|---:|---:|
| `127.0.0.1:8080/health` | 12/12 | `0.42/0.63ms` | n/a | `1.55/17.00ms` | `1.66/17.09ms` |
| `link.stockhub.wiki/health` | 12/12 | `72/196ms` | `148/700ms` | `889/1971ms` | `889/2541ms` |

使用浏览器 User-Agent 对本地与固定域名分别执行 Viewer 登录、WebRTC 配置、Terminal admin 登录和 bootstrap，全部返回 200。固定域名单次样本分别为 `1467ms`、`1028ms`、`845ms`、`912ms`；本地除首次 Viewer bcrypt 登录为 `355ms` 外，其余均为 `2.8-5.3ms`。运行配置确认：

- `turnConfigured=false`、`turnStatus=missing`，与“不部署 TURN”的明确约束一致。
- `recommendedMode=auto`，无 TURN 时 `manualFallbackChain=[auto,tunnel]`；Strict STUN 失败后不会自动切换 tunnel。
- 正式入口模式为 `fixed-domain`；Terminal 已启用，默认最多 8 个 session，每个 session replay 上限 256 KiB，默认不记录 Terminal IO。

固定域名返回的 `webrtc-stats.js`、`input-geometry.js` 和 `terminal-echo-controller.js` 与本地文件的字节数及 SHA-256 逐项一致，说明公网静态入口正在提供合并后的整改资源，而不是旧缓存版本。

#### Terminal RTT

测试仅建立 admin Socket.IO `/terminal` WebSocket 并发送 12 次 `terminal:ping`；没有创建 PTY、没有发送 shell input。

| 入口 | WebSocket 建连 | RTT P50 | RTT P95 | 最大值 | transport |
|---|---:|---:|---:|---:|---|
| 本地 | `22.37ms` | `1.07ms` | `11.90ms` | `11.90ms` | websocket |
| 固定域名 | `1444.89ms` | `419.31ms` | `437.96ms` | `437.96ms` | websocket |

这与整改前结论一致：本地业务处理没有形成主要延迟，约 420ms 的持续 RTT 来自当前 Cloudflare 公网路径。仓库内指标修复可以准确显示并避免额外开销，但在不改变网络入口、connector 路径且不引入 VPS/TURN/客户端的约束下，无法把该外部 RTT 降到设计目标。

#### 日志与回归

- 重启后的 Host/Signal 日志未发现新的 `ERROR`、exception、traceback 或 event-loop lag 告警。
- 新日志未命中旧的 `Input received`、`Keyboard executed`、raw key/code/text/coordinate 模式；`WRD_TERMINAL_RECORD_IO=false`。
- 当前 Host 日志约 1.1 KiB；重启前约 45 MiB 的历史输出保存在未跟踪的 `back-debug.log.1`，未纳入提交。
- 2026-07-19 重新执行全量回归：Signal Server `75/75`、Viewer/CSS/运维脚本 `162/162`、Python Host/入口健康/service helper `55/55`，合计 `292/292` 通过；仅有 1 条既有 `mss.mss` API deprecation warning。

#### 当前完成判断

在已确认“不部署 TURN、不引入 VPS/客户端、保留固定域名 + Strict STUN + 手动 tunnel fallback”的方案边界内，F-01、F-04 至 F-20 的代码整改、自动化契约、合并部署和非浏览器运行态验收已经闭环，模块边界与降级策略合理。F-03 是明确接受的部署约束，不再作为待开发项；F-02 是仍存在的 Cloudflare 路径性能上限，不应虚报为代码已解决。

仍未闭环的验收只有真实浏览器/真实会话才能完成：当前没有可用的浏览器自动化实例且 `viewerCount=0`，因此没有取得实时 selected candidate pair、首次出帧、非黑画面、FPS/jitter、50 次 refresh 回调计数、双击/拖出释放/cover-fill 点位，以及 Terminal password/alternate-screen 的真实 UI 证据。另有两项已知运维状态保持不变：debug quick tunnel 当前 404；现有 cloudflared argv 仍触发 token 暴露告警。按既定权限边界，本次只报告，未重建 tunnel 或轮换其凭据。

### 13.6 真实普通浏览器验收与验收后整改

本节取代第 13.5 节末尾“没有浏览器证据”的限制结论。测试使用普通 headless Chromium 147 和 Python Playwright，从正式入口 `https://link.stockhub.wiki` 完成 Viewer 登录、真实 WebRTC/Quartz 输入和临时共享 PTY 会话；没有使用 TURN、媒体 tunnel、浏览器内 mock 或协议级假视频。测试 PTY 均显式关闭。

#### 媒体连接、首帧与画面

| 项目 | 真实结果 | 判断 |
|---|---|---|
| selected candidate pair | `host -> host`、UDP、remote IPv4 `192.168.0.107`，RTT 样本约 `1-17ms`；无 relay candidate | Strict STUN/direct contract 通过 |
| 首次出帧 | 三次独立冷会话 `4.12s / 3.52s / 4.52s`；P50 `4.12s`、nearest-rank P95 `4.52s` | P95 `<5s` 通过；P50 `<3s` 未通过 |
| 首帧分段 | 代表性 4.12s 会话：PC `0.42s`、public signaling socket `1.51s`、ICE connected `3.52s`、video ready `4.10s` | 等待主要在 Cloudflare 信令与 ICE，连接后解码/出帧约 `0.58s` |
| 稳态媒体 | `19-20 FPS`，jitter buffer 常见 `0-5.8ms` | 当前 20 FPS profile 达标 |
| 非黑画面 | Canvas 采样 non-black ratio 约 `98.5%-100%`，分辨率 `1152x720`，截图可见真实桌面 | 通过 |
| 统计生命周期 | 稳态 `getStats()` 正好约 1 次/秒；一个 sampler、一个 active video-frame callback | 通过 |

`playoutDelayHint` 的真实 Chromium 接口要求有限数值秒，旧 `{min,max}` 对象会抛异常；另外，前两次 0 FPS 解码预热样本会被误判为 survival，且 Host media profile 会跨 Viewer 保留。浏览器验收已推动以下修复：数值 `playoutDelayHint=0`、两样本 `media-warmup` grace、每个新 PC 同步当前 high profile。修复后 focused WebRTC 测试 `37/37` 通过，首帧从修复前约 `6.47s` 降至上述 `3.52-4.52s`，但 P50 目标仍不能标记完成。

#### 刷新与自适应质量恢复

- 通过真实 `#refreshBtn` 并遵守 5 秒 UI debounce 连续执行 50 次 refresh，`50/50` 重连成功；重连 P50 `1.18s`、最大 `2.10s`。
- 每一轮均保持一个 sampler、一个 active callback，且 sampler 绑定当前 PeerConnection；页面异常为 0。
- 强制 survival 后持续采样 60 秒，档位依次为 `survival -> low -> medium -> high`；采样点约在 20s、35s、50s 观察到升档，末值 high/20 FPS、connected、页面异常为 0。
- 绕过 UI debounce 的非正常高频直接 refresh 在约第 31 次暴露 trickle ICE 竞态：Host 先收到 `127.0.0.1` candidate，约 50ms 后 srflx 才到，ICE 已提前失败。正常 UI 路径未复现；该压力路径记录为 P3 robustness 风险，不作为 50 次真实 UI 验收失败。

#### 桌面输入与坐标

| 项目 | 真实结果 |
|---|---|
| Chromium 双击 | PointerEvent 第二次 down/up 的 `detail` 仍为 1；修复后实际发送严格为 `down:1, up:1, down:2, up:2`，全部由 DataChannel 接受 |
| 拖出释放 | 释放后 pressed buttons=0、active pointer=null、pointer capture=false；window blur 另发送已接受的 `mouse/reset` |
| contain/cover/fill | 三种模式各九点均为有限且有界坐标，中心误差 0；contain 黑边按 outside 处理 |
| 输入延迟 | input RTT P50/P95 约 `13/16ms`；Host execute P50/P95 约 `0.99/5.55ms`；visual feedback P50/P95 约 `39/63ms` |

真实 Chromium 证明浏览器不会为 PointerEvent 提供可靠的第二击 `detail=2`。Viewer 已改为按同一按钮、500ms 时间窗和 6px 距离推断第二击，pointerup 复用当前 down 的 clickCount；blur/cancel/reset 清理序列。对应输入 focused 测试 `12/12` 通过，浏览器页面异常为 0。

#### Terminal 普通回显、密码与 alternate-screen

- 普通命令标记出现两次，严格对应“命令 + 输出”，没有第三次重复回显。
- `stty -echo` 下输入 13 字符 sentinel：输入中和提交后均不可见，返回 `WRD_PASSWORD_LEN:13`；新鲜完整会话的 `echoConfident=false`。
- 额外 10ms 高频采样取得 154 个 echo-off 状态样本：`echoConfident` 从未为 true，pending local echo 最大 0 字节，输入前后均无 sentinel。
- alternate-screen 进入状态为 true，按键后 100ms 内没有本地字符，echo confidence 为 false；随后正确返回 primary screen。
- 最新公网样本中 socket RTT 约 `520-893ms`，input ack 约 `591-1426ms`，server process `0-1ms`。抖动来自当前 Cloudflare 公网路径，PTY 处理不是主耗时。
- Cloudflare RUM `/cdn-cgi/rum` 出现一次 `net::ERR_ABORTED`，产品页面 error/console error 均为 0，按非产品请求分类。

#### 验收发现的 Signal/Host 恢复缺陷

浏览器关闭旧 PTY 后立即创建并输入时，迟到事件曾让 `terminal:input` 在 handler 外抛出 `terminal_session_not_found`，Signal Server 进程退出。修复保留 session-manager 严格异常语义，在 Socket.IO adapter 统一把已关闭 session 的迟到 input/resize 转为稳定错误和脱敏拒绝审计。TDD 先复现 `1 fail`，修复后 focused `1/1`、Terminal WebSocket `12/12`；真实浏览器再测时 Signal PID 保持不变，新 session 命令完成、session 数回到 0、页面/console 异常为 0。

该崩溃还揭示 Host token 过期恢复问题：Host token 有效期 15 分钟，Signal Server 长时间运行后重启，旧实现持续用过期 token 重连，无法自动上线。`ensure_connected()` 现会销毁旧 client、重新认证、再连接。运行验证中只重启 Signal Server，Signal PID `96038 -> 339`，Host PID 始终为 `204`；首次认证在 origin 尚未监听时失败，下一秒重新认证成功并恢复 `hostOnline=true`，无需重启 Host。

#### 日志、安全、服务与回归

- 修复后 Signal 日志没有新的 uncaught/unhandled/traceback/exception/error；迟到 Terminal 事件仅形成 `terminal_input_rejected` / `terminal_resize_rejected`。
- 当前 Viewer/Terminal 运行密码、三组浏览器测试 sentinel、输入标记均未出现在 Signal/Host 日志；版本差异秘密扫描为 0 命中。
- 并行浏览器与全量测试负载期间 Host 记录三次 event-loop lag：`94.9ms`、`106.0ms`、`40.9ms`，一次达到 critical；当时 `pcState=none`、无 relay，告警随后未持续。F-20 的监控已有效，但仍应在真实长会话中观察是否周期性出现。
- 最新全量回归：Signal Server `76/76`、Viewer/CSS/运维 `165/165`、Python Host/入口健康/service helper `56/56`，合计 `297/297` 通过；仅保留既有 MSS deprecation warning。
- 最终本地服务 health 正常、Host online。safe URL 文件 SHA-256 始终为 `db9e24d63c80c44591b3da933379de5cb4ab9d59e92b29741b3e5891aac46214`，cloudflared PID 始终为 `398/5567/90866`；本轮没有停止、重建或轮换 tunnel。

#### 最终完成判断

真实浏览器功能与正确性验收已闭环：selected pair、非黑画面、稳态 FPS/jitter、50 次正常刷新、自适应恢复、双击、拖出释放、三种 object-fit、Terminal 普通回显、密码隐藏和 alternate-screen 均取得实际证据。验收发现的 Terminal close race 和 Host 过期 token 重连也已修复并运行验证。

仍不能标记为完全达到所有性能目标：首帧 P50 实测 `4.12s`，未达到 `<3s`；公网 Terminal RTT 仍约数百毫秒且波动到接近 900ms；Host 在高并发验收负载下出现一次 106ms event-loop critical lag。前两项主要受当前 Cloudflare/ICE 路径和既定部署约束影响，第三项需要长会话趋势证据。除此之外，当前方案在“不部署 TURN、不引入 VPS/Viewer 客户端、Strict STUN 失败后手动 tunnel”的边界内合理且已完成代码闭环。


## Reliability closure update (2026-07-20)

Automated items closed on branch `feat/remote-desktop-reliability-closure` (see `2026-07-20-remote-desktop-reliability-closure-evidence.md`): reset fail-closed, port-search lease gate, media suspend WebRTC+tunnel, viewport stability. Dual Viewer / physical keyboard / public tunnel remain runtime pending.

### Review remediation (same day, post-4faf271)

Additional automated closures on `worktree-reliability-closure-p1` (see recalibrated evidence report):

- ACTIVE controller disconnect no longer opens a FREE window; formal reset-only REVOKING barrier only.
- Media activity bound to `connectionAttemptId` from offer through Signal and Host.
- Resume input unlock requires real fresh decoded/rendered frames (not cumulative `framesDecoded > 0`).
- Tunnel media control waits for Host applied ack; Viewer synthetic applied removed.
- Host media apply aggregates input/sender/capture/relay and fail-closes to suspended on any applicable failure.
- launchctl fixture restored by copying `lib-turn-env.sh`.

**Withdrawn over-claims:** resume P95≈333ms (synthetic frame note), formal tunnel suspend/resume PASS without Host applied ack, and disconnect reset barrier “closed” while FREE-on-disconnect remained. Those rows are now **NOT RUN** or recalibrated automated-closed only. No tunnel rebuild in this work.
