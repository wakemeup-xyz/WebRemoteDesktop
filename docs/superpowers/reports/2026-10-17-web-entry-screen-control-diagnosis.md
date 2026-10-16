# 网页入口、投屏与远程控制稳定性诊断报告

日期：2026-10-17；时间统一为北京时间（Asia/Shanghai）。

审查对象：当前工作区、实际部署资源、Host / Signal / 固定域名巡检日志及轻量只读现场采样。基线提交 `ab1a343680aa0ec093a4e0a781052e149f7dc793`，包含此前已有的未提交修改，不能仅以该提交号重建本次审查代码。源码哈希和脱敏测量结果见 [证据摘要](evidence/2026-10-17-web-entry-screen-control/summary.json)。

本报告合并此前“持续丢失控制”的完整复查，并追加“刚刚整页打不开”、网页加载、投屏和输入性能专项。用户要求本阶段不修复、不重启；本轮仅新增报告与证据，没有修改业务代码、配置、服务或 tunnel，没有新建生产 Viewer。建议均为后续修复方向，未执行。

后续补充：[传输耗时与输入到画面延迟专项诊断](2026-10-17-transport-input-to-frame-diagnosis.md)确认当前“输入→画面”标签实际绑定ACK RTT，visualFeedback也未等视频呈现；键盘wire耗时、JPEG跨机计时和部分详细trace存在错误。因此本报告中的业务RTT、Host本机阶段和投屏统计应各按原边界解读，不能拼成真实端到端延迟。

## 1. 结论

**不稳定由多层问题叠加，已有证据不足以归为单一网络故障。**

| 现象 | 已有证据 | 可以确认到哪一层 |
|---|---|---|
| 刚才整页打不开／连接不上 | 排查时入口已恢复 200；本地 54 字节 health 请求曾耗时 3.608 秒；同机出现大量实际换页 | 本机调度和内存压力是本次采样期间的重要瓶颈；缺少用户失败瞬间的时间、错误页和请求记录，不能唯一确定那次整页失败原因 |
| 历史公网探测失败 | 10-16 19:34–19:44，巡检记录本地正常、公网失败，现有 watcher 两次自动恢复；23:30 有 connector 连接重连 | 能确认巡检端访问公网路径失败、本地 health 成功；历史日志不足以排除巡检端代理/DNS因素，不能确定故障位于本机之外，也不能认为所有边缘连接同时掉线 |
| 重连后立即再丢控制 | 19:44:33.584 rebind 成功，19:44:36.228 租约过期；前端首次心跳延后 3 秒 | **已确认真实故障与租约续期缺口相符**，成功迁移到过期仅 2.644 秒 |
| 画面与控制一起卡顿 | Host 出现 4.076 / 8.182 / 8.556 秒事件循环停顿；隧道媒体同步采集、转换、JPEG 在控制事件循环执行 | 控制面会被媒体工作和整机调度停顿阻塞；不能把每次停顿都算成纯 CPU 编码时间 |
| 点击、松键响应晚 | 实际 down/up 等待同一输入锁约 3.6 秒，wheel 等待 4.87 秒 | 输入队列积压已在现场发生，并非仅网络 RTT 高 |
| 页面短暂异常后需要重新登录／刷新 | 503 会清除 token；旧页面延迟资源可能 404；部分请求无应用层超时 | 已离线复现或由代码路径确认，但未证明恰是用户刚才那次故障的触发点 |

此前控制专项还保留 **11 项未修复问题**（R1–R11），覆盖租约、Host 并发状态迁移、输入 ACK、reset 屏障、媒体恢复身份和 legacy relay。新增可用性与性能项见 N1–N13。P1 表示可直接造成控制不可用或破坏状态隔离，应优先修复；P2 表示特定条件下恢复失败、明显延迟或观测失真；P3 表示已确认的额外开销，尚无现场 CPU 占比证明。

## 2. 时间线与因果边界

