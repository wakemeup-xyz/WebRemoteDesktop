# 信令握手无响应：有限回退与可归因诊断

2026-10-17。继续使用 brainstorming + writing-plans。用户已授权开发、维护与验收；不重复询问规划方式。生产代码3cafc64/build22d13d54ac6b458a，文档基线608cbdf；Signal15383、Host89291。服务保持运行，tunnel/watch不操作。

## 已知事实与不能推断的结论

23:00正式入口启动观察到一次connect_error（记录为unknown）、engine close与恢复；之后300秒被动画面通过。只有一次Host offer，不能把PC2等同两次Host协商失败。此次unknown尚不能归因timeout、认证或网络。

独立源码审计确认浏览器实际打包Socket.IO4.8.3的Manager握手超时直接发Error('timeout')后关闭Engine；它不经过Engine._onError，故tryAllTransports不触发polling回退。每次重试创建新的WS-first Engine，可能重复卡在无响应WS。现有测试只覆盖明确拒绝。Manager的5秒预算是Engine打开截止，不是完整namespace认证或整个恢复过程截止。

## 方案比较与选择

1. 只补日志：最小运行风险，但留下已证实的静默WS回退缺口。
2. 在同一次5秒内为WS和polling分配子预算：可限定总尝试时间，但需额外取消/计时状态，可能提前放弃合法慢WS，并增加重复准入竞态。
3. **采用：第一次仍WS-first；确认当前WS opening发生Manager timeout后，下一次既有重试改polling-first，每次Engine打开仍最多5秒。** 使用同一Socket/Manager既有重试，不创建第二socket，不调用私有_onError，不伪造错误。代价：初次超时+重试总耗时可能超过5秒，这已是既有恢复行为；不声称符合信令P95<=3秒或全流程<=5秒。轮询可增加HTTP开销；按现有库策略允许升级WS。不能承诺所有unknown失败都由此修复。
4. 一律polling-first：改动明确WS-first产品约定，本轮不采用。

## 绑定契约

### 回退策略

- 新的一次用户连接仍使用现有websocket,polling顺序和现有5秒budget。显式allowPolling=false始终仅websocket。
- 仅对当前socket/manager所属的connect_error，且精确错误分类timeout、当时transport=websocket、Engine state=opening、socket未连接、socket.active不为false、manager选项确实允许polling时选择后续polling-first。namespace认证失败、硬transport error、未知错误、已有open Engine、旧socket回调均不得改变策略。
- 真实超时callback时Manager已经closed，Engine仍opening，socket.active仍true；不得要求Manager opening或_reconnecting=false。同步为当前Manager.opts.transports赋新数组，供下一次open读取；不修改正在关闭的Engine，不另起连接，不抢占、复制或重放已消费准入票据。保持既有tryAllTransports/重连间隔/重试上限/SignalingRecovery行为；无新增重试循环或计时器。
- preference属于独立于media attempt的一次用户连接会话，在显式Start及成功reclaim创建新socket之前重置；手动disconnect、superseded清理。同会话自动peer刷新、同Manager重试、signaling socket重建、手动媒体模式/TURN切换均保留。不要在通用init、init({reuseSocket:true})、普通media attempt递增或信令成功时清理；Start可在bootstrap完成和复用socket的init之前已选择fallback。legacy直接init仅在无会话状态时惰性初始化。捕获并校验socket/Manager/独立session所属，避免旧socket在新Start边界污染偏好。每次builder仍先尊重allowPolling=false。
- 回退选择要幂等。任何选项读取异常或资格未知时跳过选择；诊断同步抛错或Promise rejection均须隔离，不能阻断既有恢复；旧回调不能污染新会话偏好。不得改媒体网络模式、TURN、画质、权限、输入ACK/reset策略。

### 固定最近错误摘要

