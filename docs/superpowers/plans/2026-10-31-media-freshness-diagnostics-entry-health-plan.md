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

追补事实（2026-10-31）：`4a3e92e` 已为 watcher 增加加载源码 fingerprint，`c983575` 已将输入/reset ACK 关联脱敏并把 summary gap、ring drop、coverage 和 input trace loss 接入 runtime evidence。定向验证为 watcher/runtime 19/19、entry probe 17/17、Signal 131/131、diagnostic/runtime/store/reset ACK 107/107、Host observability/admission 46/46；常驻 watcher 尚未重载，三小时 passive 会话仍未结束。
