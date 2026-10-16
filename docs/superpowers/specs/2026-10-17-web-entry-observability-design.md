# 网页、入口与运行观测整改设计

> 执行状态更新（2026-10-17）：用户已要求完成开发、验收并保持本地服务可用，已进入实施阶段。下文“本轮仅文档／未来授权／全部 NOT RUN”等初稿状态描述保留为规划历史，不再限制本次已授权工作；实际完成、复核、部署与未运行项以[实施记录](../reports/2026-10-17-remediation-execution.md)为准。tunnel 禁止重建的限制继续有效。

日期：2026-10-17。状态：已授权编制设计与计划，未实施、未部署。采用 superpowers 6.3.0 brainstorming 的 Architectural 路径：该子项目改变认证结果、资源生命周期、巡检结果和诊断快照契约。用户已授权直接完成文档与复审，不再逐段确认；这不授权执行后续代码、部署或 tunnel 操作。

## 1. 目标、证据与所有权

本设计消费[总设计](2026-10-17-reliability-latency-remediation-design.md)的控制身份和耗时契约，与[执行计划](../plans/2026-10-17-web-entry-observability-plan.md)配套。W 负责网页恢复、入口观测、诊断与前端观测开销；C 决定控制是否可用，M 决定媒体及耗时计算。W 不新增控制恢复状态机，不以诊断缺测撤销或恢复授权。

证据：

- [综合诊断](../reports/2026-10-17-web-entry-screen-control-diagnosis.md)：N5–N12、D1–D6、N1。
- [耗时诊断](../reports/2026-10-17-transport-input-to-frame-diagnosis.md)：L9；L1 的显示适配只消费 M1，计时修复仍归 M。
- [72 小时 Viewer 证据](../reports/evidence/2026-10-17-three-day-review/viewer.json)：固定窗口内 48 份现存报告，加 23 条旧摘要，按原始 SHA 去重为 71 条报告；46 份自动报告全部缺 latency，不能把 71 当独立故障数。48 份现存报告均无持久化 startup/build；13 份事件时间全部钳到 600000。
- [72 小时入口证据](../reports/evidence/2026-10-17-three-day-review/signal-entry.json)：4032 次离散巡检，25 次 formal 探针失败（包括 2 次恢复 tick），不能换算完整可用性。两次既有恢复耗时 330/33 秒，第一次完成后仅 68 秒即开始第二次，最大巡检间隙 398 秒。origin refusal 与已有本地重载窗口重合，不能归为 Cloudflare 根因。

缺少原始日志的时间段保持未知；不上网补猜，不把部署目录的版本当作长开浏览器的版本。

## 2. 方案选择

| 方案 | 取舍 |
|---|---|
| 延长所有超时、失败就清凭据或刷新页面 | 会继续混淆认证与网络错误，可能丢失草稿和控制上下文；不采用 |
| 保留现有入口，补结果分类、操作代次、资产保留和有界观测 | 直接覆盖已复现路径，可在临时目录/内存中验证；采用 |
| 引入 Service Worker、全套监控平台或新的入口 | 扩大缓存、部署和运维状态空间，本轮没有必要；不采用 |

W1–W4 分别交付认证/资源、巡检、诊断、前端开销，内部按可独立审查的任务拆分。共享 webrtc.js、input.js、diagnostic.js、host.py、signaling.js 必须在 C/M 前置任务完成后串行适配，不覆盖原有未提交修改。

## 3. Global Constraints

以下内容须逐字复制到各执行计划的 Global Constraints：

1. 用户后续已明确授权本轮开发、验收、启动本地 Signal/Host 并保持可用；不得停止、重启或重建 tunnel。生产 Viewer 仍须避开正在使用的会话。
2. 后续实施沿用严格单桌面 Viewer、控制租约和 fail-closed reset 屏障；不重放投递结果不确定的点击、文本或命令。
3. 不自动切换网络模式、TURN 节点或公网地址；保留 Quality Lock，不自动降低用户选择的分辨率。
4. 生产 Viewer 验收必须有明确维护窗口；普通检查不得创建会抢占用户控制的 Viewer。
5. 默认不增加运行依赖；纯函数、fake-clock 和模拟适配器测试不得启动真实抓屏、输入或公网连接。
6. 缺测使用 null/unavailable；不以 RTT/2、跨机 wall clock、frame_timing 到达或ACK冒充实际单向传输或可见效果。
7. 日志不保存键码、文本、剪贴板、坐标、token、完整URL或原始输入ID；仅保存有界关联摘要、状态和阶段耗时。
8. 不运行会重建生产dist的 npm test/pretest；定向使用 node --test、unittest 或已有独立临时构建入口。
9. 未做的真实公网、设备、光学或长时间验收必须标为 NOT RUN，不以单元测试通过替代。
10. 每个任务只提交该任务的文件或明确选择的改动，不夹带任务开始前的无关修改。

