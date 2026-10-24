# Reset ACK 回程优化实测与系统性复核

日期：2026-10-25（Asia/Shanghai）。已完成改前及改后各20对reset、正式within-grace短断线、故障前五分钟被动采样、正常UI诊断落盘及最终运行核对。实现已提交main并加载。当前结论只覆盖reset-only安全释放和文中限定的恢复/采样范围。

改后40次reset全部由DC镜像ACK先完成，原Socket ACK随后40次全部观察到；真实pending正常消费，M1每次只推进一次，Socket迟到副本没有再次推进。本批原M1 RTT的mouse p95从500.7ms变为275.8ms，keyboard p95从502.6ms变为276.5ms。仍未达到200ms目标：改后mouse/keyboard p50为201.7/205.6ms，且存在314.2/462.1ms尾样本。该结果不是业务输入、物理显示或长期可用性验收。

改前来源为[已入库基线](evidence/2026-10-25-reset-ack-latency/before-native-reset-api.json)，范围为73.884秒、20对/40次reset；改后来源为[入库脱敏汇总与逐样本记录](evidence/2026-10-25-reset-ack-latency/after-native-reset-api.json)，范围为76.717秒、20对/40次reset。两次均调用原产品reset API，`routeOverride=false`、`productFunctionsOverridden=false`；均未发送业务键鼠、文字或坐标输入。改后70条健康采样均为scope稳定、PC/Socket connected、inputAllowed，Socket route为websocket，ICE两端候选类型均为relay。这些是该采样窗口的证据。

| 已加载组件事实来源 | 改前 | 改后 |
|---|---|---|
| Signal/Viewer source | `a88f7fecb2dc630ed7658c315acc71e4bed3f03b` | `6312429d6cd4b40d8769e8daba2c098fb0c25ddb` |
| Host source | `9e352fc8d3abb315d69194ff45f82fa76bc8c22c` | `6312429d6cd4b40d8769e8daba2c098fb0c25ddb` |
| Viewer build | `79d27719867d5814` | `c6915df5ba8c0c6f` |
| PID记录 | Signal 15428、Host 64981 | Signal 83219、Host 83441（root部署记录） |
| 版本依据 | 基线部署记录与root attestation | summary manifest与root attestation |

不能从当前仓库HEAD推断进程加载版本。以上改后source/build取自冻结summary和root部署记录。改后私有summary SHA256为`53529db4f745cbb84afed3d54e990a30adeee004e7711602053d29245c842b50`，私有samples SHA256为`b52645aa955e94a11950e4521b8f1b4c87facd774c3c77d8710645ed6a483d6e`；probe SHA256为`30e8586a6c130b44434c55bae4a2a9c99c6481521f1bb5d05cd2b9bbef21faac`，其改前模板SHA256为`b73b5008a0c6347057e5c22339de36dea4779c278cf2c5bfce57d4fcb5c2c77f`。对应脱敏时长、逐输入hash关联、源摘要及配对差分布已保存入库；[独立探针复核](evidence/2026-10-25-reset-ack-latency/probe-validation-review.json)记录`NO_MUST_FIX_FOUND`及原始DC到达未知等限制。

本次选择“唯一Socket请求、成功结果经当前DC补充回传”。Host仅为已执行成功的schema2、单ID、mouse/keyboard reset结果镜像`resetAckMirrorVersion=1`，发送前在无await间隙核对authority、绑定及当前DC归属，best-effort DC失败不影响原Socket ACK。Viewer只允许发送时捕获且仍current的DC成为该reset pending的第二ACK source，继续执行ID/type、lease/epoch、attempt、socket对象/id、seq和barrier校验。保留原3秒barrier与Socket兜底，不复制请求、不重放业务输入、不操作tunnel。

拒绝“双通道同时发reset请求”，因为mouse sequence-gap可能rewind并发送新reset，旧副本迟到可能干扰后续seq；不能只凭同ID/seq假定所有恢复分支永远幂等。延长期限或仅改变RTT口径也不能减少实际确认等待。

