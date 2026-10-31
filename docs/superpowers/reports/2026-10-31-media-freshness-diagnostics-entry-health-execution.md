# Media freshness、诊断 receipt 与入口健康实施记录

日期：2026-10-31（Asia/Shanghai）

本轮先完成代码、离线回归和构建加载；Signal/Host 尚未重启，tunnel 未操作。当前已有一个 Viewer 占用槽位，真实维护窗口需在确认归属后执行。

## 已实现

- **媒体 freshness 门禁**：新增有界 Viewer freshness registry，观测 media activity、Viewer stats 和 control heartbeat。`page-hidden + suspended` 超过 `WRD_VIEWER_MEDIA_STALE_MS`（默认 120 秒，范围 30 秒至 1 小时）且无控制 heartbeat 时，按 `media_stalled → session_stale_detected → remove/disconnect → slot_released` 顺序处理；清理失败记录 `slot_release_failed`。清理复用现有 Viewer 身份检查、lease reset barrier 和幂等删除路径。
- **可用性状态**：`/api/status` 增加 `viewerFreshness`、`mediaFresh`、`mediaState`、`mediaStateAgeMs`、`pageVisibility` 和 `lastFrameAgeMs`。Viewer 槽位存在不再单独等价于媒体可用。
- **诊断 receipt**：统一 `empty`、`unknown`、`valid`、`truncated`、`failed`；保留有界 reported/retained/redacted/dropped 计数，并把 input trace 的 dropped events、hash drop、pending ACK eviction、expired ACK 和 timeout 计数写入日摘要/runtime evidence。
- **上传 receipt**：保留兼容的 `accepted`/`duplicate` 字段，并返回稳定的 `receipt.status`；持久化异常显式为 `write-failed`，未启用持久化为 `rejected`。
- **端到端关联**：runtime evidence 分别报告 ACK、Host apply、capture、encode、RTP、decode、present 阶段的 available 状态；scope 缺失时不标记 complete。frame trace 只保留 `PENDING/UNALIGNED`、pending/matched 与 dropped/stale/conflict 计数，不保存逐帧原值；重试和 localStorage replay 继续保留这些有界计数。
- **入口 watcher**：生产探测改为 `/index.html`、`/viewer.html` 和 manifest core asset；资产异常记为 `entry-degraded`，不授权 tunnel recovery。增加有界 loopback `/api/status` passive runtime probe；无数据保持 unknown，环境代理和资产失败不能触发 connector restart。

## 验证

- Signal freshness、signaling 和 runtime context：141 tests passed；独立 freshness：4 tests passed。
- Signal diagnostic、diagnostic-store、runtime-evidence：72 tests passed；frame trace correlation、receipt status 和 retry tests passed。
- Viewer diagnostic/runtime-diagnostic：63 tests passed；Viewer frame-trace/latency suite：286 tests passed。
- watcher/entry 定向 Python tests：17 route/runtime tests passed；watch shell fixture：26 tests passed。
- 前端生产 dist 已重新原子构建；本地和正式入口 manifest 均返回 buildId `006ff0c9024b1e27`，desktop asset 为 `assets/desktop-core.c131225e94ec4c33.js`。

## 维护窗口实测（进行中）

- 已按本地 runbook 重启 Signal/Host：Signal PID 31381、Host PID 31415；cloudflared PID 未变化，safe URL 文件保持为空，未执行 tunnel 操作。
- 重启后 `/api/status` 已加载 freshness 聚合字段，初始 Viewer 槽位为空，`mediaState=unknown`。
- 浏览器协议验收报告 `/tmp/wrd-acceptance/task9-final-report-2026-10-31T04-16-22Z.json`，SHA-256 `b16fb13485e4a149ab3ee501b3a5b847b904503a944f07e87059310ef55e0d4d`：媒体恢复 20/20，p50=212ms、p95=420ms、max=739ms；15 秒停流期间 frame/byte delta 均为0；键盘和鼠标浏览器协议输入通过；正式双 Viewer 项因单 Viewer admission 迁移语义记为 FAIL，旧控制器本地写 gate 已拒绝；物理键盘、光学 visible effect、formal entry/TryCloudflare 和 fault injection 按边界为 `NOT RUN/BLOCKED`。
- 三小时 passive continuity 已启动，输出目录 `/tmp/wrd-acceptance/soak-20261031T0417`，session handle 仍在运行。开始后约 173 秒已有 173 个采样、`missing=0`、`pcState=connected`、`mediaPhase=active`、约20 FPS、`framesDropped=0`；该会话不发送业务输入，不证明 visible effect/physical display。

## 尚未完成的真实验收

- 可用的短断线/媒体恢复、浏览器协议键鼠、首帧、FPS/丢帧证据已完成；三小时长会话仍在运行，最终状态未定。
- 物理键盘、光学 visible effect 和 reset fault injection 仍为 `NOT RUN`；当前 passive 会话不发送业务输入。
- `inputToVisibleEffectMs` 仍需真实 controlled marker/visible effect 证据；ACK 或 frame notice 不能替代该项。
- tunnel 未重启；历史 SIGTERM 最终发送者仍未完成因果闭环。

