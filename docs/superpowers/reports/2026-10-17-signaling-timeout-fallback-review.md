# 信令超时回退：源码审计与方案记录

更新至2026-10-18。修复源码d27dbb2、测试输出清理f4202b7均已review并加载，当前网页build07ad960b331ccc4b。最新被动复测失败：Host心跳超时，最大画面间隔11.766s；本次没有捕获Viewer connect_error，不能把这次失败归因到已修复的WS超时路径。历史23:00的unknown仍不能直接归因超时。

## 确认的代码缺口

实际网页打包的是socket.io/client-dist/socket.io.min.js v4.8.3（build-web-client.js:96–106），不是单独安装的client包。独立审计也核对socket.io-client4.8.3和engine.io-client6.6.6的可读实现。

WebRTC配置WS-first、tryAllTransports和5秒Manager timeout。Engine只在opening时_onError路径转向下一transport；Manager自己的超时直接emit Error('timeout')然后Engine.close，不经过该路径。Manager重试又创建新的Engine、重新选WebSocket，故静默WS可能反复卡住，而明确WS拒绝时可以回退polling。浏览器分发版可读代码2106和4668–4672行具有相同流程。现有测试覆盖明确拒绝/关闭端口，没有覆盖无open/error的静默WS。

Manager截止只覆盖Engine打开，不是namespace认证完成或整段恢复的5秒总上限。不能通过改报告口径把启动性能SLO说成已通过。

## 现场证据边界

本次observer仅把TransportError识别为transport-error，timeout和已知认证拒绝都会降成unknown。source可解释可能原因，但现场没有类别证据。初期事件环还丢772条，PC2具体刷新入口只能依据恢复源码推断。因此修复源码已证实的回退缺口，同时补安全分类；不将其写为已唯一定位此次网络故障。

## 采用的决策与代价

| 决策 | 依据 | 代价 |
|---|---|---|
| 当前WS opening确实Manager timeout后，让下一次既有重试polling-first | 不新增并行socket或子预算取消状态，可修正已证实缺口 | 初始超时加重试可超过5秒，保留每次Engine5秒预算，不声称全流程达标 |
| preference在同一用户会话的自动peer/socket恢复间保留，新用户连接/主动断开/superseded清理 | 避免每次重建又回到已失效WS-first；保留新会话默认约定 | WS之后恢复时当前会话仍polling-first，HTTP开销增加；已有升级策略保留 |
| 固定10字段last-connect-error摘要、既有cooldown自动保存 | 区分timeout/transport/auth且不上传任意error内容；解决当前unknown盲区 | 仅保存最近一条；cooldown/认证/网络可抑制即时送达，不承诺完整事件历史 |

独立preflight已通过；明确显式Start/成功reclaim所属边界、Manager closed/Engine opening事件顺序、age超限null、诊断Promise拒绝隔离和既有存储/裁剪口径。实现/测试/部署记录继续追加。服务当前保持可用，未因此操作Host或tunnel。

[绑定设计](../specs/2026-10-17-signaling-timeout-fallback-design.md)、[执行计划](../plans/2026-10-17-signaling-timeout-fallback-plan.md)。

## 实现与独立检查

实际浏览器分发库的无网络VM先复现RED：5000ms时Manager已closed、Engine仍opening、Socket active，原有下一轮仍选择WS。实现仅替换下一轮Manager的transports数组，并在用户会话内保留偏好；真实库把字符串规范化为构造器，因此只接受受保护读取的已知prototype.name，保留原构造器引用。未知或抛错选项不触发回退。

诊断采用共享十字段净化器，覆盖core、完整报告、缓存、超大报告裁剪和服务端持久化；保留既有watchdog及marks/resources留存边界。自动发送的同步异常或Promise拒绝都不阻塞恢复，既有cooldown与回执协议不变。

离线最终相关覆盖为117个不同用例：主要诊断/实际库91项、会话生命周期25项、后补1项旧owner用例；重复运行另列，不累加。独立任务review通过spec与quality，唯一Minor为预期测试警告外溢，f4202b7仅改测试捕获并断言警告，4项针对性复测通过，scoped review确认解决。最终integration review通过，没有遗留Critical、Important或Minor；明确核对Start/bootstrap、恢复和core/full诊断调用链。review与生产加载分别记录，不能由离线结果代替。

## 并行空闲日志复核

23:05:28.030–23:51:26.049的498条Host摘要均无Peer、无捕获、零输入、relay停止；两条直接lag样本≥1秒，分别为23:32:14.215的1165.127ms与23:36:58.227的1170.418ms。24条滚动max≥1秒是重叠摘要，不能称24次停顿。此窗口未复现历史多秒停顿，也不能否定历史故障。

资源状态495次ok、3次timeout，缓存均可用，年龄最高8926.839ms；系统负载/换页较高，memoryPressure始终unknown，不能归因到Host或具体应用。45个完整Signal入口窗口为空且无入口错误；23:05:27–28的controller-disconnect/retry对应此前测试关闭，不能列为新故障。

