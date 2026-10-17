# 2026-10-17 公网运行验收

当前部署：`58ad766`（生产增量 `d1166ab`），网页 build `c30530f331a4def5`；本地 Signal/Host 在线，Cloudflare tunnel 未变。此前 M6 两条媒体路径生命周期短测 PASS；93.094s 信令断线仍为 INCOMPLETE。服务端心跳观测已加载，新一轮 300s TURN 连续性测试已 PASS，独立 3h 测试进行中；不能提前声明三小时或真实输入验收通过。

本报告追加真实运行证据，不能以源码复审或本地 health 代替公网可用性。所有测试使用正式入口；创建自动化 Viewer 须 fresh zero-Viewer + 一次性 proof，人工显式连接优先。未发送业务原生输入、剪贴板或 Terminal 命令。

## 媒体生命周期

| 运行 | 结果 | 已确认与限制 |
|---|---|---|
| c5-media-relay-a | FAIL / readiness deadline | 网页、proof、登录通过；脚本未保留 Start 证明，62 样本无 Socket/PC。发现 helper 一次检查按钮可见性可能静默跳过 Start；不能据此认定服务回归。 |
| c5-media-relay-c | PASS / 93.816s / 85 样本 | 真实 Start、3 健康样本、5s baseline、暂停确认/关闭 gate、恢复新确认/当前帧/gate、60s 同会话持续画面均通过。恢复到连续三健康样本约 4.010s，自有浏览器已关闭。 |
| c5-media-tunnel-a | FAIL / 51.924s / 48 样本 | JPEG 暂停/恢复通过；随后图像 load age 5434.5ms，Socket/控制租约仍在线，未通过 60s 连续性。 |
| c5-turn-soak-a | INCOMPLETE / 0 样本 | 计划 3 小时，但真实 Start 证明通过后 45s 内未进入 media-ready；尚无持续采样。不可计为 3 小时或短时通过。 |
| c5-media-relay-b | FAIL / pause UI timeout | 修订后真实 Start 点击、3 个连续健康样本、5 秒 baseline 均通过；当前 receiver track、decoded/rVFC 进展、有效 input gate 已确认。暂停点击未发生，不能计暂停/恢复 PASS。 |

b 的实际启动观测保留了认证完成前 Start hidden/disabled，随后 auth=verified 时显示可操作、真实 `start-click` 从 0 增至 1。这支持修订等待逻辑，但不能倒推 a 未留存的具体时序。b 的末个 baseline 样本 Socket/PC connected、ACTIVE controller、inputAllowed=true、1152×720、135 次 rVFC，最新回调年龄 40.9ms。普通 chrome 自动收起会将底部工具栏移出视口；后续工具须经真实顶部“显示控件”按钮操作，不能 force click 或调用媒体 setter 绕过 UI。

b 的 9 个可用 gate 样本中，candidate RTT 的各样本 last 值 29–43ms；8 个有效样本 jitter buffer last 6.0–12.2ms、decode last 0.594–0.768ms；paint interval last 16.6–83.3ms。这些是短窗口指标的最近值范围，有重复/重叠可能，不是独立事件总体分布或 P95。RTT 不等于单向传输；缺少真实输入后 encoder/fresh causal frame 数据，不能将这些相加得到输入到画面。

## 网页真实登录采样

5 个全新 context，4 次获得核心就绪标记，第 3 次登录阶段超时。共 2 个自有 browser/5 个 context 关闭已确认。只登录、不 Start；被动观察未出现自有 Viewer Socket、proof、准入票据或 Terminal 请求。已读 build 均为上述部署版本。

| 序号 | Viewer 导航→core | 登录请求开始→core | 结果 |
|---|---:|---:|---|
| 1 | 4389.3ms | 5359.6ms | OBSERVED |
| 2 | 3819.3ms | 5067.3ms | OBSERVED |
| 3 | 缺测 | 缺测 | ui-login TimeoutError；保留，不替换 |
| 4 | 2156.5ms | 3261.0ms | OBSERVED |
| 5 | 1418.5ms | 2494.6ms | OBSERVED |

