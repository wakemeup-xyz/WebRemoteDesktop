# After-grace recovery：无租约 PeerConnection 的 attempt 归属修复

日期：2026-10-19。状态：最小修复已实施，候选 commit `cc833d82a2e0700135a92dc53fac7bfad0912dbf`，受影响测试 459/459 通过；独立 Task 1 review Approved，最终源码复核待完成。尚未部署或取得新的运行资格。

## 目标与证据边界

修复 Viewer 的一个明确可达生命周期缺陷：恢复期间创建的无租约 peer，在新控制租约推进 connection attempt 后仍携带旧 attempt 的回调 owner，导致有效的新连接拒绝自己的 connection/ontrack 回调。目标是让最终 attempt 的新 peer 正常接管媒体，同时保持旧回调、旧授权和旧帧不能打开输入。

工作区限定为 `/Users/macstudio1/.codex/worktrees/after-grace-recovery/WebRemoteDesktop`，分支 `codex/after-grace-recovery-remediation`，基线 `b032481707f08f35bb91683da1f3a6ac4c22fa24`。文档依据当前 checkout 源码、需求文档的「Viewer 启动性能与可恢复性」「Desktop Session State 验收边界」「C5 Viewer 准入与恢复补充」，以及只读源代码调查 `after-grace-recovery-source-assessment.md`（14922 bytes，SHA-256 `583b22c1286bd7fa65837da631358e12899d3d54f14891909fad6f2661688066`）。调查原件位于 `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-r5-terminal-proof-static-20261019-qdbxmtgi/`；由 root 单独归档必要的脱敏证据，不把临时目录当成长期唯一证据。

root 报告本轮全新 baseline PASS；within-grace 在 5.999977s 恢复并稳定 30.030s；after-grace 的 12s 故障后，服务端完成 lease epoch 8 reset/FREE，新授权为 epoch 9，PC2 解码增至 823，但独立视频回调约 44.5s 未推进且输入仍关闭。已失败序列关闭，不得继续或用新代码修补该序列的结果。上述统计与源代码缺陷一致，但尚无直接 callback-owner、track attachment、play 结果元数据，不能把此缺陷说成这次现场的唯一根因。

## 缺陷路径

`freezeControl('signal-disconnect')` 清除实际授权而保留 `_mediaControlLease` 关联。`refresh()` 推进 attempt，关闭旧 peer，然后在尚未重新获得授权时调用真实 `createPeerConnection()`；它把空租约保存为 `peer._wrdControlLease` 并绑定该 attempt 的 owner。此时 `createOffer()` 只请求控制。

新 grant 与保留的 `_mediaControlLease` 不同，`handleControlGrant()` 会推进 attempt。但是现有退休分支只接受 truthy 的不同 `peer._wrdControlLease`，所以无租约 peer 留下。后续 offer 使用新 attempt 和新 lease，旧 peer 回调却仍捕获旧 attempt/sequence。`ownsStartupOwner()` 正确拒绝这些回调，`ontrack` 因而不能设置 `video.srcObject` 或调用 `play()`，connection 回调不能启动当前 stats/rVFC。解码增长不等于 HTML video 已显示新流。

## 方案比较与决策

| 方案 | 行为 | 代价与风险 | 决策 |
|---|---|---|---|
| 新 attempt 退役无租约 peer | changed lease 将推进 attempt 时，既有无租约 peer 与携带不同租约的 peer 一样退役；最终 attempt 确立后沿现有 reconcile 创建新 peer | 增加一次必要的 peer 建立；复用现有关闭、offer fencing 和回调绑定路径，改动有界 | 采用 |
| 保留同一 peer 并完整移交 owner | 退休所有旧 producer，为 peer/DC/watchdog/stats/rVFC/video hooks 创建新 owner，并定义已到达 track 的接管策略 | 较大重入/事件竞态面；必须移交所有 producer 和既有 deadline，不能仅重绑 ontrack 或修改旧 owner.sequence | 不采用 |

不增加通用 owner 框架，不修改 `ownsStartupOwner()` 放行条件，不用旧帧补齐新 attempt，不以直接设置 input active/painted 绕过恢复。