| 时间 | 事件与证据 | 解读 |
|---|---|---|
| 10-15 22:30 附近 | 之前诊断中可靠 DataChannel 的 down/up/reset 未到 Host，但 Socket 键盘 reset 可在 0.705ms 内应用 | 数据通道“open/connected”不保证业务输入到达；最初 DC 失效究竟来自 TURN、SCTP、浏览器还是网络，仍未知 |
| 10-16 01:35–01:37 | 前一阶段已部署局部修复，Signal PID 22232、Host PID 22537；当时 tunnel 未变 | 这是本轮之前的操作，不属于本次只读审查；此前测试通过也不是长时间稳定性的证明 |
| 10-16 19:34:29–19:37:46 | 固定域名连续 formal-down，origin_ok=1；watcher 19:37:46 执行恢复 | `/tmp/wrd-fixed-watch.log:20348–20351`，确认巡检端访问公网路径失败，尚不能定位故障环节 |
| 10-16 19:37:46–19:43:16 | 第一次 watcher 恢复耗时 330 秒后 exit=1 | 等待参数并非真实秒数上限；恢复期间没有正常周期采样 |
| 10-16 19:44:24–19:44:57 | watcher 第二次恢复，exit=0；当前 cloudflared PID 84671 启动于 19:44:27 | 属于原有 watcher 的自动行为，本次审查未触发；不等于已确认首次入口异常的底层原因 |
| 10-16 19:44:26.678 / 33.584 / 36.228 | grace → rebind confirmed → lease expired | Signal 日志 34016 / 34050 / 34203；Host 日志 7092 亦确认迁移。与 tunnel 恢复同期发生，R1 使重连恢复继续失败 |
| 10-16 19:48:01 | Host lag 8182.498ms，紧接 Engine.IO packet queue empty / abort；19:48:17 信令断开 | `back-debug.log:8772–8773,8837`；说明本机长停顿与信令失败相邻，不足以证明唯一因果 |
| 10-16 19:49:29 | wheel 排队 4870.9ms；down/up 排队 3682.2 / 3627.3ms | `back-debug.log:9384,9409,9416`，真实输入排队问题 |
| 10-16 23:30:39–23:31:20 | tunnel 的 connIndex 1/2 掉线并重新注册；23:34:45 有请求 context canceled | `/tmp/wrd-fixed-domain.log:4061–4090`；前后分钟级巡检均 healthy，采样漏掉瞬断的可能性已存在 |
| 10-17 00:06:51 | 隧道画面 0.8 FPS，6 帧平均采集＋转换＋JPEG 750.5ms，平均 4.7KB，随后 Host lag 4076.268ms；load1=5.688 | `back-debug.log:11891–11892`。此时不能套用稍后 load194 的解释；同步媒体工作阻塞控制循环需独立处理 |
| 10-17 00:12:54–00:14:48 | Viewer relay RTT 4920ms / 4.1 FPS；Host 00:14:43 lag 8556.12ms / 输出 1.8 FPS；软件编码明显变慢 | 多种路径都在恶化，不能只凭 RTT 推定外网带宽不足 |
| 10-17 00:16:03–00:17:55 | Host 无 PC、捕获、relay 或输入等待，112 秒累计 CPU 仅 +1.068 秒，但仍出现 1439ms lag | `back-debug.log:14959–14996`，支持跨进程调度压力，排除这段时间主要由 Host 编码持续占满 CPU 的说法 |
| 10-17 00:18–00:21 | load1 194.20，swap 使用约 25.05GiB；2.034 秒采样测得换入 223.37MiB/s、换出 117.29MiB/s；本地 HTTP 秒级停顿 | 是正在换页的证据，不只是历史 swap 占用高；机器总 CPU 仍有约 29% idle，不能称“CPU 100%” |
| 10-17 00:23:12–00:23:14 | 本地 health 三次 TTFB 降至 56 / 49 / 13ms | 未重启即改善，说明具有明显瞬态特征；不是问题已根治 |

00:00–00:24 的 watcher 结果均为 healthy，只能证明这些离散采样时刻 health 成功。用户尚未给出“刚刚打不开”的精确时间与错误样式，以上各段不能强行合并成同一次事故。

## 3. 本轮现场测量

### 3.1 HTTP 与资源加载

这些是少量只读 `curl` 请求，没有鉴权、创建 Viewer 或发送控制输入。时间均为 10-17；TTFB 是首字节等待，total 为完整请求耗时。

| 时间 | 路径 | HTTP | TTFB | total | 备注 |
|---|---|---:|---:|---:|---|
| 00:18:22 | localhost:8080/health | 200 | 3.608s | 3.608s | 54 字节，TCP 连接 0.875ms |
| 00:18:24 | localhost:8080/ | 200 | 2.631s | 2.631s | 2319 字节登录页 |
| 00:18:26 | 正式入口 /health | 200 | 1.546s | 1.547s | 直连采样 |
| 00:18:28 | 正式入口 / | 200 | 2.043s | 2.044s | 直连采样 |
| 00:19:18 | 正式入口 /，经本机代理 | 200 | 2.196s | 2.366s | HTTP 代理 127.0.0.1:7897 |
| 00:19:21 | 正式入口 /，直连 | 200 | 1.954s | 1.955s | 与代理均可成功，不能排除用户端网络差异 |
| 00:19:55 | 本地 desktop-core 资源 | 200 | 0.193s | 1.288s | gzip 109757B，immutable |
| 00:20:01 | 正式入口 desktop-core 资源 | 200 | 3.228s | 5.798s | `CF-Cache-Status: MISS`，响应压缩后 108991B |
| 00:23:12–14 | localhost /health，3 次 | 200 | 0.056 / 0.049 / 0.013s | 近似相同 | 未做服务变更 |