以下统计均为每种输入n=20，分位按nearest-rank计算；所列原M1及产品后置阶段没有缺测。API→后置处理结束的改前值由基线40条逐样本计算，改后取冻结summary。

| 指标，ms | Mouse改前 p50 / p95 / max | Mouse改后 p50 / p95 / max | Keyboard改前 p50 / p95 / max | Keyboard改后 p50 / p95 / max |
|---|---:|---:|---:|---:|
| 原M1 `inputAckRttMs` | 414.4 / 500.7 / 513.3 | 201.7 / 275.8 / 314.2 | 420.0 / 502.6 / 514.3 | 205.6 / 276.5 / 462.1 |
| API入口→产品后置处理结束 | 415.1 / 504.1 / 513.9 | 202.5 / 276.7 / 315.0 | 420.7 / 503.9 / 514.8 | 206.3 / 277.0 / 462.8 |
| 新产品入口RTT `inputAckArrivalRttMs` | 未部署/缺测 | 201.6 / 275.7 / 314.1 | 未部署/缺测 | 205.2 / 276.1 / 461.7 |
| 新产品处理阶段 `inputAckValidationMs` | 未部署/缺测 | 0.1 / 0.2 / 1.0 | 未部署/缺测 | 0.4 / 0.5 / 1.1 |

以下为各自时钟区间的辅助分段，均为每种输入n=20、缺测=0；其分位不能与Viewer分位相加/相减以分解一条输入的端到端耗时。

| 指标，ms | Mouse改前 p50 / p95 / max | Mouse改后 p50 / p95 / max | Keyboard改前 p50 / p95 / max | Keyboard改后 p50 / p95 / max |
|---|---:|---:|---:|---:|
| Signal本地forward→Host ACK | 5.985 / 13.866 / 17.942 | 8.160 / 21.025 / 21.140 | 6.001 / 14.240 / 17.872 | 10.669 / 20.574 / 21.109 |
| Host adapter await | 0.684 / 3.147 / 7.294 | 0.699 / 3.791 / 8.185 | 0.456 / 0.713 / 2.276 | 0.778 / 2.565 / 8.708 |
| Host adapter内queue | 0.212 / 2.115 / 6.165 | 0.190 / 1.764 / 2.336 | 0.151 / 0.276 / 2.071 | 0.186 / 0.324 / 0.497 |
| Host apply | 0.006 / 0.016 / 0.021 | 0.007 / 0.028 / 0.041 | 0.045 / 0.104 / 0.113 | 0.055 / 0.123 / 0.131 |

改后40/40次同时证明了原M1及两个新指标各自rolling count增加一次、对应真实pending消费，并满足探针age≤20ms的样本归属要求，三项实际最大sample age均为1.5ms。原M1的发送/提交时点与全局clock规则未改变；新增入口时刻仅作差值数据，不能回退clock。新指标仅记录同scope、正向ACK、真实pending匹配且到达时刻位于sent至处理时刻之间的样本；缺失、非法、拒绝、旧scope、超时和迟到副本保持缺测。

`inputAckValidationMs`是产品ACK入口至C、相关UI/同步工作、scope同步及M1取时提交阶段的elapsed，不是纯验权CPU。其结束点之后的controlled observation及最终passive trace不在该M1取时点之前。改前Socket `prependAny`→新增后置listener的mouse p50/p95/max为0.5/0.7/2.4ms、keyboard为0.7/0.9/1.5ms；该段包含此前所有同步listener，不能与新产品处理阶段直接等同。

改后原始DC listener到达仍为unknown：私有顺序fixture观察到`original-onmessage → capture-arrival → post-listener`，后加`capture:true`不能证明早于产品handler。因此改后`apiEntryToAckArrivalMs`与`ackSynchronousHandlerMs`均为0个有效值、每种输入缺20个；没有补0。新产品入口RTT是原M1发送时点至产品`acceptObservedInputAck`入口，不是native wire arrival；API入口→后置处理结束还包含提交前同步工作，也不是精确enqueue RTT。

