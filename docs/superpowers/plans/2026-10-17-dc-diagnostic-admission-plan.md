# Host 可丢诊断 DataChannel 准入执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 消除可丢诊断对输入DataChannel的无界入队放大，保留可靠控制协议。

**Architecture:** 单事件循环同步准入helper，固定字节预算和标量摘要；ScreenCaptureTrack四类诊断接入。

**Tech Stack:** Python3.11、现有aiortc、unittest/pytest定向离线测试。

**Spec:** docs/superpowers/specs/2026-10-17-dc-diagnostic-admission-design.md

## Global Constraints

- 仅工作树 /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop；不改生产、不启动/重启服务、不浏览器/网络/截图/业务输入、不安装依赖、不npm test/pretest、不碰tunnel文件。
- 保留原有dirty README/runbook/requirements/reviewanchors与node_modules symlink。只stage/commit任务白名单文件。
- 固定4096B、四类可丢诊断allowlist；可靠ACK/绑定/时钟/labflush路径不改。
- /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 为测试解释器；避免生产import副作用，使用现有AST方法测试约定。

### Task 1: 同步诊断准入及接线

**Files:** Modify python-host/host.py; optionally create focused python-host/dc_diagnostic_admission.py; Create python-host/test_dc_diagnostic_admission.py; adapt only necessary existing test_media_timing.py/test_media_stage_boundaries.py/test_input_frame_causality.py or related narrow fake DC fixtures after documented baseline failure. Report .superpowers/sdd/2026-10-17-dc-diagnostic-admission-plan/task-1-report.md.

**Interfaces:** Existing ScreenCaptureTrack._send_frame_timing/_send_frame_trace_batch/capture_stats calls consume gate. Fixed local aggregate counters cannot contain raw diagnostic/input payload. Root alone owns deployment and main docs.

- [ ] 阅读spec与/tmp/wrd-dc-telemetry-bound-design.md，确认实际frame/loss consumers及registry计数契约。
- [ ] RED真实方法+实际aiortc纯内存backlog反例；边界等号/超1/Unicode字节、oversize、各invalid channel情况、legacy全部drop路径清空。
- [ ] 实现最小同步helper及四类接线，固定枚举/饱和摘要、复用现有5秒日志，无新待发队列或异步工作；保持input_ack/input_frame_binding/clock_sync/labflush原方法。
- [ ] 验证trace两批独立结果、loss已有drop计数归还/恰好一次、空events计数批；原lab begin/flush epoch回归。
- [ ] GREEN定向/必要相邻回归；fake DC按真实API补readyState/bufferedAmount并保留原wire断言，不削弱旧边界。仅为新增gate改变的fake作调整。
- [ ] 自审并提交白名单源码/测试；报告commit/hash、RED/GREEN命令、真实覆盖与缺测。不能运行生产验收，不spawn子agent。

### Task 2: 复审与部署（controller）

- [ ] 独立task review，随后跨层增量review。
- [ ] 受控当前候选同步、Host-only重载、源码/HEAD/index/tunnel身份/health/Host/Viewer检查；新运行不与正在进行的诊断混合。
- [ ] guarded短媒体及后续长会话验收，记录失败及环境；不将本队列修复称为13.8s停帧已解决。

### Task 3: 独立确认的旧trace fixture同步（Task2部署前完成）

**Files:** Modify only python-host/test_latency_timing.py; report .superpowers/sdd/2026-10-17-dc-diagnostic-admission-plan/task-3-report.md.

**Interfaces:** 当前真实Viewer verifiedVideoFrameIdentity要求同一当前PC receiver对应展示track且唯一SSRC；detail trace必须在frame-first callback前启用。仅补fixture契约，不改变任何生产代码/生产gate或断言。

- [ ] 阅读 docs/superpowers/reports/2026-10-17-existing-trace-fixture-classification.md；原target仍RED，保持原始frame-first顺序。
- [ ] 只在该Node fixture给video.srcObject.getVideoTracks/currentPC.getReceivers/receiver.getSynchronizationSources补唯一track id v / kind video / source7；在beginConnectionAttempt之前启用WebRTC._frameTraceEnabled=true。可加matched.length==1的更清楚断言，原captureSeq/RTP/PENDING/legacy断言全部保留。
- [ ] 跑完整target、safe TestFrameTiming（排除真实MSS构造）及Node webrtc.frame-trace.test.js；不启动browser/network/native screenshot。
- [ ] self-review，白名单提交唯一test文件，报告RED/GREEN及源码未变；禁止子agent。
