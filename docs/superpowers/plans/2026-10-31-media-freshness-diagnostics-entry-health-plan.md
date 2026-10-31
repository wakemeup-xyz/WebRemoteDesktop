# Media freshness、诊断 receipt 与入口健康执行计划

日期：2026-10-31（Asia/Shanghai）

设计依据：[Media freshness、诊断 receipt 与入口健康设计](../specs/2026-10-31-media-freshness-diagnostics-entry-health-design.md)。本计划使用 superpowers brainstorming + writing-plans 约定，保留当前服务和 tunnel 的运行边界。

## 阶段 1：会话 freshness 与 stale 门禁

- [x] 梳理当前 media activity、Viewer heartbeat、Host viewer stats、lease 和 removeDesktopViewer 的边界。
- [x] 增加 `pageVisibility`/media freshness 有界状态和 `session_stale_detected`、`media_stalled`、`slot_released` 事件。
- [x] 将 stale 清理接入现有身份检查、lease reset barrier 和幂等删除路径。
- [x] 将媒体 freshness 字段加入 `/api/status`/admin summary，并覆盖恢复、重复清理、旧 attempt 和 sink 失败测试。

## 阶段 2：诊断 receipt 与丢失汇总

- [x] 统一 `empty`、`unknown`、`valid`、`truncated`、`failed` 的生产语义。
- [x] 将 raw report 的 log、summary gap、ring drop、input trace drop、expired ACK 和 receipt 状态汇总到 daily/runtime evidence。
- [x] 把 receipt horizon gap 纳入可见 summary，确认容量、TTL 和 dropped 计数有界。
- [x] 增加接收端重复、拒绝、写入失败和缺字段测试，验证 metadata-only 不泄露输入内容。

## 阶段 3：端到端 correlation

- [x] 复核现有 input frame causality、latency monitor、RTP observer 和 Viewer stats 的字段边界。
- [x] 用脱敏 scope/frame binding 连接 input ACK、Host apply、capture、encode、RTP、decode 和 paint；缺测保持 null/unavailable。
- [x] 增加旧 scope、复用帧、迟到 ACK、发送失败和重复 notice 的负例测试。
- [x] 输出可按 attempt/stream scope 聚合的 5 秒和 60 秒摘要。

## 阶段 4：入口 watcher

- [x] 修正实际页面/manifest 探测路径并补 404/资产 degraded 测试。
- [x] 接入可验证的 passive runtime 数据源；无数据保持 unknown，不参与 tunnel recovery。
- [x] 让入口状态、Signal/Host lifecycle 和 watcher decision 使用统一脱敏 correlation。
- [x] 保持 direct formal 连续失败的既有预算，禁止环境代理/资产失败授权 tunnel restart。

## 阶段 5：验证、部署与维护窗口

- [x] 运行目标模块测试、静态隐私检查和私有前端构建；不执行默认发布式 pretest。
- [x] 在维护窗口清理 stale Viewer 后按 runbook 加载本地 Signal/Host；不操作 tunnel。
- [~] 已实测短断线/媒体恢复、浏览器协议键鼠、首帧、FPS/丢帧和 reset gate；可见效果与物理键盘仍为 `NOT RUN`。
- [~] 已启动至少三小时 passive 长会话，当前正在记录中断、采样覆盖和资源趋势；最终完成前保持 `INCOMPLETE`。
- [~] 已更新实施报告并完成当前 git/service/privacy review；长会话结束后再做最终 completion audit。

执行事实（2026-10-31）：freshness/Signal 141 tests、viewer-freshness 4 tests、diagnostic/runtime-evidence/store 72 tests、Viewer diagnostic/runtime-diagnostic 63 tests和 frame-trace/latency 286 tests通过；watcher/entry 定向 Python 17 tests、watch shell 26 tests通过，前端构建通过。当前构建产物 buildId `006ff0c9024b1e27` 已被本地与正式入口 manifest 同时提供。维护窗口已开始，三小时 passive 会话仍在运行。

追补事实（2026-10-31）：`4a3e92e` 已为 watcher 增加加载源码 fingerprint，并已按 runbook 重载验证；当前 watcher PID 51489 的 fingerprint 为 `33ddf5011fe34f827b8e9918`，页面、core asset 和 loopback passive runtime 均成功。`c983575` 已将输入/reset ACK 关联脱敏并把 summary gap、ring drop、coverage 和 input trace loss 接入 runtime evidence。定向验证为 watcher/runtime 19/19、entry probe 17/17、Signal 131/131、diagnostic/runtime/store/reset ACK 107/107、Host observability/admission 46/46；三小时 passive 会话仍未结束。