核心就绪只表示 handler 已安装，4 次成功中的 3 次在该采样时点仍未 authVerified；稍后 250ms idle 观察均已验证。不能把 core 当作 Start 可点击时刻。五次无法证明总体 P95/SLA；状态接口 10 次 unavailable，不能证明外部 Viewer count/epoch 未变。失败尚需对齐已留 HTTP 阶段证据，不能直接归因 Cloudflare、DNS 或 Host。

## 输入到画面与未完成项

实际业务输入、native apply→capture→RTP→rVFC、真实可见 marker、物理显示均 NOT RUN；参见[原生输入验收边界](2026-10-17-visible-effect-acceptance-boundary.md)。输入门禁开放只证明协议允许输入，不证明每种设备/键盘/触控的实际执行。普通用户自动重连无法通过消费过的一次性 proof 会话代替；不绕过保护。每条路径 3 小时连续运行及主动场景覆盖仍未完成，未宣称彻底验收通过。

## 私有证据

- `/tmp/wrd-public-c5-media-relay-20261017a` / `...17b`：结构化样本与 summary，0600，浏览器清理确认。
- `/tmp/wrd-entry-timing-combined-J11qtb-20261017/summary.json`：5 次合并记录，第三次失败原样保留。
- `/tmp/wrd-media-lifecycle-private-HiqscA/START_UI_REVISION_REVIEW.md`：修订依据、白名单字段和静态验证。

私有证据仅作为本机复核线索；版本化文档保留可阅读结论、条件与缺测，不保存凭据、原始 session/input ID 或屏幕内容。


## 新复现的 JPEG 缺陷与处理状态

详见[JPEG 故障诊断](2026-10-17-jpeg-stall-diagnosis.md)。实际运行中 Host 被两个未确认帧阻塞，回执耗时 6876/6677ms，超过收集器 5s 新帧门槛后才到达；首个慢跳未定位。Host 事件循环仍在运行，不等同于整机停顿。独立离线调用实际方法另证实：超时不会退役发送槽位，ACK 乱序会留下旧槽位，结合 volatile 丢帧可能无限停止抓图。帧/ACK 也缺完整 producer/attempt/media-generation 来源，旧队列帧可能被盖上当前 scope。该项正在补充 M6 设计和实施，未以重启暂时出画宣称修复。

TURN c 的恢复后 61 个 1Hz 快照覆盖约 60s，rVFC 增加 928（约 15.5 次/秒，观察窗口平均回调率，不是目标档位）。各窗口 last 值范围：candidate RTT 27–163ms、jitter buffer 1.2–146.1ms、decode 0.576–2.254ms、paint interval 16.6–333.4ms；不能将重叠窗口的 last/p95 再统计成总体 P95。H.264、实际双侧 relay/UDP，末次 stats framesDropped=0。全程累计 maxFrameGap 4766.6ms 包含主动暂停，不作为恢复后无意卡顿；恢复后每个 5s 窗口均有当前帧进展。输入 ACK、输入到真实可见效果仍无有效样本。

## 网页分段观察补充

前 3 次 Login HTML 的 TLS 阶段分别 3715.4/3707.8/4250.9ms，后两次 720.0/650.2ms。Login 导航到 DOMContentLoaded 12648.5/17463.3/15257.3/2907.6/2241.9ms；响应结束后到 DOMContentLoaded 8035.9/9255.8/10033.9/1175.5/1124.4ms。TLS 属于建连子阶段，不能重复求和；后者包含资源依赖和执行调度，不是纯网络耗时。第 3 次登录失败窗口 09:05:57.023–09:06:47.061（末值是落盘上界），只见 POST 发起，不能确认请求最终 pending/failed/abort，也不能据 harness TimeoutError 认定产品 8s deadline 已触发。

