# 现有 WRD_FRAME_TRACE_DETAIL=1 生产短测只读审查

结论：现有flag确实是Host启动期的opt-in观测路径，可在下一次已授权的Host重载中开启；没有内置300秒自动退出。它会增加metadata、锁和DataChannel流量，不能承诺零开销。更关键的是当前生产首连接有context装配缺口：只设置flag并重载，不能保证实际获得grab/worker/output/wire关联。因此当前不能无条件认定“开flag后直接300秒”能完成所需诊断；需实际有非零output/grab/encode和sourceToWire覆盖证据，缺测保持NOT_RUN。此报告不修代码、不改变配置、不发起任何连接。

## 范围与服务约束

只读primary/worktree相关代码、README/runbook及webremote-service技能，服务边界按该技能与仓库规则处理。未运行服务helper、launchctl、network/native probe、浏览器或profiler。读取配置时只提取WRD_FRAME_TRACE_DETAIL这一非秘密flag；未输出或保存其它.env值。只写本0600报告。当前repo LaunchAgent plist没有EnvironmentVariables；signal-server/.env没有该flag。没有读取进程环境，因此不声称当前Host运行时flag已验证为0。

## 开启与恢复路径、配置优先级

-`python-host/host.py:99–102`仅精确值`1`开启；未设置或`0`都关闭。2037–2040在WebRemoteHost构造时读取，分配FrameTraceRegistry与StageMetrics。进程启动后改.env不会动态切换已存在Host，也不会给现有track补context。
-`scripts/restart-host.sh:10,17`委托lib-host-launchctl，不直接exec调用shell里的Host；`lib-host-launchctl.sh:59–92`安装/复用LaunchAgent并kickstart。把flag只写在`WRD_FRAME_TRACE_DETAIL=1 ./scripts/restart-host.sh`这一调用shell前面，不保证被launchd新进程继承。
-`launchd/com.webremotedesktop.host.plist`的ProgramArguments指向primary的`scripts/run-host-launchctl.sh`。该wrapper12–17在set-a下source primary `signal-server/.env`，因此普通`WRD_FRAME_TRACE_DETAIL=1`赋值会覆盖已继承的同名LaunchAgent环境；若.env没有赋值，则保留LaunchAgent继承环境。当前wrapper没有专用trace参数或300秒临时配置入口。Host本身没有再读dotenv。
-若下一次授权包含这一诊断，可在既有本地运行配置里临时明确设置该flag为1，仍只按既有Host重载入口完成加载。不要误操作worktree的.env而期待primary LaunchAgent读取。此次没有执行该设置或重载。
-结束后恢复先前配置（本次读取到.env原本没有该键；若需明确覆盖未知继承值，可在运行配置设0），再走相同的Host-only重载，使构造时关闭flag。只改.env而不重载，旧Host继续trace。Flag没有timer，也不随300秒collector结束自动清理。
-Viewer在首次收到batch后`webrtc.js:5768–5770`将_frameTraceEnabled设true；本次搜索未找到设false的复位赋值。关闭Host后要完全恢复该Viewer的默认观测开销，需新页面/刷新载入；仅Host断开不会证明旧JS collector已关闭。
-上述动作均属于Host本地流程，不涉及Signal重启或任何tunnel操作；不得调用全链路stop-safe/start-safe/run-safe-quicktunnel替代。保留既有URL文件、Cloudflare进程及其它应用。实际重载仍需遵守本地健康、Host在线、授权连接验收和两类密码仅从本机配置回报的规则；密码不进入本报告。

## 首连接context缺口：现有flag的实际限制

生产`host.py`源码链：

1.2041初始化`self._frame_trace_context=None`；连接清理3352也重置None。
2.3636创建局部`frame_trace_context = self._frame_trace_context_for_policy(policy)`。
3.3637调用`_create_screen_track()`；工厂2135–2137却从Host的`self._frame_trace_context`传给track，尚未使用这次局部context。
4.3641给sender传正确局部context；encoder通过114/128得到sender context。
5.3702提交成功时才把局部context写入Host；没有同时给offer_track重新绑定。

