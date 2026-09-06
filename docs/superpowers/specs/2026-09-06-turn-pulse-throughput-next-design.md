# TURN 画质脉冲与出帧耗时：下一轮设计

日期：2026-09-06。基线：本地 main `91cf000`。状态：经主线程补充自审修订；方案可行性仍待实验，未实施，不保证彻底修复。审查记录：`../reports/2026-09-06-turn-pulse-throughput-plan-review.md`。

规划路径沿用用户已确认的 EnterPlanMode；仓库内设计和计划为执行入口。本文件扩展 2026-09-05 原设计，不改写已失败的历史验收。对应计划：`../plans/2026-09-06-turn-pulse-throughput-next-plan.md`。

## 1. 问题、事实与目标

已确认：legacy 使用 libx264/ultrafast/Baseline、20帧周期IDR、100ms VBV。在无网络的静止文字探针中，1080p IDR 前后 PSNR 从32.64降至19.30dB；编码侧可以独立产生周期画质变化。20帧并非在低FPS下仍严格等于1秒，用户所有画面抖动的唯一原因尚未确认。

最新真实TURN长跑：720p 600秒 FPS中位13、最大呈现间隔949ms；1080p 300秒 FPS中位6、最大间隔967ms。对应1080p `encode()` 墙钟加权平均91.018ms，包含转换、编码、分包和调度等待，不能解释为纯x264 CPU或端到端延迟。phase内逐帧尺寸和CSS几何稳定。VBV200/225/250的按需IDR质量均未到28dB；停止继续扩大VBV。

已修复的RTP时钟、worker帧构建、呈现间隔采集和候选选择器保留。下一轮目标：

1. 健康静止桌面不再因应用周期IDR反复变糊，首帧和恢复仍可得到可读画面。
2. 量化并降低真实Host流水线瓶颈，使720p/1080p分别达到原帧率和缓冲门槛。
3. 让文字、输入及有限丢包从当前固定 `NOT_RUN` 变为有真实因果证据的验收；缺少设施时明确 BLOCKED，不伪造通过。

## 2. 方案选择

| 方案 | 收益与代价 | 本轮决定 |
|---|---|---|
| 继续扩大VBV或单纯拉长GOP | 已测到250ms仍失败；拉长周期只改变复发频率 | 不继续此路线 |
| 按需IDR + 实际生效的编码preset实验，独立优化流水线 | 可复用现有H.264、恢复和输入契约；新preset可能增加计算成本 | 首选，按下述固定矩阵和门禁推进 |
| 切换VideoToolbox或捕获后端 | 可能减少软件处理，但现有历史包含延迟出帧和IDR验证问题 | 条件性后续设计；本轮不直接切换、不承诺收益 |

优先完成一个明确的preset候选 `superfast`，不是无界搜索。若它不满足质量或耗时门槛，保留诊断成果、输出失败原因；不得自动再加码率、改profile、启用硬件编码或降低28dB门槛。此时另写基于证据的后续设计。

这是有界验证与优化方案，不是已证实的完整修复方案。T2无合格候选时记 `NO_QUALIFIED_CANDIDATE`；质量失败须按静止/成熟IDR/安全网分别交付失败帧与成本，耗时失败须在T3区分转换、编码、分包和调度贡献，再决定后续编码后端或码控设计。T7未定位到的瓶颈保持OPEN，不能将capture降频或更换preset当作必然有效的修复。后续设计完成并通过同一验收前，用户问题继续OPEN。

## 3. 硬边界

- 生产默认与 `policy_version_from_environment()` 继续只允许 legacy；实验不能通过环境变量、Viewer payload或任意JSON放开v2。
- TURN正式入口、凭据加载、Quality Lock、认证、控制lease、attempt/generation/profile-sequence和恢复token契约保持。
- 原始码率上限720p 3.2Mbps、1080p 5Mbps；本轮编码实验固定VBV200ms、Baseline、20FPS、线程1、zerolatency、仅按需IDR，其余x264选项固定。
- 不改公共tunnel、cloudflared、URL文件或主机pf/iptables；不在生产网络注入丢包。不停止其他业务程序以制造性能通过。
- 真实实验只在无活动人工Viewer的维护窗口运行；实验与长跑串行。用户接入时中止实验并清理自己创建的资源。
- 本次工作仅规划和review。未来实施沿用Terra High子代理、每任务测试和独立review，未通过的实验不能进入生产。