## 行为契约

1. `mediaLeaseChanged` 的定义仍来自旧媒体关联与新有效 grant 的 leaseId/leaseEpoch 比较。在它为真且已有 peer 没有 `_wrdControlLease` 时，必须先退役该 peer；已有不同 peer lease 的原退休行为保留。
2. 退休沿现有 `handleControlGrant()` 分支：取消 DC watchdog，解绑 peer 事件，清空当前 peer/DC 引用，推进 offer epoch、结束旧 offer in-flight 状态，清空 attempt 媒体 ready/paint 状态，停止 DC keepalive，再关闭旧 peer。先清空引用，确保同步 close 触发的旧 DC 回调也失去 ownership。
3. 写入新实际控制状态，按现有 `beginConnectionAttempt('control-identity-changed')` 推进 attempt，再由 `reconcileConfiguredControlMedia()` 创建 peer/offer。新 peer 的 `_peerCallbackOwner` 必须同时指向最终 peer、attempt 和 sequence；不在 attempt 推进前创建替代 peer。
4. 同 lease 的健康 peer 重复 grant、within-grace rebind 必须保持现有复用路径，不平白增加 peer/attempt，不清除已证明的同 attempt 画面。既有 stable 但未连接 peer 的合法重新 offer 行为不被本修复禁止。首个 grant（没有旧媒体关联）不因无租约 peer 被无条件重建。
5. 旧 connection/ontrack/ICE、DC open/close/message、watchdog、stats、rVFC、metadata/playing、fallback 与异步完成不得接管新 stream、打开新输入、重启旧计时器或污染当前 producer。旧 owner 记录保持不可变；不把旧记录的身份改成新 attempt。现有 play promise 只记录完成/失败，不获得新的控制或 paint 权限。
6. 新 connection 仅进入媒体等待；只有当前 attempt 的 fresh frame 和有效控制、在线 socket、媒体 applied/resume proof、键鼠 reset/ACK 门禁全部满足后，才可开放输入。pending startup 的剩余预算不重置；complete startup 的恢复不回到新的初次启动预算。

## 范围与固定约束

- 产品代码只修改 `web-client/js/webrtc.js`；真实源码 VM 回归只修改 `web-client/js/webrtc.test.js`，必要时同类回归落在现有 `web-client/js/input-signaling-continuity.test.js`。
- 保留 M1、ACK、lease/reset、媒体门禁及旧回调拒绝；不改 FPS、codec、quality、网络模式或恢复/准入权限。
- 不改 Host、Signal、tunnel、运行配置、验收 runner/sampler 或 protected checkout。
- 运行目录与 primary HEAD `b6bd0c11fd6055923768ac9f8d457995ac24cde0`、legacy HEAD `41c7b0998859a7e9d088cefcc0f3a1eeab190684` 及 R5 execution HEAD `b032481707f08f35bb91683da1f3a6ac4c22fa24` 分别保持原状，直到新修复受审并由 root 完成具体部署准备；保留已有 index/dirty 状态。
- 本修复默认不新增诊断；若独立 review 认定必要，只允许有界有限退休 reason、数值 generation、枚举 peer state，不记录 leaseId、token、原始输入或坐标，不做通用观测框架。
- `reset-unconfirmed` 覆盖过宽是独立 runner 诊断问题；不在本修复修改该标签、验收判据、原始失败记录或预算，不靠改标签取得 PASS。
- 普通完整序列、native/visible/physical 效果及三小时连续性未重新实测前保持 `NOT_RUN`/未取得资格；外部隔离资源问题尚未解决。

## 验证设计

Node VM 必须执行真实 `freezeControl`、`refresh`、`handleControlGrant`、`beginConnectionAttempt`、`createPeerConnection`、`bindPeerCallbacks`、`createOffer`、stats/rVFC 与 Input 门禁。只模拟浏览器/网络平台边界（PC、DOM、video、时钟、socket），不得用 stub 替换上述产品方法后宣称覆盖恢复链。

