# 运行加载、资源诊断与验收复查（2026-10-19）

## 当前结论

Viewer 启动配置/授权并发修正 `fefc555` 和 ordinary 收尾修正 `2822441` 已实际进入运行目录。Signal 已重载为 PID33179/birth1792348311.587397，Viewer build `a3671ba674ad7516`、builtAt1792348315201，当前 core `23d4e5e6416b1792`。原 Host36877/birth1792322600.528357 保持运行；tunnel84671、watcher897 身份未变，quick URL 文件仍不存在。

**最新实际结果：新 R5 序列的五分钟基线和宽限内恢复均合格通过，宽限外恢复失败，序列已关闭，三小时未运行。频繁控制丢失尚不能宣布解决。** 长断线后已观察到新PC解码但画面回调停滞、输入门禁持续关闭；这是当前优先代码整改项。后文历史失败及原始收据不改判。

此前旧序列完成了一次正常连接后的五分钟被动连续性观察：300.4068秒、301个基线样本，missing/late/failed/identity-change 均0，最大画面回调无进展间隔533.312ms，未触发 Host sample。worker退出0，收尾正常。但**该旧序列整体资格失败**，不能继续该序列，也不能作为 pacing 诊断的成功基线：进程扫描在浏览器子进程退出时遇到 `children()/NoSuchProcess`，原覆盖检查拒绝。真实输入、可见效果及物理显示均未验收。

失败后的独立本地检查在02:45:22.910–22.956 CST取得 health/status200、Host在线、Viewer0/relay0，33.317/13.063ms。该后来窗口不能反向解释先前最终严格健康检查的 RuntimeError；不能仅猜测为断线宽限。

## 实际代码和部署范围

这次复制的是四个已有代码/测试文件：`scripts/ordinary_session_recovery.py`、对应测试、`web-client/js/webrtc.js`、对应测试；已知源文件1016个，保留原权限、HEAD、index、用户已有修改及其他文件。Viewer 将已配置初始化与当前有效控制授权汇合，并保留 peer/offer/attempt 所有权约束。ordinary 工具在关闭 Playwright 前解除监听，并保留首个失败优先级。

源码相关测试及独立 review 记录在前一份启动修复报告中。离线测试、实际加载、五分钟被动观察和真实业务输入属于不同证据。新版尚不能宣布“频繁控制丢失彻底解决”。

R4F1源复制结果 `4eb2f339…` 为 source-applied。重载 helper 退出0、13.783秒，六个已记录身份退出、无信号，但存在唯一 observation-unavailable，原重载 `ff6ff0b8…` 保持 failed-or-indeterminate、helper lifecycle=false。现有已审窄规则允许独立只读核对；新 readiness `1064eeaa…` 为 runtime-ready-observed，实际14资源、原Host、新Signal和本地在线状态均核对，独立 reconciliation review Approved。这没有把旧helper覆盖或完整进程树追认为通过。

## 部署工具暴露的问题

本轮各失败与窗口保持独立、不可重放：R1收据字段不匹配；R2私有构建观测缺口、具体异常未保留；R3全局 lsof5秒超时；R3B私有构建/离线集成成功但窗口过期；R3C重复校验造成60秒退出观测过期、复制前拒绝。R4将320次逐文件 Git show 的静态路径改为7次批量读取加7次原始tree读取，完整校验OID/type/size/SHA1/EOF、原子缓存并局部禁用replace对象，仍重新检查live文件、HEAD/index、服务与新鲜度。9项定向纯测试和完整独立review通过。

静态调用数不等于实际耗时收益，缓存/响应接受上限不等于OS捕获内存硬上限。原5秒全局lsof、60秒新鲜度、所有权与视频质量/恢复时限均未放宽；R4首次freeze实际66.353秒，不能宣传整个部署校验已变成毫秒级。执行和诊断代码及其原manifest随证据归档，归档副本不构成再次执行授权。

## 最新日志和资源压力

