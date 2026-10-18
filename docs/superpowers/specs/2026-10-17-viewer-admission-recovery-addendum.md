# Viewer 准入与自动恢复补充设计

2026-10-17；总整改真实验收中追加。用户已授权持续修复直到远程服务可用，沿用 brainstorming + writing-plans，不重复询问规划方式。实施基线 adfcb48；本补充不扩大 tunnel、真实输入或其他应用操作权限。

## 问题与证据

独立审查用真实内存 Signal handler 复现两种事件序列：A 失联仍在 grace 时 B 成为 ACTIVE，随后 A 自动重连；A grace 到期后 B 成为 ACTIVE，随后 A 自动重连。当前实现均将 A 作为普通新 Viewer 准入，顶替 B 并触发 reset。若 A 在断网时漏收 superseded，客户端本地标记无法阻止此行为。当前日志中普通 Viewer 顶替测试会话、page-hidden 与租约到期只能说明干扰存在，不能证明来源设备、人工操作或同一旧 session。

## 方案比较与选择

- 仅关闭旧标签页：短期缓解，不能修复丢失 superseded 通知的自动恢复路径。
- 给自动重连增加 sticky manual=true：不能区分迟到恢复与新的用户动作，拒绝。
- 在服务端区分显式准入意图与当前会话恢复：采用。旧页可以恢复自己的当前会话，不能顶替后来接入的会话；用户主动 Start/重新连接桌面仍可顶替。

## 契约

1. 保留单桌面 Viewer 和控制租约/reset 屏障；本设计只决定谁能进入 Viewer map，不自行 grant 输入。
2. 只有实际 UI Start 或“重新连接桌面”动作产生新的显式准入意图。自动 Socket.IO 重连、PC refresh、恢复重试使用已确认的 session/准入代次，不生成新的显式意图。
3. 显式意图必须服务端可验证、短期、可去重，且绑定认证 Viewer 与 viewerSessionId；不能用永久布尔标记。建议复用认证 API 路径发放单次短期 ticket，服务端记录发放顺序，过期/已被更新代次取代的 ticket 不能重新顶替。
4. 判断在 supersede、noteHumanViewerAdmission 或其他 Viewer epoch/map 变更前完成。被拒绝的旧自动恢复不能打断现有媒体、控制或 proof；客户端停止该自动抢占链并展示现有重新连接入口。
5. 同一当前 session 在 grace 内仍走原 Host 确认 rebind；过 grace 后可在当前 owner 未变化时重新 grant。缺失或过期历史的自动 resume 遇到不同当前 session 时拒绝，不能因 TTL/LRU 淘汰而回落成新的手动准入。
6. 状态有明确 TTL、容量和当前 owner 保留规则；容量满采取有界拒绝，不误淘汰仍有效 ticket 的去重证据。重复 ticket 只能命中其原代次，不能重复推进代次。
7. 普通旧版客户端首次未知 session 的兼容行为须明确；已经被更新 session 取代的旧版 session 不能静默夺回。没有可信意图区分时保守拒绝冲突并提示刷新/重新连接，不让兼容分支绕过新规则。
8. proof admission 仍单次、严格 zero-Viewer，不修改为可重放，不允许自动化接管真实 Viewer。登录凭据、ticket、原始 session 标识不写日志或文档。
9. 不自动切网络模式、TURN、分辨率，不改业务 ACK、媒体暂停和旧异步权限隔离。

## 验证

真实 Signal handlers 覆盖 grace 内/外旧页恢复不能顶替 B、当前 A 合法恢复、显式 B 顶替 A、重复/迟到/过期 ticket、乱序握手、容量/TTL、旧版兼容、proof 和 Host 缺失/失败屏障。真实 Viewer 调用链覆盖 Start/手动重连生成意图一次，自动重连/refresh 不生成意图，拒绝后保留用户草稿并停止抢占循环。完成独立 review 后部署本地 Signal/Host；真实网页/媒体连续性与设备/可见效果仍分别记录，不因纯测试通过关闭。

## C5 实施选择与边界