旧资源 probe 的状态检查使用独立 urllib，将 HTTP、TLS/网络、body/JSON/schema 问题折叠为 unavailable，因此 10 次不可用不能判定浏览器网页宕机。后续采用浏览器同源且保留固定错误分类的只读 probe 继续定位。Playwright `Response.finished` 后台 watcher 的 Target closed warning 已在私有工具离线修正；原数据未改，不是已证实的服务端错误。

## 未登录资源与同源接口复查

09:24–09:28 的三次新 context 导航均取得登录 HTML 200 和预期 build，没有登录 POST、Start、Viewer Socket 或 Terminal。第一轮因工具尚未识别额外跨域资源/自动 POST 而停止；这是工具保护分类失败，不是产品连接失败。后两轮确认该自动行为为边缘遥测类别后完成；三个 context、两个 browser 均已关闭。

三次 DOMContentLoaded 分别为 2134.1/2044.4/1958.1ms；HTML body 结束至 DCL 为 964.1/960.3/989.8ms，没有复现先前的 8–10s。HTML TLS 为 680.6/606.3/555.3ms，TTFB 469.1/464.0/410.8ms，body 1.0/3.4/0.7ms，均为 HTTP/2。应用 CSS 约 417–460ms，主要在 TTFB；应用 JS 约 210–615ms，其中一次约 418ms 在 requestStart 之前，缺少队列/优先级 trace，不能归为网络 TTFB。

额外脚本耗时约 886–912ms，并在 DCL 前约 5–6ms 完成；时间相邻支持继续检查该依赖，但没有 defer 属性、主线程 trace 或禁用对照，不能判定因果，更不能用这些新样本解释先前慢样本。跨域资源缺少 TAO 细分数据，DNS/TLS/TTFB/body 保持缺测。第一轮原 JSON 将不可见 body 错算为 2128.8ms，报告已更正为缺测，原始证据未覆盖。

09:28 的两轮浏览器同源 `/health` 和 `/api/status` 均 200、有效 JSON；Host 在线、Viewer 数为 0。health 耗时 1003/1077ms，status 1001.2/1058.2ms。与旧 urllib 检查的方法和时间均不同，不能倒推出旧失败属于哪一层。小样本只证明这些时点可达，不构成 P95、连续可用率或输入验收。

可复核私有证据：`/tmp/wrd-login-resource-private-J11qtb-20261017/REPORT.txt`、`analysis.json`、`STATIC_REVIEW.txt`。

## TURN 长测启动失败的界定

`c5-turn-soak-a` 的日志关联窗口为 09:21:40–09:23:30。Host 持续采样但 PC/ICE 为 none、relay 未运行、captureSeq=0，未见新 offer 或新媒体 producer；Signal 有 bootstrap 与 dc-stuck 诊断，但未留足本次浏览器准入、控制 grant/reset 和媒体状态。日志中的无时间戳 `Connection:viewer` 在准入检查之前输出，不能证明成功准入。未观察到普通 Viewer 顶替，也没有证据支持上一轮 JPEG generation 2 污染新 TURN generation 0；代码在新 attempt 上初始化 generation 0，且本窗尚未到 offer 阶段。

因此原因保持未知，不能归因 TURN 网络或认定 proof 过期。现有工具在登录前领取默认 30s 一次性 proof，慢登录可能消耗有效期；整改将证明领取移至真实 UI/auth 就绪之后、Start 之前，并加入启动阶段白名单快照。仍需 fresh zero-Viewer、当前登录 token、一次领取一次使用；不能通过重领、清除 proof 或普通票据绕过准入。该调整是验收可靠性修复，不是前次故障因果结论。私有诊断：`/tmp/wrd-turn-soak-start-diagnosis.md`。


## Proof 时序修订后的 TURN 复测

`0a89ebe` 验收工具经独立 review 后部署，无服务重启。`proof-timing-turn-a` 请求 300 秒，真实登录/Start 和首帧均成功；实际采样 173.094 秒、174 行，未缺样/迟采，随后信令断开，结果 INCOMPLETE，不计五分钟或三小时通过。运行 build 仍为 `b73325b8166441a6`。这证明新工具能完成本轮启动，不证明前次失败必然由 proof 过期引起。

