# 2026-10-24 控制恢复修复记录

## 确认的问题

本轮从 CPU 归因转到独立可复现的控制恢复缺口。没有修改抓帧倍率、分辨率、编码器或全机业务负载。

1. active 成功 ACK 后等待新鲜帧，同 generation soft replay 会被 Signal 或 Host 拒绝。旧 Viewer 用 Host stale-generation 覆盖成功 ACK 并取消剩余 fallback；之后的新帧被 no-active-ack 拒绝，永久 resuming。真实 Signal 更早拒绝重复请求且不带请求身份，Host ACK 转发又丢失 reason，因此仅修改 Viewer 的直连 Host fixture 不足以修复生产路径。
2. DataChannel 的 send 同步失败会让上层重新抛异常，没有进入已存在的 Socket fallback。
3. schema 3 主动删除控制台原文后用空数组生成 logCount=0，误导诊断；原上送条数与仍保留的结构化 trace 没有分别记录。

前两项由真实生产函数/validator 和可控时钟反例证实；第三项由实际 v3 raw、ingest 源码与持久化 canary 反例证实。不能把这些反例反推成今天所有断连的唯一根因。

## 修改范围

- `web-client/js/webrtc.js`：同 scope 已确认媒体请求的重复回复不覆盖成功证明；保留有界新帧恢复期限；DC 同步 send 失败交给既有 Socket fallback。
- `signal-server/websocket/signaling.js`：拒绝回复携带经过验证的 state/generation/attempt，不回显 lease；Host ACK 仅透传固定原因枚举，Viewer 按当前请求处理拒绝；旧身份和无 scope 回复不能取消当前恢复期限。
- `signal-server/lib/diagnostic.js`、`diagnostic-store.js`、`observability/runtime-evidence.js`：只持久化 reported/retained/redacted/trace 计数，不保存控制台原文。历史未知保留 null；v3 非法身份/capture 不进入 legacy 原文分支。
- 将 `input-events-dropped` 更正为 `input-trace-truncated`、`input-reset-ack-expired` 更正为 `input-ack-observation-expired`。真实 ring 仅记录生命周期事件也会淘汰，不能把它解释为键鼠动作丢失。
- 新增或扩展与上述行为对应的回归反例；没有新依赖。

## 验证与加载状态

- 初次最小修复回归：Viewer 1,507/1,507 PASS；Signal（含 signaling）432/432 PASS，无跳过。后续补丁的最终全套为 Viewer 1,517/1,517、Signal 537/537，见下方系统性复核记录。
- 媒体路径独立审查：PC/socket/lease/attempt/generation 隔离、legacy relay 及固定恢复期限未发现必修问题。
- 隔离构建：`/tmp/wrd-web-preview-20261024-final-control-recovery`，buildId `544814d637669668`；`git diff --check` 通过。
- 代码提交 `09d5c24`，22:38 通过服务 helper 仅重启 Signal，PID `99844`。Host 保持原进程并重新上线。生产 build 与隔离构建一致，正式域名获取的 desktop bundle 字节与本地产物一致；tunnel PID/启动时间及缺失的 safe URL 文件均未变化。
- 正式域名 TURN 被动连续会话：120 秒、121 次采样、无缺失/失败、无身份或路径切换，最大观测无新帧时间 933.4ms；启动点击到首帧约 3,667ms。仅为 passive continuity，不含业务输入/可见效果。
- 同一旧加载版本的 30 分钟 TURN passive 长会话已 **PASS**：1,800.215 秒、1,801 次采样，missing/failed/identity change/path change 均为 0，最大观测无新帧时间 1,266.6ms。来源仍为 `09d5c24` / buildId `544814d637669668`，不能归入后续日志补丁的加载验收；cleanup 为 `api-finished-exit-unknown`，未证明所属进程最终退出。真实业务输入及输入后目标应用可见效果 **NOT RUN**。
- 第一次短断线验收：300 秒连续基线 301 样本无缺失；一次 native direct-close 后 5.024 秒完成 within-grace rebind，稳定 20.571 秒，随后 `host-observation-unavailable`，浏览器 close 超时。该次为 **INCOMPLETE**，不能记完整通过；同时间 Host 仍在线且无 Host disconnect 事件，不能把观察不可用等同 Host 掉线。后续独立重测与观察器复核结果见下方。
- 第二次：300 秒基线仍有 301 样本且无缺失；原 lease rebind 后出现释放/重新获取，最终 Viewer 为 socket connected、PC connected、media active、inputAllowed=true，但已不再是原 lease，严格恢复判定为 **INCOMPLETE / recovery-deadline**。Host 观察完整、无 disconnect，浏览器清理完成。不能因为最后可控制就把原租约恢复验收改为通过。
- 公网接口差异已复现：默认 `Python-urllib/3.11` User-Agent 收到 Cloudflare HTTP 403/1010；相同请求换浏览器 User-Agent 或 curl 默认均 200。项目 `WRD-Entry-Health/2.0` 探针亦 200。因此默认 urllib 的拒绝不能代表浏览器入口宕机；本轮没有修改入口规则。

