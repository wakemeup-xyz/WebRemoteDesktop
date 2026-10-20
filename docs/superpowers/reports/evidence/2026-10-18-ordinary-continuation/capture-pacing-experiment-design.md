# 抓屏线程 pacing 超额的最小归因实验提案（2026-10-18）

状态：只读设计，**未实施、未运行**。本提案不构成重放任何已消耗 sequence/attempt 的许可；需要新鲜的工具范围/source pin/执行包独立 review。应先发布已批准的 timer 初始化修复和进程诊断修复，完成不受采样扰动的新 baseline，再决定是否执行本独立诊断会话。

## 要回答的一个问题

在既定20 FPS、1x抓屏、相同分辨率/codec/bitrate/TURN路径下，capture loop 的 `time.sleep` 区间为何经常比请求多约100–150 ms？首轮只观察一次受控3秒原生栈采样，判断样本是否支持“某类线程等待”的下一步方向；**不承诺单次sample就能证明GIL、QoS、App Nap或内核调度是根因**。

不改质量、FPS、网络、重试/截止预算、权限/租约/输入gate；不发业务键鼠/剪贴板输入；不调用调试器执行目标进程代码；不切换抓屏后端；不调整nice/QoS、电源断言或线程优先级。Host/Signal/tunnel/watcher都不是本实验要启动、重启或清理的对象。

## 已有证据足够到哪一步

第二次实际baseline最后已闭合的242个抓取开始间隔覆盖37.267秒：6.4936 Hz，平均153.998 ms；minInterval=50 ms。grab均值27.710 ms，pacing请求均值22.391 ms、实际125.838 ms、超额103.447 ms。最大453.249 ms的同一周期中，pacing实际426.605 ms，请求23.456 ms，超额403.149 ms，grab只有25.248 ms。7个输出统计窗649帧、438帧复用。active Host过程CPU约一个逻辑CPU的28%，系统load约3.8–4.2，不能据此排除单一线程/GIL短期争用。

| 现有字段 | 可以判断 | 不可以判断 |
|---|---|---|
| cadence.lastInterval 的interval/grab/postGrab/pacingActual/pacingRequested/pacingExcess/other | 一个**配对周期**的主要wall time落在sleep bracket；50ms目标未被主动降低 | sleep超额中内核等待、计时器合并、线程唤醒、GIL重新获得的分别耗时 |
| cadence.intervalCount / activeIntervalCoveredMs / rate / stages / discontinuous / invalidTiming / clipped | 已闭合前缀的实际抓屏率、边界有效性和统计覆盖 | 未闭合尾部、逐次全量分布、单次长尾的原始栈 |
| capture.currentGrabAge / lastCompletionAge / duration / paired threadCPU/nonCPU | 当前/最近原生grab是否卡住；grab内wall与CPU差 | pacing区间CPU与等待分解；不能把grab的非CPU95ms挪给另一个pacing周期 |
| targetFps / mediaProfile / minInterval / viewport / PC、attempt、generation、lease与guarded admission | 已观察到的生产配置、会话连续性与诊断所属会话 | 没有发布的完整profileSequence/捕获线程native TID；缺测仍unknown |
| loop摘要、过程CPU/RSS、系统load/swap | 不同边界的负载背景 | capture线程实时调度保证；低load不是线程已及时运行的证明 |
| Viewer rVFC、paint gap和dropped | 已编码/提交的画面节奏 | 新桌面像素年龄、输入到可见效果、物理显示 |

原SUP仅在5分钟场景rVFC `frameAgeMs >2000`（3小时场景`>=5000`）触发。当前R2 supervisor额外要求无故障 baseline/continuity、scopeStable、active、已有callbacks；恢复场景整段禁采样。本次frameAge最大47.9 ms而新抓屏约6.5Hz，现有触发自然不会触发；降低旧frameAge阈值既答非所问又改变旧工具范围。应使用**新独立的一次性 pacing 诊断触发**，旧SUP/R2实现和历史结果保持原样。

