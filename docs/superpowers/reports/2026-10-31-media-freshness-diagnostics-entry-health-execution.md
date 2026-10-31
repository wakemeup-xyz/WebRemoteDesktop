# Media freshness、诊断 receipt 与入口健康实施记录

日期：2026-10-31（Asia/Shanghai）

本轮先完成代码、离线回归和构建加载；Signal/Host 尚未重启，tunnel 未操作。当前已有一个 Viewer 占用槽位，真实维护窗口需在确认归属后执行。

## 已实现

- **媒体 freshness 门禁**：新增有界 Viewer freshness registry，观测 media activity、Viewer stats 和 control heartbeat。`page-hidden + suspended` 超过 `WRD_VIEWER_MEDIA_STALE_MS`（默认 120 秒，范围 30 秒至 1 小时）且无控制 heartbeat 时，按 `media_stalled → session_stale_detected → remove/disconnect → slot_released` 顺序处理；清理失败记录 `slot_release_failed`。清理复用现有 Viewer 身份检查、lease reset barrier 和幂等删除路径。
- **可用性状态**：`/api/status` 增加 `viewerFreshness`、`mediaFresh`、`mediaState`、`mediaStateAgeMs`、`pageVisibility` 和 `lastFrameAgeMs`。Viewer 槽位存在不再单独等价于媒体可用。
- **诊断 receipt**：统一 `empty`、`unknown`、`valid`、`truncated`、`failed`；保留有界 reported/retained/redacted/dropped 计数，并把 input trace 的 dropped events、hash drop、pending ACK eviction、expired ACK 和 timeout 计数写入日摘要/runtime evidence。
- **端到端关联**：runtime evidence 分别报告 ACK、Host apply、capture、encode、RTP、decode、present 阶段的 available 状态；scope 缺失时不标记 complete。frame trace 只保留 `PENDING/UNALIGNED`、pending/matched 与 dropped/stale/conflict 计数，不保存逐帧原值；重试和 localStorage replay 继续保留这些有界计数。
- **入口 watcher**：生产探测改为 `/index.html`、`/viewer.html` 和 manifest core asset；资产异常记为 `entry-degraded`，不授权 tunnel recovery。增加有界 loopback `/api/status` passive runtime probe；无数据保持 unknown，环境代理和资产失败不能触发 connector restart。

## 验证

- Signal freshness、signaling 和 runtime context：141 tests passed；独立 freshness：4 tests passed。
- Signal diagnostic、diagnostic-store、runtime-evidence：74 tests passed；frame trace correlation 和 receipt retry tests passed。
- Viewer diagnostic/runtime-diagnostic：63 tests passed；Viewer frame-trace/latency suite：286 tests passed。
- watcher/entry 定向 Python tests：17 route/runtime tests passed；watch shell fixture：26 tests passed。
- 前端生产 dist 已重新原子构建；本地和正式入口 manifest 均返回 buildId `006ff0c9024b1e27`，desktop asset 为 `assets/desktop-core.c131225e94ec4c33.js`。

## 尚未完成的真实验收

- 尚未在维护窗口重启本地 Signal/Host，因此当前运行进程仍未加载 freshness 后端代码。
- 尚未完成真实短断线、实际键鼠、首帧、可见效果、RSS/CPU/FPS/丢帧和 3 小时长会话。当前 Viewer 槽位未确认归属，不能强制中断它执行维护验收。
- `inputToVisibleEffectMs` 仍需真实 controlled marker/visible effect 证据；ACK 或 frame notice 不能替代该项。
- tunnel 未重启；历史 SIGTERM 最终发送者仍未完成因果闭环。

## 代码与文档提交

- freshness 门禁与状态：`80269ed`
- receipt 状态与 trace loss：`0115f6d`、`3460348`、`9418237`
- scope/frame correlation：`21a3b1c`、`c8002af`、`5a9f529`
- watcher 入口与 passive runtime：`5303252`
- 设计、计划和本实施记录：后续随维护窗口验收结果继续更新。
