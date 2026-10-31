# Media freshness、诊断 receipt 与入口健康设计

日期：2026-10-31（Asia/Shanghai）

本设计承接[日志与 Goal 审查](../reports/2026-10-31-observability-and-goal-review.md)，目标是把“Socket/PeerConnection 存在”与“会话确实可用”分开，并让断连、输入中断、媒体停滞和入口故障能被同一份有界证据解释。

## 设计目标

1. 为每个 Viewer 维护有界的媒体 freshness 状态，显式识别 `page-hidden` 后持续 suspended、无新帧或无解码的 stale 会话，并记录 `session_stale_detected`、`media_stalled`、`slot_released`。
2. 为诊断上传建立 receipt 状态：`empty`、`unknown`、`valid`、`truncated`、`failed`，同时汇总 summary gap、ring drop、input trace drop 和过期 ACK 观察。
3. 用脱敏 scope、attempt、lease epoch、capture sequence 和 frame correlation 把输入 ACK、Host apply、抓帧、编码、RTP 首包、Viewer decode 和 paint 关联起来；缺失阶段保持 unavailable。
4. 让 watcher 使用实际页面路由和 manifest 资产，passive runtime 只作为观察证据，入口 degraded 不得直接触发 tunnel recovery；只有 direct formal 连续失败才进入既有恢复预算。
5. 维护窗口验收必须分别记录短断线、实际输入、首帧、可见效果、RSS/CPU/FPS/丢帧和三小时连续性，离线测试不能替代真实证据。

## 约束与安全边界

- 不写入密码、token、原始输入、文本、坐标、SDP、候选或完整 socket/lease 原值；日志关联使用固定长度 hash 或受控 scope。
- stale 判定不能放宽 lease、attempt、sequence 或 reset barrier；清理必须经过身份检查并走现有 `removeDesktopViewer` / Lease fail-closed 路径。
- 只允许在明确的 stale 阈值、页面可见性证据和无新媒体/输入进展共同满足时发起清理；观测 sink 失败不能改变业务路径。
- 不因资产 404 或环境代理 passive unknown 重启 tunnel；保留 direct formal 的原有连续失败预算。
- 所有缓冲、ring、receipt 和 summary 都必须有容量、TTL 和 dropped 计数。

## 会话 freshness 状态

每个当前 Viewer 保存：

- `pageVisibility`: `visible`、`hidden` 或 `unknown`；
- `mediaState`: `active`、`suspended`、`stalled`、`unknown`；
- `lastMediaRequestAt`、`lastMediaAckAt`、`lastFrameAt`、`lastDecodeAt` 的有界年龄；
- `inputHeartbeatAt`、`socketHeartbeatAt` 和当前 attempt/generation 的脱敏 scope；
- `staleSince`, `staleReason`, `staleAction`，以及一次性事件计数。

`page-hidden` 本身不立即断开会话。它在超过有界 grace 且没有新的 active request、media ACK、frame/decode 或控制 heartbeat 时进入 `session_stale_detected`；持续无媒体进展进入 `media_stalled`。只有经过现有身份和 lease 清理路径才记录 `slot_released`。恢复到 visible/active 或新 attempt 时清除 stale episode，但保留闭合摘要。

`/api/status` 和 admin summary 公开 `viewerMediaFresh`、`mediaState`、`mediaStateAgeMs`、`lastFrameAgeMs`、`pageVisibility` 和 `staleCount`，不把 `viewerCount` 与 `hostOnline` 单独当作可用性结论。

## 诊断 receipt

Viewer 在构造报告时产生有界 receipt 元数据，Signal 接收端只保存脱敏字段：

```text
collectorState: not-started | empty | valid | truncated | failed | unknown
reportedLogCount: integer or null
retainedLogCount: integer or null
redactedLogCount: integer or null
summaryCursor: integer or null
summaryGapCount: integer or null
ringDropCount: integer or null
inputTraceDroppedEvents: integer or null
expiredPendingAcks: integer or null
receipt: accepted | rejected | duplicate | write-failed
```

`empty` 只表示收集器已启动且明确收集到 0 条；`unknown` 表示未启动、字段缺失或采集失败；`truncated` 必须同时保留 dropped 计数。日摘要必须从 raw runtime report 复制输入 trace 丢失和 ring drop 计数，不能只保留 `inputTraceEventCount=256`。receipt horizon 的 gap 必须出现在汇总，而不是只留在私有状态文件。

## 端到端帧关联

同一 scope 内允许保存有限数量的 frame binding：`captureSeq`、`encoderTimestamp`、`wireTimestamp`、`ssrc`、`captureFresh`、`captureAfterApplied` 和最多 64 个 input ID hash。成功完成的阶段按以下顺序产生事件：

```text
input sent
  -> Signal forwarded
  -> Host applied
  -> capture started/completed
  -> encode completed
  -> RTP first packet accepted
  -> Viewer decoded
  -> Viewer paint/visible effect
```

任何阶段缺失、scope 不同、帧复用或 ACK 迟到都不产生下一阶段的虚假延迟。ACK RTT、frame notice 和 visible effect 分别展示，不能互相替代。

## Watcher 入口判据

- 登录/Viewer HTML 探测使用实际入口 `/`、`/index.html`、`/viewer.html`，核心 JS 只接受当前 manifest 的相对资产路径。
- 资产失败产生 `entry-degraded` 和分层原因，不等价于 formal tunnel down。
- passive runtime 若无有效数据只记录 `unknown/unavailable`，不参与 restart authority。
- `entry-healthy` 需要 origin 与 direct formal 都明确成功；资产 degraded 在状态中可见，但不触发 tunnel recovery。
- 每个 decision 记录 `decisionId`、`restartActor`、`operationState`、probe mode、连续失败窗口和关联的应用健康快照。

## 验收

- 离线：Signal/Viewer/Host 单元和集成测试覆盖 stale、恢复、清理幂等、receipt 状态、gap/drop 汇总和 frame scope 校验。
- 维护窗口：短断线恢复、真实键鼠输入、首帧、可见效果、RSS/CPU/FPS/丢帧、reset ACK 和至少三小时长会话分别留证；缺测记录 `NOT RUN`。
- 只有所有上述证据齐全，且 `/api/status` 不再把 stale media 当作 healthy viewer，Goal 才能标记完成。