测量端和服务端在同一台受压机器，耗时也含测量进程的调度等待，不能把本地 3.608 秒全部解释成 Node 函数执行时间。但 Signal 自身 `viewer_bootstrap_served.serverProcessMs=622.33`（`/tmp/signal-server.log:36459`，00:17:52）提供了独立的服务端停顿证据；该同步内存构造通常约 0.07–2.71ms。当前没有 Node event-loop / GC / 完整 HTTP 请求阶段指标，进一步归因受限。

正式入口为 `https://link.stockhub.wiki`。本轮 A/AAAA 均能解析，直连与本机代理均返回 200；这是排查时状态。`/tmp/wrd-safe-current-url.txt` 不存在表示没有记录可用的可选 quick URL，**不代表正式固定域名失效**。

部署 core 为 `desktop-core.53adfd7519ca04dc.js`，原始 413891B / gzip 109757B；Viewer CSS 49178B / gzip 9469B；Viewer HTML gzip 6678B。关键路径一个 JS，无运行时 CDN；Terminal JS 555545B / gzip 144964B，按需加载。因此没有证据把初始故障简单归因于“主包特别大”或第三方 CDN。

`shell-guard.js:27` 的核心资源提示阈值是 5 秒。本次公网冷资源请求 5.798 秒说明资源加载确有跨过该阈值的可能，但这不是用户浏览器加载轨迹、也不是 P95，不能据此宣称用户实际触发了 ShellGuard 超时。

### 3.2 主机资源

- 12 个逻辑 CPU、32GiB 内存；00:18 load 为 194.20 / 137.88 / 80.30，swap 使用 25648.75MiB。
- 00:19:41：约 946 个进程、7767 个线程，30GiB 内存已用，压缩约 6.6GiB；CPU user 42.31%、system 28.28%、idle 29.39%。load 很高不等于 CPU 满载。
- 00:21 的两次 `vm_stat` 相隔 2.034 秒，4096 字节页，swap-in +116318 页、swap-out +61081 页，折算换入 223.37MiB/s、换出 117.29MiB/s。**这才是当前内存换页压力的直接证据。**
- 独立进程快照见 mysqld 约 154% CPU，30 个 Codex Renderer 合计 RSS 约 6.64GiB、CPU 约 81%，另有 Codex Service、WindowServer 和较大的 Chrome Renderer。RSS 汇总可能重复计算共享页，CPU 百分比也跨核；这只是定位线索，不能指认某个进程单独导致事故。本轮诊断进程也占少量资源。
- 磁盘可用约 64GiB；最近 Signal 结构化日志约 22KB/15 分钟，没有磁盘满或日志洪泛的证据。

## 4. 控制可靠性：完整复查保留的问题

以下 R 项在当前代码仍成立。除 R1 有生产日志直接对应，其余主要为代码路径和轻量离线调度/状态机复现，不能说每个问题都已在用户最近一次会话发生。

### R1 · P1 · 重连迁移未续租，恢复后可在首个心跳前到期

`signal-server/lib/desktop-control-lease.js:140` 的 `rebindViewer` 只改 viewerId，没有刷新 deadline；`web-client/js/webrtc.js:3566` 用 3 秒 interval 启动心跳，没有立即发送。

离线时序：最后心跳 t=0，t=2.9 断线，t=10.8 在 8 秒 grace 内重连，t=11 Host 确认，t=12 租约过期，首次新心跳要到 t=14。生产 19:44:33.584→36.228 正好落在这个窗口。影响是刚恢复控制就又被撤回。建议在经认证且 Host 确认的迁移中明确续租语义，并立即心跳；加入接近过期边界的时钟测试。

### R2 · P1 · 旧 offer 在 await 后覆盖较新的控制租约

`python-host/host.py:2834` 在 offer 锁内等待关闭旧 PC；控制迁移使用另一把锁。等待期间可完成新授权，但 `host.py:2888` 恢复后不重新校验权威状态就写入旧绑定。

离线挂起真实 pc.close 路径后先发新控制迁移，得到 Viewer epoch9 被旧 offer 回写成 epoch7，键盘身份也回退。仅比较 connectionGeneration 不能代替控制 epoch 校验。建议串行化权威控制迁移，并对 await 后的提交重新验证身份/epoch；加入旧 offer 与新授权交错测试。

### R3 · P1 · 普通键盘输入无 ACK 时，界面仍可长期认为可控制

