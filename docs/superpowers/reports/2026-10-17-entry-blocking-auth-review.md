# Signal 网页入口阻塞审查（只读，2026-10-17）
范围：reliability-latency 工作树；已读 AGENTS.md 与需求文档相关入口、认证、诊断约束。未启动服务、浏览器、网络或原生输入；未读取运行环境秘密，未修改源码/index。以下是源码可达性与离线微测，不能证明当前线上停顿归因。

## 高置信发现：每次 Viewer 登录在 Signal 主线程执行两次 cost 10 bcrypt
- 调用链：web-client/js/login.js submit → POST /api/auth/login（另有 /api/auth/login/viewer 别名）→ routes/auth.js:81 loginViewer → :88 verifyPassword → :58 bcrypt.hashSync(expected,10) → :59 bcrypt.compare(input,hash)。非空错误密码也触发完整工作；空密码400绕过。
- bcrypt.compare 的 Promise 不是线程池：当前 bcryptjs 2.4.3 dist/bcrypt.js:714 MAX_EXECUTION_TIME=100，:1210 next 在主线程循环约100ms才通过nextTick让出。把 hashSync 改成 await bcrypt.hash 只会分片，不消除CPU竞争。
- 单次正常登录可达，不需要攻击或异常数据。两个路由共享单IP20次/15分钟 limiter；没有Viewer全局并发/队列限制。浏览器单个控制器只允许一个pending，但多页面/多客户端/直接API可以并发；在有机器压力时这会延迟health、Socket.IO、ACK。不得声称一次登录必然造成数秒；已登录Viewer、Host token刷新、health本身不调用bcrypt，此问题不能独立解释没有登录事件时的持续Host停顿。
- 离线合成字符串微测（只运行bcrypt，无监听端口）：hashSync cost10=111ms；紧接异步compare wall=123ms；事先安排的0ms timer到233ms才执行。是单样本，非生产p95。
- 可复现：node加载本地signal-server/node_modules/bcryptjs与perf_hooks；先setTimeout(0)记录漂移，然后hashSync一个合成字符串(cost10)，接compare一个合成错误输入；只输出毫秒。扩展测并发登录需在隔离测试进程以路由fixture调用，不连接生产。

## 最小修复边界（不降cost、不装包）
- Node内置worker_threads固定一个长期worker，worker内部保留现有hashSync(expected,10)+compareSync(input,hash)语义；主线程只做既有route限流与有界任务投递。先保留双bcrypt工作，避免顺手改变密码语义（包含bcrypt 72字节截断与既有类型错误处理）。
- 更进一步可按router实例私有、完整配置值生成一次cost10 salted hash，再每请求worker compare；缓存仅hash/配置版本，不缓存输入密码或认证结果。配置变化必须明确失效；本生产router exact config是启动时快照，直接router用户getConfig仍动态loadConfig，不能共享进程全局缓存跨测试/实例。
- 池和队列必须硬上限；饱和返回临时503/429（前端现有server分支保留会话）；失败不得回退主线程bcrypt。请求断开丢弃等待结果，不签token。worker error/exit拒绝全部受影响任务，有限退避重建，关闭先拒绝队列并terminate，不能无限建worker或遗留worker导致测试不退出。对超时中的任务不能无限在后台积压。
- 可信度验证：合成正确/错误密码、cost10与长UTF8边界保持；限流两个别名共享；不同router配置隔离；饱和/worker崩溃/退出/重建/取消/关闭不漏Promise，不发token；在worker阻塞fixture下主线程timer仍推进。无需启动生产服务。