## 新增原生栈证据

22:43:29 的 `/usr/bin/sample` 采样（请求 5 秒、10ms 间隔，各长期线程 420 个采样点）中，抓帧 worker 287/420（68.33%）处于 `CGDataProviderCopyData`，其中 286 个明确在 `CGSCaptureImageProviderBytePointer → mach_msg` 等待；另 12 个采样点在 `SLWindowListCreateImage` 分支。`bytearray` 内存复制 74/420（17.62%），该 worker 的 `take_gil` 25/420（5.95%）。main 从 select 恢复时 `take_gil` 71/420（16.90%），所有 main `take_gil` 分支共 92/420（21.90%）；main `kevent` 245/420（58.33%）也包含正常 I/O 等待。

这份栈与 MSS ctypes/CoreGraphics 实现吻合，直接支持系统抓屏数据/IPC 等待与进程内 GIL 竞争并存。采样比例不是单帧耗时分解、不是抓帧 p95，也不能证明它们分别导致了哪次 ACK 超时。原始采样留在本机临时目录，不纳入版本管理；仓库只保留脱敏比例和覆盖窗口。进程隔离 A/B 应分别验证 GIL 干扰、bytearray 复制和 native IPC 等待，不能把进程隔离当作 WindowServer 加速保证。

两段 Host 性能见 `evidence/2026-10-24-continuing-disconnect/postfix-host-performance.json`。下表按各自 track 的实际 runtime 采样窗口统计，未跨 track 累加 CPU；100% CPU 表示一个逻辑核。RSS 为窗口末次当前值，未使用进程历史 peak，也不把启动时异步缓存的 RSS 当稳态基线。

| 资源窗口 | Runtime 覆盖 / 样本数 | 进程 CPU 差分 / 覆盖时间 | 平均单核 CPU | 末次 RSS | Rolling 新截图完成率首→末 |
| --- | --- | --- | --- | --- | --- |
| 第一段 track | 22:39:19.685–22:41:23.698 / 24 | 94.922s / 124.013s | 76.54% | 341.0MiB | 15.77→7.37Hz |
| 第二段 track | 22:42:13.681–22:47:34.818 / 59 | 222.645s / 321.137s | 69.33% | 366.4MiB | 17.14→1.93Hz |

这些是约5–6秒一次的 runtime 快照，两个连接段的末尾分别还有约5.8/5.2秒未被 runtime 快照覆盖，没有插值补齐。第二段失败附近抓帧 wall 366–820ms，其中 nonCPU 334–782ms；转换/编码五秒窗口加权均值分别 24.66/50.06ms，末60秒 event-loop P95=172.43ms。可靠/无序输入队列无积压或新增丢弃。抓帧和转换/编码都存在退化，不能只修其中一个指标就宣布完成。

