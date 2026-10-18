# 2026-10-17 公网运行验收

> **2026-10-18 08:06最新状态：** 实际产品代码已部署为53ed5d7/build79bf9a5afea0458e，Signal45287/Host94398在线，tunnel/watcher未操作。新正式短测300.000051s/301样本PASS，独立三小时10800.000087s/10801样本PASS，缺样/迟到/失败/身份变化0，最大rVFC间隔766.58ms；不合并旧失败片段。源采集约8.171次/秒，输出19.458FPS包含59.062%复用，内容新鲜度和编码局部尖峰仍有限制；真实业务输入、可见/物理效果NOT RUN，普通恢复未验收。SUP观察缺失和完整进程树UNKNOWN保留。新增HTTP请求头相关403/200差异已记录，未动边缘配置。详见[最新诊断总览](2026-10-17-diagnosis-and-acceptance-status.md)和[本轮代码、上线与三小时证据](2026-10-18-verified-warmup-execution.md)。**以下是各自时间点的历史记录，不代表当前部署；旧FAIL/INCOMPLETE不改写。**

> **15:16 部署更新：** 认证e996467、截图epoch修复83c513e已随冻结候选afd598a加载；本地restart-local25.679s，Signal28142/15:15:15、Host28181/15:15:18，health与Host在线、Viewer0、源码/资源及主仓HEAD/index保留核对通过。builda6e8b15122bde656及tunnel/watcher身份未变。新TURN窗口turn-long-20261017b最终131.953秒/132样本INCOMPLETE：客户端transport-close时PC与画面仍推进，maxgap783.3ms；5次Signal ping均有pong，本次没有长停帧或ping-timeout签名。七个已登记测试身份自然退出；三小时及真实input→visible仍未通过。

> **14:59 复核更新：服务在线，长会话验收未通过。** 已加载Host e279060（候选0ffb941），PID10658、Signal64505及builda6e8b15122bde656保持。本次计划10800秒的TURN实际采样256.072秒/256条，首次超限frameAge5262.4ms，已完成帧间隔先达6733ms、最终最大8116.308ms；Host心跳超时使控制租约失效，helper退出，INCOMPLETE。浏览器信令在清理前仍在线，不能归为Viewer先断开。线程采样被10秒预算终止且文件0字节，没有可用栈；旁证7个已登记测试进程自然退出，完整进程树退出仍未证明。原生input→visible仍NOT RUN。


> **前次状态（14:34核验）：服务在线，稳定性验收尚未完成。** 已部署Host JPEG传输准入/阶段观测和Viewer时钟/reset修复。JPEG暂停恢复短测PASS；随后TURN在31s内发生13.849s停帧与PC重建，Host同窗encode13.541s/loop lag12.771s。之后独立300s诊断窗口301样本无故障、最大画面间隔433.316ms，未触发线程采样，不能据此否定先前故障或代替三小时验收。已记录7个测试进程均自然退出；旧记录与完整子进程树的退出盲区保留。详见[实施记录](2026-10-17-remediation-execution.md)、[真实验收](2026-10-17-live-acceptance.md)、[Host停顿边界](2026-10-17-turn-host-stall-code-review.md)。业务输入到真实可见效果仍NOT RUN。

当前部署：`afd598a`，Host `83c513e` / PID28181、Signal `e996467`（含d1166ab）/ PID28142、Viewer时钟及reset修复 `c3abb21`，build **`a6e8b15122bde656`**；13:12本地Signal重启5.861s，Host自动恢复，tunnel保持。新build正式登录页200且build一致；本次只读页面未登录/Start。13:12后的普通Viewer曾自动重连；该连接13:32后已退出，后续新build proof会话结果见文末。

此前上一build曾TURN300s PASS，随后JPEG69.744991s在恢复后发生5200.4ms加载停顿而FAIL；当前build追加JPEG111.236s短测PASS、TURN31.004s失败及独立TURN300.158s诊断PASS，最新256.072s长测仍失败。此前93.094s信令超时和约1922.5s长测5149.8ms间隔均保留。连续三小时、普通用户重连及真实原生输入/可见效果均未完成。

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

## 32 分钟终态与单调时钟缺陷

长测 1922 样本，0 缺失/迟采/身份变化；97 failedObservations 是首次超限加累计最大 gap 的重复观察，不是 97 次断线。信令全程 connected，74 轮 ping/pong；唯一关闭为主动停止自己的测试浏览器。服务仍在线，三小时未通过。完整 [媒体事件](2026-10-17-longrun-gap-diagnosis.md)与[心跳报告](2026-10-17-server-heartbeat-runtime-diagnosis.md)保留原证据。

进一步 [源码时钟审查](2026-10-17-media-clock-review.md)确证 recv 与 JPEG 循环用墙钟节流；模拟回拨 4.24s 会把 30ms 等待变为 4.27s。已补 [spec](../specs/2026-10-17-media-monotonic-clock-design.md)和[plan](../plans/2026-10-17-media-monotonic-clock-plan.md)，待实现复审。该机制与第二次停帧吻合，仍不能分摊整段 5.15s 或解释第一次真实 2.7s Host loop stall；尚未据此声明线上修复。