## 4. 编码实验契约

### 4.1 先修复实际配置可观察性

当前 `H264SessionPolicy.preset` 未被 `_create_codec()` 使用；`libx264_zerolatency_options()` 硬编码ultrafast。扩展为keyword-only `preset="ultrafast"`，仅允许本轮两个枚举；实际创建codec时传入policy.preset。所有legacy调用产生的完整options必须与修改前相等。

每次真实 `_create_codec` 路径提交options时发出不可变 `CodecCreationRecord`，字段为scenarioId、resolution、creationIndex、requestedPreset、submittedCodecOptions、profile/fps/bitrate、generation和reopenReason。probe收集这些调用现场记录，禁止调用helper第二次生成记录。每个场景的记录缺失、preset或options摘要漂移、意外重建均判无效；spy测试同时覆盖ultrafast和superfast。记录代表实际提交的配置，编码后的IDR、PTS与解码证据另行验证，不声称可读取x264所有内部码控决策。

### 4.2 新矩阵 `relay-preset-refinement`

只运行两个配置：新测 `on-demand-cap-vbv200-ultrafast` 对照，以及仅将preset改为 `superfast` 的候选。固定输入、版本、分辨率、码率、VBV、GOP、profile、线程和其他options，完整记录候选摘要。对照质量可以失败，测量完整性不可失败。

场景包括：原65帧静止文字（第5帧直接请求IDR，便于与历史比较）；独立1201帧健康静止序列（0至1200，20FPS逻辑60秒）；滚动文字300帧；滚动后静止300帧。后两场景在第5及第200帧请求IDR，检查成熟码控下的恢复，不仅优化刚启动的第5帧。帧序列固定种子，记录每帧输入hash、PTS、IDR原因、解码图像质量和耗时；probe要区分直接encoder耗时与完整encode/packetize耗时。

保留原门槛：全部按需IDR PSNR≥28dB；健康60秒无应用periodic IDR；每个场景编码P95分别≤25/45ms。初始帧PSNR单独记录并纳入真实文字可读性验证，不以初始化帧替换按需IDR。只要一档或一个场景失败，候选就不能进入runtime准入。缺帧、非有限值、参数漂移、错误IDR或意外reopen均是无效实验，立即停止。

`ScenarioRun` 固定包含scenarioId、sessionId、phaseStartIndex、frameCount、requestTokens、codecCreationRecords、frames、独立quality/cost/burst门禁。每帧含连续全局index、phaseIndex、inputHash、PTS、requestToken、bitstreamIdrKind、PSNR/changeMAE、encode时间和bytes。静止65、健康1201、滚动300分别使用全新encoder/decoder；滚动后静止300继承滚动同一会话，session全局index为300..599，phaseIndex为0..299，请求发生在全局305/500。所有场景各自计算P95，禁止合并稀释；每档缺一个场景或任意索引缺失均拒绝。旧helper的一次IDR/65帧假设不用于新场景判定。

现有 `ON_DEMAND_ONLY_KEYINT_FRAMES=1201` 是编码器安全上限，不是无限GOP。第5个必需场景 `safety-net` 使用全新encoder/decoder，静止输入0..1225，无额外forced IDR；要求从真实bitstream识别初始IDR以及index1201的 `encoder-safety-net`，无应用periodic。缺失/位置不同须记录版本差异并拒绝本次候选，不能当无脉冲通过。安全网IDR同样要求PSNR≥28dB、相邻静止changeMAE≤3.0，单独记录编码时间和bytes并纳入场景P95≤25/45ms；真实TURN长跑须观察该安全网IDR的缓冲max≤300ms和无1秒停顿。它不是可省略的观察项，不能只以0..1200无周期IDR推广。

## 5. 耗时观测与单变量优化

### 5.1 同钟、同帧边界

Host使用 `monotonic_ns`，不可与浏览器的performance.now直接相减。为每帧关联attemptId、generation、streamId、captureSeq，并分别保存encoderTimestamp90k与实际wireTimestamp，二者不得混用。按采集边界记录 `grabMs`、`captureAgeAtRecvMs`（grab结束至recv选择该捕获的时间），按worker记录queue/prepare/build，按encoder记录reformat/encode/packetize及总墙钟。grab包含MSS内部复制；除非有直接边界，不虚构“纯系统捕获”和“纯复制”两个数字。字段无法可靠取得时为null并拒绝相关阶段结论。