`web-client/js/keyboard-transport.js:63` 主要监测 reset 屏障超时；`input.js:1171` 的可靠输入隔离只覆盖 down/up；诊断观察不等于恢复动作。

离线发送普通键盘输入并丢弃 ACK，5 秒后 transport 仍 ready、pending=1、lastSent=1/applied=0，输入门仍允许，下一次发送仍成功，无自动恢复。普通 wheel/command 也没有完整业务 ACK 失联闭环。建议按可靠通道进度而非只按 reset 或鼠标边沿判断失联；测试仅键盘工作负载和 ACK 丢失，避免依赖鼠标触发自救。

### R4 · P1 · Host rebind 拒绝／超时后的 reset 完成，未自动重新申请

`signal-server/websocket/signaling.js:480` 在 Host 拒绝或 1500ms ACK 超时（`:487`）后执行 reset，reset 成功确认后才进入 FREE；`:1044` 在 rebind pending 期间丢弃自动 acquire。前端 `webrtc.js:3256` 只在连接事件发自动 acquire，`:3469` 的 FREE 状态只收紧输入和刷新 UI。现场秒级 Host 停顿可能使超时路径更容易触发，但未逐次配对所有超时事件。

离线结果为 FREE、无新 grant、无自动申请回复；必须额外人工动作。`signaling.test.js:913` 手动再次 acquire 掩盖了此缺口。建议 reset 确认结束后有明确、有界且幂等的自动重新申请协议；不能在 reset 未确认时直接放行。

### R5 · P1 · pending grant 转 reset 复用 epoch，迟到 grant ACK 可被误认成 reset ACK

`desktop-control-lease.js:182` 的断线分支及 beginRelease 将 pending 授权改为 reset，但复用同一 epoch；`:59` 确认主要按 epoch 匹配。

离线顺序：grant(epoch1) → 断线改 reset(epoch1) → 旧 grant 的 applied ACK(epoch1) → 状态 FREE；真正 reset 的 rejected ACK(epoch1) 被作为过期消息忽略，没有 reset 重试；新申请可进入 GRANTING(epoch2)。这证明 reset 完成语义被错误确认，**不等于已证明任意原生输入越权**。建议每次 transition 使用唯一身份并校验类型，保持 reset 的 fail-closed 语义。

### R6 · P2 · 已超时的 reset 在同租约重连后无法自动恢复

`keyboard-transport.js:244` 保留同身份的失败状态；`input.js:1130` 继续复用旧恢复状态。blur 发 reset 后断网 4 秒，reset 的 3 秒截止时间早于 8 秒 grace；重连保留同租约时，transport 已进入 reacquire-required，自动恢复和普通重试都报 keyboard-reset-send-failed。`input.js:1797` 仍提供“释放→重新申请”的人工出口，所以不是所有恢复手段都失效。

保留过期屏障本身是正确的安全约束，缺口是没有自动收敛到新授权。建议区分“身份仍有效”和“传输屏障已失败”，走权威的重新授权路径并处理旧请求；不能通过简单清除 reacquireRequired 来绕过屏障。

### R7 · P2 · 在途鼠标 reset ACK 发往旧 socket，同页重连却复用旧请求

本项发生在同一页面、同租约重新授予以及在途 ACK 走 Socket 的条件下，不是新开页面或 DC ACK。`host.py:2265` 使用原输入携带的 viewerId 发送 ACK；迁移后旧 socket 已不在 Signal 映射中（`signaling.js:1331`），ACK 被丢弃。前端 `input.js:1120` 复用未完成鼠标 reset。

离线 Host 迁移与 ACK 交错后，只完成新键盘 reset，mouseConfirmed=false、keyboardConfirmed=true，最终 timeout，输入门仍关闭。建议定义迁移中的请求/ACK 归属和重建策略，结合 lease/attempt 校验，不能无条件把所有旧 ACK 改投新 Viewer。

### R8 · P2 · fallback 新授权未同步 Host 的 PC 所属 Viewer

触发前提是 rebind 失败后用户随后重新申请并获得新 grant，同时复用健康的旧 PC；R4 所述缺口意味着不能假定这个 grant 会自动发生。`host.py:2692` 更新 active input，后续 `connection-attempt-bind`（`:4497/:4542`）更新媒体 attempt，但 `current_viewer_id` 可留在旧值。随后合法迁移被 `host.py:2607` 拒绝，新 Viewer 的 ICE 还可能被 `:3141` 过滤。

建议明确控制、PC、媒体所有权分别如何迁移，并在复用旧 peer 时保持一致，或完成完整重建；补充新授权后再次重连和 ICE 更新的跨层测试。

### R9 · P2 · 旧媒体恢复等待完成后覆盖新 attempt

