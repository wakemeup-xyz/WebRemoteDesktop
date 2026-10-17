# 晚间反复连接失败与控制中断：继续诊断

更新：2026-10-17 22:27，Asia/Shanghai。状态：继续排查，尚未稳定验收；本地服务保持运行。用户维护授权延续；本轮没有重启或修改tunnel。

## 为什么先前修复后仍有问题

先前修复对应明确的输入排队、租约恢复、鉴权阻塞、缓存epoch等缺陷，但未通过连续三小时和真实输入验收；不能据离线测试或短测宣称整体稳定。今晚又复现停帧，证明确有剩余性能问题。用户此次“连接不上/输入中断”的具体时间和界面状态尚待对齐，不能用本机测试替代用户设备证据。

## 本轮数据边界

21:01:59观察并按当时字节长度保存四份日志前缀，原始内容只存私有临时目录，避免后续自动测试混入既有故障窗口。Signal文件正确由当前PID28142打开，最近写入15:19:10；Host持续写日志。15:55–21:03的3313个已解析Host窗口均PC/ICE none、输入计数0；这只说明该日志未出现已准入活动，不能说明用户未尝试。JSON解析数量与稍后审计截止不同会有微小差异。

watcher15:55:02–21:02:59共287次离散探测origin/formal均成功；20:02以后57次同样正常。这不是连续可达性证明。cloudflared19:16和20:06各一个connector断开后恢复，没有据此证明所有connector同时故障。诊断目录不是空：raw14份、summary33条，最近保存14:08；旧原因计数不能当作晚间故障样本。

## 同版本入口对照

| 窗口 | 结果 | 可解释范围 |
|---|---|---|
| 本地入口，TURN媒体 | 300.177s、301样本、maxgap266.7ms，PASS | 只验证这一短窗口的被动画面连续性 |
| 正式入口，TURN媒体 | 301样本，后续summary记录302.859s、31个failed observations、maxgap10566.326ms，INCOMPLETE；清理也报告失败 | 出现4.666s及更长停帧，不能宣称300s稳定通过 |

两者同build a6e8b15122bde656和同Host；originClass是测试输入标签，不能当作实际网络路由证明。媒体两边均TURN，顺序执行、系统负载不受控，不能把差异归因Cloudflare或页面origin。正式运行总supervisor326.821s，不是媒体时长；7个登记进程自然退出、没有发清理信号，完整进程树退出仍不作保证。实际服务Host在线、Viewer0。

正式测试第104秒、frameAge2483.3ms触发3秒Host sample；样本251172字节、退出0，观测到退出距启动约6.45秒，工具开销和调度包含在内。首轮4.666s停帧对应Host event loop延迟和截图调用：277个采样点中，capture线程70个点在bytearray/PyBuffer_ToContiguous/memmove，79个点在CGDataProviderCopyData/WindowServer IPC，主线程至少82个点等待GIL；encoder和图像处理worker大部分空闲。这是短时采样占比，不是CPU时间或全停顿归因。

后轮10.566s停帧期间，Host在21:18:09.421至19.318约9.897s内CPU仅新增0.134s、captureSeq仅新增1，事件循环迟到8905.41ms/漏8次采样。encoder记录10253.034ms墙钟耗时包含调度/等待，不能称为VideoToolbox纯执行耗时；这次没有同期native stack。Viewer第270–280秒帧/字节/解码均未推进，媒体PC一度disconnected、Signal仍连接；已有RTT快照在无新包时可能陈旧。首轮附近系统swap-in/out约320.7/253.0MB/s，后轮resource快照陈旧14.85s、系统负载升高。证据更支持Host执行/调度或换页停顿；尚未定位单一进程或证明网络无贡献。不能未经验证延长心跳来掩盖实际卡顿。样本原始地址/路径不进入文档。测试summary的cleanup错误覆盖更早的结果分类，需要保留failed observations和原始采样序列一起解释，不能据cleanup字段抹掉停帧。

## 本轮耗时如何解释

| 观测 | 本轮证据 | 解释边界 |
|---|---|---|
| TURN candidate RTT | 首次停顿前约27–28ms，恢复后约784ms；后次暂停前约99ms、恢复后约312ms | 是候选链路往返，包含端点调度；无包期间的旧RTT不能代表当前链路健康，也不能折半当单向视频耗时 |
| 浏览器解码 | 首次停顿前窗口单帧约0.64ms，framesDropped=0，停顿时decoded/received/callbacks一起不前进 | 不支持只归因浏览器解码慢，但不能覆盖所有未测浏览器阶段 |
| Host编码调用 | 首次窗口max153.6ms；后次wall max10253.034ms | 后者包含重排/转换、调度与等待，不是硬件编码器纯计算时长 |
| Host循环与抓屏 | 后轮lag8905.41ms、约9.897s内仅一张新capture且CPU新增0.134s | 支持Host执行停顿，缺同期stack不能唯一分解GIL/换页/调度/原生等待 |
| 输入到ACK/新鲜帧/真实可见效果 | 本轮均NOT RUN | 被动测试没有业务输入；不能用TURN RTT、帧率或reset握手填入这些指标 |