抓帧追补事实（2026-10-31）：长会话证据显示 output FPS 被缓存帧复用掩盖，Host 新抓帧约 9–13 Hz；`c4a6888` 已把 fresh capture/reuse/age 观测接入 Host capture snapshot，待维护窗口重载 Host 后验证。

## 最终复核状态（2026-10-31 16:35）

- receipt 的生产传递已补证：当天手动诊断 summary 出现 `logReceipt.state=valid`（reported=48、retained=0、redacted=48、dropped=0），input trace loss 全 0，并包含 Host `diagnosticAdmission` 计数；因此“代码已接入但生产未加载”的旧风险已关闭。
- 全局 `.summary-state` 的 receipt-horizon gap 仍未直接进入单条 daily summary；当诊断没有携带覆盖信息时，`summaryGapCount`/`ringDropCount`/`coverageStatus` 保持 unknown/null，需在管理员摘要或日告警中显式标记。
- 三小时 passive continuity 已 PASS，但只覆盖连接/帧回调连续性；真实输入到 visible effect、物理显示、reset fault injection、双 Viewer 语义、capture backend A/B 仍未闭环。
- Host 诊断准入降频后拥塞已从 dropped=113 降至短窗口 dropped=9，但仍可能出现 `congested`；fresh capture 长尾、缓存复用和非 CPU 抖动仍未解决。
- freshness 追补已加入 active-stall 二阶段恢复：首次无新帧记录 `media_stalled`，恢复窗口后记录 `media_stall_recovery_requested`，再经第二个有界窗口且 `progressAgeMs` 仍无进展才按 `active-media-stale` 释放；hidden-suspended 判定同时考虑 media request、applied ACK、received/decoded frame 和 heartbeat。定向 freshness/signaling 138/138 通过。
- active-stall recovery event 在当前 ACTIVE lease 和有效 attempt/generation 下会向 Host 发一次受身份约束的 keyframe request；旧 attempt、无 lease 和失效 generation 均被拒绝。新增 signaling 回归覆盖该路径。
- 结构化 Signal/Host lifecycle correlation 已统一为有界 hash；FrameTrace 追加固定阶段 coverage 计数并保留 `correlation.complete` 的严格缺测语义。Node signaling/admission 164/164、Node diagnostic/runtime/frame 262/262、Python observability 15/15 通过。
- durable daily summary 已同步保留 `frameTrace.stageCoverage`，并新增 summary 投影回归，避免 raw/runtime 与日摘要字段不一致。
- coverage 追补已加入管理员 evidence：`coverageSignals.summaryGap`/`ringDrop` 明确为 `observed`、`nonzero` 或 `unknown`，并保留原始 count；`diagnostic-store.listSummary()` 增加 `gapTotalCount`。定向 diagnostic/store/runtime evidence 37/37 通过。
- 计划阶段 1–4 的实现和离线测试可视为完成；阶段 5 只完成被动连续性和协议层子集，整体 Goal 继续保持 `active`，不能标记完成。

## 追加执行记录（2026-10-31 18:56）

- [x] 统一诊断 `diagnostic_uploaded`、Signal/Host structured correlation 和诊断持久化的脱敏字段；raw `viewerId`/`connectionAttemptId`/`browserSessionId` 不再进入诊断存储，管理端按 `attemptHash` 查询和去重。
- [x] 同步 guarded recovery runner 的 hash schema：只接受 `viewerHash`/`previousViewerHash`/`browserSessionHash`，拒绝 raw correlation；兼容生产 32-hex hash 与测试私有投影。Node diagnostic/store 65/65、Host observability 16/16、runner 95/95 通过。
- [x] 本地 Signal/Host 已重载并保持在线；cloudflared 未重启、URL 文件未变化。within-grace 正式入口 relay 维护窗口 PASS（300s continuity、3s recovery、30s stable）。
- [~] after-grace fault injection 已真实触发，但 lease expiry 后新 connection attempt 没有 `viewer_reconnected`/`viewer_rebind_confirmed`，结果 `recovery-deadline`；需补“重新 admission/重新获取控制”路径和对应真实验收，不能把新连接当成控制恢复。
- [~] 实际业务输入、输入到可见效果、物理显示、reset fault injection 的端到端样本仍未运行；捕获后端 A/B、诊断拥塞长会话和 tunnel SIGTERM 根因仍未闭环。
