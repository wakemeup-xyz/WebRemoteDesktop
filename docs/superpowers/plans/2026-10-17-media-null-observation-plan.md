# 媒体缺测数值修复 Implementation Plan

日期：2026-10-17。状态：实施前计划，继承 M1 已审查的 nullable 指标契约；真实执行和部署结果另记实施报告。目标是修复已确认的 `rttMs` / `jitterBufferMs` 缺测变0及其直接消费者，不新增RTP/capture测量，不调参数、阈值、模式、权限或恢复预算。

## Authority 与问题

上位约束是仓库已有总spec `docs/superpowers/specs/2026-10-17-reliability-latency-remediation-design.md:38`：“缺测使用 null/unavailable”；M1细则 `docs/superpowers/specs/2026-10-17-media-latency-design.md:71`：“只接受 typeof value==='number' && Number.isFinite(value) && value>=0。null、空串、undefined及无emitted frame均缺测。禁止Number(null)转换。”缺测诊断不得改变控制授权（总spec:69），不需要新多页spec。

原始 `webrtc-stats.js:77–78,107–116,142–143` 已能产生typed null，`LatencyMonitor`只接受有效非负number。后续却有多次转换：

- `webrtc.js:5759–5760` `Number(stats.rttMs || 0)` / buffer同式；5915–5916进入真实handleReceiverStats；5926–5927再上送viewer-stats。
- `notePaintStats`在1992把buffer缺测写成0；`diagnostic.js:415`又在traceSummary做同样转换。
- `LinkQualityController.observe`在210–211再转0；280–293把未知延迟当作低延迟，累计goodCount并可能sustained-good升级。NaN、Infinity、负数、数值字符串当前也可能被错误处理。
- Signal `signaling.js:1491–1509`在role/activeViewer/recoveryKey准入之后原样spread数据；Host `host.py:3713–3779`只把这两个字段写入VIEWER_STATS/WRD_VIEWER_SUMMARY，不用它们做解码恢复决策；缺字段当前默认0，恶意字符串会未经归一化写入日志。

本次只修上述两个nullable延迟标量。`canonicalMediaStats`对FPS/计数的legacy 0 fallback是另一个已有语义缺口，本brief不同时重做计数/解码恢复协议。有效FPS、计数和已有stall判定继续按原实现；本修复不得以缺测延迟屏蔽已测得的解码空窗或丢包。

## 数据规则与最小方案

JS边界统一使用 `typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null`，不先Number()。Python对应接受有限非负int/float但拒绝bool，其他返回None。`null/undefined/缺键/字符串(含"0"、空串)/bool/对象/NaN/±Infinity/负数`都unknown；number 0、0.1、725.1原样保留。

采用原字段 `number|null`，不另加schemaVersion、availability sidecar或输入envelope字段。JSON会保留null；undefined、NaN、Infinity在浏览器出站前就归为null。所有信令准入/身份覆盖顺序保持原样，未知值既不获得新准入，也不能借诊断推动控制授权。

取舍：只改UI不够（controller和Host仍错）；引入sidecar但仍发0会让旧消费者继续伪造测量；把整份样本遇到一个null就丢掉会损失真实stall/丢包。推荐沿现有两字段传播typed null，逐字段判断known，仅在证明需要完整观测的“持续良好”分支要求完整延迟观测。

## 精确生产文件边界

1. **web-client/js/webrtc.js**：在既有canonicalMediaStats或相邻局部方法添加严格可空延迟normalizer，不新建依赖/全局script。canonical结果显式携带归一化rttMs和jitterBufferMs。processStatsSnapshot取canonical字段，handleReceiverStats收到同样nullable值，viewer-stats上送同样nullable值，notePaintStats缓存nullable buffer；selectedCandidatePair默认rtt用null，已提供pair只归一化其rtt字段，不动candidate身份/地址/选择策略。UI用 `!== null` 判断可用，合法0必须显示“RTT 0 ms”/“缓冲 0 ms”；unknown明确“未测量”或既有“-”，有一个可用就显示该项。覆盖latencyDisplay、candidateDisplay附加RTT和5848/5870/5875的提示文案；禁止 `value || '-'`吞掉合法0。控制/媒体UI phase和输入gate不因两个字段缺测改变。console显示明确unknown，不打印非数原值。`LatencyMonitor.onMediaStats`可接收已经归一化的stats，保持其窗口/年龄规则不变。
2. **web-client/js/link-quality-controller.js**：observe直接调用也要严格归一化两字段（不能依赖只从WebRTC调用）。highRtt/veryHighRtt/highJitter必须先known再比较。sustained-good须两项known且低于原阈值；unknown不得累计goodCount、不得因NaN/负值被视为健康。unknown且没有其它已知bad信号时返回hold/不升级；goodCount清零以打断“连续良好”，不伪造healthy。已有FPS/decoded/loss等真实bad仍进入原阈值和恢复路径；已有known high RTT/jitter也不能被另一个unknown字段掩盖。若现有尾部分支可能在unknown时靠前次critical/degradedCount触发动作，加入hold边界/打断无证据连续计数，不能让unknown样本推进旧阈值。所有输入都是有效数值时行为、Quality Lock和各网络模式策略须与改前一致。
3. **web-client/js/diagnostic.js**：buildConnectionDiagnostic的traceSummary.jitterBufferMs使用严格nullable值，不重新Number。从notePaintStats来的0/正值保留；直接fixture喂非法值也归null。无需给traceSummary新增RTT字段；M1 LatencySnapshot已有candidateRttMs。
4. **signal-server/websocket/signaling.js**：viewer-stats在现有role/activeViewer/recoveryKey校验通过之后，仅将出站对象rttMs/jitterBufferMs归一化为number|null。把两个归一化字段放在spread data之后，recoveryKey和viewerId的权威覆盖保留。可复用/提取该文件1409附近已有严格duration小函数，避免泛化为telemetry schema重构。不要新增不同的legacy身份回退。
5. **python-host/host.py**：on_viewer_stats对两字段做严格有限非负处理，缺键不补0；两个日志输出使用nullable本地值，unknown写固定`null`或`unavailable`，不写原始异常值。numeric0/正值沿用已有单位格式。不更改fps/received/decoded解析、_has_exact_recovery_identity、_stall_sample_count或_observe_decoder_stall顺序。typed null不会触发float(None)错误，因为当前两字段仅%s日志消费；不要为了统一数值格式对nullable值强行float。