不把重叠/流水线阶段的P95相加。保存有界逐帧样本和每5秒count/P50/P95/max、stage覆盖率、复用和覆盖计数。丢失关联、跨generation复用、无样本不能视为0ms。限制为每stage最多2048条滚动记录，关闭详细采样时只保留现有计数；不逐帧同步刷日志。

因果join由新 `FrameTraceRegistry` 持有：recv设置PTS后登记 `(attempt, generation, streamId, encoderTimestamp90k) -> captureSeq/framePts`。复用captureSeq允许，但输出encoderTimestamp必须唯一；每流最多2048条且TTL120秒，淘汰计数显式记录，generation结束清空。encoder按同一time_base换算查表，在记录中补IDR原因和policyDigest；查不到为UNMATCHED，不能继承上一帧的captureSeq。

必须再观察真实RTP包头：本机aiortc的 `_run_rtp` 会把encoder timestamp加随机origin后按uint32回绕，故前者不能直接匹配rVFC。新 `rtp_frame_observer.py` 以已存在的sender wrapper为入口，登记当前发送task/SSRC及返回的编码帧描述；在该task的首个新RTP包交给DTLS传输前读取实际wire timestamp，建立 `(attempt, generation, streamId, ssrc, wireTimestamp) -> FrameTrace`。只观察不修改字节/发送顺序。验证同一stream的origin差值一致，排除RTCP、RTX和其他task的重传；空payload、冲突timestamp、无法区分的重传均拒绝关联。该私有API观察适配器必须绑定已安装aiortc版本/函数签名，版本不兼容时关闭观测并使验收失败，不能破坏正常媒体发送。

诊断由新只读 `frame_trace_batch` 消息发到当前Viewer，每100ms最多64条，包含schemaVersion、attempt/generation/streamId、policyDigest及逐帧wireTimestamp/captureSeq/IDR记录。Host队列与Viewer索引各最多2048条/120秒，拥塞丢诊断并增加droppedTraceCount，不阻塞媒体。当前attempt/generation的身份绑定沿用frame_timing传输通道；collector以当前stream的wireTimestamp匹配rVFC metadata，诊断晚到允许有界等待2秒。缺失、冲突、溢出或metadata不支持均为UNALIGNED；可见marker只能证明场景身份，不能替代IDR帧关联通过。

### 5.2 A/B顺序

先固定legacy和其他负载，以相同受控场景做A/B/A各60秒，再做B/A/B确认，两档串行，共每档6个独立会话。保存全部run级指标、顺序和负载上下文，不把相关的每帧样本当独立试验。不再用任意10%判定因果；呈现绝对/相对差异和三次A、三次B的范围。来源覆盖率/场景不一致或不同顺序结论反转，结果为INCONCLUSIVE，不持续重跑挑最好结果。

第一候选只把40Hz（目标20FPS的两倍）采集改为20Hz。`ScreenCaptureTrack`增加keyword-only capture策略；普通Host的 `_create_screen_track()` 使用默认legacy策略，Lab子类在相同工厂方法传入冻结实验策略，不经Viewer payload选择。保留latest-frame单槽、暂停/恢复唤醒、generation丢弃、独立VideoFrame和PTS规则。检查抓屏调用数、captureAge、复用率、输入效果和阶段耗时；不能用更少抓屏次数直接证明更低端到端延迟。

只有worker resize在有效基线中占主导时，才增加第二候选：OpenCV默认线程对比单线程。`cv2.setNumThreads()` 是进程级设置，只能在独立实验Host启动前固定；不得会话中切换或影响正在工作的其他Peer。失败的40→20Hz改动不能叠加到线程实验。

候选筛选采用预先固定的run级一致性规则：三次B的目标stage P95（或预先选定的CPU时间/解码帧）均小于三次A中的最小值；三次B的FPS下界不低于A的下界，其余捕获帧龄/呈现间隔/输入ack/输入效果P95的B上界不大于A上界，且无新增功能失败。目标成本必须在第一次运行前写入manifest，不能事后换有利指标。这只是 `candidate-requires-confirmation`，不是统计显著性或产品PASS；只有T8全部原硬门槛和场景通过才能保留为生产默认。不满足一致性则保留旧参数并报告INCONCLUSIVE或无收益。

## 6. 隔离实验到生产的桥接

