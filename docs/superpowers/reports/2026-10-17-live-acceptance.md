# 2026-10-17 公网运行验收

当前部署：`8e375fa`；Viewer build `b73325b8166441a6`。本报告追加真实运行证据，不能以源码复审或本地 health 代替公网可用性。所有测试使用正式入口；创建自动化 Viewer 须 fresh zero-Viewer + 一次性 proof，人工显式连接优先。未发送业务原生输入、剪贴板或 Terminal 命令。

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