`host.py:4192` 在 media 锁内等待新鲜捕获；`on_connection_attempt_bind`（`:4497`）未使用同一提交序列。旧请求恢复执行后在 `:4282` 回写旧 attempt。

离线结果 input attempt2 / media attempt1，且新绑定序列未保留，后续 rebind 被拒绝。建议 await 后校验 generation / attempt；过期完成必须失效，不能覆盖新状态。

### R10 · P2 · 前端旧媒体 ACK 可帮助新 attempt 提前解除屏障

`webrtc.js:1235` 切换 attempt 时未清理 `_mediaResumeFramePending`，新帧路径 `:1072` 以 afterResume=true 通知 runtime，绕过新 attempt 尚未取得恢复 ACK 的条件。

离线条件是旧 active ACK 已收到，但还没等到恢复后的新帧；此时 refresh 切换 attempt，重新发送 active 意图并刷新 baseline，旧 `_mediaResumeFramePending` 仍保留。随后收到帧但没有新 ACK，结果 runtime active、输入门已开。不是任意旧 ACK 加新帧都会触发。建议把 ACK、帧证据和 baseline 全部绑定同一 attempt/generation；切换时清除过期证据。

### R11 · P2 · legacy relay companion 绕过 rebind pending 屏障

`signaling.js:362` 的 `hasActiveLegacyRelayOwner` 未检查 `_wrdRebindPending`；owner 在 `:455` 提前迁移，因此 Host 尚未确认时仍可转发新 Viewer 的 relay-start。

离线先 startB 再 Host rebind，可能造成身份拒绝；失败清理 stopB 又无法停止仍属于 A 的旧 relay。影响限于 legacy 兼容路径。建议所有旁路共享同一 pending 屏障，并将失败清理绑定实际生产者身份。

## 5. 新增可用性与性能问题

### N1 · P1 · 整机实际换页与调度压力造成跨进程停顿

本项是现场运行瓶颈，不是已定位到单行的代码缺陷。3.2 的实际 swap 速率、空闲 Host 仍停顿、Signal 自身 622ms 构造耗时和 localhost 秒级响应相互支持。它可以同时拖慢网页、信令、投屏和输入，且进程还活着、health 最终成功都不能排除。

后续需要先按时间关联内存/压缩/换页、各服务 event-loop 和请求延迟，再决定并发预算、负载隔离与容量安排。不能仅按单次进程排名结束任务，也不应靠自动重启 tunnel 治疗本机压力。本轮没有结束进程或调整系统配置。

### N2 · P1 · 隧道媒体同步采集与 JPEG 阻塞 Host 控制事件循环

`host.py:735` 在同一个 asyncio loop 创建 relay 任务；`:828–848` 连续执行 MSS 抓屏、NumPy 转换和 PIL JPEG，直到 `:863` 才 await。期间同 loop 的 Socket 输入、ACK 和心跳不能运行；原生函数释放 GIL 也不能让同线程 asyncio 调度继续。

00:06:51 的 750.5ms 指采集＋转换＋JPEG 整段 wall time，不是纯编码 CPU 时间；4.076 秒 lag 同期发生，但不能把全部 lag 分配给某一帧。那时 load1 为 5.688，且 Host CPU 增量不高，同步原生等待同样会阻塞事件循环。同步阻塞机制应独立列项，不能仅用 00:18 的换页采样解释 00:06 的停顿；当时没有对应换页采样，仍无法细分原生等待与系统压力。

Signal `signaling.js:1702` 还把媒体帧通过同一 Viewer socket 转发；volatile 可减少待发送帧，不能让控制消息越过已经入队的视频字节。后续建议隔离捕获编码工作与控制循环，设置媒体队列上限，并审查控制/媒体传输的队列隔离。应通过慢捕获注入证明 ACK/心跳仍可及时处理。

### N3 · P2 · 降帧率触发软件编码，码率下限限制弱网降级

`h264_encoder_policy.py:203–211` 的 peak 硬编码资格仅覆盖标准 20 FPS 尺寸，其他配置回退 on-demand，`:275–277` 使用单线程 libx264。这是有注释说明的资格限制，问题在于它与运行时降级策略组合后会增加 CPU 工作，不能直接删除资格限制。

纯函数验证 1152×720、请求 600kbps：20 FPS → VideoToolbox 3.2Mbps；15/12 FPS → libx264 单线程 1.8Mbps。`:166–168` 的最低码率还使 0.61–0.78Mbps REMB 请求不能真正降低到该估计/请求值；REMB 不能直接证明实际可用带宽。