同一改后样本内，40个hash各有DC首ACK与一个Socket迟到副本。逐hash计算`late.apiEntryToCopyPostHandlerMs - first.apiEntryToPostHandlerMs`后再汇总，得到下表；这是同Viewer clock、同输入和同API起点的实测后置处理差，不是相减两组p95，也不是单向网络或物理呈现。

| 镜像先于该Socket副本的实测差，ms | n | min | p50 | p95 | max |
|---|---:|---:|---:|---:|---:|
| Mouse | 20 | 164.3 | 196.6 | 235.1 | 322.4 |
| Keyboard | 20 | 163.1 | 195.4 | 216.5 | 234.3 |

全部40个Socket副本到达时`productPendingAfter=false`、`m1AckCounterUnchanged=true`且`lateDuplicate=true`。完整Socket副本观察阶段额外预算3秒，实际收齐阶段耗时0.184秒；这些副本不计为新输入。该配对证据直接显示本次镜像比同一输入的Socket副本更早完成产品处理，但不保证其他网络状态下固定收益，不能由此替代Socket-only故障回退验证。

对40个post reset hash只匹配结构化事件，排除普通console重复行、其他会话及无关reset：当前`back-debug.log`匹配行1609–1854，UTC为2026-10-24 22:58:33.937091至22:59:02.884223；每个hash各且仅有1条`host_input_received`、1条`host_input_result`、1条`host_input_ack_sent`，合计120条。40条result均为`applied`，40条Socket ACK enqueue均为`ackAccepted=true`。`/tmp/signal-server.log`匹配结构化block行601051–603052，UTC为22:58:33.933至22:59:02.885；每个hash各且仅有1条`signal_input_relayed`和1条`signal_reset_ack_observed`，合计80条。所有40个hash都完整关联，未发现同hash第二条Host执行结果日志。逐hash五事件的白名单metadata、UTC定位、源line/block SHA及尾样本时长已保存为[有界关联evidence](evidence/2026-10-25-reset-ack-latency/host-signal-reset-joined.json)，没有复制整个活跃日志。

全部120条Host关联事件的inputType、seq、leaseEpoch与对应样本一致，action=reset、transport=socket、inputIdCount=1，字段不一致为0。这是“日志记录了单请求、单次applied结果及原Socket兜底”的证据，与DC只镜像ACK的实现一致；它不是物理输入/显示proof，也不能将未观测的native效果写成通过。Host仍可能因其他生命周期动作记录不带这批hash的安全释放，它们不应混入本批reset计数。

最大尾样本为第15对keyboard reset，hash `9f818b2233d10b81`，seq=15、leaseEpoch=1。它经Socket唯一请求，DC marker=1的ACK先完成；原M1为462.100000ms，产品入口RTT为461.700000ms，产品处理阶段为0.400000ms，API→首ACK后置处理结束为462.800000ms。Host adapter await为0.796984ms、adapter内queue为0.182353ms、apply为0.049882ms；Signal本地forward→Host ACK为20.574389ms。其Socket副本在API起点后637.500000ms被动到达、637.800000ms后置处理结束，pending保持已消费、M1计数不变。镜像先于该Socket副本后置处理结束175.000000ms，尾部仍真实保留。

同对mouse hash `0dd3be39d594d874`亦为seq=15：原M1 314.200000ms、产品入口314.100000ms、产品处理阶段0.100000ms，API→首ACK后置处理结束315.000000ms。Host adapter await为0.657249ms、queue为0.189786ms、apply为0.004860ms，Signal本地bracket为21.140138ms；Socket副本后置处理结束637.400000ms，镜像领先该副本322.400000ms。两条输入都出现尾部，但各自API起点不同，不能将跨输入的时长差直接解释成某一网络方向的额外延迟。