因此首个新Host/new offer的track可以仍为None。其recv1619/1623不会进入trace注册/summary，1632不会_record_output_trace，1759–1761也不会发送batch；encoder虽有context，却无法找到对应注册output，故不能得到完整stage链。

4578–4583某次真正的media-profile应用会给Host/sender/track/encoder统一context，可能使后续trace工作；但4573的no-op提前返回不会做这次补绑。不能假定普通连接或相同默认配置一定触发真正profile应用。无需为此引入新架构，但在当前只读任务中它是一个明确的可用性限制，不以无关切档作为诊断准备动作。

所以在保持现有代码的300秒试测中，只能把summary/覆盖真实出现视为已启用；不能把env=1、Host在线或encoder日志存在当完整frame trace已成功。若没有实际trace，应记录观测未覆盖，而不是继续300秒后再推断“grab没有耗时”。

## 有效绑定时已有观测能回答什么

-真实MSS grab边界：host1384/1390已有monotonic_ns起止，并按成功captureSeq保存在2048上限的bounds侧表。1399淘汰旧bounds。trace开启不额外抓图；1401仅增成功capture计数。
-`_record_output_trace`1841–1857注册一个输出身份（attempt/generation/stream/captureSeq/encoderTimestamp），将grab起止、finish→selected的age_at_recv、worker_queue、prepare、convert和build记录到同Host单调时钟。fallback复用保留原source capture identity；blank无capture证据。输出计数、fresh与reused分开。
-这是“被选作输出的source”stage证据；未被取用就覆盖的截图没有独立grab直方图。复用同一capture时，grab耗时可能随多个输出重复进入分布，不能称为每次唯一MSS调用分布。异常截图次数/异常耗时没有这条trace的显式计数。
-encoder1029–1066按相同timestamp与scope唯一查找，测materialized encode、packetize、encode_total并注记IDR/policy。build包含prepare+convert；encode_total包含encode+packetize，不能重复求和。reformat字段没有独立填入时保持null，不能认为0。
-`rtp_frame_observer.py:93–182,238–258,279–297`在_encoded_frame完成后关联身份，在实际transport send await成功后提交首个有效RTP packet，检查ssrc、非零origin和generation，排除RTCP/RTX等。bind不是“已经到达浏览器”，也不是全部RTP包发完。
-Viewer收到batch才启用FrameTraceCollector，用rVFC的rtpTimestamp作identity join；Host/Viewer时钟不互减。无controlled ROI时`decodeControlledMarkerFromVideo`直接return，不会因为flag本身额外抓取canvas pixels；flag不会自行打开controlled scene或loss lab。

仍unknown：真实抓图异常/失败分布、未使用capture的grab分布、截图线程完成间隙、recv错误pacing具体请求sleep、默认encoder executor排队等待、全RTP发送await/所有packet持续时间、transport/网络单向延迟、浏览器接收/解码队列逐帧分配及物理可见效果。worker_queue已覆盖imgproc executor这一段，不能把它误称encoder executor等待。当前trace不包含rtp_send stage时长。关闭的lab loss tap不能当作生产trace默认已有的完整packet轨迹。

## 有界性和真实开销