fixture 必须在同一 VM 加载真实 `media-activity-controller.js` 与 `media-activity-runtime.js`，通过 `initializeMediaActivity()` 建立并断言两个实例存在。generation 0 的正常初始 active 路径本来不要求 resume ACK；因此主恢复回归必须在基线用真实 `setMediaActivityReason('manual-pause', true/false)` 建立正 generation 的 active intent，经实际发出的 request 与匹配 `handleMediaActivityAck()`、真实 rVFC 完成恢复。changed grant 后再次验证当前 request 的 applied ACK 与当前 scope 的 fresh resume frame，不能利用 absent runtime 的默认放行获得 GREEN。覆盖 ACK→frame 与 frame→ACK 两序：前者 ACK 后仍关闭，后者 frame 后仍关闭；只有同一 request baseline 内两证据齐全才允许媒体 runtime active，旧 scope ACK/frame 不能补齐。键盘/鼠标 reset ACK 是另一个独立必测门禁，不被媒体 ACK/frame 替代。

最小回归矩阵：

| 场景 | 必须观测的结果 |
|---|---|
| 已完成 startup，freeze → real refresh 无租约 peer → changed grant | 旧 peer closed，新 peer 与最终 owner 一致；真实 track 接管 stream，play 调用，stats/rVFC 活跃；当前 fresh frame 后才可开放输入 |
| pending startup 同路径 | 同样重建，预算/episode 保留；不因换 peer 重置总硬预算 |
| grant 前 connected/ontrack，及 grant 后 connected/ontrack | 两种顺序都不留下 stale owner；grant 前旧 frame 不可成为新 attempt 证明 |
| 退休前排队的旧回调、play 完成与 fallback | 调用后新 peer、stream、gate、当前 sampler/frame producer 与 timer 不受污染 |
| 同 lease 重复 grant 和 within-grace 健康 peer | 复用同 peer/attempt，单一有效 producer；双 reset ACK 未满足时继续关闭输入 |
| 没有旧媒体关联的首 grant；已有不同租约 peer | 分别保留初次启动行为、保留既有退休行为 |

先在基线上证明具体 stale peer/owner 行为导致 RED，再实现最小条件扩展取得 GREEN，不能以错误 fixture、缺少平台方法或手工打开 gate 作为 RED/GREEN。现有 M1/媒体/控制相关离线回归需通过；测试日志明确 `offline-synthetic`，不替代真实播放或输入。

## 后续运行阶段

离线通过和独立 review 只是代码准入。root 另行准备受审的新组件 pin、新 manifest、构建/交付核对和原失败历史，才进入部署与完整新资格序列。不得复制携旧固定 pin 的 R4 包直接执行；不得继续已经失败的 after-grace 序列。

新序列保留原有 lsof 5s 上限、root decision/known-quiescence 60s freshness、60s 恢复截止、30s 恢复稳定窗、300s baseline、390s within-grace、390s after-grace、10800s continuity 预算及全部帧新鲜度、身份/覆盖/cleanup 门禁。按 baseline → within-grace → after-grace → continuity 顺序独立运行，每个场景仍须 root 独立决策和 fresh strict-idle；任一失败保存失败并关闭该序列。health、解码增长、离线测试或短时恢复不能替代这些资格。

## 自审记录与未决边界

2026-10-19 文档自审：已核对需求与源码；推荐方案覆盖无租约 peer 的明确路径；排除对 owner guard、性能档位、runner 判据和运维权限的修改；已区分静态可达缺陷与现场因果推断；已给出回归矩阵和独立运行阶段。未执行测试、build、服务或网络操作。

2026-10-19 独立设计/计划 review 的 Important 修订：原 fixture 装载描述允许缺少媒体 runtime，从而不能证明契约 6。现已将真实 controller/runtime 初始化、正 generation intent、匹配 applied ACK 与 fresh resume frame 两序及旧 scope 拒绝列为强制要求；此为文档修订，尚待 root 窄复审，不表示测试已运行或实现已批准。

无需用户补充信息即可实施这一有界修复。独立 reviewer 需裁决：最小退休条件能否覆盖实际 VM 的全部事件次序；现有 retirement 是否留下仍可生效的 producer；是否真的需要上述有限诊断。若发现更广的新缺陷，先报告并扩展受审设计，不借本任务重构生命周期或放宽验收。