| 第15对关联证据 | 源位置 | SHA256 |
|---|---|---|
| Keyboard Host receive | `back-debug.log:1788` | `7bef51e746eaa757d1b6bc0c7042cb967f36a8f37f58695f18476febcce307a0` |
| Keyboard Host applied result | `back-debug.log:1790` | `17017f102d92a1fdd10b4dc683db852f96f10e987001ebcad6703ce54806b98d` |
| Keyboard Host Socket ACK enqueue | `back-debug.log:1791` | `6e041d95611b9fdc45a12889d783626b85c715967f9378c7dc6d4f6c05dca450` |
| Keyboard Signal relay block | `/tmp/signal-server.log:602491` | `9c7935fe877ff3f899a5bd4e3cc72884aeb68fd353ab86119756da03efe09a55` |
| Keyboard Signal ACK block | `/tmp/signal-server.log:602539` | `ece1dab24d7fce9b3dad4fa762dc4a05ba513959ec58628848669a082a7c0e3d` |
| Mouse Host receive / result / ACK | `back-debug.log:1784 / 1786 / 1787` | result：`631c0642b6b2f38e28a9216de96531b0e6046ccfb7c359806af4c58e61cdbba0` |
| Mouse Signal relay / ACK block | `/tmp/signal-server.log:602466 / 602515` | ACK：`e79a2567f6673b6fd4362787b774fa949b6875465e90d543d7ead0e44919d182` |

Host line hash按整行UTF-8内容、不含换行计算；Signal block hash按顶层`{`至匹配顶层`}`整块、行间LF且不含末尾LF计算。UTC只用于定位各日志，未做跨进程时钟相减。上述日志会继续追加/轮转，最终脱敏evidence应保留该批匹配窗口和digest，不以整个活跃日志的持续变化SHA作为永久关联依据。

剩余462ms尾部不能由0.4ms产品处理阶段或不到1ms的Host adapter await解释；已测Signal本地约20.6ms bracket也显著较小。这支持继续调查这些有限测量区间以外的等待，但不允许把462ms减20.6ms或Host时长后称为纯网络。Signal bracket包含本地传输、Host及服务调度/校验，不证明Viewer收到ACK；Host adapter/queue又不包含外层Host admission等待。原Socket请求上行、relay DC回程、服务区间外调度和浏览器产品入口前排队仍未被独立分离。

后续建议按现有证据优先进行：保留逐hash有界样本，在不改变协议的前提下细分Socket提交/flush/drain、Signal handler入口与转发前后、Host外层admission、DC enqueue/backpressure及Viewer产品入口前后的同进程单调时间；结合实际选中relay链路的getStats及RTT再判断TURN路径机会。若产品处理阶段仍为约1ms，优先调查入口前等待，而不是先优化验权CPU。不要通过重复reset请求、放宽owner/seq校验或延长barrier掩盖尾部；健康DC的优势也不构成重建tunnel的授权。

源码验证与部署记录如下，离线通过、加载和真实运行证据分别保留：

- Host新增镜像focused测试及peer cleanup、control transition、input timing回归共57/57。使用AST/memory transport隔离native依赖；逐例覆盖DC missing/closed/throw/congested/old owner、普通/失败ACK不镜像、原Socket仍发送、Socket发送失败不撤销DC已入队结果。未在生产故意破坏DC来声称硬件故障回退已测。
- Viewer两个传输/恢复测试文件164/164；补充keyboard-DC-first/mouse-Socket-last的乱序集成1/1。Task3b focused23/23及三个文件624/624通过。
- 最终12文件定向前端回归1080/1080，无skip/fail，40.508秒；直接`node --test --test-concurrency=1`，未执行会发布dist的npm pretest。覆盖input、backpressure、datachannel fallback、signaling continuity/recovery、keyboard transport/controller、latency、WebRTC、frame trace、signaling fallback和私有持久化。
- 通过显式私有outDir调用`buildWebClient`得到`c6915df5ba8c0c6f`，确认生产manifest字节及mtime未变；提交main `6312429`后才维护加载本地Signal/Host。实际加载build与私有构建一致，Signal helper报告Interactive，Host经既有launchagent流程启动。
- Host、Viewer、Task3b及最终跨文件独立静态审查均无必须修正代码项。真实20对探针又经独立逐样本复核；另独立按源位置重算120条Host line SHA与80条Signal block SHA，200/200吻合。最终文档审查发现JSON同钟分组混入Host时长，已移到`hostReportedStageMs`并更新引用digest，未改变原测量值。`host_input_ack_sent.ackAccepted=false`只表示原Socket enqueue失败，不能据此判定DC镜像失败。