-Registry默认TTL120秒、每个stream-scope最多2048trace，active attempt/stream索引最多2048，pending总队列最多2048（media_stage_metrics26–27,139–162,198–213,377–380）。不是全局所有scope合计仅2048trace；scope数量也有限但理论总上限更大。一次固定身份300秒测试主要是一个scope；TTL/容量淘汰都会计数，不保证全300秒都留在内存。
-StageMetrics每个10个metric stage各2048样本deque，五秒summary后reset。每个record有锁、float舍入和registry注记；registry _purge会扫描scope和pending，编码/recv两线程会共享RLock。每五秒计算排序分位数、JSON序列化和同步日志I/O都在现有路径中，不能称无开销；本次未测CPU/RSS增量。
-rtp observer pending按task用WeakKeyDictionary；origin映射上限64。已有observer通常也为输入因果关联安装；本flag增加trace registry查找/标注，不是另开一个sender/编码器或抓图源。
-Host每100ms最多尝试一批、每批最多64行（1757–1784），通过现有input DataChannel同步send JSON，不await诊断回执。pending有界、发送错误计drop。该函数未检查bufferedAmount或设置诊断字节预算；成功dc.send只表示进入SCTP队列，不能声称所有下游缓冲都有严格字节上限。额外metadata与已有媒体/输入反馈共用transport，有可能扰动待测系统。
-20output/s、300s量级约6000行。按当前wire schema构造一条不含秘密的代表性JSON为470B，约2.82MB纯行metadata（约75kbps）外加batch封装、SCTP/DTLS/IP及重传；这是预算估算，不是实际流量测量或硬字节上限。实际行长、帧率、drop、batch频率和网络重传均会改变结果。
-Viewer FrameTraceCollector容量默认256，TTL30秒，lateWait2秒，batch≤64；identity冲突/缺失会fail closed。内存与匹配分布不是全会话持久化存档。
-Flag没有输出6000行到新的本地文件，也没有后台trace线程。有效context时WRD_FRAME_TRACE_SUMMARY约每五秒由recv路径触发；当前门槛仍与last_time/time.time共享墙钟统计窗口（1623/1661），墙钟异常可延迟summary。停帧时recv不推进也不会准时吐出摘要，不能当独立看门狗。

## 输出、隐私及采样落盘

Host summary进入现有back-debug.log（或显式WRD_HOST_LOG_FILE）；`observability.py:30–31,48–82`默认RotatingFileHandler为10MiB、3备份，约40MiB总上限，可被运行环境覆盖。脚本wrapper的/tmp/wrd-host-launch.log是启动日志，1MiB裁剪不是frame trace目标。summary包含本地stage分布、CPU、覆盖/失配计数和observer身份摘要；不会为flag单独创建trace.jsonl文件。

逐帧batch发往当前Viewer，字段为attemptId、generation、streamId、captureSeq、encoderTimestamp、wireTimestamp、ssrc、framePts、IDR kind/reason、policyDigest和数值stage。没有屏幕像素、输入正文、剪贴板、坐标、密码/token、SDP/IP地址或TURNcredential。observer仅解析已有RTP header，trace不落packet payload。身份/会话活动频率本身仍属于诊断metadata，应按私有有界证据处理；通用摘要是直接logger输出，不应对未来任意新增字段假定自动脱敏。

高细节loss lab另须WRD_LAB_LOSS_TRACE=1且WRD_LAB_HOST_ENTRY=1，普通生产只开DETAIL不会启用它；不需要更改这些lab变量。

现有`scripts/passive_session_sampler.js`和`passive_session_soak.py`全文检索没有frame_trace/frameTrace/getFrameTrace导出。因而已有300秒samples.jsonl仅保留它原本的媒体/LatencyMonitor指标，并不会自动存下本次raw trace batch/Viewer匹配结果；能够直接从现有产物读取的是Host五秒摘要（若context真的绑定）。普通diagnostic导出仅提供collector摘要，不等于完整逐帧stream。不能声称现有被动artifact已经覆盖全部source→Viewer关联。

## 对下一次限定300秒的判断

在已授权Host重载范围内，使用现有flag进行300秒短测在机制上可行，且比开profiler/第二套抓图路径窄；必须接受它是带观测开销的对照条件。当前首连接context装配与现有sampler不导出raw trace的限制，意味着不能承诺只改flag即可完成所需stage诊断。若实际summary已有非零grab/worker/encode、有效scope与可解释drop/coverage，则可利用这些现有日志分析局部stage；其余等待保持unknown。不要为补观测而自动操作tunnel、切媒体档位、另建Lab或扩展新设计。

本次未设置flag、未重载Host、未改变其它应用或访问公网。服务技能只用于确认操作边界，未执行任何服务动作。


## 追加交叉确认：M2基础输入因果关联独立于DETAIL（只读）