此前固定72小时的修正统计仍采用完整根事件分帧，见启动修复报告；不重新扫描约280MB旧前缀。此次追加采用有界尾部读取，失败提取版本保留，最终v2先通过8组纯夹具，再各读取一次至多1MiB，保存白名单摘要并据此复算。

- Signal 在实际尾部窗口有60条完整 entry_window/info 根事件；它们不是60个连接。控制台经 `logger.info(JSON.parse(line))` 输出Node多行对象，直接JSON解码不成立；v2复用完整根对象边界及精确顶层字段。60条孤立物理行保持未知。
- Host覆盖01:54:50.703–02:29:39.518 CST，373条完整 loop-lag 根记录（317 warning/56 info），缺失这一小时前约1510秒。瞬时 lagMs 最新4.065ms、最大3733.163ms、6条≥1秒；滚动 maxLagMs 最新186.005ms、最大3733.163ms、52条≥1秒，窗口可能重叠。p95LagMs未观测，数值为null。另有2个不完整JSON时间块。
- 最新Host白名单上下文是 pc/ICE=none、inputEventCount0、relayRunning=false、captureSeq0、inputWaiters0；仅代表该观测，不能外推整小时无人或没有失控事件。

01:41窗口12逻辑CPU的load1约233–237，全局端口查询三次5秒超时；01:42资源快照823进程、swap使用约11169.5M/12288M。01:51负载降至9.19时同一全局查询0.287秒完成。支持资源竞争相关性，不能证明唯一根因或按进程名称回收未知服务。一次netstat仅确认schema，未建立与FD所有权完整性的等价关系；未替换原门禁。

空闲Host也出现秒级调度停顿，是仍需取证的性能问题。不能把发射告警当作全部tick延迟分布，也不能将事件循环停顿、ACK往返、画面回调间隔相互替代。六项真实输入耗时继续null/NOT_RUN；此前capture pacing等待与复用帧的诊断结论没有因此获得新的因果证明。

## 下一步与验收边界

本次唯一明确的验收扫描错误是scan457、PID36482的直接children/NoSuchProcess。167毫秒前有该注册身份观测，最终七个已记录身份退出，但没有当时即时的前后身份证明。原失败 `5ebf46ff…` 永久保留，不补造证明、不继续旧序列。

后续设计为精确、有界的前瞻终态证明及独立消费者，保留原始gap，只接受逐条证明完整的注册身份退出竞态；其余未知/权限错误/不同操作仍拒绝。完整进程树保持UNKNOWN，PID reused不绕过原最终all-exited要求。见同日 `known-process-terminal-scan-proof` spec和plan。代码及review完成后，创建全新序列和实际基线，逐项验证宽限内外恢复及三小时连续性；每项需要新严格空闲检查，不自动推进失败场景。pacing及原生输入诊断当前无合格前置基线。

完整SHA、实际结果与失败提取版本见 [证据索引](evidence/2026-10-19-runtime-startup/evidence-index.json)。密码只从运行配置在聊天报告，不写入版本化正文。

## 补充复查：源码边界与公网403

Host lag observer 的六文件有限静态 review 未确认可重复秒级阻塞的确定 bug。首次 Thread.start、producer 侧 redact/JSON/format 和短锁确有同步边界，但耗时未测；资源命令在私有 loop、writer I/O 在锁外。后来按已部署 backend dfb15434 的 Git 对象逐文件校对，六文件均与受审 held41 文件字节相同；原“尚未加载”说法撤回。静态边界可关联该版本，但不能证明本次6条秒级 lag 的运行耗时或根因。当前源码 percentile 位于 eventLoop.p95，不能据此反填日志顶层 p95LagMs。详情及文件 SHA 已归档。

