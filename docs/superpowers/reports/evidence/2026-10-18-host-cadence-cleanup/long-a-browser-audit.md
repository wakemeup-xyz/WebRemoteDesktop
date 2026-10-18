# Host cadence 长会话 A：失败浏览器证据独立审计

**本轮长会话未通过资格验收。** 原状态保留 `INCOMPLETE`，原故障 `sampling / runtime / session-changed-or-disconnected`；不能用此前的成功会话替代本次失败。浏览器最先记录到异常 WebSocket 关闭，随后信令断开、本地输入 gate 关闭；同期媒体仍继续出帧。上游网络、代理或服务端根因仅凭这些文件仍未知。

## 范围与重算

- 只读取 `host-cadence-long-20261018a` 的四项已完成产物及其开始/结束元数据。没有读取旧 3 小时记录、修改原产物或 tracked/index，也没有网络、浏览器、native、进程采样、测试、构建、npm、服务或 proof 操作。比较 opaque 身份仅在内存进行，输出只保留相等布尔和计数。
- 任务给定部署锚点 source `e5927c7`；37 个样本 build 均为 `79bf9a5afea0458e`。浏览器文件不独立证明源码提交。原 samples 126,778 bytes，SHA-256 `2e7230d970cedffba9396af7b5eda32a763a793b48715eb0dcc391856a17d0d5`。
- 共 **37 observed**，tick 0–36，无重复、缺号、missing 或超过 500ms 的 late；观察跨度 **36.00244484 秒**。helper elapsed **36.321748069 秒**，SUP elapsed **78.157652429 秒**，各有边界，不能互换。
- 独立重算失败条件 1 次、失败行 1 行、相对基线组合身份变化 1 次（组合身份共 2 个），与原摘要所有对应计数一致。
- rVFC 最大已完成间隔 **300ms**；回调年龄快照 n=37，nearest-rank P50/P95/max = **25.500000143 / 138.200000191 / 191.400000048 ms**。没有达到 5,000ms 媒体停顿阈值，Host 采样未触发。

## 首个断连与清理的时序

以下 t 均来自同一个浏览器 lifecycle observer 时钟，不混减 Python monotonic：

| 事件 | observer t (ms) | 记录 |
|---|---:|---|
| Engine close，首 terminal | 50,037 | 当前对象，`transport-close`，WebSocket **1006**、**wasClean=false** |
| Socket disconnect | 50,052 | 当前对象，`transport-close`，比首 terminal 晚 15ms |
| Manager close | 50,052 | 当前对象，`transport-close`，比首 terminal 晚 15ms |
| helper preclose | 50,112 | 比首 terminal 晚 **75ms** |

- 这证明本次**首先被记录的异常关闭早于后续 helper preclose**；不能将它归为该后续清理动作造成的首次断连。事件不是完整历史，不能由此排除所有未被记录的更早外部动作。
- code 1006 / wasClean=false 表示客户端观察到了异常关闭；它没有给出服务端关闭帧或上游具体故障点，不能直接归因 Cloudflare、物理断网、Signal 崩溃或 Host 变更。
- Python failureDetected monotonic **1459329795ms**、wall **1792306875585ms**（UTC `2026-10-18T07:01:15.585000+00:00`）。browser.close 从 **1459329900→1459330022ms**，在检测失败后 **105ms** 才开始，耗时 **122ms**、closed；manager.stop **1459330022→1459330048ms**，耗时 **26ms**、ok。跨时钟不直接相减。

## 最后好样本与首个坏样本

| 项目 | 最后好 tick 35 | 首坏 tick 36 |
|---|---:|---:|
| Python 观测 elapsed (s) | 35.000497204 | 36.002688902 |
| browser performance.now (ms) | 53882.600000143 | 54906.600000143 |
| socket/input allowed | true / true | false / false |
| PC / media | connected / active | connected / active |
| rVFC callbacks | 585 | 604 |
| decoded frames | 593 | 612 |
| frame age (ms) | 75.700000143 | 16.436000143 |
| bytes received | 741478 | 757083 |

