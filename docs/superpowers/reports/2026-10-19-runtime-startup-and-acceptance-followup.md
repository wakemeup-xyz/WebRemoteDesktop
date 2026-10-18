# 运行加载、资源诊断与验收复查（2026-10-19）

## 当前结论

Viewer 启动配置/授权并发修正 `fefc555` 和 ordinary 收尾修正 `2822441` 已实际进入运行目录。Signal 已重载为 PID33179/birth1792348311.587397，Viewer build `a3671ba674ad7516`、builtAt1792348315201，当前 core `23d4e5e6416b1792`。原 Host36877/birth1792322600.528357 保持运行；tunnel84671、watcher897 身份未变，quick URL 文件仍不存在。

新版完成了一次正常连接后的五分钟被动连续性观察：300.4068秒、301个基线样本，missing/late/failed/identity-change 均0，最大画面回调无进展间隔533.312ms，未触发 Host sample。worker退出0，收尾正常。但**整体资格失败**，不能进入该序列的恢复/三小时步骤，也不能作为 pacing 诊断的成功基线：进程扫描在浏览器子进程退出时遇到 `children()/NoSuchProcess`，原覆盖检查拒绝。真实输入、可见效果及物理显示均未验收。

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

Host lag observer 的六文件有限静态 review 未确认可重复秒级阻塞的确定 bug。首次 Thread.start、producer 侧 redact/JSON/format 和短锁确有同步边界，但耗时未测；资源命令在私有 loop、writer I/O 在锁外。受审源码尚未加载到旧 live Host，因此这些结果不能作为本次6条秒级 lag 的根因。当前源码 percentile 位于 eventLoop.p95，不能据此反填日志顶层 p95LagMs。详情及文件 SHA 已归档。

03:16:08.419–03:16:10.412 CST 的独立检查取得本地 health/status200，16.791/12.469ms，Host在线、Viewer0/relay0；四个受保护服务身份均匹配原 birth，safe URL 文件不存在。但同一窗口公网健康请求为 HTTPError（首次摘要未保存错误状态码）。03:16:38.228–03:16:40.600 CST 的有界补查确认公网 `/health` 与 `/` 均403、server=cloudflare、响应前缀17字节、约2162/2362ms。此时不能宣布公网可用；server header 不能独自区分边缘策略、客户端请求条件或源站路径。02:56的200不覆盖该新异常，未因403重启或重建任何服务/tunnel。后续精确错误码与请求条件检查单独记录。

终态扫描证明 Task1 代码提交 f5b932e，43项纯夹具测试通过（5.221秒），独立 review 尚未完成。这是验收工具的前瞻修正；不更改旧失败、不提供新的控制稳定性或公网可用性通过结论。

03:19:15.587–03:19:16.620 CST 的四请求只读对照进一步取得：公网 health 默认 Python-urllib UA403/edgeCode1010；同路径改用常见浏览器 UA 后200，公网入口用该UA也200；本地 health 默认UA200。对应耗时724.616/1023.364/1019.847/5.817ms。三次公网请求均显式direct/no-proxy且不跟随重定向，同窗口路径/UA对照支持请求条件关联；不证明具体UA/IP规则或真实浏览器连接可用。此前root请求未单独记录代理条件，不能将跨窗口观测说成只改变UA。403事实保持保留，尚未据此改CF策略或服务/tunnel。

Cloudflare [1010官方说明](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/)将其解释为按浏览器签名拒绝访问；[BIC官方说明](https://developers.cloudflare.com/waf/tools/browser-integrity-check/)列出非标准/缺失UA可能被挑战。该通用含义与本轮对照一致，但没有CF规则/源站链日志，不能据此确认本域名的具体配置。今后的诊断应单列HTTP状态、body错误码、请求UA与代理条件，避免将自动探针403计为服务离线；真实浏览器/媒体/输入仍需独立验收。本轮没有关闭或修改任何安全功能。

Task1独立review发现exact ownership五字段schema未严格拒绝额外字段。修正312a163新增严格键集合，实际行为RED后2项定向测试GREEN（0.089秒），独立窄复审确认全部finding已解决、无新Critical/Important。Task1至此通过代码review；Task2集成、全分支review、真实只读check-only及新runtime资格尚未运行。原43项完整fixture结果来自修正前f5b932e，修正后只运行覆盖该差异的2项测试，不伪称整套重跑。