## 代码与文档提交

- freshness 门禁与状态：`80269ed`
- receipt 状态与 trace loss：`0115f6d`、`3460348`、`9418237`
- scope/frame correlation：`21a3b1c`、`c8002af`、`5a9f529`
- watcher 入口与 passive runtime：`5303252`
- 设计、计划和本实施记录：后续随维护窗口验收结果继续更新。

## 追补实施（2026-10-31 13:20 后）

- `4a3e92e` 为 watcher 增加 `watcherSchemaVersion=2` 与源码 fingerprint；随后按 runbook 重载 watcher。当前 PID 51489 已写入 fingerprint `33ddf5011fe34f827b8e9918`，实际页面、core asset 和 loopback passive runtime 均探测成功，Signal/Host 与 cloudflared PID 保持不变。
- `c983575` 将 Host/Signal 输入与 reset ACK 关联改为脱敏 `viewerHash`、`attemptHash`、`inputIdHash`、lease/generation 字段；高频 move/wheel 路径继续不读取 payload、不计算 hash。
- `c983575` 同时把 `summaryGapCount`、`ringDropCount`、`coverageStatus` 和 input trace loss 接入诊断接收、daily summary 与 runtime evidence。
- 本轮验证：watcher/runtime 19/19、entry probe 17/17、Signal signaling 131/131、diagnostic/runtime/store/reset ACK 107/107、Host observability/admission 46/46。Host rotating writer 首次并行运行时出现一次已有时序抖动，单测及完整 Python 定向集重跑通过。
- 三小时 passive 会话仍在运行，当前约 68 分钟、4090 个采样，connected/active、约 20 FPS、丢帧 0；无业务输入、visible effect 或物理显示证据。未重启 Signal/Host，未操作 tunnel。
- 长会话期间 `CAPTURE_STATS` 输出约 18–19.5 FPS，但每 5 秒复用缓存帧约 17–56 个；Host cadence 实际约 9–13 Hz，lifetime 抓帧 max 约 1296 ms、非 CPU约 1263 ms、线程 CPU约 33 ms。`c4a6888` 已增加 fresh capture/reuse 观测字段；Host 重载和 backend A/B 仍待维护窗口。

## 最终维护窗口结果（2026-10-31）

- 三小时 passive continuity：`PASS`，10800.5577 秒、10801 个采样、无 missing/late/failure/identity/path change，最大无进展 1133.3 ms；`visibleEffect`、`activeControl`、`physicalDisplay` 仍为 `NOT_RUN`。
- lifecycle 诊断覆盖为 `partial`，`missingReferences=1`、`droppedEvents=34459`；这是观察环丢失证据，不能被三小时 PASS 掩盖。
- supervisor 已只重启本地 Signal/Host，Signal PID `73182`、Host PID `73217`，cloudflared PID `26104` 保持不变；验收结束后 Viewer 槽位为空。
- 重启后的短 passive 会话已在 Host 生产日志中看到 freshness 字段：`reuseRatio` 约 0.14–0.26，`lastFreshCaptureAgeMs` 约 3–103 ms；窗口内抓帧 max 约 311 ms、非 CPU max 约 264 ms、线程 CPU max 约 47 ms、RSS 约 424–453 MiB。
- 同一短会话的诊断 admission 出现 `frame_timing` dropped 最高 113、`capture_stats` dropped 2，原因含 `congested`；这属于诊断覆盖缺口，尚未修复或转为统一告警。
- 自动协议验收：resume 20/20，p95=800 ms、max=800 ms；媒体停止、浏览器键鼠、tunnel 媒体恢复 p95=493 ms 通过；双 Viewer FAIL，物理键盘、OS reserved、reset fault injection 未运行，正式入口 BLOCKED。

最终状态：代码和离线测试已完成，三小时被动连续性及 freshness 生产字段已验证；真实输入到可见效果、物理显示、reset fault injection、receipt/loss 日汇总、诊断通道拥塞处理和 capture backend A/B 仍待完成。

受控手动诊断上报随后验证了生产 receipt 路径：当天 summary 新增一条 `logReceipt.state=valid`、`reported=46`、`retained=0`、`redacted=46`、`dropped=0` 的记录，`inputTraceEventCount=9`，input trace loss 全部为 0，frame trace 为 `PENDING`。这证明有效上报字段已落盘；非零 gap/ring-drop 仍只在长会话 lifecycle 和 Host admission 证据中可见。

`32cfc92` 的 Host 诊断降频优化已实测：无待关联输入时每 5 帧采样，输入关联帧仍逐帧保留。重载后 30 秒会话 `frame_timing` dropped 从此前 113 降到 9，`capture_stats` dropped 为 0；但同一窗口 fresh capture rate 约 4.9 Hz、缓存复用约 73%、抓帧最大 833 ms，后端抓帧长尾仍未解决。