解决“生产拒绝未验收v2，但runtime验证又需要运行候选”的循环：使用独立实验入口，复用同一Host实现，通过Python构造器注入不可变策略provider；普通Host入口不暴露此能力给环境/网络请求。

具体接口：不可变 `PolicySelection(policy_id, resolver, manifest_digest)`；`H264SessionPolicyProvider(*, resolver=resolve_h264_policy)`。普通 `WebRemoteHost()` 不接收candidate参数，其 `_create_policy_selection()` 只从生产env parser取得legacy并绑定默认resolver。Host初始化保存该selection，后续publish/refresh传入selection.policy_id，provider重建始终复用selection.resolver；禁止事后改私有policy字段。

实验入口定义 `LabWebRemoteHost(WebRemoteHost)`，必须先构造校验完毕的 `VerifiedLabContext`（loopback实验origin、独立realm/proof身份、冻结manifest及逐帧重算结果），再调用共用Host初始化。仅这个子类覆盖 `_create_policy_selection()`，返回context持有的实验selection；resolver只接受完全一致的 `experiment/<digest>`，收到legacy/其他digest必须拒绝，而非忽略参数。普通Host直接注入selection应TypeError；普通env/payload不能创建VerifiedLabContext。这样运行的仍是同一Host业务方法，实验选择入口与生产入口清晰分离。

新 `scripts/turn_lab_host.py` 是唯一实验入口。它先校验本地冻结候选manifest与源文件hash，重新从逐帧证据计算全部离线门禁，再创建provider；candidate policyId为 `experiment/<digest>`，日志不得谎报legacy或validated。所有profile refresh使用同一冻结参数；direct/未知尺寸请求拒绝。manifest无执行代码、无任意模块名、无凭据，不能让一个手写PASS绕过证据计算。

新实验Signal使用 `createServerApp({signalingRuntimeContext:createRuntimeContext(), ...})`，单独随机认证信息和runtime目录；直接对其server执行 `listen(0, "127.0.0.1")`，不使用绑定0.0.0.0的startServer。从 `server.address()` 获取实际端口，拒绝8080和非loopback origin。实验Host的SERVER_URL在导入host前绑定该origin。构造器注入测试必须证明普通Host即使收到candidate env/payload仍拒绝。

实验前取得生产的proof admission，凭据仅内存保存；监视viewerEpoch和实际人工Viewer接入，失效即中止。实验Signal另有独立proof admission，两个realm的token不可互用。实验runtime只允许单个测试Viewer；不抢占生产Host注册或控制lease。

离线合格、实验TURN/输入/丢包门槛全部通过后，另一个窄提交把唯一已验证参数冻结到v2并开放生产gate，不加入任意候选加载器。证据身份分两层：`encoderParameterDigest` 对实际编码参数做规范化摘要，排除实验/生产别名、commit和时间；完整source commit及逐文件hash另行保留，不省略或伪造。推广提交只允许固定策略注册、默认选择及已验证吞吐常量的白名单差异，必须测试实验与生产解析所得参数完全相同。任何codec实现、Host流水线、观测器或采集算法变化均使受影响证据失效，重新运行对应离线/实验门禁；只改别名不要求伪装成相同源码hash。部署后仍须重跑生产验收。默认切换和最终生产长跑属于最后部署步骤；若回归，回滚legacy，本次交付仍失败。

## 7. 受控内容、输入与画质关联

`--controlled-producer-id` 当前只是标记，不能直接变为PASS。实现新的producer配对：在捕获的Host显示本地受控页，loopback驱动器取得一次性runNonce及页面身份，页面绘制带校验的 `(runNonce, sceneId, tick)` 可见标记。Viewer实际解码帧必须读出一致标记，才能证明当前采集的正是受控内容；只读取producer DOM不够。

页面提供静止中英文文字/细线、滚动区、拖动块和输入框。自动注入必须在仅含测试应用和测试数据的专用实验桌面/登录会话进行；macOS Quartz是全局事件，独立Signal不隔离本地输入。实验输入adapter只包裹原InputAdapter并在真实注入边界复验fixture窗口身份与foreground，委托原InputHandler执行，不能用页面JS事件代替生产链路；检查与全局注入并非原子操作，因此不能以该检查替代专用桌面。没有专用桌面时可由操作者主动在实验Viewer里发送远程动作，驱动器只读观测；没有操作者则BLOCKED。该前置条件不限制离线和无输入的阶段测量。