生产 15 点硬编码 711 个窗口、68659 帧加权均值约 4.55ms；00:12:55 软件编码窗口平均 216.9ms，00:14:48 平均 85.2ms / P95 201ms。不同时间负载不同，不能把它当相同条件 A/B 性能倍数；编码 wall time 也包含调度等待。后续建议验证更低 FPS 的硬编码能力、把尺寸/FPS/码率/编码器联合降级，并做弱网与负载组合验收。

### N4 · P1 · 可靠鼠标输入没有有界背压，积压后阻塞点击与松键

2026-10-17扩大到最近72小时后，由P2升为P1：10-16 02:18:33记录wheel锁等待60846.1ms、等待数峰值1173；up/reset另有约32秒adapter等待。见[三天复查§3.1](2026-10-17-three-day-review-and-solution.md)。以下保留前轮约4秒样本，不能当作本次最大值。

`input_handler.py:225–242` 忙时只丢 move；wheel/down/up/reset 在同一输入锁等待，没有显式容量限制。19:49:29 的日志已证明 wheel 等待 4.87 秒，down/up 各等待约 3.6 秒；down 总耗时 3687.7ms，绝大部分不是实际执行，而是排队。

建议在可靠编号之前合并适当的滚轮/移动事件、限制生产速率并监测 oldest pending age；对已编号可靠事件不能简单丢弃，也不能随意把松键/reset 越过前序输入，必须保留顺序和安全屏障语义。

### N5 · P2 · tunnel 恢复等待没有真实时间上限，长等待吞掉冷却期

`scripts/lib-fixed-domain.sh:100` 将 WAIT_SEC=45 当循环次数；每轮可有两次默认 10 秒 HTTP 检查和无显式超时的 tunnel info，因此不是最多等 45 秒。`watch-fixed-domain.sh:295` 同步等待，现场第一次恢复等了 330 秒。

同文件 `:223` 在探测前取 now，`:298` 用旧 now 记录重启冷却；330 秒执行已消耗掉 300 秒冷却，第一次失败结束仅 68 秒后再次恢复。建议用单调时钟的真实总截止时间、给外部子命令单独超时、从完成时刻计算冷却，并保留独立探测。现有 `restart-fixed-domain-tunnel.test.js:27` 只做源码形态断言，没覆盖慢探测。

该缺陷会拉长恢复盲区和扩大连接抖动，但没有证据证明 watcher 制造了最初的 formal-down。本轮没有运行恢复脚本或更改 watcher。

### N6 · P2 · health 巡检不足以代表网页、投屏和控制健康

`server.js:216` 的 health 与 HTML/关键资产、登录 API、Socket、Host 业务输入、画面新鲜度是不同层。`lib-fixed-domain.sh:36` 巡检主要保留布尔值；`:41` 调用的 checker 使用本机默认代理与 DNS，formal-down 不能直接定位为 Cloudflare 故障。`watch-fixed-domain.sh:649` 每轮完成后再 sleep，实际间隔约 63–92 秒，丢失具体 HTTP 错误与延迟。

建议分层记录入口 HTTP、页面/资源可用性、API 和 Socket 延迟、Host event-loop、业务 ACK、画面新鲜度；被动观测或不占 Viewer 的探针优先。只有显式授权的维护验证才创建会抢占控制的 Viewer。需保留错误类型、阶段耗时和探测代理路径，不能把所有失败折成 formal_ok=0；否则探针自身失败也可能触发破坏现有连接的恢复动作。前阶段已出现同一入口 curl 200、urllib 403 的探针差异，但不能据此倒推出 19:34 的失败必然也是误报。

### N7 · P2 · 临时 503／网络异常会清除有效登录凭据

`web-client/js/auth.js:30` 对任意非 2xx 或异常返回 false，`:52` 随后 logout。离线注入 503，观察到 session/local token 被删除并跳到 index.html。

这会把暂时服务不可用放大成重新登录。建议仅在明确身份失效响应时登出，暂时网络/服务错误保留凭据，显示可恢复状态并做有界重试；需覆盖 401/403、503、离线和请求迟到等情况。现场尚无用户此次实际收到 503 的证据。

### N8 · P2 · 发布删除旧哈希资源，已打开页面的延迟组件无法恢复

`signal-server/scripts/build-web-client.js:151` 切换 dist 后立即删除旧目录；旧页面持有旧 Terminal/deferred 资源路径，`terminal-loader.js:54` 重试仍用原地址。条件是页面跨越一次对应文件哈希变化的发布，且资源此前未缓存。

HTML 禁止缓存不影响已经打开的页面，结果可能持续 404，需要整页刷新。建议保留合理数量的历史哈希资产或提供受控版本更新路径；测试部署前打开页面、部署后首次加载延迟组件。此问题不等于当前所有旧页面都会失败。