“仅诊断和文档”约束描述当前授权。计划中的代码步骤是后续获实施授权后执行的内容，不是本轮完成声明；本地部署和tunnel操作继续遵守runbook及用户直接授权。

## 4. W1：认证和资源加载

### 4.1 明确认证结果与有界请求

新增 bounded-request.js，提供 fetchJsonWithin(url, init, {timeoutMs, fetchImpl, setTimer, clearTimer})，统一覆盖获取响应和 JSON 读取；默认 login/verify 总截止 8000ms。超时触发 AbortController 并结算一次，fetch 实现忽略 abort 时仍必须通过 Promise 截止返回；迟到结果不改变已结算操作。异常只返回有限 reason，不把响应正文、密码或完整 URL 放入诊断。

Auth.verifyToken() 返回以下对象；Auth.init() 保持 boolean 调用兼容，但只有 verified 才返回 true：

~~~ts
type AuthCheck = {
  state: 'verified' | 'unauthorized' | 'unavailable';
  reason: 'ok' | 'missing-token' | 'invalid-token' | 'timeout' |
          'network' | 'server' | 'invalid-response' | 'superseded';
  httpStatus: number | null;
};
~~~

仅应用认证端点的明确 401/403、JSON valid=false 且已知认证错误，或明确 missing-token，视为身份失效。代理 HTML 403、429、5xx、离线、超时、坏 JSON 都保留 token。比较请求开始的 token 和操作 generation，旧请求的 401 不得清除之后登录的新 token。验证临时不可用时显示重试入口，不把它伪装成已验证，也不触发服务或 tunnel 重启。

登录表单抽到 login.js，最终只有当前 operation 可以保存 token、跳转或恢复按钮状态。提交在进行中复用/拒绝重复操作；用户重试先递增 generation、取消旧请求。失败后按钮有界恢复，不能自动重放密码请求。构建时本地 login bundle 包含 bounded-request + login，无外部 CDN。

### 4.2 延迟模块按资源分别管理

createAssetLoader 维护每个 src/href 的 idle/loading/loaded/error 状态及底层单一请求；操作层另有 generation 和 5000ms 截止。Terminal ready 必须同时满足 CSS loaded、JS 已完成注册、init 成功；不能因 TerminalPanel 存在而跳过失败样式。成功 JS 不重复注入，失败 CSS 可以单独重试。

script 标签的移除不能保证浏览器从未执行其代码。超时但底层请求结果未知时，重试只重新等待同一请求，不并发注入第二份同 hash classic script；旧 operation 的回调不得更新新 operation。已知网络 error 后允许新的加载尝试；代码部分注册或解析结果不确定时提供显式刷新，避免全局 const 重声明。Diagnostic.init 与面板 interval 采用一次性初始化/显式销毁，迟到 load 不创建重复 timer。应用截止不声称取消了浏览器底层所有网络活动。

deferred 诊断也消费该 loader，故障时 core 诊断仍可工作。ShellGuard 保留 5000ms core deadline；迟到 core 安装只能完成一次、关闭过时的失败提示，不自动重复 Start。任何全页刷新由用户显式操作，先展示未完成草稿状态，不自动重发未知结果的输入。

### 4.3 保留旧 hash 资产

buildWebClient({sourceDir,outDir,now,retention}) 在临时 staging 内先验证新资产，再复制历史 manifest 指向的合法 hash 文件。默认最多 3 个 release、额外历史 72 小时、唯一资产总量 64 MiB；当前及紧邻上一 release 必须保留，上一版不因年龄单独淘汰。若保住这两版已超过空间预算，发布失败并保持现网目录，不能为通过预算静默删掉上一版。额外历史先按年龄、再按数量/字节淘汰。

