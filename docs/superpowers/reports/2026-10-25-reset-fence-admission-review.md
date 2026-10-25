# Reset 屏障与 Host 排队观测实施复核

日期：2026-10-25（Asia/Shanghai）。承接[上轮 ACK 回程实测](2026-10-25-reset-ack-latency-review.md)。本轮代码已合入 main `7ba8dcf`，经既有 helper 仅重启 Host。Signal PID83219、源码 `6312429`；Viewer 源码同为 `6312429`、build `c6915df5ba8c0c6f`；Host PID31867、源码 `7ba8dcf`。不能用后续文档提交的 HEAD 推断这些进程版本。未重建客户端，也未操作 tunnel。

本轮解决的是缺口恢复多一次往返及错误成功确认，并补齐外层排队观测，不能声称健康 RTT 或全部断连根因已经解决。20 对安全 reset 公网实测全部通过：40 次唯一 Socket 请求、40 次 DC 首 ACK、40 个原 Socket 副本收齐，pending/M1 均只消费一次。当前 mouse/keyboard 原 M1 RTT p95 为347.4/348.2ms，仍不满足200ms目标。与上轮网络时段不同，本轮明确 `performanceComparisonEligible=false`，不将差值归因于本轮代码。

## 已修复的问题与边界

1. **Mouse reset 原先也要求序号连续。** 纯模型复现：普通输入 seq1 成功，reset seq3 因缺口被拒绝，迟到普通 seq2 成功，rewind 后的新 reset seq2 被当作 duplicate；这个 duplicate 不能证明释放发生。现在 reset 可作为向前的单调屏障，但只有执行锁内原生释放成功且原 authority fence 有效，才提交 seq 和成功证明。晚到的低序号普通输入不执行；普通 command/down/up 的连续规则保持。
2. **重复 seq 不足以证明 reset 成功。** Mouse/keyboard 每种只保存一份有界、仅内存的已成功 reset seq/ID 证明。当前 lease 内只有精确副本可返回 duplicate；不同 ID、普通操作碰撞或无证明的旧 seq reset 返回 resync-required。旧 lease 在序号和证明检查前以 stale-lease 拒绝。失败或过期 fence 不产生证明，不放开控制屏障。
3. **原生释放失败不能清掉 tracking。** Mouse 逐按钮确认释放成功才移除，失败及未尝试项保留以便真实重试。Keyboard 显式 reset、生命周期 reset 和 transition 若仍有按键未释放则失败，不能安装新 lease。兼容适配器的 seq 也仅随 applied 且有效 fence 推进，修复失败 reset 后下一次 keyup 永久 sequence-gap 的问题。
4. **原 `hostQueueMs` 未覆盖外层 admission。** 新增 `hostAdmissionWaitMs`，从现有 submit 的 perf_counter_ns 到 `_execute_input` 入口，只附在既有低频 `host_input_received`。原 adapter queue、ACK 和 Viewer 指标意义不变；缺失、倒序或非法值为 null，不改 FIFO、不插队或增加逐消息任务。

前三项由纯状态/AST fake-native 测试复现并验证，没有向生产构造乱序业务输入。正常 reset-only 运行验证加载版本与日常成功路径，不能替代失败的物理释放或业务可见效果证明。设计与步骤见[spec](../specs/2026-10-25-reset-fence-admission-design.md)、[plan](../plans/2026-10-25-reset-fence-admission-plan.md)。

## 当前公网 reset 实测

来源：[脱敏逐样本与汇总](evidence/2026-10-25-reset-fence-admission/native-reset-api.json)。时长73.228秒，30秒预热后20对、40次安全 reset；业务键鼠/文字、应用可见效果及物理显示均 NOT RUN。70条健康采样均为 scope 稳定、PC/Socket connected、inputAllowed，Socket route=websocket，两端选中 ICE 候选均为 relay。实际本会话 Socket WebSocket handshake 为101，Cloudflare edge colo=SEA；这不是 TURN 节点位置或单向延迟证明。

下表每种输入 n=20，nearest-rank 分位；除明确未证明的 DC 原始 listener 到达阶段外，表中项目无缺测。各进程阶段不得做跨钟相减或相减两个 p95 来分解网络。

