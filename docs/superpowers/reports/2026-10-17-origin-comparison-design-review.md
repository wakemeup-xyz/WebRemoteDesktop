# 条件性本地源站对照：设计与静态 review

日期：2026-10-17。状态：DESIGN ONLY / NOT RUN。人工独立设备测试仍 pending；本报告不授权或安排自动执行。只读核对现有源码、私有 supervisor 与 fake 测试文本；未运行测试、网络请求、浏览器、Viewer 或服务操作，未修改生产代码、配置或 Git index。

## 目的与结论

后续若用户/主任务明确授权空闲窗口，可用同一现有 helper 分别访问固定 formal 与本机源站，保持 relay 模式及生产 Signal/Host 不变，观察首次信令断连和媒体进展。先考虑单次 300 秒本地诊断；不得把它提升为 10800 秒连续性资格，也不得在人工测试 pending 时启动。

最小实现只需修改私有 `/tmp/wrd-owned-turn-probe-private/supervisor.py` 的端点白名单和分类记录；复用 `scripts/passive_session_soak.py` 与 `scripts/passive_session_sampler.js`，不引入 browser wrapper、代理、实验服务或新框架。

精确白名单仅为：

| 输入 origin | 输出 originClass |
|---|---|
| `https://link.stockhub.wiki` | `formal` |
| `http://127.0.0.1:8080` | `loopback` |

不接受 localhost、IPv6、其他 127 地址、LAN 地址、其他端口、quick tunnel、URL userinfo、path/query/fragment、尾部斜杠或“等价”拼写。这里拒绝别名是为缩小执行边界，不是否认其他 loopback 地址的浏览器安全属性。不同 origin 不共享 sessionStorage/localStorage，每次用 helper 自己创建的新 Chromium context。

## 静态事实：本地入口与安全上下文

README 与 runbook 均列出上述两个固定入口；127.0.0.1:8080 指向已有生产 Signal，并非隔离的 Lab 服务。对本机源站发起 Viewer 也会使用同一桌面控制系统，不能在已有人工 Viewer 时并行运行。

Chromium 的安全上下文规则将 HTTP loopback 视为 potentially trustworthy；因此 `http://127.0.0.1:8080` 与普通 HTTP LAN 地址不能混同。此处是浏览器规则层面的预期，**本轮没有实际读取 window.isSecureContext**，现有 helper 也不记录该字段。HTTP loopback 没有 TLS，安全上下文不等于传输已加密。不得为测试添加忽略证书、关闭 Web Security 或强行信任不安全 origin 的浏览器参数。

认证使用正常登录 POST 和 browser sessionStorage token（`web-client/js/login.js:18`、`auth.js:15`），不是依赖 Secure cookie；loopback HTTP 不需要修改 cookie 标志。`RuntimeConfig.getApiBase/getSocketBase`（`web-client/js/runtime-config.js:8`）优先使用注入/存储覆盖，默认才是 window.location.origin。当前生产源码检索未见设置 __WRD_API_BASE__ 的代码；helper 新 context 只写 wrdNetworkMode=relay，不写 wrdApiBase。因而当前源码预期登录、API、信令都随入口同源。

必须保留以下观测限制：helper 的 originClass（`passive_session_soak.py:682`）只是按**传入** URL hostname 分类，不验证重定向后的页面、运行时 API base 或实际 Socket URL。它不是“实际已绕过 tunnel”的独立证明。不能在报告中把这个标签说成实测路由；若后续发现 base override、重定向或不同构建，停止对照归因，而非修改页面设置强迫通过。

Signal 的 Express CORS 检查（`signal-server/server.js:143`）还可能按配置拒绝带 Origin 的请求；配置是否允许 loopback 本轮未读运行环境、未请求验证。若将来本地登录/API 被配置拒绝，应记录入口/认证前置条件不成立，不修改 CORS、认证、代理配置或认定连续性产品故障。

## 登录、零 Viewer proof 与 Start：原样复用

现有 helper 的流程为：新 browser/context → 本 origin 登录页 → 填正常 Viewer 密码并点击登录 → viewer.html → 安装被动 observer → 等待 fresh/auth-verified core → 签发 proof → 一次正常 UI Start → 等媒体就绪 → 1Hz 被动采样 → bounded finally 清理自己 browser/worker。

证据位置与守卫：