`executionMode` 与验收status分开：`automatic-isolated` 是专用桌面自动远程输入；`operator-remote` 是操作者从实验Viewer原Input路径发送，必须同样采齐真实inputId→Host applied ack→producer事件→解码visual marker，所有时延由Viewer同钟观测计算，不靠操作者报数；`producer-local` 是操作者直接在Host页面输入，仅可用于场景准备/可读性观察，永不满足远程输入gate。最后一种即使画面变化也保持inputAck gate NOT_RUN，不得使marker_failures移除对应失败。executionMode本身不能令status通过；前两种只有相同完整机器可核验的因果证据才能PASS。原产品门槛不要求输入一定自动生成，要求的是经过真实远程路径并满足同一指标。

operator-remote使用独立控制端，不在被捕获桌面内自指操作。实验Signal继续只绑定loopback；控制端访问只能使用已有授权的端口转发连接，不能因此开放公网监听、启用新的远程登录服务或改tunnel。没有可用控制端/连接时，该模式同样BLOCKED。

驱动器仅在有效身份与控制lease下通过Viewer原有Input接口发送动作。分别保存原inputId、applied ack、producer实际收到的事件和状态、随后解码画面的状态标记。ack只代表执行确认，不能冒充画面效果；记录浏览器同钟的send→ack和send→观察到效果。

每档：静止60秒、滚动30秒、10次拖动、20次短文本输入；每次有独立动作ID，鼠标移动合并不作为必达ack样本。测试结束清空受控页内内容，不操作其他应用。nonce失配、页面失焦、lease/attempt变化即停止输入。

marker采用固定32×16格，目标编码像素每格8×8，边框1格供定位/定向。内部30×14格按行存两个相同的192bit payload，剩余36格为固定交替校准位；payload为version8bit、reserved8bit、runNonce64bit、sceneId16bit、tick32bit、actionId32bit、CRC32/IEEE32bit（前20字节校验，大端）。灰阶32/224；每格中心4×4中位亮度≤96或≥160分别判0/1，中间值无效。两份payload必须逐bit相同且CRC正确，禁止跨帧投票拼接。producer依据实际捕获尺寸/缩放比和DPR校准格子大小，decoder只搜索预声明ROI；完整编码链路在720p和1080p均需验证成功、损坏和缩放失配测试向量。不依赖OCR。

静止场景的marker必须冻结：tick不是每帧/每秒时钟，仅在明确场景或动作状态转换时更新；静止窗口内nonce/scene/tick/action及全部像素恒定。固定文字ROI排除marker；诊断计数、鼠标闪烁和动画不得落入静止ROI。用无marker与冻结marker的相同输入对照记录质量/成本影响，不能用动态marker污染静止基线；每帧身份由T3的wire-RTP关联取得，不靠变化marker补齐。

marker version=1、reserved=0；边框四角依次TL/TR/BL/BR=0/1/1/1；顶边内部30格从0开始交替，底边内部全0，左右边内部全1。padding从0开始交替。超出预声明ROI、version不符、尺寸或边框不匹配均拒绝，不在整幅个人桌面上搜索。

从实际视频像素取得ROI，禁止用带Viewer浮层的截图做画质基准。按编码像素坐标校准文字ROI和marker，保存质量序列、IDR对齐及差分图；尺寸变化独立判定。缺可靠wire-RTP/rVFC关联时报告UNALIGNED，marker只证明场景和动作状态，不可让IDR-ROI门禁通过，也不把两套时钟相减。

## 8. 有限丢包设施与测试

有限丢包需要专用Linux网络命名空间/容器中的测试TURN媒体路径，仅有docker CLI不足。本次只读检查发现本机Docker daemon不可达，因此此项当前为前置条件未满足；不假设设施已存在。

建立独立测试TURN fixture：唯一runId、临时凭据、专用relay端口范围和可销毁网络namespace；测试端点仅供实验Host/Viewer使用。loss控制器只作用于经过selected-pair实际验证的UDP媒体leg，禁止控制通道、生产TURN、宿主机网卡和pf。接收端统计和fixture包计数必须证明注入确实影响目标媒体，作用接口上无包时判无效，不能通过。