末样本 Socket=false、PC=connected，H.264 双侧 relay/UDP，RTT 31ms；rVFC 从上一秒 1932 增至 1938，帧年龄 7.5ms，framesDropped=0。leaseEpoch 已从 15 清为 0、inputAllowed=false；即使 controlState 的旧展示仍是 ACTIVE，也不能称有效控制仍在。视频仍出帧而信令先断，符合应继续定位信令路径的证据。最大观察帧间隔约 1899.9ms，不能等同输入到画面。

Signal 09:49:02.126 的断开 reason=transport close，09:49:10.132 grace 到期后清理，Host 09:49:10.137 才关 PC。末样本落盘 09:49:02.050 早于该日志；脚本在观察到断开并取 startupSummary 后关闭自有 browser，所以确有先观察到的客户端断线，但 server close 与清理同窗，仍无法确定最初主动关闭端或心跳超时原因。Host 同窗 loop rolling max 约 9.8–10.2ms，无 Host 断线；formal watcher 相邻探针正常不能排除短暂 WebSocket 故障。

当前首次客户端关闭 reason、engine 心跳和清理前事件尚缺，首因 UNKNOWN。不自动重领 proof，也不把一次性测试会话的重连限制当成普通用户重连失败。下一步补充有界脱敏的现有 Socket/engine 事件观察后重测。私有证据：`/tmp/wrd-public-proof-timing-turn-20261017a` 和 `/tmp/wrd-turn-signal-drop-diagnosis.md`。


## TURN 新鲜度、缓冲与显示频率

`proof-timing-turn-a` 的 173 个断线前快照覆盖 172.0015s，rVFC 回调增加 1923（11.18 次/s），解码增加 3335（19.39 帧/s）；新采集 captureSeq 约 8.84 次/s。相邻约 1s 快照的回调增量为 2–20、中位数 12、无零增量。rVFC 观察器没有保留 metadata.presentedFrames，因此不能用这两个速率之差宣称视觉丢失 42%。36 个稳定捕获日志窗口共有 3482 输出、1908 缓存复用（54.80%）；新编码 PTS 不等于新内容。

区间每 emitted 单位的缓冲均值最高 742ms；启动后约 157s 仍出现 725.1ms、同期 candidate RTT 31ms。10 个断线前快照的最近缓冲值至少 250ms，另有末个失败样本；不是完整事件分布。decode 最近值约 0.544–2.219ms、RTT 29–131ms。后段 loss/NACK、解码空窗和追帧表明不能全部归为启动暖机；具体哪一跳及调度因素未定位。Host VideoToolbox 5s 编码摘要平均大多约 4–5ms，稀疏最大约 100–166ms；不含 executor 等待和逐包发送等待，也不能直接与接收均值相加。

另已确认 UI/上送将缺测缓冲/RTT 转成 0 的代码缺陷；本 artifact 的 LatencyMonitor 直接使用原始值，不能用此缺陷否认已有正值峰。原始 stats timestamp/inbound identity、presentedFrames 以及逐次截图耗时未导出，是下一步进一步归因的缺口。完整方法、源码与日志分母见[媒体性能诊断](2026-10-17-turn-media-performance-diagnosis.md)。


## M6 新版 JPEG 公网生命周期短测（2026-10-17 约 10:50）

运行代码 `966890b`、build `f5c2a9203e47f9e5`。`/tmp/wrd-public-m6-media-tunnel-20261017a` 为 PASS：85.034304s、84 样本、0 缺失，owned browser 已关闭；随后本地 Host 在线、Viewer 0。真实 UI 登录及 Start、fresh zero-Viewer 单次 proof、三个连续健康样本、5 秒基线、真实 UI 暂停/恢复均通过。恢复到三个连续健康样本用时 4.009457s；新媒体 generation、完整 producer 来源、应用 ACK、合格新图和有效输入门禁均匹配。