22:55:36 整机单点：12 逻辑核、load 301.57/195.93/126.61、158 个运行态进程、CPU idle 15.53%、压缩内存约 8,966MiB；22:57:16 运行态进程回落到 19。load 不是 CPU 百分比，压缩内存也不证明该秒正在换页；这些说明压力具有明显波动，不能把不同时间的 capture 数值直接比较成受控 A/B。未调整或停止其他项目任务。

初次加载后的该次生产 runtime receipt 为 reportCount=0，reported/retained/redacted/trace 计数均为 null；summary gap=0、ring drop=1（诊断/心跳环保留）。这份运行证据证明缺测被正确暴露，不能证明已经收到新版本诊断报告或真实输入效果；不能将该次旧采样的计数延伸为后续加载后的当前状态。

独立原生接口探测（23:08，开始时无 Viewer）：权限 preflight=true；CGDisplayStream start/stop 均返回0，约6秒观测收到73个 complete 和1个 stopped 回调。IOSurface→CVPixelBuffer 元数据桥接成功，1152×720、BGRA、bytesPerRow=4608。首次回调距脚本 native 阶段起点约2,017ms，最大观测 callback 间隔165.843ms；该间隔不是逐帧抓取耗时。没有读取或保存像素，没有 resize/编码，没有接入生产。idle=0，静态恢复、像素读取/归属、重复生命周期、资源长期回收及同负载 A/B **NOT RUN**。该结果只解除接口/元数据桥接可行性的部分疑问，不证明 backend 性能提升。

## 重绑定后 reset ACK 的关联复核

第二次维护窗口中，22:55:54.632 Signal 已确认原 lease 重绑定，56.774/.776 转发双 Socket reset。Host 于57.294/.848 应用成功，57.409/.849 提交 ACK。Viewer 从 waiting 转 failed，Signal59.211 记录主动 released，59.818 复位进入FREE，之后重新 grant。失败前 socket/attempt/PC/media 均稳定；没有媒体 hard fallback 先行的证据。浏览器 observer 的1秒 lag采样最大仅16ms，不能泛称浏览器主线程阻塞3秒。Host 到 Signal 已确认是 established loopback 连接。

真实 Host Socket ACK方法→Signal注册handler→Viewer注册handler的离线7种对照中，正常新Socket及同对象换id均可recovered；刻意旧目标、错误序号、二次身份变更、ACK在browser处理延迟到3.1秒才分别失败。现场没有重现正常owner守卫误拒，故不修改身份门禁。浏览器packet观察在55.505至58.278之间无rx，覆盖Host ACK提交区间，支持端到端交付迟到；但没有具体ACK标签，不能断言哪条ACK在哪一层丢失或延迟。Host ACK enqueue不能代替Viewer接收。

## 验收探针诊断增强

`read_local_host_status()` 原来把连接、HTTP 头/body、关闭及期限错误都压成相同 ValueError。现保留原错误契约，另携带固定 stage/errorCategory 和 bounded elapsedMs，失败时只在该次验收私有输出目录写 `status-observation-failure.json`；不写异常原文、URL、身份或密码，不更改严格 summary/lifecycle schema。页面观察失败本身不能生成 status-reader 证据。750ms status、2s tick、1s final export 及 cleanup 时限不变；写入失败保留首失败且不能生成 PASS。主套 91/91 与取消/清理期限 focused 6/6 通过。旧两次验收没有该侧文件，无法回溯具体失败阶段。

## 后续日志补丁及系统性复核