固定两次注入，之间恢复健康10秒：稳定单次每100个媒体包丢1个、持续30秒；100%媒体包丢弃200ms、仅一次。控制器须有独立超时撤销（最多35秒）、异常退出finally清理和目标allowlist。记录selector、实际drop计数、起止monotonic时间及接收序号缺口；时间比较在同一驱动器时钟完成。命名空间本身的配置与日志须归档，地址和凭据脱敏。

恢复门槛：注入结束后2秒内重新观察到连续的新画面/正确标记；不重建PeerConnection、不改变分辨率；请求IDR要看到实际IDR输出和恢复关联。保留NACK/PLI/FIR与重复请求计数。不能用HTTP限速、离线直接force_keyframe或sender丢包模拟替代这项真实网络门禁。fixture未就绪则阻止候选推广，其他不依赖它的开发仍可继续。

## 9. 验收与发布

继承原硬门槛：720p600秒/1080p300秒、FPS中位≥18/15；缓冲P95≤150ms、max≤300ms；无超过1秒无paint；CSS几何变化≤1px；Host loop lag P95≤50ms、输入ack P95≤150ms；暂停恢复/有限丢包2秒恢复。只有满足全部必需场景才能总体PASS。

新增呈现gap的P50/P95/P99和freeze计数。原1秒上限只用于严重停顿，不能独自证明没有每秒短停顿。为本次缺陷增加明确的 `periodic-paint-stall` 门禁（新拟定的工程验收条件，尚非实测结论）：在前台、无计划交互/恢复的健康60秒窗口中，按真实rVFC逐帧时间记录gap；gap≥3×目标帧间隔（本轮目标20FPS，即150ms）为短停顿事件，连续5个事件的相邻结束时间均间隔0.8–1.5秒即FAIL。只按预声明场景边界分段，不事后剔除坏帧；缺少连续逐帧证据为UNALIGNED。该检测只覆盖明确反例，不保证捕获全部人眼可见抖动，必须同时通过以下画质和原客户端验收。逐帧文字质量、健康场景无周期谷值、用户可读性观察是额外必需证据，不能被FPS中位掩盖。周期谷值判定沿用原受控静止IDR处changeMAE≤3.0，并保存IDR前后文字ROI；无IDR时仍检查整个健康ROI序列是否有0.8–1.5秒反复变化，无对齐证据不通过。

必需回归反例：重复600次 `[50ms×17,150ms]` 的帧间隔序列，每秒18帧且max gap仅150ms，当前numeric phase gates会PASS；新增门禁必须拒绝。还须覆盖均匀50ms负例、单次150ms非周期事件、generation/暂停分段与采样丢失；不得从每秒最大gap推断事件准确发生时间。先用legacy及健康对照校验检测器和观测开销，再冻结规则并测候选，不能按候选结果放宽规则。

生产本地验证与用户问题关闭分开：必须在用户最初报告问题的客户端/浏览器及访问入口、TURN选择、viewport/DPR/缩放、前台状态和代表性Host负载下，复验两档长跑、静止文字、滚动、输入、暂停恢复及1秒脉冲。记录实际环境和差异；浏览器不支持因果metadata时记录可观测边界，不以本地Chrome结果替代。原场景必需机器证据加操作者观察；任一失败仍为OPEN，缺少原客户端验收为 `USER_SCENARIO_NOT_VERIFIED`，只有全部通过才是 `USER_SCENARIO_PASS`。原客户端正常使用的观察是最终专门窗口，不与无人工Viewer的实验负载并行；自动输入仍遵守专用桌面规则。有限丢包仍只在隔离fixture，不在原客户端生产网络注入。

最终证据须绑定代码commit、配置digest、输入/版本、runId、attempt/generation、selected relay、完整样本及SHA256。离线PASS、实验runtime PASS、生产验证PASS三层分开记录。生产发布前保留用户脏文件，合入main，只重启本地Signal/Host，核对tunnel不变并从运行配置回报密码。生产长跑失败立即回滚本轮参数，不能保留坏默认后写“部分成功”。

## 10. 覆盖映射

实际参数与编码候选→计划T1/T2；流水线耗时→T3；隔离验证桥接→T4；受控输入/画质→T5；网络丢包→T6；单变量性能实验→T7；推广、回归和证据→T8。T1–T3可先实施，T3实测依赖T4-legacy；T4-candidate依赖T2有离线胜者，T4-legacy可先开发；T5依赖T3的帧关联并可用legacy验证；T6设施前置条件未满足时不阻塞纯离线开发但阻塞推广。
