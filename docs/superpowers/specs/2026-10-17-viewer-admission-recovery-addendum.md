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
- 默认 ticket TTL 为 30 秒（测试/嵌入选项上限 120 秒），最多 128 条（上限 256）；已消费 ticket 也保留到过期。容量满返回 429，不 LRU 淘汰有效去重记录。发放先后使用常数空间 high-water；仅最新尚未消费 ticket 可建立新准入代次，已消费 ticket 只能重试自己的当前代次。准入代次为随机标识，与已有 proof Viewer epoch、控制 lease epoch 分离；新的已接纳 socket 仍按原契约推进 proof Viewer epoch。
- 当前 owner 的认证主体、session、准入代次和是否旧版这一个固定大小记录不随 socket、grace、ticket TTL 或 map 清理消失。它只在后续显式接纳、proof 接纳或进程退出时替换/失效；自动恢复必须匹配该 owner 和已确认代次，不会获得新 ticket。重启后未知 resume 保守拒绝，用户可点击 Start/重新连接桌面。
- 旧版无意图握手仅在本 runtime 从未接纳过任何 Viewer 且 zero-Viewer 时首次兼容；有合法 session 的该旧版 owner 可以恢复自身。发生新显式/proof 接纳后不重新开放首次分支；新协议 owner 也不接受省略代次的旧版恢复。同 session 的显式新准入仍使旧代次失效。旧版无 session 无法证明恢复身份，后续需要刷新新版本后显式连接。
- proof 接纳保持原单次、realm/epoch、zero-Viewer 校验；成功后显式占据 admission high-water 并失效普通历史 owner/ticket，拒绝旧普通 resume。此后用户新的显式 Start 可顶替 proof。proof 页面（包括格式损坏但仍保留 proof 标记的页面）Start/重新连接均不请求普通 ticket，不提升为人工顶替。
- 客户端首次 `connected` 收到代次后同步替换 Socket.IO 的 `auth.viewerAdmission`，自动 manager 重连、socket 重建、pageshow、PC refresh 都只带该恢复身份；丢失 welcome 的握手可在 ticket TTL 内重试原代次。拒绝复用已有 superseded 停止/手动重新连接 UI，保留文本草稿。API 请求 5 秒有界，token/auth generation/请求序号防止迟到结果覆盖新认证状态。
- C5 不改变网络模式、媒体参数、业务输入 ACK 或 Host reset/rebind 门禁。ticket、认证信息和原始 session 不新增到日志/版本化证据中。