- 真实reset barrier超时、发送失败、明确ACK拒绝此前没有DOM incident，可能完全不上报。本次在同recovery identity释放前进入既有前台/active/lease/15秒节流入口，以固定 `recovery-failed` 报告，具体原因保留在已脱敏状态/trace。同步采集throw和异步发送reject不影响恢复；日汇总保留固定原因。
- 独立review用真实双reset定时器发现，UI或builder读取keyboard snapshot会触发第二条超时重入，提前释放导致证据丢失。已用仅覆盖同cycle同步采集阶段的门闩修复，finally清理并执行一次既有恢复；真实定时器+builder的4项反例先红后绿，原3秒期限和身份门禁不变。
- 新 `signal_reset_ack_observed` 只关联已转发reset，32项/10秒；包含哈希、固定状态、目标/shape/租约与类型匹配布尔、是否转发、Signal本地request→Host ACK耗时。明确包括Host处理，不当作纯网络耗时或Viewer接收。首个匹配ACK消费记录，badshape也消费；后续同IDACK仍按原协议处理。日志sink异常不影响转发。
- 最终回归：Viewer全部1,517/1,517；Signal的test及所有websocket测试537/537，无跳过。扩展Signal目录时曾出现12项旧fixture失败，根因为该组隐含8秒grace/单次ACK与现行30秒/有界重试不一致；现显式固定该组短时钟，32项边界用例及全套通过，未修改生产默认值。
- 最终隔离构建 buildId `3fb4a1fd0774bdcc`；`git diff --check`通过。独立review未发现遗留必修。30分钟旧版本长测结束后，于23:54:27仅重启 Signal（PID `36168`）加载后续日志补丁 `4826` 与该 build，本地及公网 desktop bundle 字节一致；Host（PID `35629`）和 cloudflared（PID `6438`）的启动时间未变。第三次在baseline观察缺口停止、未进入故障注入，结果见跨日记录；不能把旧版本长测 PASS 作为新版本短断线恢复通过。

## 30分钟旧版本长会话的资源窗口

本轮 Host runtime 实际覆盖 **23:23:06.694–23:53:02.688**，共324个快照、1,795.994秒；同一 track，无 capture sequence 回退，所有快照为 PC connected / ICE completed。最后一次被动采样写入时间为23:53:04.073，Host runtime 末尾缺测1.386秒；清理及后续新会话日志已排除。脱敏摘要保存在本机 `/tmp/wrd-20261024-long-session-host-performance.json`，包含下述整段资源窗口和23:41:20–40的 quiet 原生采样对照窗口。运行来源始终为 `09d5c24` / buildId `544814d637669668`。

- RSS 去除一条缓存时间早于连接的样本后，当前值范围281.9–471.9MiB；首分钟后的基线323.7MiB，末值321.0MiB，差值−2.7MiB。中间有台阶上涨和回收，不支持持续单调增长。进程 CPU 差分618.437s / 1,795.994s，平均34.43%单核；去首分钟后为34.03%。可靠及无序输入队列的 pending/inflight 最大值、drop计数增量均为0。系统 swap 速率来自整机 `vm_stat`，不能归到 Host 单进程。
- 新截图采集完成增量16,749，按runtime窗口计算平均9.33Hz；rolling 60秒完成率范围7.30–12.36Hz，末值8.48Hz。输出五秒窗口均值19.56fps，但35,082个输出帧中18,631个复用前次截图，占53.11%；输出/解码进展不等于取得新截图，更不证明屏幕内容改变。转换与编码加权均值分别1.93/4.16ms。
- 周期抽取的末次抓帧 wall/threadCPU/nonCPU P50分别25.07/7.10/17.47ms；这些不是全部帧的延迟分布。会话内完整rolling窗口的 event-loop P95范围2.52–9.90ms，最后P95=4.81ms；没有把重叠窗口合并成全程P95。
- Host收到1,795条稳态Viewer stats，RTT P50/P95为54/161ms，浏览器dropped增量0，报告的freeze interval delta合计78。独立passive的1,800个相邻观察间隔均有解码和回调进展，最大回调间隔1,266.6ms；passive schema未采集freezeCount，不能在该来源填0。诊断ring覆盖旧事件是证据保留行为，不是媒体丢帧。

该结果只通过30分钟TURN被动连续性。真实业务键鼠输入、输入后目标应用可见效果、marker→paint及三小时连续性 **NOT RUN**；也不替代原lease短断线恢复验收。

## 低负载长会话的额外定位