manifest v2 保存当前 buildId、builtAt、assets 和有界 retainedReleases；不携带源码路径、环境或凭据。buildId 是规范化当前资产清单的内容摘要，同时注入 __WRD_BUILD__。只复制受验证的 assets/<stem>.<hex>.(js|css)，禁止路径逃逸；复制后校验内容 hash。保留既有 HTML revalidate/no-store 与 hash 资源 immutable 策略，且承认现有目录 rename 发布不是多文件事务级零间隙保证。

旧页面加载错误后最多进行一次有截止的 manifest 版本查询；确认版本已淘汰时显示刷新入口，不无限请求同一失败 hash。不自动替换当前页面的 core，也不创建新的 Viewer。跨 A→B 发布后首次加载 A 的未缓存 lazy 资源、再发布 C 后的有限保留，都在独立临时 outDir 验证。

## 5. W2：入口分层巡检和恢复时间边界

### 5.1 结果类型与层级

扩展既有 wrd_entry_health.py，不把所有失败折为布尔值。结果至少为：

~~~ts
type ProbeResult = {
  schemaVersion: 2;
  layer: 'origin-health' | 'formal-health' | 'login-html' |
         'viewer-html' | 'core-asset' | 'passive-runtime';
  outcome: 'ok' | 'failed' | 'unknown';
  stage: 'dns' | 'connect' | 'tls' | 'headers' | 'body' |
         'content' | 'deadline' | 'passive';
  reason: string; // 有限枚举，不保存原始异常正文
  httpStatus: number | null;
  elapsedMs: number; timeoutMs: number;
  proxyMode: 'environment' | 'direct' | 'unknown';
  resolverMode: 'system' | 'configured-public' | 'unknown';
  bytesRead: number; observedAt: string;
};
~~~

默认探针继续使用原配置路径，但显式标注代理/解析方式；direct 对比只在配置允许的诊断请求执行，不以不同代理路径的结果互相冒充。持久化 layer/routeClass，不保存 checked_url 或代理地址。新 timeout 参数贯穿 DNS fallback、每个候选地址、HTTP body 和子进程；所有阶段共用一次截止，不为每个阶段重新获取完整预算。

health 每 60 秒一轮；login/viewer HTML 和当前 core 资产最多每 5 分钟一轮、每轮串行且共用 15 秒预算。核心资源最多读 1 MiB；HTML/health 64 KiB，超限记录 content-limit。Manifest 先验证路径，禁止跟随到未知 origin。页面/资源检查不登录、不建立 Socket Viewer、不发送输入。业务 ACK、新鲜画面、Host 队列只读已有被动快照；没有样本时是 unknown，health=200 不能补成 healthy。鉴权 API 通过 W1 的真实既有会话结果观测，不向公网自动发送密码或创建会话。

### 5.2 截止、冷却和恢复隔离

保留现有 180 秒失败阈值、300 秒冷却、每 3600 秒最多 2 次恢复预算；不新增启用恢复的权限。WRD_FIXED_WAIT_SEC=45 改为真实单调总等待上限，探针/只读 tunnel-info 子命令只获得 min(单次预算,剩余预算)。超时只能终止本次拥有的探针子进程，不能对运行 connector 或其他项目执行宽泛 kill/pkill。

恢复启动与完成分别记录。失败/超时同样消耗一次预算；只有确认本次恢复 worker 及它可能改变服务状态的子命令已结束，才记 terminal 并从该完成时刻开始 300 秒冷却。超时终止并回收本次拥有的 helper/probe 子进程，不终止 connector；无法确认结束或操作结果时保持 in-flight/unknown，继续阻断后续恢复。一次恢复在途时不启动第二次；独立采样继续运行，只记录恢复中的实际探针结果，缺测为 unknown。使用固定单调 tick deadline，慢轮次只跳过错过的 tick，绝不并发补跑积压轮次。记录 scheduledAt/start/finish/skippedTicks。

执行状态由单一 watcher writer 持久化，包含 operationId、worker PID/start identity、在途状态与已消耗恢复预算。恢复互斥锁覆盖 worker 及变更子命令生命周期；丢弃迟到 result 不能代替副作用隔离。watcher 重启先核对并认领已有 worker，无法确认身份或完成状态时保持 unknown 锁定，不能仅凭 PID 或冷却到期解除。持久化 monotonic 值带 boot/clock epoch；epoch/history 不可信时不跨重启相减，保留已消耗预算并从首次确认未知时钟起完整等待 3600 秒保守窗口，不能 300 秒后重置恢复次数；仍有 unknown/in-flight 时窗口到期也不放行。现有 token connector、multiple-owner、origin-down 保护继续有效。probe unknown、仅资产失败或恢复过程中单点失败不扩大 tunnel 自动恢复条件。本轮只写其设计和测试，不运行 watcher 或恢复脚本。