当前socket的connect_error先采集脱敏不可变快照、记录回退选择，再沿现有Diagnostic.autoSendFailure('signal-connect-error')路径尝试保存，随后继续现有恢复。遵守既有共享cooldown、队列/重放、回执和认证HTTP预算；不绕过cooldown、不新建诊断Viewer Socket。即使被cooldown抑制，最近安全快照仍供后续手动/运行诊断读取。

保存在startup.signalingFailure，严格10字段：scope固定last-connect-error；failureClass为timeout/transport-error/auth-required/auth-invalid/unknown；transport为websocket/polling/unknown；engineState为opening/open/closing/closed/unknown；managerState为opening/open/closed/unknown；socketConnected、socketActive、fallbackSelected为bool或null；connectBudgetMs为0..30000有限数或null；ageMs为0..3600000有限非负数或null。精确消息仅在内存中作白名单匹配：timeout、Authentication required、Invalid token；TransportError类型对应transport-error；其他全部unknown。不得保存raw message/type/data/context、URL/ID/token/地址/SDP/输入。

scope明确它是本会话最近错误，不冒充当前连接状态；age从采集时单调时钟算，负值/非有限/缺失/超过3600000ms则null，不钳成误导上限、不拿墙钟补，也不因年龄超限删除本会话记录。fallbackSelected表示该错误的合资格选择（含幂等重复选择），不证明polling成功。显式Start、成功reclaim、主动断开、superseded清理；同会话媒体恢复可保留带年龄的最近错误。先构建的故障报告在清理后保持不变。

使用现有runtime-diagnostic.js共享纯白名单函数，接到实际core/full builder、localStorage投影及服务端redactStartup/持久化；保留watchdog和原schema3、128KiB上限；marks/resources沿各路径既有存储/裁剪政策保留，不扩大localStorage或超大报告回退所保留的数据。当前localStorage及超大startup回退只保留watchdog时，新增signalingFailure与它并列即可，不强行恢复marks/resources。摘要小于1KiB。无新增模块/assets/deps。允许固定reason signal-connect-error；无失败时不伪造一条失败。现有raw console警告改为安全类别是同一日志修复范围。

### 验证与生命周期

- TDD先复现实际浏览器分发版（socket.io/client-dist/socket.io.js）静默WS达到Manager timeout后下一次仍WS的缺口。不得只测试evaluateSignalingTransportPlan模型。采用VM虚拟WebSocket/XHR或等价无网络公开transport夹具；绝不能向生产端点创建测试socket。
- 验证修复后由既有Manager下一次重试进入polling；无同时活跃第二socket、不重复准入。验证每次原5秒budget未放宽、hard error仍按库正常回退、WS-only不变、已open/auth/unknown/旧回调不切换、重建继承/用户新会话清理、幂等选择。
- 实际core/full/cached/server persisted报告固定10字段和reason；getter异常/非有限数/未知字符串/大小界限/marks/watchdog保留；最近错误age和退休不污染新会话；诊断抛错/抑制不能打断恢复。
- 离线只运行有必要的定向Node测试，不跑npm pretest/livebuild/native imports；独立任务及最终review后controller隔离build、freshHostonline/Viewer0/relay0、Signal-only helper重启。Host89291和tunnel/watch身份保留；产物/健康/凭据核对。真实新错误快照若未出现，明确未观测，不主动向生产制造故障。

## 结束边界

记录修复缺口、运行真实类别和一次正式正常Start/被动连续性。若新的错误揭示其他根因继续定位；真实输入/光学效果和三小时不能由此替代。所有诊断/spec/plan/review结果纳入仓库；保留四份已有dirty文档和node_modules符号链接。

独立preflight核对后明确：实际timeout事件先Manager closed/Engine opening再关闭Engine；只改变下一open配置。VM提供虚拟WebSocket/XHR和确定性计时，无require/network暴露；检查旧Engine关闭后才打开下一个、无额外admission/auth变化，不放宽已消费proof重连限制。