无需改 `webrtc-stats.js` 的两字段公式、LatencyMonitor、输入协议、capture/encoder/sender。Signal diagnostic redactor `signal-server/lib/diagnostic.js:8,81–85` 已严格判断，未知optional traceSummary字段会被省略；这是现有“unavailable”的兼容表示，可保留。M1 `latency.metrics`的last/p95等仍显式null，不应为了traceSummary强制扩展schema。给redactor增加测试证明unknown省略、真实0保留即可，无需生产改动。

## 兼容关系

- 新Viewer→现有Signal：null可被spread转发；旧Host `%s`对None可格式化，不参与两个延迟字段的恢复判断，所以不存在要求降级回0的协议障碍。
- 旧Viewer→新Signal/Host：合法0仍接受；旧Viewer已经伪造出来的0无法与真实0区分，不能猜测反转成null。用户需刷新Viewer才获得完整缺测修复。
- 新Viewer→新Signal/Host：两字段端到端number|null。JSON中不出现NaN/Infinity；未知不通过数值默认变0。
- Diagnostic v3 optional traceSummary：unknown在客户端为null、redactor后可缺键；使用方必须按缺键/nullable unavailable消费。稳定M1快照schema不变。

## 实施步骤与真实行为测试

所有测试离线，不能启动抓屏/输入、Viewer、服务、tunnel；不能运行会重建生产dist的npm test/pretest。先补失败反例，再做上述小改动，串行复审当前主线程代码，保留本轮已有工作。

1. **webrtc.test.js**：复用loadWebRTC实际fixture及6000附近出站测试，但不要stub掉handleReceiverStats。给真实controller、connected socket记录器和DOM，直接调用真实processStatsSnapshot。对每个字段输入unknown矩阵、0、正值，检查DOM文本/title、_lastPaintStats、controller收到/实际行为和viewer-stats payload；不只测normalizer。混合RTT已知/buffer未知、RTT未知/buffer0也要断言；selectedCandidatePair默认RTT不造0。使用完整有效FPS/计数/identity fixture，避免把其它缺测的既有语义误认为本次结论。
2. **link-quality-controller.test.js**：调用真实observe，先建立接近升级阈值的profile/streak，再送unknown延迟，确认无upgrade、goodCount不推进；多份unknown不会ICE restart、keyframe、降档。独立验证合法0按真实低值、正值阈值照旧；known high一个字段+另一个unknown不屏蔽真实bad；decoded=0/received>0的原stall恢复在延迟unknown时仍按既有次数发生。对relay/strict-stun与Quality Lock现有分支复跑，禁止用mock恒等返回冒充控制器测试。
3. **diagnostic.test.js**：调用真实buildConnectionDiagnostic，检查unknown矩阵→traceSummary.buffer null，0/正值保留；M1窗口数据和计数不受影响。Signal `signal-server/test/diagnostic.test.js`调用实际redactor/ingest，断言unknown optional key省略、0保留，不断言必须新增字段。
4. **signal-server/websocket/signaling.test.js**：用现有makeIo/setupSignaling/current bound viewer（599–608附近完整身份）实际trigger viewer-stats，检查Host sent中的两个字段。含null、缺键、非数、NaN/Infinity、负值、0、正值；同样payload来自非viewer、inactive、旧attempt仍拒绝，不能只单测helper。只归一化字段，derived aliases与权威viewerId/recoveryKey保持原样。
5. **python-host/test_quality_lock.py**：object.__new__ fixture、ListHandler、asyncio.run真实on_viewer_stats。legacy与当前identity都覆盖；unknown矩阵（含bool）不抛错、不出现Error handling viewer stats，日志未知不会是0ms/非法原字符串；numeric0/正值准确记录。用有效received/decoded同序列配unknown延迟，与已测延迟对照，stall计数/decoder恢复结果一致；旧identity保持拒绝。需要时复用test_stall_decoder_refresh.py的真实入口断言，避免只测formatter。

建议定向命令（实施时按实际解释器和测试目录调整；本brief准备阶段未执行）：

```sh
node --test web-client/js/webrtc.test.js web-client/js/link-quality-controller.test.js web-client/js/diagnostic.test.js web-client/js/latency-monitor.test.js web-client/js/webrtc-stats.test.js
node --test signal-server/websocket/signaling.test.js signal-server/test/diagnostic.test.js
PYTHONPATH=python-host python3 -m pytest python-host/test_quality_lock.py python-host/test_stall_decoder_refresh.py -q
```

验收是行为证据：unknown端到端可区分真实0；unknown不创造连续良好/恢复动作；真实已测分支、身份准入和控制authority不回归。无需线上重启才能完成源码修复和离线验收，部署授权/真实媒体验收由主线程已有任务串行处理。此brief不把这项观测修复宣称为已解决TURN抖动。
