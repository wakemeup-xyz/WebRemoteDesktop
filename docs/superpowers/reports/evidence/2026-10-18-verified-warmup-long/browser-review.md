# 已结束 3 小时公网会话：独立浏览器证据审计

结论：**仅被动连续性 PASS**。逐行重算与原摘要全部吻合；业务输入、输入后的画面、真实可见效果和物理显示均未验收。原始结果未修改。

## 范围与方法

- 仅只读解析指定 `supervisor.json`、`summary.json`、`samples.jsonl`、`lifecycle.json` 和开始/结束元数据；流式读取原始 samples，未导出事件 ring、模板、opaque 会话/路径/attempt 标识、凭证。未进行网络、浏览器、进程采样、构建、测试或服务操作。
- 部署锚点由本次审计任务给定：source `53ed5d72e331b808245b7d650a6c4ff7b2969c85`；浏览器每行 build 均为 `79bf9a5afea0458e`。浏览器证据本身不独立证明源代码提交。
- 原 samples：37,284,140 bytes；SHA-256 `aa3a021bbcd15608d18b47ea5733f31f67b11c35cbcdde7ac1bf38274ae7b2a9`。分位数均采用 nearest-rank `sorted[ceil(p*n)-1]`。

## 连续性重算

- 共 10,801 行，全部 observed；tick 0–10,800，重复和缺号均 0。观察跨度 **10800.000087013 秒**；浏览器单调时钟跨度 10800000.700000048 ms。原 helper elapsed 10800.183899897 秒，SUP elapsed 10826.653034042 秒；三个边界分别记录。
- missing 0、超过 500 ms 的 late 0、失败条件次数/失败行数均 0、相对基线身份变化 0，组合身份唯一数 1。回调计数 12 → 208,025，无倒退，基线后确有进展。
- expected build、scopeStable、socket connected、PC connected、有效 relay 路径、inputAllowed、inputGate observed、blockedReasons 为空：每项均 **10,801 / 10,801**。八项 gate（allowed、inputActive、hasInputLease、viewportSupported、hasPaintedFrame、currentAttemptReady、hasActiveControl、socketConnected）每项及全部同时为 true 均 **10,801 / 10,801**。
- 最大已完成 rVFC 间隔 **766.58 ms**；观测 no-progress 最大值相同，低于原阈值 5,000 ms。1 Hz 回调年龄快照 n=10,801，P50/P95/max = **26.399999952 / 51.900000095 / 367.400000095 ms**。这不是物理显示延迟，也不能证明桌面内容新鲜。
- 采样迟到量快照 P50/P95/max = 0.485470984 / 2.123476006 / 61.997679994 ms；采样间距 n=10,800，P50/P95/max = 1.000002171 / 1.001716098 / 1.061040341 秒。

## 首次连接与耗时边界

- 原 startProof 为 verified、freshPage/coreInstalled/authVerified 均 true，startClickMarksBefore=0、After=1。结合现有 helper 的唯一正常 UI click 路径，仅确认本次记录的一次正常 Start；没有重放或重新生成 proof。
- 同页 browser performance.now marks：click→bootstrap-start **0.5 ms**，click→bootstrap-ready **4.4 ms**，click→signal-connected **3030.7 ms**，click→first-frame **6434.1 ms**，click→active **6434.2 ms**。
- 这些是一个页面的一次首次连接，不是全体用户启动 P95，也不是与上一版本的因果对照。

## 应用指标：末次滚动窗与快照分布分列

末次 last/P95 属于应用五秒滚动窗；下面快照分布来自 1 Hz 采样的有限 metric.last，可能重复或已陈旧，不能视为原始网络包、帧或全会话事件延迟分布。

| 指标 | 有效 last 快照数 | 末次滚动窗 last / P95 (ms) | 快照 last P50 / P95 / max (ms) |
|---|---:|---:|---:|
| candidateRttMs | 10,801 | 36 / 42 | 37 / 52 / 424 |
| jitterBufferMs | 10,799 | 8.1 / 10.1 | 7 / 10.9 / 121.4 |
| decodeMs | 10,799 | 0.6757 / 0.6757 | 0.636684211 / 0.817315789 / 0.999947368 |
| paintIntervalMs | 10,801 | 50 / 66.699999999 | 50 / 66.7 / 350 |

- 六项输入指标 `inputAckRttMs`、`inputToPostApplyFrameMs`、`inputToVisibleEffectMs`、`hostQueueMs`、`hostApplyMs`、`hostAdapterAwaitMs`：每项 available/usable/numericLast 观察数均 0，maxCount=0，末次 last/P95 和分布值保持 null；**NOT_RUN**。允许控制 gate 为 true 不能证明业务输入已执行或可见。
- `freshFrameAgeMs`、`encoderMs`、`relayFrameAckRttMs` 在浏览器采样指标中亦无可用样本。不能由 rVFC 年龄、paintInterval 或 candidate RTT 填补。

## 生命周期与清理

- lifecycle capture/write 为 ok，coverage **partial**、missingReferences=2、bindingChanges=3；只保留 128 个 ring 事件，丢弃 **30,815** 个。原 counters 中 socket disconnect、Manager close、Engine close、connect_error、reconnect_error 均 0；firstDisconnectEvent 不存在，归因为 unknown。只能作为该观察器的计数证据，不能当成完整事件历史。
- browser.close API 120 ms（closed），manager.stop API 25 ms（ok）；helper cleanup 为 `api-finished-exit-unknown`，ownedProcessExitEvidence 为 `not-observed`。API 返回不等同于完整子进程退出证明。
- SUP workerExitCode=0、deadline=false、intervention=false；Host 采样未触发。登记 7 个身份，7 个均记录退出，signals=0。
- **完整进程树退出仍 UNKNOWN**。原 coverage 原样保留：`observation-unavailable`、`polling-may-miss-fast-orphan`、`macos-check-to-signal-race`、`no-CDP-no-manager-proxy`；`completeProcessTreeExitEstablished=false`。不得删除该缺失或将本次操作分类改写为完整成功。

## 开始/结束边界

- 开始 UTC `2026-10-17T20:58:16.951824+00:00`，结束 UTC `2026-10-17T23:58:59.981203+00:00`，元数据单调跨度 10843.30615185 秒。
- 两端 health=true、Host online、Viewer=0、relayViewer=0；Signal PID 45287、Host PID 94398、build `79bf9a5afea0458e` 相同。Viewer epoch 1→2 是该测试连接生命周期记录，不能当成身份切换。边界快照不独立证明每一时刻服务健康。

## 验收结论

- **三小时被动连续性 PASS**，仅适用于该页面、该 build 和该 relay 路径。
- **真实业务输入、输入后画面、真实可见效果、物理显示 NOT_RUN**；原缺测保持 null，不能宣布全部远控验收完成。
- 保留 partial ring 与 SUP 观察缺失；未改写任何原始产物、未更改跟踪文件或 Git index。