## 生产1x与profile fence为什么重要

当前`WebRemoteHost._create_screen_track()`显式传入`CaptureExperiment(1.0,1)`。`CaptureExperiment.capture_fps_for_target(20)`返回20；因此`_capture_loop()`的最小间隔就是50ms。类的`capture_strategy=None`兼容入口仍按2x/headroom计算，20FPS时约40次抓屏/秒（25ms），不能拿兼容/实验入口解释这次50ms，也不能为“改善观测”临时改成2x。

原生grab与publish还受`_capture_generation`、`_target_generation`、suspended/running保护；recv在executor返回后再次检查捕获/目标generation。`_target_generation`主要隔离**尺寸**，`set_target_fps()`并不递增这个尺寸generation。媒体profile请求另有attempt/generation/profileSequence和当前Viewer绑定准入。实验不得依赖尺寸generation单独证明FPS/bitrate没变；至少同时检查新记录targetFps=20、minInterval=50ms、mediaProfile保持high、Viewer尺寸/codec/路径和会话身份不变，并拒绝已观察到的profile写入/轨道计数重置。未暴露的profileSequence不能编造。源树/build/Host身份固定与这些运行观察应分别记录，不能互相替代。

## 推荐的最小执行形态

**采用已有300秒baseline形态的guarded普通会话作为独立诊断，保持runner的300秒契约与原严格gate，明确标记`diagnosticPerturbed=true`；它的产物不计入5分钟资格或3小时资格。** 不为缩短几十秒新增60秒runner模式、扩大duration准入，避免对正在修复的验收协议再作功能修改。采样只在首次稳定baseline后的第10–60秒允许触发一次，之后不再武装；未触发就报告NOT_TRIGGERED并正常结束，不自动再跑。