- PC、attempt、generation、build 和完整 relay path 身份均未变化；仅 leaseEpoch 比较发生变化。不能把摘要的“1 identity change”误读为 PC 重建、媒体切路或新页面。全部 37 个样本 scopeStable=true、PC connected、media active、有效 relay path 和 expected build；manualDisconnect/superseded 均从未 true。
- 首坏样本 viewportSupported/hasPaintedFrame/currentAttemptReady 仍 true；allowed/inputActive/hasInputLease/hasActiveControl/socketConnected 已 false。前五项 true 各 36/37，前述三项画面条件各 37/37，八项同时 true 为 36/37。
- 首坏 uiPhase=disconnected、keyboardControllerState=INACTIVE，但 keyboardTransportState=ready、surfaceState=settled、recoveryState=idle、desktopWriteRecoveryState=none；draftUncertain 从 false→true。mouseResetPending/draftComposing/draftPending/manualDisconnect/superseded 均 false。原 blockedReasons 数量 3，未导出原模板。
- 失败后的 preclose snapshot 仍显示 PC connected、媒体 desired/runtime active、Auth verified、未 superseded；宽泛 controlState 仍为 ACTIVE，而细粒度 input gate 已不允许控制。两种字段边界不同，应以 gate 判断本次本地输入可用性；不能据 ACTIVE 声称控制正常。
- 最后好→首坏 rVFC +19、decoded +19、收到字节 +15,605，首坏帧龄约 16.436ms。证据支持“信令断开时本地控制失效，媒体仍在进展”，没有支持“先媒体卡住才触发本次失败”的记录；后续媒体长期状态未观测。

## 启动范围与输入缺测

- 现有 startProof：verified，freshPage/coreInstalled/authVerified=true，Start 标记 0→1；未复用或生成任何 proof。启动时 Auth verified、Host online、PC connected、socket connected，controlState ACTIVE、uiPhase connected、media desired active、未 superseded。启动 marks 在失败 snapshot 中保持相同，desiredGeneration 也未变。
- 单页首次连接 click→bootstrap **9.1ms**，click→signal **5217.8ms**，click→first frame/active **10410ms**。这是一次连接，不是总体 P95；本次 signal/首帧样本仍偏慢。
- 六项 `inputAckRttMs`、`inputToPostApplyFrameMs`、`inputToVisibleEffectMs`、`hostQueueMs`、`hostApplyMs`、`hostAdapterAwaitMs`：每项 available/usable/numericLast 都为 0，maxCount=0，last/P95=null。**业务输入、输入后画面、可见效果、物理显示 NOT_RUN**；没有发出业务输入，不得用 ready gate 或媒体回调替代。

## 事件覆盖、环境状态和退出边界

- lifecycle capture/write=ok，coverage=partial、missingReferences=3、bindingChanges=3、transport=websocket；保留 128 个 ring 事件、丢弃 **16** 个。首 terminal 投影和所列时序保留，但仍不是完整事件流。
- counters：Engine close/Socket disconnect/Manager close 各 1；connect_error/reconnect_error/reconnect_attempt/reconnect/reconnect_failed 各 0。最终 visibility=visible、online=true、focus=true；hide/show/freeze/resume 各 0。nav online 不能证明到远端服务的链路通畅。
- 观察器 lag 50 次、max=7ms、missedIntervals=0；仅为该观察窗口的事件循环统计，不能证明宿主机或外部网络无抖动。归因 cause 保持 unknown。
- SUP worker exit **1**，deadline=false、intervention=false；登记 7 个身份均记录 exited，signals=0。helper cleanup=`api-finished-exit-unknown`、ownedProcessExitEvidence=`not-observed`；**完整进程树退出 UNKNOWN**。
- 原 SUP coverage 原样保留：`observation-unavailable`、`polling-may-miss-fast-orphan`、`macos-check-to-signal-race`、`no-CDP-no-manager-proxy`，`completeProcessTreeExitEstablished=false`。退出证据不改写本次运行失败。
- 开始 UTC `2026-10-18T06:59:46.652132+00:00`，结束 UTC `2026-10-18T07:03:29.437530+00:00`；两端 health=true、Host online、Viewer/relayViewer=0，Signal PID 45287、Host PID 76982、build79 相同。边界健康及相同 PID 不证明中间每一时刻服务健康，也不独立证明进程 birth 身份。

## 可用诊断结论与未知项

1. 本次已确认发生真实异常信令关闭并导致本地控制 gate 中断，3 小时未完成。原 `INCOMPLETE` 与 failure 均保留，不能宣布服务已彻底验收。
2. 首个记录是当前 Engine WebSocket `1006 / wasClean=false / transport-close`，早于 helper preclose 75ms；PC/relay/媒体仍在进展。后续定位应围绕该失败时刻的信令链路和服务日志交叉核对。
3. 本文件无法区分代理、传输网络、远端/本地关闭及其他上游原因，也无法证明真实输入执行或端到端可见延迟。未在诊断前新开测试、重启服务或修改代码。