### N9 · P2 · Terminal CSS 加载失败后，重试会误报 ready

`terminal-loader.js:47` 只要 TerminalPanel 已注册便跳过全部资产。离线 JS 成功/CSS 失败，第一次 failed，重试 ready，但 CSS 请求总数仍为 1。建议独立记录脚本与样式状态，失败项必须重新尝试，ready 需满足完整依赖。

### N10 · P2 · 登录与诊断资源悬挂时缺少应用层截止时间

`index.html:40` 登录禁用按钮后等待无 AbortController/deadline 的 fetch；`webrtc.js:6386` 的 deferred 诊断加载只监听 load/error，没有超时。离线 pending 时登录按钮始终禁用、没有 abort signal；诊断处于 loading、没有 timer、无可用 retry。

浏览器最终可能报网络失败，但在此之前应用没有有界退出路径。建议请求超时、可见重试和过期结果隔离；不要把另一个已有超时的 Terminal loader 混为同一缺陷。

### N11 · P3 · 高频鼠标 ACK 绕过采样，每条同步序列化整个诊断环

`input.js:780` 将 ACK 动作写为 ack，绕过 `input-trace.js:496` 的 move/wheel 采样；`:243` 每条记录复制、序列化并编码最多 256 条历史事件。

用真实日志缓冲只追加一个 unordered ACK，离线同步序列化 59270B，move 发送本身在采样条件下为 0 次。近期诊断缓冲 ACK 占 143–176/256 条，既增加开销又挤掉故障上下文。建议保留原动作以采样 ACK、增量维护字节预算。没有真实浏览器 CPU profile，不能称它是当前主线程卡死的已证实主因。

### N12 · P3 · 稳定视频每帧重复刷新整套控制栏

`webrtc.js:5081` 的 rVFC 每帧调用 markMediaAttemptReady，再刷新 UI/键盘状态；相同状态没有早退，`:5277` 还读取布局。离线调用真实 ChromeLayout，相同输入第二次仍有 120 次属性/class 写入、22 次 aria 写入、23 次 ID 查询，未含键盘 UI。

以 20 FPS 外推约 2840 次属性/class/aria 操作每秒，仅说明调用冗余，不是实测 DOM 重排次数或 CPU 百分比。建议状态变化才更新控制栏，帧回调维护必要时间戳，布局观测降频并缓存几何结果，再用浏览器性能轨迹验证收益。

### N13 · P2 · Viewer 重复帧统计恒为零，掩盖画面不新鲜

`host.py:1413` 先清零 `_total_reuse`，`:1425` 再发给 Viewer，因此该字段恒为零。15 点实际日志输出约 19.5 FPS，但 57.6% 是复用旧图像；输出 FPS 不能直接视为新鲜画面 FPS。

建议先保存窗口快照再清零，并同时报告 fresh FPS、reuse 比例、最后新鲜帧年龄。验收应覆盖捕获停顿但发送重复帧的情形，不能只检查视频仍在输出。

## 6. 其他诊断缺口与已排除的误判

| 编号 | 缺口或误判 | 证据／影响 |
|---|---|---|
| D1 | 输入 trace 时间在 10 分钟后固定为 600000ms | `input-trace.js:201–204`；离线结果 `[0,599999,600000,600000,600000]`，无法正确复原长会话事件间隔 |
| D2 | Signal disconnect 没有记录 reason | `signaling.js:1763` 忽略回调原因，难区分 ping timeout、transport close 与主动断开 |
| D3 | 持久化诊断缺少稳定 build 身份，已有资源线索也在落盘时丢失 | 前端 `diagnostic.js:399` 上传 startup.resources，可带哈希资源路径；服务端 `lib/diagnostic.js:609` 组装报告时未保留 startup。无法据持久化报告证明长开页面已加载最新修复；服务端 dist 新不代表浏览器已刷新 |
| D4 | Host rssMiB 是历史峰值 | 数据源 `ru_maxrss`，不能把它解释为当时 RSS；此前资源结论以独立系统采样为准 |
| D5 | 只有超过阈值的 event-loop lag 被记录 | 不能拿这些日志的分位数冒充完整运行延迟分布 |
| D6 | 诊断上传时间不等于故障发生时间 | receivedAt 只能作为接收时刻，需结合包内事件时间、build、attempt 和现场日志 |

其他核对结果：