1. 根执行器在维护/无人占用前提下创建新的0700私有目录、新sequence/attempt/manifest；确认新代码/build/source pins、Host PID+birth、受保护服务身份和原始配置，使用正常`vacant-only-v1`单次Start。按既有流程拒绝未知占用，不抢占。预先记录当前Host日志文件device/inode/EOF offset与源文件hash。没有fresh receipt不执行。
2. 会话与输入门槛完全沿用已批准runner；必须已有至少10秒同身份、同配置的实际媒体进度，且最新约1秒行仍为baseline/connected/active、scopeStable、inputAllowed、所有原严格inputGate条件成立。此处是**是否允许诊断的必要条件**，不是把inputAllowed冒充输入已验收。
3. 独立collector从预记录EOF顺序读Host已有`host_event_loop_lag`结构化事件。限定本文件device/inode不变、无截断；每次最多64KiB、单行最多32KiB、全实验读取预算2MiB；轮询不快于250ms。只落盘明确白名单的数值/有限枚举投影，最多20条、总128KiB；不复制原始Host行、correlation任意值、Viewer/attempt、argv、环境变量、密码、输入内容或坐标。遇预算/格式/文件变化就停用触发并报告INCONCLUSIVE，不轮转搜索替代文件、不从头重读。
4. 只用首次满足下列条件的**新闭合周期快照**触发：`event=host_event_loop_lag`且schema/source正确；PC=connected、targetFps=20、mediaProfile=high；capture/cadence有效、未clipped、failed/error/discontinuous/invalidTiming为0；`intervalCount`相较前条增加、captureSeq/完成数不回退；`lastInterval.minIntervalMs=50`、`lastInterval.pacingExcessMs>=100`，所有配对时长有限且非负。不使用历史maxInterval或窗口平均值反复触发。
5. 日志新事件相对本机wall clock不超过2秒、不得来自未来；collector arrival用自身monotonic记录，并确认无wall/monotonic反转。`lastCompletionAgeMs<=1000`且最近Viewer行不超过1.5秒；阈值不满足保持不触发。**本机wall时新不等于捕获异常的精确触发时刻**：Host约5–6秒才发一次摘要，采样会滞后发生，必须在报告中保留这项限制。
6. 首次条件成立即消耗一次触发令牌。启动前再次核对**同一个**Host PID/birth和既有pidfile绑定，不按进程名重新寻找替代Host。只执行一次已审阅命令形态：`/usr/bin/sample <已核验Host PID> 3 10 -file <新私有文件>`。其中3是采集秒数，10是间隔参数，沿用既有SUP形态。采集对象是现有Host；新创建并拥有的仅是sample子进程。
7. sample报告先`O_CREAT|O_EXCL`预建为0600；子进程umask077、RLIMIT_FSIZE=8MiB、RLIMIT_CORE=0、start_new_session，stdout/stderr仅作有界非阻塞读取，最多留16KiB前缀并记丢弃计数。创建后立即记录sample子进程精确PID/birth，之后只通过这个已证明拥有的子树做timeout/cleanup。目标Host的PID/birth在采样开始前后和每个监督tick重核；有变化立即终止**自己拥有的sample子进程**，不采替代Host、不信任已采数据。
8. 从sample Popen时monotonic起保留原**10秒外部截止**，先poll/检查deadline再drain；超时只终止已验证sample子进程，随后只给原有有界term/kill/wait预算（总清理最多2秒），核对birth后再发信号。保留timeout与后来exit两个时间，不能用后者擦掉前者。主worker沿用300+128秒deadline，不加长；诊断失败不阻止必要的有界清理。若人类Viewer接入/本guarded admission被撤销/会话generation变动，立即停止自己的sample并走当前会话正常清理，人类优先。
9. 持久化同钟的trigger见到时间、对应Host事件wall时间、intervalCount/配对周期数值、sample开始/退出观察/超时/清理时间、文件大小/hash、退出码/读取截断状态和已拥有子进程清理证据。 raw sample保留本机0600、≤8MiB，**不提交仓库**。仓库只收脱敏摘要与hash。空报告、缺符号、超时、权限不足、PID变化、日志覆盖不足都记INCONCLUSIVE/UNKNOWN，不自动sudo、不安装工具、不重试。
10. 保持无故障整个scenario：不注册CDP网络路由、不短断网、不采fault/recovery/recovered-stability；此次诊断也不能串进正式恢复/连续资格sequence来借用后继。sample会扰动Host，前/中/后观察只能作为诊断证据，不能把“采样时仍connected”当作新的性能资格。正常结束检查现有服务可用；不得通过重启Host/Signal/tunnel来完成cleanup。

## `/usr/bin/sample`能提供什么、不能提供什么

| 采样中可能出现的证据 | 合理结论 | 不能据此声称 |
|---|---|---|
| 可唯一归属capture线程的原生栈主要在sleep/计时器等待 | 采样期间该线程大量处于某等待路径，与观测pacing超额相符 | 请求sleep具体被内核推迟多少、是否App Nap、何时已到唤醒deadline |
| 同一capture线程多次在CPython GIL取得/锁等待函数，其他线程在Python执行 | 存在GIL相关争用的有力线索，值得下一轮定向观察 | 每个103ms都由GIL造成；仅从一般`cvwait`/`ulock_wait`就认定GIL |
| capture线程在MSS/Quartz/系统截图栈阻塞 | 采样时有原生抓取等待 | 之前最大sleep超额由grab造成；不同配对周期不能串因果 |
| capture线程处于publish/activity/target锁路径 | 出现对应锁/门控等待线索，需要与当时phase/suspended/锁计时配对 | 从不同线程的同名等待推断capture被锁住；当前平均锁0.004ms足以解释100ms |
| 所有可用栈短时间CPU计算密集/频繁运行，或符号稀疏 | 可描述采样分布与覆盖不足 | 真正内核runnable等待时长或GIL持有者的精确ownership |
| sample明确报告的线程名/队列/QoS信息 | 仅报告原样验证过的字段，并与线程身份对应 | 未提供QoS时据线程名/后台运行/低CPU猜测QoS、优先级或App Nap |