## 6. W3：统一、可保留的运行诊断

### 6.1 唯一耗时生产者

M1 提供以下接口，W 原样消费，不计算/重算阶段、分位数或 RTT 剩余：

~~~ts
type MetricSummary = {
  last: number | null; p50: number | null; p95: number | null;
  count: number; available: boolean; lastSampleAgeMs: number | null;
};
type LatencySnapshot = {
  schemaVersion: 3;
  scope: { connectionAttemptId: string; generation: number; leaseEpoch: number } | null;
  windowMs: 5000;
  metrics: Record<string, MetricSummary>;
  outcomes: { sent: number; acked: number; rejected: number; timedOut: number;
    late: number; cancelled: number; dropped: number; unmatched: number };
};
~~~

调用为 LatencyMonitor.snapshot({nowMs,scope})。M1 的 web-client/js/latency-monitor.js 通过 classic-script 全局及 CommonJS 导出 LatencyMonitor、LATENCY_METRIC_NAMES、createLatencyMonitor；require 仅定义，不启动 timer/DOM/连接。W 的服务端校验器直接消费同一白名单。metrics 为 5 秒窗口，outcomes 是当前 scope 累计并饱和，不得跨重复报告相加。

白名单由 M1 唯一定义：frontendDispatchMs、inputAckRttMs、hostAdapterAwaitMs、hostQueueMs、hostApplyMs、signalForwardMs、signalAckForwardMs、inputToFrameNoticeMs、inputToPostApplyFrameMs、inputToVisibleEffectMs、relayFrameAckRttMs、paintIntervalMs、freshFrameAgeMs、candidateRttMs、jitterBufferMs、decodeMs、recvBytes、elapsedMs、captureGrabMs、captureAgeAtRecvMs、capturePrepareMs、frameConvertMs、imgprocQueueMs、imgprocBuildMs、encoderMs、packetizeMs、encodeTotalMs、rtpApiAwaitMs。recvBytes 为字节，elapsedMs 为区间长度，不能当时延相加；rtpApiAwaitMs 只是 Host 单包 API 成功返回，freshFrameAgeMs 只在已关联新 captureSeq 时按 Viewer 同钟计算。freshFrameAgeMs 是即时 gauge，count=1、p50=p95=last 仅为 schema 占位，UI/报告只展示当前年龄，不能解读为分位分布。UI 以 M1 名字显示“输入确认往返”和“受控可见效果”，后者缺测显示未测量。

M1 的 takeClosedScopeSummaries({nowMs}) 原子取走 {summaries:[{endedAtMs,snapshot}],dropped}；其 final snapshot 已先 expire 并结算 cancelled，最多 4 份/60 秒/32 KiB。W 只有一个消费点，在构建诊断时 drain 到自身有界 pending 队列，作为 scope-ended 事件按同一 redactor 持久化；失败重试复用该事件 ID，不重复 drain 或把旧 outcomes 加到新 scope。消费者未加载或队列满时保留 dropped 与覆盖缺口；不声称所有断线 scope 一定持久化。W 队列也限制为最多 4 份/60 秒/32 KiB；RuntimeDiagnostic.scopeEnded 只携带该有界事件快照，传输成功按 eventIdHash 移除，失败保留同 ID 重试，服务端幂等持久化且同样清洗 snapshot scope。该事件不改变主 LatencySnapshot schema。

### 6.2 buildRuntimeDiagnostic

W 提供 Diagnostic.buildRuntimeDiagnostic({reason})，在 diagnostic-core 即可用，手动 sendLogs、autoSendFailure 和 pending replay 使用共同生成器。deferred/M1 未到时 latency=null、latencyStatus=collector-unavailable，不启动补载、不阻塞故障上报。重放使用故障时保存的快照；另可附当前发送年龄，不能把故障快照悄悄替换成重放时状态。

