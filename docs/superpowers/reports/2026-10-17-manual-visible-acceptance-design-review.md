# 人工远程输入的最小验收证据路径（只读设计）

日期：2026-10-17。审查目录：/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop。
本次仅阅读源码/既有报告，未运行测试、浏览器、网络、服务、截图或 native input；未修改源码/index。三小时生产长测期间不执行本设计。

## 结论

长测结束、产物封存后，用户从另一台设备亲自操作现有 Viewer，可先完成远程可用性观察以及已有 M1/M2 的真实输入采样。这可以测 inputAckRttMs 和满足因果匹配条件的 inputToPostApplyFrameMs；不能据此声称真实可见 marker 或 150–200ms 可见效果目标已验收。当前 operator-remote 只是受验证的抽象 executionMode/adapter 接口，没有现成可执行的人工证据收集入口。

自动 native fixture 的 BLOCKED 保持不变。不得改 probe=true，不得把生产 shared WindowServer/global HID 改称隔离环境，不得把自动 runner 改一个 mode 名字后执行。用户亲自操作的维护窗口与自动化隔离资格是两件事。

## 可立即复用与证据语义

- web-client/js/latency-monitor.js：被动、有界 M1 输入 ACK、Host 阶段、候选 RTT、jitter/decode 与 M2 post-apply 指标。按 available/count 和时间范围报告实际存在的值；缺测 null。candidateRttMs 是 RTT，不能除二冒充网络单向时间。
- web-client/js/runtime-diagnostic.js 与既有 Viewer 诊断：同一快照构建器保留五秒窗口指标和 outcomes，含捕获时间/build。人工步骤后立即获取既有诊断可以留住对应窗口；延迟收集可能已过窗口。不得将重叠五秒快照的 count 或 p95 相加当整段分布。整个会话分布如无逐样本唯一身份收集就不宣称可得。
- webrtc.js 的 inputFrameCollector 与 LatencyMonitor.onPostApplyFrame：独立于 WRD_FRAME_TRACE_DETAIL，匹配 Host applied 后新 capture 的 wire RTP 与 Viewer rVFC 原始同钟时间。它证明输入后新采集帧被提交呈现，不证明画面内容因输入发生指定变化。
- scripts/turn-runtime-controlled-producer.html：已有合成文字、scroll、drag、text 与双 CRC marker（256x128，nonce/scene/action/tick）。可作为用户人工操作目标，但它不是完成的 operator-remote 工具。
- scripts/turn_controlled_scene.py 的 evaluate_scene_result：可复用严格 send/ACK/producer/visual 身份与 RTP join 校验、sendToAckMs/sendToVisualMs。run_controlled_scenes 仍调用 viewer.send_input，不会自动等待真实人手；operator_endpoint 非空字符串也不证明操作者设备独立。
- scripts/turn_controlled_scene_runtime.py：MarkerLayout、FixtureBroker 可复用；aggregate_action_evidence 明确要求 host guard claim，不能拿人工流程伪造 claim。生产人工路径要单独记录其真实性与授权来源，不能声称通过 automatic-isolated gate。

## 第一阶段：最小可执行操作（不改运行代码）

1. 等三小时长测正常结束并封存其采样终点/产物。确认该测试不再计入下述主动操作；记录一个新的短维护窗口与环境/build/媒体模式。
2. 用户确认使用另一台设备，独占控制租约，Host 端没有其他人/自动程序输入。用户自己切换到只有合成数据的测试目标，确认安全后取得 Viewer 控制权。无需 agent 代发鼠标、键盘或 lease 请求。
3. 用户手动做少量、逐次的点击/输入/滚动，操作之间停顿。每次只记录动作类别、成功/失败及可见响应的主观观察，不记录文字内容/坐标。此小样本是 smoke，不冒称完整既定31项工作负载。
4. 在对应五秒采样窗口内由用户触发既有诊断；收集 build、captured、latency metrics、scope摘要/outcomes。诊断采用既有脱敏存储，不导出完整 DOM、截图、地址或原始输入追踪。结束时保留原始指标数值、样本数和缺测原因；最多报告每个窗口自身 p50/p95。
5. 实际有 applied ACK 但 M2 仍不可用时，检查已返回的 capability、scope、rVFC/RTP 可关联条件与超时计数，不立即开启 detail/重启 Host。无有效输入样本则报告 NOT RUN。