结论：WRD_FRAME_TRACE_DETAIL默认关闭、首offer的track detailed context=None，只影响可选逐帧stage trace；不使当前M2的inputToPostApplyFrameMs永久无法出样。基础链具有独立的pending输入、capture reservation、首RTP绑定和Viewer rVFC consumer。以下为实际生产接线，不依据受控场景或临时lab推断。

Host链路：

1.`host.py:140–144`无条件安装稀疏RTP observer（按本地aiortc ABI检查），并不受DETAIL flag控制。2036无条件创建InputFrameCausality；只有2039–2040的detailed registry/metrics受DETAIL控制。Capability在2216/3490按observer可用状态声明inputFrameCorrelationVersion=1，失效保持缺测。
2.真实输入adapter成功返回后2546以monotonic_ns取applied边界，2548调用_note_input_applied。2939–2951要求authority/scope与observer有效，独立note_applied；没有读取_frame_trace_context。InputFrameCausality33–44仅接收applied状态，保存有界inputIds和Host applied_ns。
3.recv1632–1639的detailed注册是条件块；其后的1640–1646是独立if，不嵌在trace_context条件里。满足fresh_output、selected_scope、grab_bounds时，无论DETAIL是否开启都按input scope构造FrameKey并reserve_for_capture。真实grab边界1384/1390与source sidecar也不受DETAIL控制。input_frame_causality46–58要求capture_started严格晚于applied、fresh/non-reused、scope一致，避免缓存帧充当输入后新采集证据。
4.offer_sender在3642始终绑定_wrd_input_frame_host，跟3641的可选detailed context是两个字段。rtp_frame_observer93–123分别查询registry key和input_key；即使registry=None，也可用input_key建立pending，111–113仅在两者都缺失时拒绝。
5.sender实际transport send await成功后才commit（observer282–297）。169–182的commit在没有detailed registry时仍执行180–181的Host _commit_input_frame；不以bound=true作为input commit前提。Host2953–2963取reservation，发送独立input_frame_binding，带attempt/generation/lease、capture identity、wireTimestamp、ssrc和inputIds。这条消息不是frame_trace_batch，也不依赖stage sidecar注册。

Viewer链路：

1.`webrtc.js:4500–4504`独立处理input_frame_binding；5745–5753只要求server capability=1、LatencyMonitor存在且有待匹配输入，创建单独inputFrameCollector。
2.每个rVFC回调5676先由真实receiver/source识别frame identity。5678–5680才是optional detailed/ROI/loss分支；基础5682–5683在该分支之外调用input collector.observeVideoFrame并consume。因此_frameTraceEnabled=false不会屏蔽M2回调。
3.5745的collector scope与latencyScope同源；5735–5742要求唯一实际video receiver和唯一同步source，携带rVFC metadata.rtpTimestamp。acceptBinding280–297检查scope、fresh/after-applied等字段，随后以相同ssrc/wire RTP identity进行匹配；matchedVisual179–199把inputIds/scope与原始callback clock保留下来。允许binding先到或callback先到，不用join时刻替代callback时刻。
4.consumeInputFrameMatches5756–5758调用LatencyMonitor.onPostApplyFrame。latency-monitor185–203验证scope/匹配/两秒迟到边界及input状态，193计算`row.viewerClockMs - record.sent`：同一Viewer时钟内的输入发送→确认属于applied之后新capture的rVFC。不是Host applied时钟减Viewer时钟，也不等于物理可见效果。

仍会合法缺测的边界：无用户输入的被动run、ABI observer不兼容/失效、输入未applied、scope变化、复用缓存/抓图早于applied、超过10秒pending期限、首RTP失败或binding未送达、浏览器没有可验证唯一ssrc/rtpTimestamp、缺失rVFC或metadata匹配过迟。它们保持null而非制造数值，但不存在“仅因DETAIL默认关闭而基础metric永远不能出样”的装配阻塞。

本交叉确认只读代码与现有测试，未跑native、服务或真实输入。前文首offer detailed context缺口的结论保持，但范围严格限定为可选stage trace，不扩大到M2基础关联或输入控制本身。