23:41:23.774 起的5秒原生采样（请求间隔10ms）：抓帧worker共441个采样点，`time_sleep` 两个分支合计348/441（78.91%），其中原生 `nanosleep` 合计347/441（78.68%，主分支346、另一栈1）；sleep返回后恢复GIL仅1/441（0.23%）。图像providerCopy为55/441（12.47%），该worker所有 `take_gil` 分支合计3/441（0.68%）。main的 `kevent` 为371/441（84.13%），select返回后恢复GIL为18/441（4.08%），所有 `take_gil` 分支合计21/441（4.76%）。

23:41:20–40的4个rolling cadence快照中，grab均值24.85–24.95ms，pacing requested=24.70–24.80ms、actual=100.23–104.79ms、excess=75.54–79.99ms，新截图完成率7.68–7.96Hz；event-loop rolling P95=4.58–8.57ms，Host CPU差分33.51%单核，load=3.53–3.68。本quiet采样窗口的主要pacing等待落在原生sleep/唤醒路径，不支持GIL主导该窗口；不能外推为早期高压窗口的唯一原因。`pacingActual` 包住 `time.sleep()` 前后wall时间，尚不能分离timer到期、唤醒调度与Python恢复各自份额，也未确认App Nap。采样比例不是单帧耗时比例或P95；采样会扰动执行，该窗口单列且不是受控A/B。

独立短进程的20ms timer原语轮换每种90次，sleep/Event.wait/Mach deadline的excess p95分别9.376/10.040/9.084ms，没有复现Host约75–80ms超睡；另一独立进程原始→NSProcessInfo活动声明→恢复原始各80次，excess p95分别9.262/9.442/8.887ms，未有明显改善，token已结束。没有修改Host timer/QoS、全局电源策略或引入忙等。两份JSON均明确不是Host受控A/B。

23:49:22 `pmset -g therm`报告CPU_Scheduler_Limit=100、CPU_Available_CPUs=12、CPU_Speed_Limit=73，同时没有已记录thermal/performance warning。这是OS报告值，未测实际频率，也未隔离其因果贡献。后续性能方案须同时记录电源/调度上下文，不能以“CPU没跑满”推断没有系统限制。

## 尚未解决

抓帧 native 等待、全机 CPU/换页压力、实际 TURN 路径抖动与 marker→可见效果仍需独立测量。本次没有通过扩大 reset deadline 或关闭身份门禁来掩盖这些问题。

## 测试隔离事故与证据边界

本轮执行既有诊断回归时，`diagnostic.test.js` 未设置私有 `WRD_DIAG_DIR`，原测试中的递归清理作用到默认 `/tmp/wrd-diag`，删除了该目录的历史诊断文件。这是 agent 的执行造成的证据损失，不能解释为正常保留策略。已向用户披露。Host、Signal 文本及结构化运行日志仍在，服务没有因此停止；原 raw 和目录内日汇总没有恢复。

修复为模块导入前分配唯一临时根，所有写入/清理归属该根，清理前检查路径，退出恢复环境变量；默认目录测试只做纯路径断言。新增子进程 canary 验证继承的模拟生产目录及文件清单完全不变。三个诊断文件修复后安全回归 55/55 通过。

另查明既有 `terminal-bootstrap.test.js` 的两项 API 测试直接启动真实 `server.js` 主入口，触发 `startServerFromSource()` 提前构建并发布实际 `web-client/dist`，还因继承环境和加载 `.env` 将测试事件写入生产 structured log。14:18 的 retained build `64e7e974fab20d09` 及同窗口的测试 admin 授权事件属于测试污染，不能解释为独立生产会话或正式加载验收。已仅修改测试，以短子进程 fixture 调用公开 `startServer()`，通过 `runtime.close()` 与 `server.close()` 保留 SIGTERM 优雅退出；诊断目录、structured log 及 Terminal audit 路径全部指向唯一临时根。修复后仅运行该文件，3/3 PASS；执行前后生产 manifest 的 SHA-256 `3e5a63df64aebf9504c1983ea2315f975e3f348da533e5c484cfb058c031b70b`、mtime `1792852701505165257ns` 均不变，生产 structured log 文件清单、SHA、mtime 与大小快照也保持不变；临时日志内独立验证最终 entry window 和测试 admin 授权事件，没有再次调用旧主入口。