| 指标，ms | Mouse p50 / p95 / max | Keyboard p50 / p95 / max |
|---|---:|---:|
| 原 M1 `inputAckRttMs` | 222.7 / 347.4 / 358.6 | 239.0 / 348.2 / 369.1 |
| 产品入口 `inputAckArrivalRttMs` | 222.6 / 347.2 / 358.5 | 238.5 / 347.6 / 368.6 |
| 产品处理 `inputAckValidationMs` | 0.1 / 0.3 / 1.5 | 0.5 / 0.6 / 1.5 |
| API入口至首ACK后置处理结束 | 223.9 / 348.5 / 359.7 | 239.8 / 349.1 / 370.0 |
| Host adapter queue | 0.328 / 3.789 / 10.919 | 0.204 / 0.636 / 1.804 |
| Host apply | 0.010 / 0.037 / 0.038 | 0.086 / 0.170 / 0.177 |
| Host adapter await | 1.263 / 4.468 / 12.310 | 1.069 / 5.288 / 13.997 |
| Signal本地forward至Host ACK | 11.411 / 26.493 / 28.145 | 14.236 / 28.217 / 29.481 |

DC 原始 listener 到达仍 UNPROVEN，因此 API→raw arrival 和 raw listener 同步阶段各缺40个值，保持 null。产品入口时钟及原 M1 时钟边界与上轮一致。额外3秒预算内收齐 Socket 副本阶段实际耗时0.197秒；40个副本均保持 pending 已消费、M1不增加。当前运行不比较上轮批次的健康 RTT 改善。

新增外层 admission 的[逐hash关联](evidence/2026-10-25-reset-fence-admission/host-signal-reset-joined.json)完整：UTC04:55:21.781至04:55:51.034，每个输入各1条 Host received/result/Socket ACK 和 Signal relay/reset ACK，共200条。40条result均applied、40条Socket ACK均ackAccepted，Signal阶段40/40与探针吻合，未观察到同hash第二条Host执行结果日志。日志source line/block SHA与分析时快照摘要保留，不复制整个活跃日志。

`hostAdmissionWaitMs` 40/40有值，整体 p50/p95/max=0.294/1.840/2.747ms；mouse为0.166/0.929/2.747ms，keyboard为1.064/1.840/2.011ms。最差原M1样本是第6对keyboard hash `73cdc7cf933f4511`，RTT369.1ms、产品处理0.5ms；其 admission0.597ms、adapter queue0.265ms、apply0.170ms、adapter await13.997ms、Signal同钟bracket29.481ms。这些已测阶段不足以解释该等待，但不能将369.1减去这些数后命名为网络，也不能把它当CPU profile来排除全部CPU调度问题。Signal bracket已包含Host阶段，不叠加。

同一输入DC首ACK至Socket副本后置处理差的nearest-rank p50/p95/max，mouse为215.6/247.5/383.4ms，keyboard为217.9/382.6/837.3ms；每种n=20。它证明本会话镜像通常早于同一输入的原Socket回程完成，不能解释为单向网络，也不是本轮序号修复的健康RTT收益。新增admission观测补齐了上轮明确缺失的区间，仍需继续定位已测区间以外的等待。

## 公网入口仍存在的问题

本轮一次显式绕过环境 proxy 的 `/health` 返回 Cloudflare 502，响应 Date 为2026-10-25T04:17:08Z，SEA，TTFB2.219345秒、总耗时2.220093秒。同一分钟 tunnel 日志04:17:05Z记录 `originService=http://localhost:8080` 的 EOF。该时间相关性支持继续调查 origin/tunnel 边界，但没有 request/Ray 精确关联，不能证明是同一请求或已确定根因。本地 Signal/Host检查正常。没有以这次故障为由重启 tunnel。

随后四次标明路径的健康请求均200：绕过环境 proxy 的两次 SEA/HKG，总耗时0.959/1.199秒；使用环境 proxy 的两次 SJC，总耗时1.158/2.715秒。canonical health 的一次200使用 environment proxy，单靠它不能证明原绕过 proxy 的路径恢复；后两次 direct 200才补上这一证据。

另保留一次未认证浏览器入口探针 TimeoutError、12.520秒、无响应且 cleanup incomplete 的失败。随后同类探针成功，三个 HTTP200/HKG；复用连接 request→first byte 为522.3/630.6ms。它只测未认证 HTTP health，不是用户 WebSocket、TURN、输入或物理显示路径；其后正式 reset 会话才实际观察到 WebSocket101/SEA。不能把 HTTP TTFB 等同纯网络 RTT，或由代理环境推断 Chromium 一定经过同一路径。

网络证据见[路由观察与失败保留](evidence/2026-10-25-reset-fence-admission/entry-route-observations.json)。现有 ws 已设置 TCP_NODELAY、Viewer 已优先 WebSocket且未启用压缩，不把这些当作尚未开启的优化。Node keepalive 和 localhost IPv4/IPv6 差异尚不足以确定 EOF 根因，本轮没有猜测性调整配置。其他工程的 CPU 工作负载与网络设置均未操作。