- `scripts/passive_session_soak.py:113` 的 login_via_ui 使用登录 UI，不 mint JWT；密码只从既有 runtime-config/环境读取，不落证据。
- `:34` 的 PROOF_ADMISSION 在同一 auth token/generation 下先 GET /api/status，必须 HTTP200、viewerCount===0、hostOnline===true，再 POST /api/proof-admission。请求共享有界 8 秒预算和 16KiB 响应上限。
- `:168` 的 start_via_ui 必须 coreInstalled、authVerified、标记计数正确、Socket/PC/attempt/queuedStart 不存在；proof 后重读 fresh/current/actionable 状态，只点击一次 Start，不强制 force click。
- `signal-server/server.js:239` 的 proof 签发再次拒绝已有 Viewer。`websocket/runtime-context.js:65`、`:83` 在消费时验证 realm、epoch、一次性 token，并再次检查 Viewer occupancy。正常用户在 status 与连接之间到达时，proof 连接 fail closed；不是先到先占后再顶替用户。
- `web-client/js/webrtc.js:2610` 的 proof-bearing page 跳过普通 human admission ticket；`:2665` 的 socket auth 带 proofAdmission 时不带 viewerAdmission。Signal `websocket/signaling.js:1061` 在进入普通 admission/takeover 分支前拒绝无效 proof。

两次独立运行各自从新页面走一次服务器 proof，不复制另一 origin 的认证、profile 或 proof。一次运行断连后，不清除/补签/重放 proof，不降级普通 ticket，不为了采够 300 秒重连；保留原始失败/INCOMPLETE 与 cleanup 证据。人工 Viewer 若在 probe 已连接后到达，也不能被 probe 重连抢回。

仅正常 grant/reset 生命周期可发生；不点击远程画面，不发业务鼠标/键盘、剪贴板、Terminal 或 native 命令。结束仅清理本次创建且身份匹配的进程。仍不得重启 Signal/Host/tunnel。

## TURN 与信令路径：哪些保持相同

`webrtc.js:1459` 对本机 relay 只显示说明，没有降级动作；`enforceSupportedNetworkMode` 保留用户模式。`buildPeerConfig`（`:2949`）在 relay 下只装载 TURN server，并设置 iceTransportPolicy=relay。offer（`:5133`）携带 networkMode=relay 及 selectedTurnServerId；Host `host.py:427`、`:3513` 按该会话模式和节点装载 TURN。Host 的 aiortc 没有同名 iceTransportPolicy，但 Viewer 强制 relay，且运行证据必须确认实际 selected pair，不能仅凭请求参数判定。

Signal `lib/viewer-bootstrap.js:10` 的 TURN 配置来自同一服务配置与请求的节点选择，不按页面 hostname 分支。新 context 无 wrdTurnServerId 旧值，默认使用服务所选节点。formal 与 loopback 在同一运行版本/配置下有相同 TURN **选择策略**；不得把它写成两个 run 共享相同 allocation、candidate 或网络时刻。

现有 sampler（`:201`）可观察：selected pair 的 localType/remoteType、protocol/remoteProtocol、relayProtocol、run-local pathIdentity、candidate RTT、bytesReceived、framesDecoded/dropped、codec。ContinuitySummary（helper `:253`）要求已知 pair 且至少一侧 type=relay；变化会记 identityChangeObservations。`relay` 是 TURN WebRTC，不是 `tunnel` JPEG over Socket.IO；不得切成 tunnel 来做对照。

明确边界：

- pathIdentity 和 PC identity 只在单次运行内有效；attemptHash 也有每次独立盐。不能跨 run 比较标签字符串来证明“同一线路”。
- 现有证据不输出 TURN URL、节点 ID、fingerprint、凭据、IP、candidate 原文；因此不能证明两次使用同一物理 TURN 节点、分配或全部 hop。
- 若两次 observed candidate types、transport protocol 或 relayProtocol 不同，不能称为只变信令路径的严密对照。即使枚举相同，也只能说观测到的媒体路径类别一致。
- 本方案不为追求严格“同一 TURN 节点”扩展持久化字段、替换 TURN 配置或开启自检。需要这种证明时另行设计，当前保留 unknown。

formal 预期路径为浏览器 HTTPS/WSS→公网入口/边缘/tunnel→现有 Signal；loopback 预期为本机 HTTP/WS→现有 Signal。两者保留现有 WebSocket-first、polling fallback（`webrtc.js:2657`）；必须依据 lifecycle.coverage.transport 实际记录区分 websocket/polling/unknown。若协议不同，只能比较入口路径整体，不能只归因 tunnel。Host 自己既有信令连接不作改变，本地 Viewer 对照也没有移除 Host 侧可能存在的外部路径。

## 可解释与不可解释的结果

| 条件性结果 | 可以支持的结论 | 不能支持的结论 |
|---|---|---|
| formal 首次信令关闭，而同 build、相近窗口的 loopback 300 秒稳定；两侧都观测到 relay 媒体 | 故障在该 loopback 窗口未复现；Viewer 公网入口/信令路径值得继续定位 | 不能唯一归因 Cloudflare、ISP、TLS、代理；不能排除间歇性客户端/Signal/调度因素 |
| loopback 也出现同类首次关闭 | 该故障无需 Viewer 公网入口路径也可出现，优先结合浏览器、Signal、Host 同会话时序 | 不能直接排除公网因素在另一次事件中的作用，也不能凭同名 reason 判同根因 |
| 两边短测均稳定 | 两个有限窗口未复现 | 不能宣布修复、3 小时稳定或人工使用通过 |
| 认证/proof/CORS/媒体启动守卫失败 | 该对照前置条件未成立，保留阶段化失败 | 不能伪造连续性 PASS 或把 guard failure 当运行期掉线 |
| 两侧 build、配置、协议或媒体类别不一致 | 结果可单独记录，因果对照不充分 | 不能以两行 PASS/FAIL 做单变量结论 |