## 已确认需要补齐的日志问题

1. 客户端diagnostic通过Socket emit后立即返回成功，HTTP202也未严格验证保存回执；UI可能误报“已发送”。重放队列还存在异步旧快照覆盖风险。修复已通过定向测试与独立review，22:06已部署；本地HTTP首次及重复提交均202且有效回执，pending=0。
2. 登录400/401/429、verify拒绝、Socket namespace鉴权拒绝和Engine.IO握手失败缺少连续、有界摘要。没有这些证据无法区分请求未到origin与到达后被拒绝。固定类别每分钟摘要已实现并独立review通过，22:06已部署并实际核对完整六类JSONL；不记录凭据、原始输入或URL。
3. 抓屏调用失败静默重试，尚未完成的调用不进入输出帧关联耗时；新增独立的有界抓屏状态、成功/失败计数及年龄观测已实现（9641ecc、39项安全测试与独立review通过），22:06已部署，空闲时正确输出unavailable/null，不修改截图质量或调度。
4. 现有阈值日志不是完整延迟分布；ACK不等于输入可见效果。今晚被动对照没有真实输入，因此M1/M2/真实可见效果保持NOT RUN，不能从画面帧率推算输入时延。

[增量设计](../specs/2026-10-17-evening-connectivity-evidence-design.md)与[执行计划](../plans/2026-10-17-evening-connectivity-evidence-plan.md)已落库。独立设计review纠正了事件ID长度契约和logger脱敏字段兼容问题，保留现有16–64位hex契约，不扩大敏感日志。

## 下一步和结束条件

先修复并review诊断回执和入口摘要，安全部署后核对新build、Host在线及可用态；同时用本次有效sample和时序找出剩余Host停顿的可行动原因，再决定性能修复。继续保持原分辨率/网络模式与tunnel。连接、普通恢复、真实输入和连续性分别验收；未完成的项目不能标PASS。


## 空闲窗口补充：不能只归因抓屏或编码

固定日志前缀8438862字节，止于22:04:58；解析21:20:03至22:04:58的472条Host报告，全部PC/ICE none、captureSeq=0、inputEventCount=0、relayRunning=false。latest lag有35条超过1s，最高15.647243s（21:28:58），22:02:35另有10.245902s；这些是报告时的最新采样，不是全部1Hz采样或完整延迟分布。Host CPU只增加15.083s/2695.232s，约一个逻辑核的0.56%。这证明活动抓屏/编码不是此空闲窗口长迟到的必要条件，进一步支持整机调度、内存/I/O争用或空闲路径阻塞的候选，仍不能唯一归因某个应用。

maxLagMs是滚动60秒最大值，不是该条日志瞬间或上次发日志以来的最大值。22:03:54 latest=13.896ms、max=2469.775ms；不能把后者说成该时刻正在停顿。资源采样有74条timeout，56条没有fresh coverage，最高age67.45s；最大的迟到往往恰好缺同期资源数据。available资源中的换页率很高，但采用缓存样本，不应据重复值生成独立时间分布。22:03:54报告的先前采样区间swap-in/out约224.26/293.17MiB/s；这是全机速率，不是Host占用。

一次独立只读快照：物理内存32GiB、swap已用23165.75MiB（约22.62GiB）；memory_pressure -Q的free percentage=63%，其口径不同于vm_stat free pages，不能将历史memoryPressure=unknown改成健康，也不能只靠swap存量判定瞬时压力。没有关闭/调优其他应用、没有改变tunnel。下一项有价值的对照是降低无关工作负载后的同配置测量；当前证据不支持通过延长心跳或反复重启替代这一步。

## 22:06部署与分层验收

最终增量review范围6e45276..db5d2b1，无Critical/Important。隔离构建、冻结apply后只用既有helper重启本地Signal/Host，25.829s；Signal89188（22:06:22）/Host89291（22:06:28），build067dfc41e8374b4e，保留a6e8b15122bde656/c30530f331a4def5。主HEAD/index、未涉及文件、cloudflared84671/watcher897身份、quick URL缺失状态均保留，四个watcher源码未部署。