## 短断线与结束时运行状态

[正式within-grace验收](evidence/2026-10-25-reset-fence-admission/short-rebind-and-five-minute-observation.json)通过。正常UI Start为freshPage/authVerified、vacant-only，Start标记0→1、guarded请求1次；对owned连接仅触发1次native-direct close，HTTP/WS拦截均0。`ordinaryRecovery.status=PASS`、within-grace-rebind、恢复3.999185秒、随后稳定30.025816秒，server coverage完整、failure=null。345条Host采样均stable、coverage完整，未观察到Host断连。

故障前canonical continuity覆盖300.240649秒、301样本，missing/late/failed/identity/path-change均0，最大无进展383.4ms且之后恢复帧进展，帧依据rVFC。最终`continuity.status`保留INCOMPLETE：工具在故障前内部完整baseline通过后才触发close，最终按实际attempt将continuity标interrupted，不能把故意短断线运行升格为standalone连续性PASS。`threeHourContinuityMet=false`，native after-grace仍NOT RUN。

原始样本中phase=baseline为300行，canonical计数额外含初始ready样本，二者不混用。phase端点跨度299.238秒，decoded frame增5731、callback增5554、浏览器reported dropped frame增0，端点平均约19.15 decoded/s、18.56 callback/s；不是瞬时/抓帧FPS或物理显示。所观察candidate RTT为30–213ms，与reset批次时间不同，不能用来分解其ACK延迟。owned passive sampler自己的128项诊断ring读取cursor gap最大0，末次累计droppedEvents=999、coverage=partial；源码`passive_session_sampler.js`在淘汰最旧项时累计该值。这不是生产inputTrace计数、不是999次网络输入丢失，也不能当完整生产日志覆盖。所有逐样本元数据和原始文件摘要已保留。

[结束时健康核对](evidence/2026-10-25-reset-fence-admission/final-runtime-health.json)：本地health正常、Host在线，Viewer/relay Viewer均0；绕过环境proxy及使用环境proxy的公网health均200，公网manifest与本地一致；Terminal启用，session和cleanup pending均0。Signal83219/Host31867未变化，cloudflared仍6438、启动时间2026-10-24 09:54:07；safe quick URL文件原本及现在均不存在，没有生成或替换地址。正式入口为https://link.stockhub.wiki。

浏览器cleanup API完成，但`api-finished-exit-unknown`不证明独立OS进程退出。刚结束时一次健康/空闲联合门禁未通过，未持久化当时各子条件，不能据此判定是哪项失败；随后只读核对已确认health正常、Host在线、Viewer0，最终完整核对通过。两次检查均如实保留，未为了满足门禁踢出任何会话。Host-only加载后两密码已从运行配置读取并在会话同时回报，未写入版本文档。

## 验证、复核与未完成资格

11个定向纯模型/AST Python 文件整合结果177 passed、141 subtests；之后独立复核发现并修正 Legacy reset 失败时推进 seq 的问题，最终受影响5文件49 passed。两次不是226个不重复用例。测试不导入真实 Quartz/Host、不操作真实按键。Task1经历失败反例、修复及独立审查；Task2由另一执行者实施、root独立审查，最终无必须修正源码项。验证日志/source SHA见[验证记录](evidence/2026-10-25-reset-fence-admission/verification.json)。

最终独立证据复核完成：Host120条、Signal80块共200/200来源摘要匹配，两源分析时快照SHA和行数匹配，逐样本关联、分位、恢复与帧端点数字、隐私和相对链接均通过，无必须修正项。审查中曾发现摘要生成包含末尾LF，与声明的无末尾LF规则不一致；已按声明重算并独立重验，行号、事件映射及耗时数值未变。旧lease状态文案和规划基线的历史时间标签也已同步纠正。

业务输入到应用后帧、真实可见效果、物理显示、native after-grace、三小时无故障长会话均 NOT RUN；本轮没有补全真实负载下CPU/RSS资源资格，200ms SLO尚未达标。下一优先级是按匹配 hash 补 Socket提交/flush、Signal handler入口和转发、DC enqueue/backpressure 与 Viewer入口前等待的同钟分段，再依据实际选中 relay stats 定位路径；不双发 reset 请求、不重放不确定输入、不以放宽授权或延长 barrier 掩盖等待。公网502/EOF需要独立相关证据，不能宣布由本次状态修复治愈。