关闭 reason、code 和 wasClean 即使未来可用也只描述观察事实；unknown 不自动变为网络故障。先区分首次关闭与 helper 清理，结合最后 ping/pong/flush、浏览器 event-loop lag、visibility、PC/frame advancement、Signal 同会话日志及窗口对齐。没有业务输入，本次不能评价操作响应、可见效果或光学延迟。

## 最小私有 supervisor 修改（将来授权后）

1. 增加一个固定常量字典，将上述两条精确字符串映射到 formal/loopback。CLI choices 复用这个字典；保留默认 formal，任何本地对照调用都显式传 --origin。
2. 在 execute 的最前面也进行严格字典查找，拒绝任意不在白名单中的值；不要只靠 argparse，因为现有 fake 测试直接调用 execute。拒绝应先于 hash、PID、输出目录或 Popen 操作。无需通用 URL parser/规范化层。
3. 将此固定 originClass 加到 supervisor 自己的 preflight.json 和 supervisor.json。仍原样把唯一允许的 origin 传给 helper，worker argv 中 mode 固定 relay。不要将完整 URL、password、token、runtime-config 内容或 browser 对象写入摘要。
4. 保持已有 helper/sampler SHA pin、私有目录0700/文件0600、时间/大小/identity 上限、owned-process cleanup 不变。若另一个已授权任务更新 observer/schema，应审查并同时更新两个 pin；不临时忽略 source-hash-mismatch。
5. 不修改 helper 的原始 session 文件。后续阅读 summary.originClass 应与 supervisor 的固定类别一致；缺失/不匹配意味着不可比较，而不是重写 helper summary。

本轮不要求 expected-build 新接口：现有 helper 记录并要求 run 内 buildId 稳定，却**没有启动前 expected-build 参数守卫**。两次对照必须按记录确认相同批准的 build；不同版本只保留为独立结果。不能凭本地文件 hash 声称公网实际加载了相同 build，也不能把事后比对说成启动前防护。

300 秒仍使用 kind=turn-diagnostic、一次 frameAgeMs>2000 时尝试既有 Host sample；10800 秒仍为 turn-continuity、阈值 frameAgeMs>=5000。worker deadline 始终 duration+300。Host sample 是既有可触发诊断干预，保留 diagnosticPerturbed 及 sampleTriggered 状态；若将来授权只允许纯被动运行而不允许该 sample，当前 supervisor 不满足该范围，应停止并另行收敛，不能悄悄改变含义。

helper 的 threeHourContinuityMet 只有完整、严格 PASS 且 duration>=10800 才可为 true。即使 loopback 10800 PASS，也只是 loopback/TURN 资格，不能替代 formal 10800 或人工设备验收。短测不是缩短版认证。

## 最小 fake 测试设计（未执行）

沿用 `/tmp/wrd-owned-turn-probe-private/test_supervisor.py` 的 unittest/mock/现有 Fake，不新增测试框架：

- allowlist：两条精确字符串各自成功；别名、额外端口、路径/query/fragment/userinfo、尾斜杠、其他域名以及非字符串全部拒绝。拒绝时断言 digest、host_snapshot、mkdir、Popen 均未被调用。
- 两个允许端点 × 300/10800：mock Popen、时钟、PID registry 与日志快照，捕获 worker argv；断言 origin 原样、mode 永远 relay、duration 不变，preflight/final originClass 匹配，不写完整 URL或秘密 canary。
- 断言现有 duration kind、>2000/ >=5000 阈值、duration+300 deadline、触发只执行一次、失效 Host 不 sample、own-process cleanup 与 helper 文件内容原样保留。
- 使用 mismatch hash fixture 验证仍在 Popen 前拒绝；不新增 bypass 参数。
- 对缺失/不匹配 helper originClass、不同 build 或未知 path 的阅读案例，只允许“不可比较”，不改写 FAIL/INCOMPLETE 或提升资格。

注意既有测试文件中 `test_harmless_owned_child` 会真的启动子进程，因此不能为本轮只读/fake-only 范围直接运行整文件。将来若授权 fake 测试，只选择上述 mocked cases，防止误触真实 subprocess、browser 或 /usr/bin/sample。

## review 收敛

方案保持单一变量意图：只换 Viewer 的入口/信令 origin，保持 relay 请求、同一生产进程、helper、采样规则和安全 admission 语义。但真实协议、TURN allocation、顺序时间、浏览器状态及系统负载仍可能不同；证据不足时明确不可比较。人工测试仍 pending，当前操作状态始终 NOT RUN。本报告本身是唯一新写入文件，0600。