当前capture thread以`threading.Thread(target=self._capture_loop,daemon=True)`创建，没有显式原生线程身份写入观测。Python对象有native_id并不等于报告已发布该值；Python3.11的名字也不能保证与OS sample线程名一一对应。macOS sample可能只见C调用栈而无Python函数名。因此**无唯一capture线程映射时，第一轮只能产生全Host等待线索，capture归因仍UNKNOWN**。报告要把缺符号/缺线程映射视作正常的INCONCLUSIVE，而非补造线程匹配。

PID/birth重核可降低采错进程风险，但`sample`CLI本身只接收PID，不原子接收birth；检查到attach间仍有macOS check-to-attach竞态。保留该固有限制；任何重核失败或可能PID复用都拒绝归因，不宣称完全进程树退出已证明。

## 只在首轮缺证据时考虑的下一小步

首轮先不改Host。不自动追加第二次采样。如果原生栈缺少capture线程映射，另立小型观测增量spec/plan/review：由既有`capture_observation_snapshot`读取**已存在capture Thread对象的native_id**，与Host birth/track epoch绑定，仅发布一个有界整数或null，不泄露输入/进程环境；不能用新线程枚举推断归属。若仍需要分解sleep区间的实际CPU，再在同一个原有sleep bracket添加成对`thread_time_ns`观测，明确观测开销与GIL/内核混合等待仍不可完全分开的限制；不要把grab的CPU重复使用。没有新实现/测试/review/发布证据前，这些字段保持NOT_AVAILABLE。

如果明确原生线程归属后，3秒sample仍无法区分timer wake与runnable/GIL等待，下一阶段才评估独立、只读、限时的线程scheduler/QoS或runtime wait测量；这需要新的工具范围与成本review。**本提案不授权powermetrics、spindump、DTrace、调试器、systemwide trace、环境/优先级修改或capture backend重写**。不能为了得到结论层层扩大一次诊断的范围。

## 产物与完成标准

实验完成标准不是“确认某猜测”，而是留下一个可复核、覆盖明确的结论：

- TRIGGERED + private report可读/≤8MiB + 精确sample子进程被回收：按采样证据给出WAIT_PATH_SUPPORTED或INCONCLUSIVE，并保留扰动和线程映射限制。
- 未出现fresh lastInterval超额：NOT_TRIGGERED，不能声称超额已消失。
- 触发/采样/ownership任一不足：INCONCLUSIVE，具体原因用有限枚举说明；不自动重试、不篡改先前失败。
- 无论结果，六项输入耗时和原生/物理可见效果仍是NOT_RUN；正式5分钟、恢复和3小时资格分别由未受本诊断扰动的独立执行证明。

## 只读源码依据

- `/tmp/wrd-owned-turn-probe-private/supervisor.py`：Trigger 123–134、Host identity 137–145、sample_limits 155–158、SampleObservation 160–202、sample命令225–236和有界cleanup264–284。
- R2私有`ordinary-continuation-supervisor.py`：53–75整scenario恢复禁采样、baseline/continuity允许范围、严格旧frameAge触发；不编辑该已执行包。
- `/Users/macstudio1/AI/Claude/WebRemoteDesktop/python-host/host.py`：1428 capture线程创建；1454–1594 capture与sleep bracket；1667–1687只读capture快照；1690–1706资源快照；2143–2179尺寸/FPS与策略；2332–2343生产1x；4454–4496profile身份/序号准入；5844–5872既有5秒以上loop日志发布。
- `/Users/macstudio1/AI/Claude/WebRemoteDesktop/python-host/capture_experiment.py`：CaptureExperiment允许值和1x/2x计算。
- `/Users/macstudio1/AI/Claude/WebRemoteDesktop/python-host/runtime_observability.py`：71–154当前grab CPU/非CPU严格配对语义。
- `/Users/macstudio1/AI/Claude/WebRemoteDesktop/python-host/capture_cadence.py`：155–183已闭合周期配对、234–278 rolling快照/计数/rate；不从不同max拼接根因。