## 同步FS与health边界
- server.js:227 health仅生成JSON，无配置读取/同步FS；它仍受同一event loop上的认证与诊断阻塞影响。
- 静态web-assets.js的lstat/readFile/hash集中loadWebAssetManifest启动阶段，createWebAssetMiddleware:111返回express.static；每请求setHeaders只做路径与Set/cache header。startServerFromSource先await build再listen，构建FS不是已监听服务的常规请求路径。
- 生产认证getConfig exact分支仅复制config，JWT HS256同步计算是有界短任务；无每请求TURN文件读取。独立默认router getConfig会loadConfig→mergeTurnConfig→readTurnJsonDocument，同步exists/readFile；生产createServerApp传exact所以不应误报为线上每次认证读磁盘。
- 真正可达诊断链：server.js:386 POST /api/diagnostics与websocket/signaling.js:1494 → ingestDiagnosticPayload → diagnostic.js:669 enableDiagPersist分支 → persistDiagnosticOnce/createDiagnosticStore.write → diagnostic-store.js:30-33 原子write/fsync/rename/目录fsync，含summary、raw、receipt及cleanup扫描；全部主线程，无worker。只有持久化配置开启且有合法诊断触发才到磁盘，当前运行开关本审查未读取，不宣称已触发。
- 即使关闭持久化，admin connection-summary/connection-attempts仍调用loadRecentDiagnostics→store.recent→readRaw同步扫描；返回limit在扫描排序之后应用，不等于读取成本上限。
- observability/logger.js:34-40 每条启用文件sink的事件同步exists/stat/append，轮转同步rm/rename。logDir为空时sink no-op；运行是否启用未核查。业务事件可达但并非health自身操作。
- 最小FS修复边界：独立有界串行诊断worker保留现有durable receipt仅在所有fsync和ledger提交后确认；不要先回复persisted=true。保留锁、防符号链接、去重、覆盖缺口语义。日志可异步有界队列但必须暴露drop计数；不能无界缓存。与认证worker分离，避免fsync排队饿死登录。

## 限制
未检查当前运行请求计数、生产加载revision、event-loop观测与Host时间线，因此不能把这次离线233ms漂移作为生产多秒停顿证明。应对齐脱敏登录计数/诊断持久化计数与Signal event-loop delay；若Host停顿而Signal loop正常，继续调查Host/整机CPU调度。当前Signal业务源码没有worker_threads/new Worker生命周期；上面的worker问题是实施必需边界，非现有泄漏结论。

## 补充评估：以固定摘要恒时比较替换Viewer bcrypt
在现有密码以明文环境配置传入、hash每请求新建且不落盘的架构内，直接对actual与expected原始UTF8编码做SHA256，再crypto.timingSafeEqual比较固定32字节摘要，是合理的更小修复；复用routes/auth.js:12已有constantTimeSecretEqual可避免新worker/队列生命周期。它保留恒时比较基础，不依赖降低bcrypt cost，也不损失现有持久化密码hash的防离线破解收益（当前没有这种存储）。哈希输入时间随长度变化，但受200kb bodylimit约束；固定摘要比较恒时不代表整个HTTP请求恒时。
必须显式接受匹配语义收紧：bcryptjs只使用UTF8前72字节，超过该边界的配置密码和不同后缀输入可能被旧实现视为相同；完整SHA256比较将拒绝它们，这是消除截断碰撞的安全改进，不应写成零兼容变化。边界按字节，不是JS字符数；多字节Unicode可在字符内部达到72字节。新实现不应做Unicode NFC/NFKC、大小写折叠或trim用户输入；目前配置由ensureSecret做trim，用户输入保持String(input||'')行为。视觉相同的组合/分解字符仍按实际UTF8字节区分；精确相同字符串可登录。
输入空值前置400、错误密码统一401、现有配置必填启动检查、两个路由共享limiter、24h签token与sub、200kb bodylimit均应保留；缺配置时绝不能通过摘要空串兜底。保留现有非string真值转String语义或另行明确类型收紧。应加合成密码正确/错误、空值、Unicode组合差异、72字节相同前缀异后缀拒绝、两个别名/限流、HTTP错误响应一致性离线测试。需求文档“服务端使用bcrypt校验”必须同步为固定摘要恒时比较，解释明文配置契约。
该修复直接移除网页登录中主event-loop的约200ms CPU工作和并发放大；不能修复已经登录且无新登录请求期间的Host多秒stall，也不能证明生产stall归因。同步诊断FS和日志仍为独立风险。