验证日志摘要、源摘要及私有构建事实见[验证记录](evidence/2026-10-25-reset-ack-latency/verification.json)。整体检查未放宽任何owner、seq、barrier或业务输入guard。

[正式within-grace恢复及故障前五分钟采样汇总](evidence/2026-10-25-reset-ack-latency/short-rebind-and-five-minute-observation.json)已完成。正常UI Start验证为freshPage/authVerified、vacant-only、Start标记0→1、guarded API请求1次；native-direct close触发1次，HTTP/WebSocket拦截均为0。`ordinaryRecovery.status=PASS`，classification为`within-grace-rebind`，恢复耗时3.998597秒，随后稳定30.031241秒，server coverage完整，failure为null。Host观察344条、coverage完整、status=stable、未观察到Host断连。

故障前被动基线覆盖300.276188秒、301条样本，missing/late/failed/identity-change/path-change均为0，最大无进展间隔300ms、其后有帧进展；帧依据为rVFC。最终原始`continuity.status`仍为**INCOMPLETE**，必须保留：`scripts/ordinary_session_recovery.py:812`先要求内部continuity达到PASS才设置baseline_ready，`:778`禁止未ready触发fault；`:888`在已attempt故障的最终结果中显式传`interrupted=attempted`。因此可报告“故障前五分钟完整被动采样及正式within-grace恢复PASS”，不能将最终continuity改写为standalone无故障连续性PASS。`threeHourContinuityMet=false`，不构成三小时验收。native after-grace资格仍为NOT_RUN。

[独立一对reset的生产UI持久化集成](evidence/2026-10-25-reset-ack-latency/production-ui-metric-persistence.json)通过：继承vacant-only/current owner/scope/health guard、正常UI诊断发送，服务端返回保存确认，root随后只读实际`/tmp/wrd-diag/raw`中schema3文件，核对build、receivedAt=2026-10-24T23:17:50.612Z及两项新指标。两个指标各count=2，last与同会话发送前数值精确一致、落盘sample age约528.1ms。该独立41.120秒运行不并入前后20对延迟比较；辅助文档review有一次约10秒CPU读取被及时中止，因此本集成也不用于任何性能资格。保存确认加实际文件重读不等于证明未来重启后的持久性。

该诊断`logCount=0`、reported=103、retained=0、redacted=103、logContentPolicy=metadata-only；这是正文脱敏后的计数，不能称103条丢失。保留18个input trace事件，`inputTrace.counters.droppedEvents=0`、truncation.dropped=0；它们仅属于本次快照，不能充作两天全部summary gap/ring drop的覆盖证据。

[最终运行核对](evidence/2026-10-25-reset-ack-latency/final-runtime-health.json)：本地与公网health正常，公网manifest与本地一致，Host在线；Signal83219/Host83441未再变化，Viewer/relay Viewer均0，Terminal启用且session/cleanup pending均0。正式入口为https://link.stockhub.wiki，公网探针显式绕过环境proxy。cloudflared仍为PID6438、启动时间2026-10-24 09:54:07，本轮未操作tunnel；safe quick URL文件原本缺失且仍缺失，没有生成或替换临时地址。

本地重启后Viewer与Terminal admin密码已从当前运行配置读取并同时在会话回报，不写入版本文档。owned页面cleanup API均完成，服务端Viewer已归零；`api-finished-exit-unknown`/`ownedProcessExitEvidence=not-observed`仍不能证明独立OS进程退出。密码、token、原始输入正文、坐标、原始lease/socket ID不写入本文。

业务键鼠/文字输入、应用内容变化、真实可见效果、物理显示及三小时长会话验收均为**NOT RUN**。reset-only安全释放、ACK成功、rVFC或本次70条健康采样不能替代这些验收。
