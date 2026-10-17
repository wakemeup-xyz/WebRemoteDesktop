# 启动期DataChannel看门狗阶段修正

2026-10-17。继续按brainstorming + writing-plans执行；维护、开发、本地加载已授权。当前生产db5d2b1/build067dfc41e8374b4e，原工作区HEAD/index/其他修改和tunnel/watch必须保留。

## 已复现的缺陷与范围

新300秒正式入口测试：22:09:25.165捕获dc-stuck，首个Host answer在22:09:25.547才发送。10秒DC计时从22:09:15.136左右的peer/channel创建开始，包含控制授权、信令建立和relay最多8秒ICE gathering。到期时new状态不享受原有connecting/checking延期，导致第二offer与Host旧媒体拆除。首轮是否最终能成功未知，但未完成answer即判定DC卡死是确定阶段错误。

新日志同时发现8.6663秒停帧、最长grab5938.428ms，以及无抓屏45分钟窗口中的15.647秒loop lag。本设计只解决过早中断初始协商与缺失阶段证据，不声称消除资源压力、所有停帧或真实输入故障。原生输入可见效果、普通恢复与三小时资格未完成。

## 方案比较

- 简单增大共享DC超时会混淆协商与通道故障，拒绝。
- 等ICE connected才创建唯一timer会使永不checking成功的路径无界，拒绝。
- 有界协商阶段 + answer成功后的既有DC阶段，采用。协商30秒从当前peer/channel创建计；answer成功安装后重新开始10秒通道等待，保留最多2次connecting/checking的10秒延期。已有连接上的DC重建立即开始通道阶段。权衡：真实协商失败最多等30秒，计时策略总预算最坏约60秒（浏览器挂起/调度延迟可能让回调更晚），不能误述仍是原10/30秒全链路界限；这不是正常启动性能目标。

## 生命周期与截止契约

1. 每次current input channel只持有一个watchdog record和一个timer，阶段negotiation/channel-open，绑定peer、input channel、socket、currentConnectionAttemptId/sequence；这些引用只存在内存，不进入诊断。不要用创建时offer epoch绑定整个watchdog：正常createOffer会推进epoch；epoch只在处理answer的await前后另行比较。没有通道或已open不启动等待。重建已connected或已有成功remoteDescription的peer时直接channel-open，不再等待新offer。
2. 创建新peer/channel后启动30000ms negotiation截止，覆盖控制/信令、createOffer/setLocalDescription、gathering、等待及安装answer；到期用固定reason negotiation-timeout，经现有scheduleReconnect，不使用dc-stuck或触发错误的DC重建。保留既有控制/权限门禁、重试/速率/Strict STUN策略，不自动抢控制、不改变网络模式。
3. answer handler在await前捕获peer/socket/attempt/offer epoch及watchdog record；setRemoteDescription成功后只有仍拥有全部身份且未过negotiation绝对截止才切channel-open。失败不启动DC阶段；stale continuation不能解除/启动新peer的timer。没有匹配watchdog时不额外创建一个无归属timer。远端answer原协议没有可证明的额外身份字段，不假称此改动解决所有旧answer报文混淆。
4. channel-open阶段10000ms后仍非open：PC connecting或ICE checking时最多延长2次，每次10000ms；否则/次数用尽调用现有noteDataChannelFault('dc-stuck')。每次延期有独立绝对单调截止；重入相同answer不得重置已在channel-open的预算。timer early callback只能等剩余时间，timer迟到不能让已过期answer赢得新预算。performance.now无效或倒退时计时值null；保留既有有限timer，不因未知时钟给answer新预算或无限rearm，原timer callback按其已排定阶段到期处理。补invalid-clock反例。
5. 在open、明确主动teardown、newpeer/rebuild替换、控制租约变化退休peer、refresh、disconnect、superseded/terminal shutdown、tunnel切换等已有清理位置同步释放。当前通道在PC new/connecting/checking阶段意外close时保留原有限watchdog，按原阶段截止恢复，不能取消唯一截止造成无界等待；PC connected意外close沿既有3秒恢复并释放阶段watchdog，3秒回调同样绑定peer/channel/socket/attempt，不得恢复下一条新通道。回调即使已排队也须owner+manual/superseded状态检查，不能影响下一次尝试。不得改变现有onmessage/输入可靠ACK/reset/视频质量/Host行为。onopen先于answer await恢复时不得重新开timer。
6. 到期前把phase/timedOut固定快照设好，再调用现有自动诊断/恢复；每个watchdog只能触发一次故障。利用现有诊断cooldown/coalescing，不新增重试循环或每帧/每输入日志。connected-peer DC重建路径也要捕获一次到期快照；scheduleReconnect再次autosend沿既有cooldown抑制，不再新建capture。

## 有界诊断字段

现有schema3服务端redactRuntimeDiagnostic主动丢network，故仅给collectNetworkSnapshot加字段无法持久化。使用startup.dataChannelWatchdog固定摘要，runtime builder中的getStartup与现有marks/resources合并，核心和延迟加载panel都使用同一builder。localStorage投影及服务端redactStartup均显式白名单，不能复制整个network或任意对象。

摘要固定14个字段：phase（negotiation/channel-open/inactive）、timedOut（bool）、elapsedMs、remainingMs、extensions（0..2）；pcState、iceState、signalingState、sctpState、inputState、moveState各只接受标准RTC枚举或null；socketConnected、localDescriptionSet、remoteDescriptionSet为bool或null。耗时有限非负，最多3600000ms，缺测null；elapsed是当前阶段年龄，remaining最多30000ms；计时可保留到故障抓取，不把先前最大值称当前。无原始ID、URL、地址、SDP、候选、错误字符串、输入正文、坐标或credential。摘要<1KiB；无watchdog仍可报告当前有限状态，phase=inactive/计时null。保持原schema3及128KiB总报告上限、同ID回执与重放语义。

纯白名单sanitizer必须放入既有runtime-diagnostic.js，采集/存储/服务端共享同一函数（服务端require），避免三个漂移的白名单；不要求新前端资产模块或额外运行依赖。采集使用安全getter，诊断失败不得改变连接状态。

## 必要验证

纯VM/fakeclock/fakeRTCPeerConnection，不接真实生产或原生输入。必须先写旧实现会失败的延迟answer案例：peer new超过10秒仍在30秒协商预算内不报dc-stuck，成功answer后新的10秒期限才开始。另测never-answer30秒正确分类、pending setRemoteDescription跨截止、ICE checking延期有界、已connected重建、open-before-answer、重复answer不延期、意外close于new/checking仍有界、connected-close旧3秒回调隔离、控制租约退休、替换/refresh/disconnect/tunnel/旧callback/staleawait隔离、最终只一次恢复。用实际核心+延迟panel builder、localStorage投影和服务端persist/receipt覆盖固定字段保留及隐私/上限；未知字段和secret-shaped hostile值必须丢弃。

逐项review及最终增量review后隔离build，按实际主工作区基线db5d2b1冻结apply；仅重启Signal加载新Viewer与诊断redactor，Host无需重启。再次核对fresh Hostonline、Viewer/relay0、资产与tunnel/watch身份。受控正常登录/Start复测分开记录startup dc-stuck、frame stall、cleanup，不将无dc-stuck等同整体稳定。保持服务在线。