- 之前 21 次 paint-pending-timeout 中 18 次来自主动 suspended，属于诊断误报；相关修复已在此前阶段完成，不应再把这些计为网络断线。
- DC 的 open、PC 的 connected、health 的 200，各自只证明对应层状态；不能替代业务输入 ACK 或新鲜画面。
- unordered move 的 ACK accepted=false 不代表所有输入被拒绝。
- 恢复超时瞬间的 recovery=idle 快照不一定表示永久失败；后续帧可能继续触发恢复，需要检查后继事件。
- 当前普通模式 stats 约 1Hz 且避免重叠，未启用测试专用像素读取；没有发现这两处无界高频工作。
- Signal 日志库确有同步 stat/append（`lib/observability/logger.js:36`），诊断持久化也有同步文件操作（`lib/diagnostic.js:367`）；但结构化文件 sink 是否启用尚未确认，诊断目录约 4.4MB，当前没有日志洪泛。保留为待 profile 的风险，不列为此次已证实根因。

## 7. 修复优先级建议与验收依据（未实施）

1. **先解决会持续制造停顿的环境与控制循环问题。** 对 N1 做时间关联的轻量观测并建立负载预算；对 N2 隔离同步捕获编码。验收必须证明慢捕获、换页压力下控制 ACK 与心跳仍有可解释的时限，不能仅看进程存活。
2. **修复控制权状态机与异步竞态。** 优先 R1、R2、R4、R5，再覆盖 R6–R11；R3 的普通键盘 ACK 失联检测必须一并补齐。验收包括接近租约过期的重连、Host 拒绝迁移、旧 ACK 迟到、旧 offer/media await 与新授权交错、reset 在断线期间超时。
3. **修复性能降级与输入积压。** 联合检查硬/软编码资格、FPS、分辨率和码率策略，以及可靠输入背压。使用同条件验证，记录 fresh FPS、控制排队时长和真实编码阶段耗时，不能用不同负载时段直接做倍数比较。
4. **补齐网页与入口恢复行为。** N5 的总截止时间/冷却、N7 的鉴权错误分类、N8–N10 的资源与超时恢复；验收 503、悬挂、旧资产跨发布、CSS 单独失败，以及慢探测和恢复超时。tunnel 操作必须另获用户直接授权；这些建议不是本轮操作授权。
5. **修正测量后再做长期稳定性验收。** N6、N13、D1–D6 及前端 N11/N12。后续在合适维护窗口进行数小时公网实际操作验证，覆盖空闲恢复、切后台、网络抖动、键盘输入、鼠标点击/滚轮、媒体模式切换和跨版本页面；需要记录失败率、恢复耗时及 p50/p95/p99，当前少量采样无法给出这些统计。

建议验收协议分别定义“页面能打开”“信令在线”“新鲜画面持续到达”“可靠输入已应用”“断线可自动恢复”，避免一个绿色状态代表所有层。具体性能目标应基于业务要求与同机可用资源确定，本报告不虚构已经达到的 SLA。

## 8. 验证方式、范围与限制

- 主线和三个独立专项分别审查前端、Host、Signal/入口；报告初稿再次交叉复核，已修正同页重连的条件、R6 的人工出口、R8/R10 触发条件、build 身份落盘丢失，以及公网探针失败和系统压力的因果边界。
- 使用源码审查、已有生产日志、少量未鉴权 GET、系统资源只读快照、轻量离线 fake-clock / VM / 状态机交错复现。R/N 项已分别注明生产事实与离线条件。
- 没有打开或连接新的生产 Viewer，没有物理输入、压力测试、实时浏览器性能录制或修改用户会话；因此没有端到端证明用户最近一次故障的完整请求链。
- 前阶段 799 个 Web、85 个 Signal、84 个 Host 测试通过，合计 968；本轮没有重跑全套或构建生产 dist。这些测试未覆盖本次发现的多条交错路径，也不能代替公网长时间验收。前阶段结果见 [原证据摘要](evidence/2026-10-16-control-recovery/summary.json)。
- 日志会追加或轮转；正文行号对应审查时文件，证据摘要保留关键时间和数值，不复制 token、密码、SDP 或原始输入内容。源码哈希用于标识审查版本。
- 主要未知：用户“刚刚打不开”的精确时刻与错误类别；首次 reliable DC 失效的底层原因；19:34 formal-down 的最初网络原因；每个服务停顿中系统调度、原生等待、GC 和实际执行各占多少；用户端主线程、网络和缓存状态。

后续文档：已按用户指定的brainstorming + writing-plans补齐[三天复查及解决方案](2026-10-17-three-day-review-and-solution.md)、[总spec](../specs/2026-10-17-reliability-latency-remediation-design.md)、[总plan](../plans/2026-10-17-reliability-latency-remediation-plan.md)及三个子项目设计/计划。新增G1诊断留存方向错误；N4提升P1。历史采样窗口保留，不与新窗口混算。

**本轮结果：完成诊断与复查，确认多个相互独立的恢复缺口和性能瓶颈；仅保存报告和证据，未实施修复、重启或 tunnel 操作。**