`evidence/2026-10-24-continuing-disconnect/control-recovery-findings.json` 仅保存删除前检查已提取的脱敏摘要，并明确标注原件丢失、无法重新回放；没有伪造或重建历史 raw。后续诊断需结合仍保留的 Host/Signal 日志和新版本产生的新样本，不能继续宣称旧 raw 可复核。

## 跨日第三轮基线及验收记时缺口

23:59开始的新build3fb4第三轮，00:00:01在故障注入前终止：有效continuity仅22.080秒/23样本，ordinaryRecovery=NOT RUN，Host观察host-observation-gap，清理API结束但最终诊断导出未完成。此时页面socket/PC connected、media active、inputAllowed=true，Host无disconnect，不能记产品断线或验收通过。

复核发现，脚本等待页面和本地HTTP观察两者完成后，才以当前时间记录Host观察；最后两行elapsed相差1533ms，而browserNow仅相差1004.8ms。750ms HTTP与2秒tick允许页面更慢，却被后置时间戳污染为Host采样gap。没有status-error sidecar与该路径一致，但现场额外约528ms具体位于页面返回、Python调度或记录尚不能唯一归因。已修复实际status完成时刻关联，94/94回归通过；保留1500ms连续性、750ms请求和2秒tick门槛，真实gap仍失败。原结果保留INCOMPLETE，不回改。

## 跨日调度候选实施

普通shell timer探针与生产Host上下文不相同：Host/Signal均launchd daemon3，线程priority/max20/20；shell及Interactive候选为31/63。独立LaunchAgent首轮20次和复测80次均显示默认timer长尾较大。80次20ms复测默认/Interactive excess p50=22.579/2.577ms、max=173.261/25.966ms，CPU约6.15/5.40ms；复测未保存精确p95，保留null及上界，不冒称分位数。5个临时label均已清理。

Host候选仅增加plist ProcessType=Interactive；修复先copy再cmp的加载缺口，预检失败保持旧配置/job，替换失败尝试恢复旧配置/job且保留非0结果。Signal维护helper通过私有plist参数数组配置Interactive，先唯一probe预检再停止旧Signal，注册/health失败回退旧submit并明确未应用Interactive。没有设置LegacyTimers、全局电源、nice、实时优先级或忙等。实际部署/业务收益仍待下方维护验收，不把独立timer收益当业务结论。

验收记时修复不会使慢page自动通过：Host使用status分支实际完成时刻；页面完成间隔超限仍为sampling-gap。已有失败时保留同owner/schema有效的final诊断，但首失败和Host不完整状态不清除。

跨日离线验证：验收observer 94/94（提交f295e29），Host helper 21/21，Signal helper 18/18，无skip；plist lint、bash语法及diff检查通过。Signal独立审查发现原候选仅以/usr/bin/true验证bootstrap，实际Node/入口无效会先停旧服务；已补实际文件可执行/可读检查及真实临时文件负例。新增状态机fixture没有执行真实launchctl；独立review另外发现既有runner用例默认写真实wrapper日志，见后续隔离修正。

后续独立review发现 `host-launchctl.test.js` 既有3个runner子进程未覆盖 `WRD_HOST_LAUNCH_LOG`，默认写/可能裁剪真实 `/tmp/wrd-host-launch.log`。新增事务mock本身隔离，但整文件回归仍会污染wrapper日志；这是本次执行旧测试造成的额外证据污染。Host运行日志back-debug与Signal运行日志不受这条路径影响，未通过测试重启生产job。将每次runner spawn的wrapper/runtime日志强制指向私有临时project，并补继承模拟生产日志canary；不拿真实生产文件做canary。

Host runner隔离已修正：统一runnerEnv末尾覆盖私有wrapper/runtime路径；使用大于1MiB的私有继承wrapper canary与runtime canary验证内容和mtime不变，新日志确实输出到独立路径。单文件最终22/22通过；独立helper事务审查无额外必修。Signal最终18/18，启动前真实路径校验已补齐；本次修改尚未加载时不宣称业务收益。
