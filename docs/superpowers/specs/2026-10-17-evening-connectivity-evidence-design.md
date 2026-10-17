# 连接反复失败：诊断回执与入口观测增量设计

日期：2026-10-17。基线：文档/工具6e45276；生产产品afd598a，Viewer build a6e8b15122bde656。继续使用brainstorming + writing-plans；用户已授权实施、维护验收和本地服务恢复。

## 问题与证据

本轮用户再次报告连接不上、控制输入中断。21:02冻结的日志前缀显示：Signal最近写入为15:19，实际进程仍写正确文件；15:55至21:03的Host窗口均无PC/ICE、输入计数为0。watcher15:55–21:02的287次离散探测均origin/formal成功，不能覆盖两次探测之间或用户设备的失败。连接前HTTP、namespace鉴权拒绝缺乏留存，故“没有已准入Viewer日志”不等于用户没尝试。旧三天数据的缺失和历史故障仍保留，不能用今晚空闲窗口覆盖。

已确认代码缺陷：Socket diagnostic emit后立即返回true，HTTP202也可能在receipt拒绝/错ID时返回true；手动UI据此宣称上传成功。早期Socket拒绝不回ACK。重放另走发送分支、可能用旧pending快照覆盖异步更新。确认修复这些问题能恢复证据可信度，但不是证明连接根因已消除。

同版本本地入口短对照：300.177秒、301样本、maxgap266.7ms通过；7个已登记测试进程自然退出。仅被动媒体连续性，主动输入/真实可见效果和三小时均未验收。公网独立对照进行中。

## 方案比较与决定

1. 仅增加原始请求日志：会收集敏感内容、无法解决上传误报，拒绝采用。
2. 延长心跳或重建tunnel：当前失败无唯一超时归因，且无tunnel操作授权，不实施。
3. 修复上传确认，并增加固定维度、固定周期的入口摘要：直接弥补已知证据缺口，采用。保留现有鉴权、网络模式、分辨率和控制协议。

## 诊断发送契约

维持sendConnectionDiagnostic的Promise<boolean>；true只代表同一非空diagnosticId的有效保存回执。receipt必须为对象、accepted严格true、ID完全相等、eventIdHashes为最多4个合法16–64位小写hex标识的数组；只确认本快照拥有的事件。服务端保存确认受既有保留策略约束，不代表永久保留raw。

一次调用只bound/prepare一次，不重新capture或drain。Socket与HTTP使用同一ID和内容。总预算8秒（单调时间）；已连接Socket使用Socket.IO自带timeout的2秒ACK上限，正确处理error-first回调。失败/拒绝/错回执/断开/超时后至多一次HTTP补投，预算仅为总截止剩余时间。Socket阶段截止后的晚ACK不再赢得本次结果，由Socket.IO清除回调；跨传输服务端去重保证补投安全。无Socket直接HTTP。每个ID合流一个in-flight Promise，最多10个在途；超过上限返回false，不新增运输请求。结束释放所有应用timer和在途记录，超过截止不得返回true。

HTTP复用fetchJsonWithin，增加可选maxResponseBytes；本调用4096字节。只对启用cap的调用以ReadableStream逐块计数，超限取消reader和abort；无reader拒绝，不回退无界json/text；其他调用默认保持行为。总截止覆盖headers、body、parse；invalid JSON、非2xx、202但receipt拒绝均false。旧队列上限10、每轮重放2及attempt cooldown保留。重放复用统一sender并从最新队列修改，不能以发送前副本覆盖新内容。

UI成功：“服务端已确认保存诊断（按保留策略清理）”；失败：“未获服务端保存确认，请稍后重试”。不声称localStorage一定写成功。自动上报不弹窗；webrtc静态“诊断日志已发送”改为不预先承诺成功的措辞。服务端role/inactive/malformed诊断返回现有negative receipt，不新增API。

## 入口观测契约

新增一个小的entry observer，HTTP middleware在CORS、JSON解析和auth之前，只比较固定method/path，不保存URL/query/headers/IP/body/token/socketId/raw error。固定类别：viewer_login（POST /api/auth/login、/api/auth/login/viewer），auth_verify（GET /api/auth/verify），viewer_admission（POST /api/auth/viewer-admission），diagnostics（POST /api/diagnostics），viewer_html（GET/HEAD /、/index.html、/viewer.html），viewer_bootstrap（GET /api/viewer-bootstrap）。其他路由、health/status轮询、Terminal和OPTIONS不计。

每类计started、completed、aborted、closedUnfinished、untracked、expiredUnfinished、stoppedInflight、当前inflight；完成状态只用固定1xx–5xx/other桶及401/403/429子计数；时长固定<=10/50/100/500/1000/5000/15000/>15000ms桶及count/sum/max/unknown。完成跨窗归入完成窗口，不能要求窗口内started=completed。finish/close/aborted只终结一次并移除自有listeners。最多256个tracker；满时只增untracked、标明completionCoverage=false。每60秒flush时释放已观察至少60秒仍未完成的tracker（实际60–120秒，event loop延迟另计）；不取消业务请求。单调时钟失效记unknown，不能伪造0。

Socket默认namespace只记录accepted/missing_auth/invalid_auth三个聚合计数；Engine.IO connection_error仅读取code，映射0..5/other，不能当作一定来自Viewer。入口观察不改变原始next、状态码、鉴权或连接行为；观察异常隔离。

每60秒写一个固定entry_window摘要，空闲窗口也写；只用固定字段，单条<16KiB，整数饱和999999999并标记clipped。无逐请求日志/序列化/磁盘写入。复用structuredLogger和recentEventStore，观测数据置于现有envelope的meta内；用真实logger序列化测试验证六类计数/覆盖/时长没有被redactor丢弃，event store采用相同envelope。不额外存窗口ring。用一个可unref的timer；listening启动，close/error/runtime.close停止并最终flush一次、清tracker/listener。timer延迟只发一个真实elapsed窗口并报告missedWindows，不补造空窗口。输出vantage=origin、覆盖起止、收集/写入失败计数；logger/store各自失败隔离。该观测只能证明请求是否到达当前origin的白名单入口，不能追溯DNS/TLS/CDN/客户端失败，也不能从零计数断言用户无尝试。结构化sink有现有轮转，stdout本身无轮转，必须如实记录这一限制。

## 验证与部署

只跑定向离线测试（不得用npm test触发live dist构建），独立task review及最终增量review后生成隔离build，冻结文件清单/hash，按既有安全apply保留主工作区HEAD/index/用户修改；只重启需要更新的本地Signal，Host无需因本增量重启。整个tunnel及watcher不动。服务启动后核对health/Host/Viewer并核对新entry_window覆盖；密码从本机配置读回报，不写文档。零Viewer一次性准入的媒体短测仍不代替普通重连、原生输入和长测。记录剩余根因未定，继续对照失败证据定位。