~~~ts
type RuntimeDiagnostic = {
  schemaVersion: 3;
  diagnosticId: string; // 页面内随机摘要标识，重传保持不变
  reason: string | null;
  captured: { wallTime: string; monotonicMs: number; bootIdHash: string };
  build: { id: string | null; builtAt: string | null };
  latencyStatus: 'available' | 'collector-unavailable';
  latency: LatencySnapshot | null; // 内存类型；落盘 scope 经 redactor
  inputState: object; inputTrace: object; startup: object;
  resources: object | null;
  scopeEnded: { events: Array<{ eventIdHash: string; endedAtMs: number;
    snapshot: LatencySnapshot }>; dropped: number };
};
~~~

RuntimeDiagnostic 内部 scope 仅供关联；持久化 scope 使用 attemptHash/generation/leaseEpoch，不能保存原始输入 ID 或直接复制未经清洗对象。指标白名单、有限非负值、年龄和 count 校验，不改变合法 last/p50/p95 的意义；unknown 字段丢弃，null 保留 null。startup 限 64 个已知 mark、10 个同源相对 hash 资源名，不保存 query/完整 URL。

inputTrace 改 schema v3，at 为同 boot 的非负安全整数相对时间，不再钳制 600000；另存捕获时的 traceNowMs，使 eventAgeMs=traceNowMs-at 可在同一时钟域求得。单独 bootIdHash 区分页面刷新，不能用 sessionStorage 的 browserSessionId 代替。wallTime 只用于对齐人工日志并标明客户端时钟，不保证跨机精确。服务端 receivedAt 单独记录；迟到重放保留原 captured 和 diagnosticId。

序列化总报告默认上限 128 KiB，inputTrace 保留原 64 KiB/256 条上限；pending 队列最多 10 个 attempt，单条和总字节预算都验证。截断增量记录 dropped/truncated，不能丢失 schema、reason、build、captured、latencyStatus 等解释字段。自动上报沿现有 15 秒 attempt 冷却，重复 diagnosticId 不追加独立事故记录。

### 6.3 留存与摘要

修复 cleanupDiagLogs 保留最新而非最老：现有 per-viewer/total 兼容上限默认 3/50，按 receivedAt 排序；旧文件缺 receivedAt 才用 mtime 并标记 fallback。新报告写入临时文件并原子 rename 后清理，稳定总量不得变 51。清理仅读取自己目录内普通 JSON 文件，不跟随 symlink；解析失败文件记录 malformed 并按隔离规则处理，不能错误删当前有效报告。

有限原始文件无法保证三天明细，所以另保留 7 个 UTC 日的脱敏 NDJSON 摘要，每日上限 8 MiB/10000 行，总 56 MiB。摘要先于 raw 清理写入，字段仅含 diagnosticIdHash、接收/捕获时间、build、有限 reason/state/mode、采样数量及 raw SHA。每条 report 最多一条摘要；最近 10000 个 diagnosticIdHash/24 小时的索引用于幂等，超出窗口后声明去重能力限制。达到容量时按最旧记录淘汰，单独记录 droppedSummaryCount、最早保留时间和覆盖缺口，不把达到上限写成“健康”。支持范围查询时先按原始 SHA/diagnosticId 合并 raw 与 summary，避免本轮补摘要式双计数。

### 6.4 资源与 Signal 观测

W 独占新增 python-host/runtime_observability.py：RuntimeObservability.observe_loop({scheduled_ns,observed_ns}) 记录所有 1Hz 观测（含零/低值），60 秒窗口最多 120 条；错过 tick 记录 missedSampleCount，不补零。每 5 秒输出有限摘要，原阈值告警继续保留，但告警子集的 p95 不充当完整采样分位数。RSS 使用独立采样得到的当前值，原 ru_maxrss 改名 peakRssMiB；失败则 currentRssMiB=null。任务/线程数由当前 Host 读取，不扫描别的项目 payload。

RuntimeObservability.register_queue(name,snapshot) 接受 inputReliable/inputUnordered/relayFrames；消费 M3 队列 snapshot() 的 pendingCount/pendingBytes/inFlightCount/droppedCount/frozen 五字段，无 hook 则 null。snapshot(now_ns) 只返回现成摘要，不在诊断回调里执行 ps/vm_stat。

scripts/wrd_resource_snapshot.py 是显式启用的只读采样器，默认 5 秒、每轮总预算 1000ms、不重叠；仅系统汇总与显式登记的本项目 PID，不按进程名称清理其他应用。采集当前 RSS、系统页大小及 swap-in/out 计数差分/elapsedMs，counter reset 或首样本输出 null，memoryPressure 无受支持的只读来源则 unknown。外部命令在专属 worker/子进程运行且超时；stdout 有界，只有单个最新原子快照和有限环，不在输入线程做系统采样。