Host读取字节[8414638,10413571)，首条合格记录9748794；Signal控制台[0,1996246)、结构化JSONL[0,312856)，按上述墙钟窗口筛选；捕获后追加数据不计。Host摘要是约5秒输出、60秒滚动统计，不是原始每秒分布。另只读核对7份旧supervisor记录的52个登记PID，均已不在运行，但未证明完整进程树退出。此处没有进行新的连接或输入验收。

## 受控加载与失败复测

冻结来源f4202b7，私有构建build07ad960b331ccc4b，保留22d13d54ac6b458a与067dfc41e8374b4e。应用前和重启前分别核对Host在线、Viewer0、relay0，主工作区HEAD/index及未改文件均保留。仅restart-signal；新Signal42509启动于10月17日23:58:09，Host89291仍为22:06:28启动，tunnel84671/watcher897和quick URL缺失状态均未变化。

启动helper在34.292s后以health超时退出，随后独立status与直连health/api/status均正常，8080由新Signal监听；未重复重启。源码、资产、manifest及未改文件校验通过。此处记录为启动窗口检查失败后恢复，不能写成正常3秒重启，也尚未确认是启动实际延迟还是检查侧调度/请求问题。

新正式入口被动复测（私有run `formal-signaling-fallback-20261018a`）以300s为目标，实际采样134.962s、133条，INCOMPLETE。按浏览器timeOrigin映射，首末样本为10月18日00:01:57.451–00:04:09.451；该映射不作光学同步。maxgap11766.232ms，failedObservations21、identityChangeObservations1，missing/late均0；这些观测数不是独立故障次数。全部样本inputAllowed=false，需要进一步核实激活/focus、reset与控制状态，不能仅凭布尔值判断产品控制故障。

已确认时间线：00:04:08.169服务端记录Host ping timeout；00:04:08.215 Host感知断开，随后重连。末条样本leaseEpoch降至0，触发session-changed-or-disconnected。Viewer observer没有在采样前记录Socket/Manager/Engine close或connect_error；preclose在00:04:09.473，服务端Viewer transport close在00:04:10.207，位于测试清理阶段。因此本次直接中止事实是Host离线导致身份变化，不能误写成与先前B窗口相同的Viewer主动断线。

Supervisor总188.173s、worker exit1、无deadline/intervention；7个登记worker自然退出，完整进程树退出未证实。一次有界Host sample在row50、frameAge2316.2ms时触发，输出242346字节、exit0；实际覆盖及栈解释另核对。browser.close报告timeout、manager.stop成功，cleanup为incomplete，不能把退出码0或登记进程退出当成完整清理证明。

日志边界：Host inode43654875、bytes[76517,222428)，Signal inode31830923、bytes[2007283,2014618)，前后inode/device相同；更早Host日志已换文件，不能跨文件直接减offset。本次没有新的真实业务输入或光学效果验收。

另发现工具证据缺陷：失败分支会用失败后的即时状态覆盖`startupSummary`，因此最终文件中的FREE/Host offline/ui disconnected不代表启动时事实。此项需修复为独立的启动与失败快照；控制门禁也需有固定安全原因/因素，避免继续从allowed=false猜测原因。

## 独立媒体与门禁审计补充

最长rVFC间隔为00:03:43.984–00:03:55.750的11766.232ms，随后还有一次超过5700.930ms的停顿；21条失败观察包含累计maxgap持续越阈，不能称21次独立故障。Host同期grab在途年龄达到4418.147ms、最近grab耗时5060.574ms，单次encode至packetize的墙钟耗时4922.852ms；后者不是CPU或单一VideoToolbox调用耗时。00:03:39.728–00:04:01.740的22.012s仅增加0.687s Host CPU。关键窗口资源缓存过期，RSS/swap为null、memoryPressure为unknown，不能把此前换页率外推为该窗口的测量。

原生sample启动00:02:47.896、报告时间00:02:48.175，触发停顿约00:02:47.903恢复；不能证明有效栈样本覆盖了该停顿，更未覆盖后面的最长停顿。报告确有main `PyEval_RestoreThread → take_gil`、CoreGraphics/SkyLight IPC及VT等待，但只能证明采样期等待，不能指定最长停顿原因。

Input lease1来源于已收到的控制租约，且Signal只有收到Host应用reset ACK后才发grant；没有证据支持“初次reset未通过”。最强候选是init开始的8s首帧期限：attempt在00:01:43.325绑定，Host直到00:01:52.208才发answer（已晚8.883s），超时会使UI进入disconnected，之后同一PC连通/出帧仍不能转回connected。此源码路径已确认，现场因缺少原始门禁/超时事件仍只是高优先候选。后续`protocol-too-old`位于Host离线间隙，原因是查询到host=null，并不证明协议退化。

已完成[证据工具独立preflight与方案](2026-10-18-passive-gate-evidence-review.md)，下一增量仅修复快照覆盖、固定门禁投影和精确超时console取证，再决定产品恢复策略。脱敏机器摘要见[evidence](evidence/2026-10-18-signaling-fallback/summary.json)。