03:16:08.419–03:16:10.412 CST 的独立检查取得本地 health/status200，16.791/12.469ms，Host在线、Viewer0/relay0；四个受保护服务身份均匹配原 birth，safe URL 文件不存在。但同一窗口公网健康请求为 HTTPError（首次摘要未保存错误状态码）。03:16:38.228–03:16:40.600 CST 的有界补查确认公网 `/health` 与 `/` 均403、server=cloudflare、响应前缀17字节、约2162/2362ms。此时不能宣布公网可用；server header 不能独自区分边缘策略、客户端请求条件或源站路径。02:56的200不覆盖该新异常，未因403重启或重建任何服务/tunnel。后续精确错误码与请求条件检查单独记录。

终态扫描证明 Task1 代码提交 f5b932e，43项纯夹具测试通过（5.221秒），独立 review 尚未完成。这是验收工具的前瞻修正；不更改旧失败、不提供新的控制稳定性或公网可用性通过结论。

03:19:15.587–03:19:16.620 CST 的四请求只读对照进一步取得：公网 health 默认 Python-urllib UA403/edgeCode1010；同路径改用常见浏览器 UA 后200，公网入口用该UA也200；本地 health 默认UA200。对应耗时724.616/1023.364/1019.847/5.817ms。三次公网请求均显式direct/no-proxy且不跟随重定向，同窗口路径/UA对照支持请求条件关联；不证明具体UA/IP规则或真实浏览器连接可用。此前root请求未单独记录代理条件，不能将跨窗口观测说成只改变UA。403事实保持保留，尚未据此改CF策略或服务/tunnel。