- `POST /api/auth/viewer-admission` 只接受已验证 Viewer bearer token，绑定 JWT `sub` 和合法 `viewerSessionId`；HTTP 与 Socket.IO 由 `createServerApp` 注入同一个 runtime。此接口代表显式 UI 意图，不声称能从服务器证明物理点击。
- 默认 ticket TTL 为 30 秒（测试/嵌入选项上限 120 秒），最多 128 条（上限 256）；已消费 ticket 也保留到过期。容量满返回 429，不 LRU 淘汰有效去重记录。人工显式发放先后使用常数空间 high-water；仅匹配当前人工意图 fence 的尚未消费 ticket 可建立新准入代次，已消费 ticket 只能重试自己的当前代次。2026-10-18 的受限初始准入只捕获该 fence，不推进它，具体规则见下节。准入代次为随机标识，与已有 proof Viewer epoch、控制 lease epoch 分离；新的已接纳 socket 仍按原契约推进 proof Viewer epoch。
- 当前 owner 的认证主体、session、准入代次和是否旧版这一个固定大小记录不随 socket、grace、ticket TTL 或 map 清理消失。它只在后续显式接纳、proof 接纳或进程退出时替换/失效；自动恢复必须匹配该 owner 和已确认代次，不会获得新 ticket。重启后未知 resume 保守拒绝，用户可点击 Start/重新连接桌面。
- 旧版无意图握手仅在本 runtime 从未接纳过任何 Viewer 且 zero-Viewer 时首次兼容；有合法 session 的该旧版 owner 可以恢复自身。发生新显式/proof 接纳后不重新开放首次分支；新协议 owner 也不接受省略代次的旧版恢复。同 session 的显式新准入仍使旧代次失效。旧版无 session 无法证明恢复身份，后续需要刷新新版本后显式连接。
- proof 接纳保持原单次、realm/epoch、zero-Viewer 校验；成功后显式占据 admission high-water 并失效普通历史 owner/ticket，拒绝旧普通 resume。此后用户新的显式 Start 可顶替 proof。proof 页面（包括格式损坏但仍保留 proof 标记的页面）Start/重新连接均不请求普通 ticket，不提升为人工顶替。
- 客户端首次 `connected` 收到代次后同步替换 Socket.IO 的 `auth.viewerAdmission`，自动 manager 重连、socket 重建、pageshow、PC refresh 都只带该恢复身份；丢失 welcome 的握手可在 ticket TTL 内重试原代次。拒绝复用已有 superseded 停止/手动重新连接 UI，保留文本草稿。API 请求 5 秒有界，token/auth generation/请求序号防止迟到结果覆盖新认证状态。
- C5 不改变网络模式、媒体参数、业务输入 ACK 或 Host reset/rebind 门禁。ticket、认证信息和原始 session 不新增到日志/版本化证据中。

## 2026-10-18：受限普通初始准入与恢复验证

本增量沿用真实 ordinary owner/resume，不增加可恢复 proof、测试专用 owner 或第二份租约。完整契约见 [guarded ordinary 设计](2026-10-18-guarded-ordinary-recovery-design.md)、[执行计划](../plans/2026-10-18-guarded-ordinary-recovery-plan.md) 和 [源码回归记录](../reports/2026-10-18-guarded-ordinary-recovery-review.md)。本节记录源码合同；部署和运行验收另记。