Host 时钟修复已通过104项离线回归与独立review后于本轮加载；新Host42127，Signal15135/buildc305/tunnel保持。新的300秒TURN测试进行中，终态以随后结果为准；旧失败记录不覆盖。Viewer计时修复尚未加载。

Host时钟修复后新TURN300s PASS：301样本0missing/late/failed/identitychange，maxgap449.998ms；decoded18.71fps、rVFC18.49/s、新capture约10.11/s、reuse48.52%。[性能细节](2026-10-17-media-clock-short-performance.md)、[信令细节](2026-10-17-media-clock-short-signal.md)。这不是三小时或真实业务输入验收。

随后JPEG媒体生命周期测试实际69.744991s/69样本FAIL：初始/暂停/恢复全部通过，但恢复后qualified load age到5200ms，输入门禁按新鲜度保护关闭；socket仍connected。失败原因是post-recovery-not-healthy，完整现场在本机`/tmp/wrd-public-media-clock-jpeg-20261017a`，继续分层诊断，不能用前一TURN通过覆盖此失败。

Viewer时钟`3ca62fe`已独立review PASS、主要427测试PASS；相邻两项失败独立确认为缺M6认证scope的旧fixture，正在单独修复测试，生产校验不放宽。[实现](2026-10-17-viewer-clock-implementation.md)、[review](2026-10-17-viewer-clock-task-review.md)。临时候选buildb6d77cd86c6f9d02保留c305/f5，尚未上线。

## 13:12前端时钟与复位修复加载

本次初始零Viewer同步检查因1个普通Viewer在线而停止，没有写入。收到用户“不是我在使用，可进入维护验收”的明确授权后，只允许对同一Viewer身份/epoch做一次已审查源码同步及Signal维护重启；无自动化接管或proof绕过。同步35个文件（含6个前端源码/测试），保留主checkout HEAD/index、原有未提交内容和tunnel/watch/quick状态。重启返回Host在线、Viewer0；随后普通客户端自动恢复为Viewer1，故新build的proof验收尚未开始。

源码/资产哈希、schema2 manifest、保留构建、Host在线验证通过。当前普通Viewer加载的网页build未取证，不能因服务端已构建a6e8b15122bde656就认定旧页面已更新。13:19左右独立未登录页面观察正式入口200、builda6e8b15122bde656、登录表单存在、无Viewer socket，DCL9565.1ms；同源health/status200且Host在线/Viewer1。browser.close在5秒预算内未完成，manager.stop API完成，OS退出未知；不把清理限制抹掉。

后续自动化继续严格fresh-zero-Viewer一次性准入，普通Viewer退出前仅进行只读诊断。真实输入到可见效果仍NOT RUN；当前在线不等于长时间连续性通过。

## 14:04 后新 Host 的 JPEG/TURN 验收

JPEG `/tmp/wrd-public-jpeg-gate-jpeg-20261017a` PASS111.235860s、97采样，真实Start/暂停/恢复/60秒followup全部10项断言通过，恢复6.006322s，browser.close API成功。恢复后61条有效帧年龄快照p95=1772.4ms、最大2884.7ms；60条ACK RTT末值快照p95=1885.2ms。它们不是独立逐帧总体分布，也不是输入可见耗时。Host15条worker快照的处理末值最大109.127ms，loop当前采样最大37.424ms；采样间活动仍未知。详见[JPEG短测指标](2026-10-17-jpeg-gate-short-performance-review.md)。

随后TURN `/tmp/wrd-public-jpeg-gate-turn-20261017a` 计划300秒，31.003861秒后INCOMPLETE；29采样、0missing/late、18累计失败观测、1次identity-change observation，最大无新画面13849.43ms，结束reason=session-changed-or-disconnected。初步socket生命周期仍connected且firstDisconnectEvent=null，必须继续区分PC更新与socket断开，不能凭通用reason宣称网络断线。cleanup browser.close timeout、manager.stop ok，OS退出证据未采集。执行进程已exit1，不自动重签proof续测。

14:13后清理复查：当前未发现14:07启动的相关浏览器/driver存活进程或临时profile；历史采集器未记录PID与创建时间，故不能补证确切退出时刻。详见[归属复查](2026-10-17-turn-browser-ownership-review.md)。不按进程名称清理用户应用；下次诊断须在启动时记录归属并单独核验退出。

## 受控TURN停帧诊断结果

按[采样spec](../specs/2026-10-17-turn-stall-profile-design.md)启动一次300秒目标窗口；先核对health、Host在线、Viewer0和固定Host PID文件。私有supervisor通过10项离线测试及独立运行审查（两项P3测试完整性问题待补，不涉及生产运行缺陷），保持原helper/proof/媒体策略未变。首次观测frameAge>2s时仅取一次3s线程栈；这轮是可能受采样扰动的诊断，不计性能/三小时合格。结果见下文。