既有结构化轮转sink已在本机配置启用，目录0700、文件0600；10MiB当前文件+3份backup是容量上限，不保证三天覆盖。首条entry_window从22:06:27.794到22:07:27.824，elapsed60028ms、missed0、completionCoverage=true，六类meta完整、无收集/写入失败；namespace accepted=1包含Host，不能当作用户数。Host22:08:00空闲capture正确为unavailable且计数/耗时null。

实际客户端source+HTTP的有界提交：firstConfirmed=true、duplicateConfirmed=true、两次202、pendingCount=0，前后Host在线且Viewer/relay计数均0；这只验证HTTP保存回执与同ID去重，不是渲染UI或Socket正常ACK验收。正式入口的新300秒被动测试已结束，INCOMPLETE；不把短测或日志生效写成整体稳定通过。

真实可见效果工具再次源码复核：当前共享桌面缺少已实现的native隔离probe，现有runner明确BLOCKED；维护授权已具备，缺的是可验证的独立输入/捕获环境，不能用CLI布尔值绕过。没有为了重现此已知阻塞而启动额外Host/可见producer；详见[输入可见效果边界](2026-10-17-visible-effect-acceptance-boundary.md)。


## 新观测版本复测与启动期根因

22:09:33.635–22:14:33.634完成301条被动样本；summary303.011s含清理/记账，supervisor373.576s包含启动及最终退出。maxgap8666.3ms；failedObservations=301来自累计maxgap在baseline已是6133ms，不能解读为301次独立故障。实际frameAge>5s有5条，位于两段停帧。全部采样Signal/PC connected、媒体/控制身份稳定、输入门禁open、relay/UDP/H.264/1152×720不变；输入门禁open不是实际输入成功。浏览器关闭超时2753ms，manager停止104ms；Signal22:14:35.777的transport close发生在主动清理期间，不是本轮采样中途随机断线。7个已登记worker自然退出，无发信号；完整进程树仍不保证。

新capture字段全部落盘：56个有track窗口中failed始终0，最大currentGrabAge5137.551ms、最大已完成grab5938.428ms，Host loop lag最大4753.737ms。最严重两段CPU仅约2%–3%单核等价，资源采样过期/timeout；完成耗时含IPC等待、调度与换页等，不能当纯抓屏计算。有效native sample166369字节、exit0，命令启动至观察退出包络10.074s，与首段8666.3ms停帧重叠，不覆盖第二段。样本包含CoreGraphics/SkyLight IPC等待、libswscale和Python属性访问；本次没有命名take_gil/GIL获取等待栈，不能复用前次样本断言GIL是共同根因。

每窗指标：candidate RTT last34–5827ms；decode last0.844–12.9518ms；buffer0–674.5ms。这些是应用窗口快照，部分可陈旧约5秒，不是本轮独立整体P95，也不是单向传输时间。真实输入ACK/应用阶段/输入后新帧/可见效果全未测。新增sink没有每帧写盘，但Socket键盘/按钮/命令会沿既有结构化日志逐条同步写盘，move/wheel每100条聚合；轮转只界定容量，不界定延迟/事件率。该开销未实测且不能解释启用前的空闲停顿，后续输入性能验收需单列。

**本轮确定的新代码缺陷：启动DataChannel看门狗过早。** 诊断capturedAt22:09:25.165，不能用uploadedAt22:09:27.826替代；首Host answer在22:09:25.547才发送。当前10秒DC计时从peer/channel创建开始，消耗了控制/信令及relay最多8秒ICE gathering；new状态不延期，尚未完成answer便判dc-stuck并触发第二offer、拆掉旧Host peer。第二次连接才在22:09:33.635达到采样基线。并非证实有reset/activeACK等待竞态，首轮如果继续是否最终成功也未测。初次core资源14.267s、先core-failed后core-interactive是另一个慢启动现象，当前没有独立代码归因。

新[启动看门狗设计](../specs/2026-10-17-startup-datachannel-watchdog-design.md)和[执行计划](../plans/2026-10-17-startup-datachannel-watchdog-plan.md)已写入，独立preflight后实施：分离有界negotiation与answer成功后的DC等待，保留已有恢复/权限/画质策略，并让固定阶段状态通过schema3白名单持久化。此修复尚未加载，不宣称已解决。

22:17本地health/Host在线、Viewer/relay0；22:20左右正式根HTTP200，TTFB1.747765s、总1.748159s，属于只读HTTP探测不是连续性通过。独立进程RSS快照较大项多为Codex Renderer（单进程约0.6–1.84GiB），另有后台Python/数据库；共享页不能相加当可回收内存，没有据此关闭其他工作或认定唯一资源来源。