恢复后 61 个快照覆盖 60.0025s，load 增量 228（约 3.8 次/s），合格 load 年龄采样最大 500.3ms；同一来源未变，当前来源 RTT 有效样本在该窗口内到达。RTT 快照值范围 405.50–633.88ms；这是 Host 同钟 JPEG 反馈往返，经过 2000ms TTL 右截断与每间隔最新样本合并，不是总体 P95、单向传输或输入可见耗时。末次反馈 expired=2、unmatched=0、timeout=0、coalesced=181、pending=1；真实过期槽被回收后出图继续。

1Hz 检查证明采样时的新鲜度及滚动窗口进展，不能排除采样间的短暂状态变化；累计最大 load gap 4200.3ms 含计划内暂停，不当作稳态故障。原 `8e375fa` JPEG FAIL 保留。该次短测不关闭三小时、普通用户自动重连、业务输入、原生可见效果或光学验收。TURN 新版本回归另测。


## M6 TURN 回归与带首断观测的后续运行

`/tmp/wrd-public-m6-media-relay-20261017a`，代码 `966890b`/build `f5c2a9203e47f9e5`：PASS，86.272106s/85 样本，恢复 4.007493s，随后 61 快照/60.0024s；rVFC 回调增量 1149（约 19.15/s），末次实际双端 relay/UDP、H.264、RTT 40ms、framesDropped 0。owned browser 已关闭；不把回调频率当作独立新截图频率或原生输入效果。

I2 observer `10d4146`+`0f0e902` 已独立复审后只同步验收脚本，无服务重启。`/tmp/wrd-public-i2-observed-turn-20261017a` 请求 300s，实际 93.094368s/94 样本、0 missing/late，INCOMPLETE。首次当前 Engine close reason=ping，在最后 incoming ping 后 45003ms；Socket/Manager 随后关闭，preclose 晚 967ms，故不是工具先清理造成首断。浏览器 103 次调度采样最大 lag 9ms，持续 visible/online/focus；最后视频仍推进，RTT 33ms、frame age 29.9ms、PC connected，但租约已清且输入门禁关闭。

同窗 formal connector 两个连接索引发生 edge loss，8s/34s 后各自重新注册；Signal/Host 上行 stats 仍每秒到达直到关闭前。证据支持公网下行/connector 路径异常假设，不足以确定丢失的下一次 ping 在生成、排队、交付的哪一步停止；不能把不同钟墙钟相差约 588ms 当作精确先后。详见[首断诊断](2026-10-17-observed-ping-timeout-diagnosis.md)。一次性 proof 工具首断即结束，不能认证普通当前 owner 自动恢复；不会清 proof、重签或自动接管。

## Nullable 修复部署与当前入口

`9e57bf4` 缺测修复通过 task review 及整轮增量复审；359 Viewer / 109 Signal / 25 诊断 / 51 Python 定向检查通过（7 个监听 HTTP 用例按离线边界未运行）。仅本地重启耗时 22.553s，Signal 3905/Host 4164；实际 schema 2/build `c30530f331a4def5`，保留 f5c2/b733。cloudflared 84671/watch897 身份不变，quick URL 文件仍不存在，原 HEAD/index 保留。当前版本的业务输入/三小时验收仍未完成。

11:08 的只读 TCP7844 单次比较：四个最近注册 IPv6 目标和四个仓库已有 IPv4 探测目标均连接成功（约 209–215ms / 175–177ms）。目标不同、只是瞬时建连，不证明长连接质量、HTTP2 成功或 IPv6 因果，故没有修改地址族/协议。真实浏览器正式根入口最新返回 200，登录表单可见，导航至 DOM 7210.4ms；同页 health 200/981.5ms、status 200/963.7ms、Host 在线、Viewer 0，owned browser close/manager stop API 完成。之前误探测不存在的 `/login.html` 得到 404，此探测路线错误不计作应用入口故障。一次可达不抵消心跳超时与历史 formal_ok0。