Signal 用现有 observability 模块记录自己的 RSS/完整低频 event-loop 统计。signaling.js 的 disconnect callback 保存白名单 reason 与已脱敏会话摘要，不记录完整请求/地址。这些是资源阶段指标，不能更改 C 的授权或 M 的计时。所有真实资源与性能收益仍需维护窗口验收。

## 7. W4：前端观测热路径

### 7.1 ACK 采样不改变 ACK 处理

在 Socket/DC 的真实 ACK 接收入口、业务处理删除 pending 之前只读截取原 action/可靠性/匹配摘要；所有 ACK 随后交 C/keyboard transport/M1 完成真实处理，再由 InputTrace 决定是否保留诊断事件。匹配 pending 的 reset、down/up、text/chord/batch、拒绝、迟到和 timeout 必须保留；已确认无 pending 的 unordered move/wheel 成功 ACK 只更新有限计数，不新增整环事件。不能只看 action=ack 或 accepted=false 采样，因为 move appliedSeq=0 可有正常 unordered ACK；未知 ACK、错误状态保守保留。

字节预算按每条已脱敏 event 的序列化长度增量维护；hash 异步完成更新对应 entry 的长度，eviction 同步减账。每次 append 不再全环 stringify/encode；导出 snapshot 时做一次最终总量校验。保持 256 events、64 KiB、64 hash jobs、256 pending ACK 的现有限额及 drop/eviction 计数，不以“更快”为由降低可靠 ACK/超时证据。

### 7.2 状态变化才更新 DOM

不能在 markMediaAttemptReady 或 Input.setActive 顶部简单按布尔值 early-return，因为同一 active 状态内可能出现 recovery、draft、lease 或键盘变化。先执行 C 的安全状态推进，再针对派生的 UI model 去重；ChromeLayout 使用 per-root WeakMap 缓存已渲染模型和已挂载节点。node 替换、主题/locale、viewport、Terminal、lease/gate/draft 改变时失效；相同模型不重复写属性/class/aria。

rVFC 每帧仍更新 frame sequence、呈现时刻、M 的关联及 C 的 fresh-frame barrier。布局几何只在 ResizeObserver/visualViewport/fullscreen/方向变化时失效，frame 上最多消费缓存；必须实时的输入坐标映射由既有几何状态验证，不能因节流使用已知过期几何。旧 attempt 的 scheduled UI callback 不得重新打开门禁。

验收比较的是行为与操作次数：相同模型连续 200 次不重复 DOM 写入，单字段变化立即正确更新；不是宣称获得某个 CPU 百分比。真实浏览器 profile、主线程长任务和最终可见效果收益标为 NOT RUN，待维护窗口测量。

## 8. 验证与交付

| 证据/问题 | 行为回归 | 任务 |
|---|---|---|
| N7/N10 | 503/代理403保留token；明确401清理；超时/迟到/新token隔离；登录按钮恢复 | W1a |
| N9/N10 | JS成功CSS失败后只重试CSS；pending script超时不并发重注入；旧回调不覆盖新状态 | W1b |
| N8/D3 | 临时 A/B/C 发布旧lazy hash仍可读；空间不足保住现版；build身份 | W1c |
| N5 | 总等待45秒、单命令剩余预算、完成后300秒冷却、一次在途且仍采样 | W2a |
| N6 | health成功而资产失败；proxy/DNS/HTTP区别；unknown不升级恢复 | W2b |
| L9/L1显示适配 | 自动/手动同schema；M数值不重算；core无collector也有诊断 | W3a |
| D1/D3/D6/留存排序 | 15分钟时间递增、旧boot分开、迟到重传、最新3/总50、摘要先保留和有界去重 | W3b |
| N1/D2/D4/D5 | 当前RSS/峰值分离、swap差分、完整低频lag样本、Signal reason | W3c |
| N11/N12 | unordered观测采样不丢业务ACK；增量预算；相同UI无写，门禁变化仍生效 | W4a/W4b |

当前只检查文档、一致性和已有离线证据，没有执行这些后续回归、构建、部署、外网或设备验收。实现每个任务后做独立 review 与小提交；保持报告的问题编号和“不冒充端到端”口径。最终运行至少 3 小时的真实 Viewer 验收必须另有维护窗口，且不能抢占当前用户。