- 同一认证接口接受可选自有 JSON 属性 `initialPolicy`。属性不存在时仍是人工显式 Start；存在时只允许精确字符串 `vacant-only-v1`，其余值返回 400。响应仍只有 `admission.ticket/expiresAt`，客户端 epoch、占用快照或握手 policy 不成为权限依据；proof-only runtime 仍拒绝普通发放。
- guarded 发放及首次消费均检查服务端同步快照：Viewer map（含 grace 保留项）为空、relay Viewer 为空、Host 在线、epoch 为有效安全整数；消费还必须匹配发放时 epoch、主体/session、TTL 和人工 high-water。初次验票到普通 epoch 推进及 map claim 间没有 await/I/O。拒绝不消费 ticket，不改变 owner/pristine/fence、Viewer/proof epoch/map、lease 或 Host 事件，也不借拒绝清理过期记录。
- 人工/旧版 owner 是固定大小的保留记录；即使 grace 和全部 ticket TTL 已过且 Viewer 数为零，也阻止 guarded 发放/首次消费（`human-owner-retained`）。未过期且未消费的任何人工 ticket（包括已旧于 high-water 的 ticket）阻止 guard（`human-intent-pending`）。后来的成功人工发放推进 fence，使旧 guard 永久失效，即使该人工 ticket 随后过期。不得清 owner、重启或消费 proof 以绕开人工优先。
- 容量/TTL 上限沿用上节。guard 不推进人工 fence，也不能驱逐其他有效记录；成功且有效的人工请求可在计算容量后撤销未消费 guard，再推进 fence/插入 ticket。若扣除这些 guard 后仍满，返回 429 且不修改记录/fence；无效人工请求不撤销 guard。有效已消费记录和人工 ticket 不被容量驱逐，去重证据保留至既有 TTL。
- 同一 owner 记录新增 `initialPolicy`（人工/旧版为 null）；已消费 guard 的 lost-welcome retry 仅匹配当前主体/session/代次，复用原代次而跳过已花掉的初始 vacancy/epoch 条件；之后按现有 welcome 转成 resume。未接纳的后续人工意图不撤销当前普通 owner 的既有恢复资格；一旦人工接纳，旧 guard resume/重试永久失效。proof 成功仍失效普通历史；guard 成功按原普通接纳规则失效 proof；单纯 guard 发放或被拒绝不失效 proof。
- Viewer 只从 URL 的单个精确 `wrdAdmission=vacant-only-v1` 读取选择。重复/空/未知值、guard 与任何 retained proof 标记组合均在请求前拒绝；响应后重新核对 selector、proof、auth generation、token、请求序号及 Start episode。失败不降级到无 policy 请求，自动重连不重发 ticket。实际 Start/手动重新连接仍复用现有调用链。
- 独立 runner 登录后导航同一认证页至受限 URL，核对全新 shell、认证、selector、零既有 Start/socket/PC/排队工作，再进行一次实际可操作 Start；只允许一次受限 API 请求。它不直接获取 ticket、调用产品恢复方法或写入代次/ACK。manifest 和当前 Signal 日志均有界且固定身份；Host/Signal 源码证据注明 `root-attested`，浏览器 build 单独比较。
- guard owner 的 grace 内恢复仍等当前 Host rebind ACK；grace 外仍等 reset applied/FREE 和新 lease grant，再满足当前新鲜媒体及现有输入门禁。被打断的 continuity 保留中断。运行顺序为独立 baseline300、within-grace（baseline300、恢复观察最多60秒、稳定30秒）、after-grace（相同观察加自身页面12秒阻断）、全新10800秒 continuity；每次完整清理后才进入下一次。人工到达或终止失败即停止，不自动重试或重新夺回。
- baseline/continuity 不安装路由；within-grace 在无路由新页面调用捕获的原生 constructor/prototype.close，范围为 `ordinary-functional-native-direct-close`。after-grace 从导航前使用受支持的 Playwright 页面路由和 public wrapper close，范围为 `ordinary-functional-playwright-routed-stimulus`；它不证明未插桩/native after-grace 或自然 WS1006 恢复。`nativeAfterGraceQualification` 固定 `NOT_RUN`。manager/browser API 清理完成仍标记 `api-finished-exit-unknown`，不证明整个进程树退出。
- 工具输出只保留有限字段、加盐身份 hash、固定错误码和必要摘要；缺测/日志轮转/Host 更换或断连/覆盖间隙不能变成 PASS。`businessInput`、`visibleEffect`、`physical` 保持 `NOT_RUN`，输入 ACK、Host 排队/应用、新帧/内容因果/物理效果缺测保持 null。本增量不改网络模式、codec、分辨率、grace、lease、ACK、媒体/输入 deadline 或不确定输入不重放规则。

Task6初次Node608项中584通过/24失败的历史记录保留；既有 `webrtc.test.js` VM 缺少 `URLSearchParams` 的F1现已由原Task2 owner在 `c10f0aa` 单行补齐真实平台global，经受影响WebRTC307/307及独立spec/quality复审通过。其余301项沿用初次通过结果，没有一次新的608项组合调用。Python160项和root隔离loopback API/proof8项通过；确切分次命令、日志和限制见[回归记录](../reports/2026-10-18-guarded-ordinary-recovery-review.md)。Task6独立审查、whole-increment review、purecollector实际连接及部署/运行恢复/新三小时验收仍待完成。历史longA中断、清理缺口、自然WS1006首跳UNKNOWN和全部输入/可见/物理NOT_RUN继续保留。