Cloudflare [1010官方说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)将其解释为按浏览器签名拒绝访问；[BIC官方说明](https://developers.cloudflare.com/waf/tools/browser-integrity-check/)列出非标准/缺失UA可能被挑战。该通用含义与本轮对照一致，但没有CF规则/源站链日志，不能据此确认本域名的具体配置。今后的诊断应单列HTTP状态、body错误码、请求UA与代理条件，避免将自动探针403计为服务离线；真实浏览器/媒体/输入仍需独立验收。本轮没有关闭或修改任何安全功能。

Task1独立review发现exact ownership五字段schema未严格拒绝额外字段。修正312a163新增严格键集合，实际行为RED后2项定向测试GREEN（0.089秒），独立窄复审确认全部finding已解决、无新Critical/Important。Task1至此通过代码review；Task2集成、全分支review、真实只读check-only及新runtime资格尚未运行。原43项完整fixture结果来自修正前f5b932e，修正后只运行覆盖该差异的2项测试，不伪称整套重跑。

版本边界澄清已单独保存v2（原v1原件不改），附live backend六文件的精确SHA与比对manifest。此次只修正来源判断，没有新增现场采样或阻塞因果结论；不外推为整个worktree或所有运行模块相同。

分析器边界再澄清：已保存的373条Host白名单仅包含lagMs/maxLagMs/sampleCount及有限上下文，没有保留eventLoop嵌套对象。受审源码的percentile是eventLoop.p95；因此“p95LagMs=null”只表示本次分析未观测该精确键，不能推出原日志不含其他percentile字段。由于有界尾读预算已用完，不为补数字重读原日志；下一次获准采样应按已部署schema显式采集eventLoop.p95并标注统计窗口。六项真实输入指标仍独立保持null，不由任何percentile/ACK/帧间隔推算。

## 已加载新版的启动与传输耗时

离线复算上述失败资格中已保存的312行，未新增现场会话。Viewer fefc555/build a3671ba674ad7516，relay↔relay UDP/H.264；浏览器行观测窗口02:37:39.7245–02:42:48.9209 CST。相同performance.now时钟的mark：点击→signal-connected3668.1ms，bootstrap672.1ms，bootstrap-ready→signal2995.3ms，signal→媒体就绪2469.6ms，点击→媒体就绪6137.7ms。旧单次点击→信令4577.8ms，本次少909.7ms，但跨样本没有受控对照，不能称因果改善或P95。

“first-frame”与“active”由markMediaAttemptReady一起写，可来自rVFC、解码进展stats或relay绘制等路径；它们不能唯一证明首次视频回调，更不能证明control grant/input-ready。第一次callbacks-positive行已有12回调，lastFrameAtMs是最新值，精确首次回调继续null。配置/授权/offer/peer-connected没有独立时间戳，serverEvents数组全空；不能将2995.3ms或2469.6ms再拆成未观测的服务阶段。

| 保存字段 | 有数值的行数 | 最小–最大 | 最新值 | 边界 |
|---|---:|---:|---:|---|
| transport.rttMs | 304 | 28–161ms | 33ms | WebRTC往返快照，非单程 |
| candidateRttMs.last | 303 | 28–161ms | 45ms | 5秒滚动窗口最新值 |
| jitterBufferMs.last | 301 | 4.5–104.3ms | 61.4ms | 5秒滚动窗口最新值 |
| decodeMs.last | 301 | 1.09863–3.7034ms | 2.43589ms | 5秒滚动窗口最新值 |
| paintIntervalMs.last | 303 | 16.6–216.7ms | 50ms | 帧呈现间隔，不是输入耗时 |
| encoderMs.last / relayFrameAckRttMs.last | 各0 | null | null | 有字段、无数值 |

累计接收7467491bytes、解码5111帧、framesDropped0，都是计数器，不能作为速率或packet-loss证明。行数不是独立包/帧/事件数；滚动窗口重叠，不相加、不重建全程P95。本批未保存capture/relay queue/packet loss分段证据，六项输入指标312行全为count0、last/p95=null。网络RTT、解码和帧间隔不能相加推导完整输入到物理显示延迟。真实输入、原生执行、业务/可见效果/物理显示仍NOT_RUN；整体资格仍failed-or-indeterminate。

后续性能定位优先补齐配置/授权/offer/首个实际视频回调/input-ready的独立有界时标及来源，再在合格被动基线之后按已审pacing方案取得线程现场证据；不修改视频质量或用这些被动数值代替输入验收。两份离线分析和精确artifactSHA均已归档。

03:36:24.518–03:36:25.369 CST 的新独立只读状态检查：显式direct/no-proxy、无重定向、浏览器UA；本地health/status200，7.330/6.321ms，Host在线、Viewer0/relay0；公网health200，845.139ms。Signal/Host/tunnel/watcher四个原PID/birth均匹配，safe URL仍不存在。该一次状态检查不构成持续可用或输入验收，且不能抹去默认PythonUA403/1010记录。

## 新验收工具的集成review阻断（未用于实际运行）

Task2代码0589da2完成38项离线测试（15.900秒）后，独立review通过两个仅fake的定向复现确认P2：ProductionIO.observe_known及Task1 proof producer重复读取同一psutil.Process.create_time，实际命中缓存，不能证明第二次birth新鲜；另previous outer result/legacy result与previous attempt/root decision只分组内部绑定scenario，缺少跨组相等及完整prior envelope校验，混合baseline结果与continuity决定可错误准入nextwithin。完整旧链始终标NOT_CLOSED，尚未做真实check-only或新资格；这些问题位于新开发的验收工具，不是当前Viewer控制故障的因果证明。

已在修复前提交spec/plan0b11baa：present观察使用两个独立fresh same-PID public handles、同对象/第二次读取失败保守拒绝、原始rawgap/exception不改；五份previous记录scenario必须等于expected previous，补exactschema/kind/version。32条/32768B/1秒、60秒/5秒以及原场景和画质门槛不变。按Task1fixround2→独立复审→Task2fixround1顺序进行。新cache-faithful测试已对zombie/reused候选及same-handle-return复现实际行为RED，修复/完整GREEN/复审结果尚待后续记录，不能把原测试通过当作当前工具已经可用。

Task1fixround2已提交1498469：present采用独立第二same-PID handle，第二错误保守拒绝。实际cache-faithful RED三个行为失败后，完整受影响文件50项GREEN（1.496秒），独立窄复审Approved，无新Critical/Important；初始absent仍1次resolve、normalpath零额外读取，原异常与rawgap/所有限额保留。此前报告before-fix内容保留为历史，由本轮记录补充。Task2fixround1已开始，仍未真实check-only或运行新资格。

Task2fixround1已提交0a7e6c7，两项实际新增行为RED后完整受影响文件45项GREEN（30.186秒），原38项全部保留。已有schema不变；legacy started的显式scenario与另四份记录严格相等，外层r5-started通过input/decision哈希间接绑定且严格schema/kind/version。独立窄复审尚未完成。03:59:30.005–31.106 CST 的另一次独立只读检查取得本地health/status200、5.087/4.123ms，公网health200、1096.687ms（显式direct浏览器UA），Host在线0/0、四服务独立双handle birth均匹配，safe URL不存在；不构成新资格。

Task2fixround1独立窄复审确认两P2全部解决、无新Critical/Important，无deferred minor；共享legacy marker helper仍保留final source校验。至此两项实现任务完成代码、fixture和逐任务review，当前转入新鲜most-capable全分支review；真实check-only与新资格仍NOT_RUN，不能把逐任务通过视为上线/连接验收。上述全部补充证据已核对归档regular文件、长度与SHA，运行服务未因此重启。

全分支独立most-capable review已完成（ee0fcde→55ceb32），代码/文档范围Ready，Critical/Important/Minor均无；50/45项测试证据和不可变原定义逐项核对，未重复执行套件或运行操作。现在只结束代码review阶段，不宣布运行通过。后续实际操作配方已同步到仓库plans/2026-10-19-r5-real-qualification-operations.md，实际材料与时间仍待root按次创建，先真实check-only，再独立fresh run decision；源执行HEAD与两production文件须在整个新sequence固定，运行证据先保存在私有root，序列关闭后归档。

实际操作配方也完成独立review：唯一P2为把所有prepare-attempt失败都当reservation已消费，现按原sequence/decision前置校验→reserve→后续准备的真实阶段及实际marker判断；已窄复核Ready。现有off-line复用边界、CLI/schema/history/freshness顺序核对无其他finding。配方明确整个新sequence冻结executionHEAD（包括暂停docscommit），运行证据私有保存到序列关闭；这只是执行准备，不提供真实准入/资格证据。两production文件字节已与最终review55ceb32对应Git blob逐一相同，新增均为文档和审查归档。

## 新 R5 实际资格及宽限外恢复缺陷

前瞻终态证明的两任务及独立全分支审查完成后，execution HEAD 固定为 b032481707f08f35bb91683da1f3a6ac4c22fa24。实际原完整门禁链 check-only 退出0，未消费one-use；随后独立新root决策单次运行每个场景。没有复用旧失败场景或其时间戳，没有修改5秒端口查询、60秒新鲜度、场景预算或媒体质量。实际序列 e0d817ad446b77398041d33d404cda2a 已因after-grace失败关闭，不自动重试或继续。

| 场景 | 实际结果 | 关键观察 | 收尾 |
|---|---|---|---|
| baseline | qualified PASS，CLI0 | 300.250165秒、301样本，missing/late/failed/identity-change均0；301行inputAllowed/scopeStable/mediaActive全true；最大无进展200ms | 7个已记录worker身份退出、无信号、无Host sample；1条前瞻终态证明，原raw gap保留 |
| within-grace | qualified PASS，CLI0 | 恢复5.999977秒，稳定30.030126秒；31个稳定阶段样本inputAllowed全true；Host未观察到断线 | 全部原验证阶段通过；7个已记录worker退出、1条证明；整个恢复场景无Host sample |
| after-grace | failed-or-indeterminate，CLI2/worker1 | routed故障12秒、阻断2条WS/0条HTTP；未达到画面/输入恢复门禁，60秒恢复窗口结束，reason reset-unconfirmed | worker阶段失败，后续验证not-evaluated；7个已记录worker退出、无信号、无sample；保留health RuntimeError |
| continuity | NOT_RUN | 前一场景失败，未获新的root推进决定 | 无运行记录 |

以上PASS只覆盖被动连续性和普通恢复契约；logical inputAllowed=true不证明真实键鼠执行、采样之间无短暂中断或可见效果。完整进程树仍unknown，原始worker的api-finished-exit-unknown表述保留；独立supervisor提供的是已记录身份及窄终态证明。真实输入、业务/可见效果、物理显示继续NOT_RUN。

### 失败时序与源码发现

服务端依次记录grace-started、grace-expired(lease8/REVOKING)、reset-completed(lease8/FREE)。新lease9高于旧lease7和reset8，满足runner的reset关联条件。随后PC2保持同一身份，generation从2升3；PC connected且framesDecoded从4增长到823，但callbacks停在6034，末行frameAge44517.372ms。产品自身hasPaintedFrame/currentAttemptReady/inputAllowed均false，uiPhase=signaling，blockedReasons为inactive及media-not-ready-for-attempt。

runner在超过60秒时统一输出reset-unconfirmed，因此这个标签不能解释为后端没有reset。此次失败不能通过改标签或以decoded代替presented帧来变成PASS。

有限静态调查确认可达的生命周期缺陷：无lease恢复创建的peer捕获旧attempt owner；handleControlGrant只退休绑定了其他lease的peer，保留未绑定lease的peer，随后beginConnectionAttempt提升代次；新offer可绑定新lease并开始解码，peer回调却仍持旧owner。ontrack和连接回调因此可被防陈旧检查拒绝，既不能挂载新stream，也不启动当前stats/rVFC。该链与实测吻合，但本次未直接保存owner/track/play元数据，现场因果仍为有依据的推断，不是唯一根因证明。

最小整改方向是在changed-lease推进attempt时一并退休已有无lease peer，并在最终attempt确定后重建，保留旧回调拒绝及同lease宽限内复用。不能修改旧owner、放松rVFC或强制开放输入。完整调查、边界和回归建议已按原字节归档；后续代码需独立RED/GREEN及review，再准备新版本部署与全新资格序列。

本次失败收尾中的严格health RuntimeError保留。后续独立只读检查epoch1792357099.878–1792357100.891取得local health/status200(5.244/4.382ms)、formal browser-UA health200(1008.041ms)、Host在线、Viewer0/relay0、四个服务原birth均匹配、safe URL不存在；这是后来的独立可用观察，不反向改判原错误或证明持续可用。此轮没有服务、Host、watcher或tunnel重启。

### 新基线延迟口径

新baseline保存的transport.rttMs有301行数值，范围21–50ms，最新22ms；不是单程或输入到画面的耗时。点击到媒体就绪标记5825.8ms，bootstrap-start到ready652.7ms、ready到namespace信令连接3021.9ms、信令到媒体就绪2150.6ms。源码确认bootstrap-start在准入POST之前，socket在ready之前已创建并与配置加载并行，故652.7ms是复合阶段，3021.9ms是并行连接的剩余等待。未发现ready后固定等待3秒的代码，不能据两次约3秒间隔归因timer。

first-frame/active仍不是唯一首个rVFC或输入就绪标记；精确首次回调、单程、六项真实输入指标仍null/NOT_RUN。后续应新增准入开始/完成、socket创建、engine-open、namespace-connect及真实帧/input-ready的独立有界时标。输入延迟collector在另一隔离分支继续离线实施，未加载当前服务，不给本轮补造真实输入数值。

此轮新增43份必要摘要/原收据/脱敏投影，未归档原始samples或Host/Signal日志。证据索引现有183个payload、1895152bytes，SHA256 7b0bbb04ff0531cec78199c94f4d581fa12ebe005d0a34e66234dbdbf42a8680；所有副本regular/0644/长度/SHA重新核对。归档只为审计，不能用作执行授权或重放原one-use。