可得：真实远程连通与用户观察；真实发送至 ACK；有条件的发送至 post-apply rVFC；已有传输/解码分段指标。不可得：真实 marker 因果延迟、显示器发光延迟、缺失阶段的值、无样本的目标达成结论。

## 第二阶段：严格可见 marker 的最小缺口（需要实施后才能运行）

只在第一阶段后用户仍要求量化可见效果时补一个小的、显式 opt-in 的人工采集适配器；不新建大框架。

1. Viewer 被动观察用户实际调用现有输入路径的发送边界及返回 inputId，同一 performance 时钟记录 send；观察实际 ACK 的接收边界并记录 status/identity/time。不要使用脚本 sendInput 代发动作。现有 lab ACK hook 只记 inputId/status，不能直接用于精确 ACK 时间，也不能无限 push；人工适配器需有界、可卸载、不影响业务回调。
2. 由可信 Host 本地 broker 预留 action 及 nonce/scene/attempt/generation，producer 只报告实际原生 DOM 事件，不接收 inputId。Viewer inputId 与 producer action 的关联必须有可验证的预留/握手且与实际用户动作绑定，不能事后按相近时间猜配。
3. 特别缺口：一个人工文本操作会产生 keydown/input/keyup；拖动会产生多次 pointermove；鼠标点击含 down/up；producer 每个事件都推进 marker。当前 prepareNativeAction 只覆盖下一个事件，FixtureBroker 每 action 仅消费一次。因此须先限定一个可以严格一对一匹配的事件子集或明确定义整个事务的终态，拒绝歧义/重复/丢失；不能直接套自动逐 step workload。完整 scroll+10 drag+20 text 要另行解决这种多事件关联，不能由一次 smoke 代替。
4. Host 捕获范围必须实际含 producer marker；标定 source 分辨率、缩放、非零 ROI 与 layoutDigest。复用 configureControlledSceneMarkerRoi 与 CRC decoder，但不持久化 pixels。当前 decoder 会在内存画 video canvas；因此与“完全不读取像素”不同，执行前要明确获准读取合成 marker 所在受控画面。
5. 复用 takeControlledVisualEvidence 的 matched wire RTP/rVFC 原始时间。先验证现有 detailed collector 能产生真实非零、完整关联；仅配置 ROI 不保证有 T3 binding。既有 existing-frame-trace-operational-review 明确首 offer detailed context 缺口，而基本 M2 无该阻塞。不能声称开启 flag 就能取到 marker join，更不能把 M2 input_frame_binding 的 post-apply 直接升级为 marker result；若选择利用基础 M2 与同帧 marker，需要新的明确关联实现和针对性测试。
6. 验证 nonce、scene、action、tick、attempt/generation、stream、RTP/wire/captureSeq 全部匹配后，才计算同一个 Viewer 时钟的 marker rVFC - send。这可称“发送至受控可见 marker 的 rVFC”，仍不是 display photons。任何一环缺失保留 NOT RUN/UNALIGNED；人工口述“看到了”不能制造毫秒值。

## 环境与隐私边界

必需：长测后独立时间窗、独立远程操作者设备、用户明确实际操作意愿、可正常连接与取得租约、仅合成数据的 Host 前台目标、无并发操作、浏览器支持可验证的 rVFC/RTP、实际运行 build 已核对。严格 marker 另需本地 broker/布局身份与被动收集入口完成及获准使用。

运行文件限本机0600；持久化白名单仅时间/计数/状态/合成 marker 身份和必要的脱敏关联 ID。禁止密码、token、URL、IP、原始输入内容、剪贴板、坐标、整页日志或屏幕图像。握手/采集密钥不得写入报告。身份重连变化必须分段并失效旧预留；关闭人工采集时卸载 hook、清空有界缓存。不得执行 lab runner 的自动 lease/input、pause/resume/refresh 或 screenshot 副作用来“顺便采集”。

## 推荐下一步

先等 root 的用户答复并保持三小时长测无干扰。若用户愿意长测后亲自操作，执行第一阶段，并明确只验 M1/M2 与人工可用性；无需为这一阶段修改源码、重启、打开 detail 或改自动 probe。若用户要求真实 marker 毫秒数据，先单独评审上述最小人工适配器和多事件关联方案、确认实施授权；入口完成前真实可见效果维持 NOT RUN。