## 11:22–11:28 网页阶段复测（只读，无登录 / Viewer）

本地根页 HTTP 200/load 约 150ms；三个正式域名新浏览器上下文访问约 7–8s，TLS 约 2.2–2.7s、document TTFB 约 0.8–1.35s。真正的同上下文 reload 为 868.3ms；不能把新 page/context 的第二次访问称 warm。

CDP 只读事件监听核验进一步区分了页面完成与功能就绪：登录 submit listener 在 5014.9ms 尚未观察到、5124.4ms 已观察到；Cloudflare analytics module 到 7589.2ms 才结束，DCL 7593.9ms。该脚本延后 DCL/load，但没有让登录初始化等到 DCL。main document 4026.1ms 结束、最后同源 CSS 5080.8ms 结束，首次功能就绪仍慢。没有登录、提交表单或触发原生输入，不能据此认证完整登录和用户设备延迟。跨域细节受 Timing-Allow-Origin 限制的 DNS/connect/TTFB/body 必须 null；先前私有 artifact 的 0 或跨字段差值无效，原文件保留。完整归因、修正和选项见[入口加载诊断](2026-10-17-entry-loading-diagnosis.md)。


## S1 加载后的 300 秒连续性验收

`/tmp/wrd-public-server-heartbeat-turn-20261017a`：artifact 判定 PASS，请求 300s，最终持久化 elapsed 300.212081s，301 个样本，missing/late/failed/identityChange 全为 0。日志 stdout 的再次汇总时间比持久化 summary 差不足 1ms，本报告使用文件终态。真实 UI 登录及一次 Start 已验证；同一 PC/attempt/lease 持续，TURN 两端 relay/UDP、H.264。没有业务输入、可见效果或普通重连测试。

客户端 firstDisconnectEvent=null；preclose 之前没有 ec/sd/mc。服务端唯一 close 为正常测试清理的 transport-close，11 次 pc、11 次 pf、11 次 pr；coverage partial、engine=true、flushScanLimited=false、valueInvalid=false，32ring 有 1 次正常覆写。最后 pingCreate/flush 距 close 21493ms、pongReceived 距 close 20593ms，下一次 25s ping 未到期。close 时 writable=true、bufferLength=0；Node 最近窗口 count60/max84ms/p95 53ms/missed0，snapshot age3862ms。这些字段是同机 age/调度证据，不称单向传输或纯网络 RTT。

Connector 日志从本轮 startoffset 到终态没有新增字节，不能据此证明永不掉线，也不能把诊断-only 新代码称为网络修复。之前 93.094s 失败仍成立。本轮完整来源/边界分析见[服务端心跳运行诊断](2026-10-17-server-heartbeat-runtime-diagnosis.md)。

独立三小时 TURN 验收随后启动 `/tmp/wrd-public-server-heartbeat-turn-long-20261017a`，fresh Host online/Viewer0 后重新取得本轮单次 proof；不是重用或 remint 已断会话的 proof。初始结果未完成，不与 300s 样本拼成三小时。


## 三小时测试进行中的 4 秒卡顿（尚非终态）

`server-heartbeat-turn-long-a` 首次完成4033.276ms的rVFC间隔在tick802；ticks798–801浏览器bytesReceived/framesDecoded/callbacks均停止，802恢复。PC/path/generation/lease/socket/input gate无变化，低于现有5000ms连续性失败阈值，但仍是实质性能问题。Host同窗11:55:37.271记录最新event-loop lag2710.327ms、missed2；随后captureSeq速率约2.13/s、编码最大928.125ms，证明存在本地媒体与调度扰动。早期资源快照age8.68s，后续timeout/age9.53s，不应称当时新鲜资源证据。无法从现有日志确定哪一个同步调用或OS资源因素阻塞，不能将本次只归于网络或直接选代码修复。随后信令/画面持续，本轮尚未结束；详见[长测卡顿诊断](2026-10-17-longrun-gap-diagnosis.md)。