该轮原helper PASS300.157576s/301样本，missing/late/failed/identityChange均0，最大rVFC gap433.316ms。没有frameAge>2000触发，未取得任何native stack；不得据此否定先前13.8s卡顿。旁车总329.086s、worker exit0、无超时/干预，7个已记录身份均自然退出；原helper自身OSexit仍not-observed，旁车补充已登记身份退出，不证明轮询遗漏的完整树退出。诊断路径未改原summary，也不合并短测作为三小时PASS。服务helper随后health/Host在线，同PID87412/64505。

## DC准入部署与三小时TURN验收启动

0ffb941受控同步27路径/5源码测试增量（含new dc_diagnostic_admission.py），备份位于/private/tmp/wrd-c5-rollout-private-ilovzfv1/apply-0ffb941a-dkrhzfun。Host-only重载11.606s，PID10658，源码sha3d54892dc58e1a69ecee619054fc07b4aaa7bd9a4d9ad4e4bcf027ac377d2a80；Signal64505及cloudflared84671/watcher897原启动身份不变，quick URL仍不存在。新版模块/Host/静态资产哈希及原HEAD/index/未触及文件全部核对，Host在线、fresh Viewer0。密码只从本机配置回报，未写文档。

私有long supervisor4d96c8b0通过16项离线测试与独立spec/quality复核，旧两项P3已补。/tmp/wrd-owned-turn-probe-private/turn-long-20261017a已启动10800s目标TURN窗口，原helper/proof未改；仅在原5秒失败门槛先被满足后才可能一次采样。此段仅记录14:49启动时刻；该轮最终256.072秒结束INCOMPLETE，最大停帧8116.308ms、Host心跳超时、sample0字节，详见[失败窗口分析](2026-10-17-turn-long-failure-analysis.md)。不能用启动成功计PASS。

## 15:19 新版本TURN窗口结束：媒体正常推进，信令transport-close

实际131.952546秒、132条、missing/late0、failedObservations1/identityChangeObservations1，最大画面间隔783.3ms。首客户端engine close发生在清理前454ms；Signal关闭事件在browser.close调用之后，不能由后者推断初始关闭方。五次server ping→pong同钟往返843/1369/855/1298/759ms，含调度/客户端处理，非纯网络或单向传输时间；末pong在关闭前8.539s，Node窗口max106ms/missed0。本次不复现先前ping timeout。Cloudflare主日志在故障窗没有记录，watcher healthy/actionnone不能排除单条WebSocket故障。

Host current loop lag最大139.052ms，rolling最大564.526ms；编码1865次、窗口count加权平均12.7384ms、单次最大601.355ms。解码约14.56/s、新截图约11.44/s、输出复用约29%；分页压力仍大，但不能据此归因这次Socket断连。未发生profile切换，仅一次真实尺寸1152×720codec打开，所以截图epoch修复的真实换档路径本窗未触发。没有真实业务输入，输入ACK/实际可见效果指标仍null/NOT RUN。

supervisor未触发sample；helper正常完成清理，旁车记录的7个子进程身份自然退出且没有signal，完整子进程树证明仍false。主服务持续在线，tunnel/watcher身份未变。

详见[媒体边界](2026-10-17-turn-long-b-media-analysis.md)、[信令时序](2026-10-17-turn-long-b-signal-analysis.md)。[普通用户恢复源码复核](2026-10-17-normal-transport-recovery-audit.md)确认8秒grace+Host ACK后恢复lease、超时新lease重建peer路径，无新确认代码缺陷；但一次性proof测试会停止首次断开，不能代表普通用户自动恢复已通过。已邀请用户独立设备人工连接、点击和文本输入并上传既有诊断；等待真实证据时不抢占新的Viewer会话。

## 15:51 诊断工具同步复核

验收工具1677473与截至0f29c45的文档已同步到主工作区，22项Node、42项Python离线检查及独立task/final增量review均通过。只更新4个验收脚本/测试，无产品服务代码和build变化，无重启。原HEAD/index、未改文件、tunnel/watcher/quick状态保留；服务健康、Host在线、Viewer0。

私有supervisor仅成对更新已审查helper/sampler SHA，现SHA为76106a958fde1fe80650524ca43952a12bc7c7ce36ee348f30ebebce95e0e884；16项纯fake回归通过，3项会启动真实子进程的测试按本次边界未运行。历史run、失败结果和hash未改。真实关闭元数据尚未采到，人工输入、普通恢复和三小时资格仍待验收。

15:55只读HTTP复查：正式根入口经测量进程现有代理环境返回200，TTFB1.272042s、总计1.272231s；本地health显式绕过代理返回200，TTFB6.159ms、总计6.230ms。未登录、未Start、未创建Viewer。此次HTTP可达不等于页面功能或连接连续性通过。15:52独立status仍Host在线、Viewer0。
