# TURN 画质与延迟优化 Spec / Plan Review

日期：2026-09-05
结论：通过，已修正 review 中发现的问题；可以进入实施，但编码参数必须经过离线与真实TURN门禁后才能成为默认值。

审查对象：

- `docs/superpowers/specs/2026-09-05-turn-quality-latency-optimization-design.md`
- `docs/superpowers/plans/2026-09-05-turn-quality-latency-optimization-plan.md`
- `~/.Codex/plans/turn-quality-latency-optimization.md`

## 审查依据

- 当前代码：`python-host/host.py`、`h264_videotoolbox_encoder.py`、`aiortc_media_sender.py`、`web-client/js/webrtc.js`、`webrtc-stats.js`、`link-quality-controller.js`
- 当前测试：时间、媒体profile、Quality Lock、IDR、Viewer stats与恢复测试
- 当前运行证据与离线复现：`2026-09-05-turn-quality-latency-review.md`及其evidence目录
- 既有Quality Lock、relay出画连续性、TURN重连稳定性和媒体暂停设计
- 运维规则：`README.md`、`docs/runbook-safe-startup.md`、根`AGENTS.md`

## Findings 与修正

### R1 / P1：原runtime步骤只重启Host，无法加载更新后的Viewer bundle

当前signal-server在启动时构建并托管Viewer。只执行`restart-host`不会加载Task 2/4/5的前端修改。

**已修正：** 首次验收改为`restart-local`，后续只在切换Host编码policy时执行`restart-host`。仍禁止操作tunnel。

### R2 / P1：现有TURN proof不足以支撑10分钟验收

当前`scripts/prove-turn-relay.mjs`没有`--duration-seconds`参数，读取的部分DOM id已落后，而且允许仅凭`networkMode=relay`与FPS>0通过；这不能证明selected pair确实是relay。

**已修正：** Task 5明确先升级proof接口、当前DOM字段和持续采样能力；通过条件要求selected pair local candidate为relay。Task 9命令依赖Task 5完成后才可使用。

### R3 / P1：自动proof可能顶替用户当前Viewer

需求文档明确是严格单桌面Viewer，新Viewer会supersede旧Viewer。直接启动headless proof会中断正在使用的会话。

**已修正：** proof启动前检查`/api/status`没有活跃人工Viewer；存在时明确退出并等待操作者安排测试窗口。

### R4 / P1：proof可能把candidate地址写进报告

当前browser snapshot可以包含完整selected pair。验收只需要candidate类型、protocol和RTT，不需要IP或端口。

**已修正：** spec与plan要求在proof结果生成点脱敏，地址和端口不得写入报告。

### R5 / P1：把PLI精确来源写进encoder统计超出当前aiortc接口

aiortc内部收到RTCP PLI后直接设置sender的force-keyframe标志。项目encoder只收到boolean，没有原始RTCP reason。

**已修正：** 未匹配项目待处理请求时统一记为`rtcp-or-unknown`；不patch aiortc私有RTCP处理器来制造不必要的seam。

### R6 / P2：编码policy配置不应混入TURN加载器

`run-host-launchctl.sh`已经以`set -a`加载`signal-server/.env`，编码policy会自然导出；`lib-turn-env.sh`只负责TURN/STUN配置。

**已修正：** plan明确不修改`lib-turn-env.sh`，并增加默认、合法覆盖和未知值测试。

### R7 / P2：CPU百分比不适合作为跨机器硬门禁

进程CPU受核心数、采样时机和测试并发影响。它能说明负载，不能直接证明输入或出画是否受阻。

**已修正：** CPU降为上下文；硬门禁使用Host event-loop lag p95和远程输入ack p95。

### R8 / P2：画质门禁需要覆盖“周期消失”和“恢复帧可读”两个维度

只要求提高IDR PSNR可能仍保留周期脉冲；只拉长GOP又可能让恢复帧不可读。

**已修正：** 周期IDR候选要求`changeMAE <=3.0`；仅按需方案要求健康60秒无periodic IDR；两者的按需IDR均要求720p/1080p PSNR目标≥28dB，并继续接受真实文字观察。

### R9 / P2：旧设计与新设计的优先级不明确

旧relay连续性设计明确使用1秒GOP，而本设计要改变该行为。没有优先级说明会让实施者同时满足互斥要求。

**已修正：** 新spec明确只取代旧设计的固定1秒GOP/周期IDR和相关恢复顺序，其余产品约束继续有效。

### R10 / P2：A/B修改本地配置缺少恢复规则

Host policy由`.env`传播。若测试失败后未恢复，可能让用户留在失败候选上。

**已修正：** plan要求只读保存policy原值、只修改该非敏感字段、失败恢复、禁止输出`.env`全文或触碰其中密码与TURN凭据。

## 架构Review

| 检查项 | 结论 |
|---|---|
| 时间线seam | 通过。`RtpFrameClock`隐藏单调时钟、90kHz换算与PTS不变量，调用接口单一。 |
| 编码策略深度 | 通过。path、codec、GOP、bitrate、VBV集中到一个纯策略模块，删除“GOP暗示codec”的浅层耦合。 |
| 恢复状态机 | 通过。演进现有`LinkQualityController`，没有新增并行控制器。 |
| 单Viewer并发 | 通过。policy带attempt generation；旧事件无副作用。 |
| 可测试性 | 通过。clock可注入，policy为纯计算，Viewer stats以明确区间接口测试。 |
| 运维隔离 | 通过。本地重启与tunnel管理分离，A/B不改TURN凭据和URL。 |
| 回滚 | 通过。保留`relay-legacy-v1`，v2未通过真实门禁不得成为默认。 |

## 验证结果

规划前基线：

```text
Python targeted: 41 passed, 1 deprecation warning
Node targeted:   11 passed, 0 failed
```

文档Review校验：

- spec、仓库plan与EnterPlanMode原始plan均存在。
- 两份plan除来源说明外内容一致。
- 引用的现有源文件和测试文件均存在；标为Create的文件不存在冲突。
- 当前`prove-turn-relay.mjs`确实缺少计划中的持续采样参数，因此已将脚本升级放在runtime验收之前。
- `git diff --check`通过。

## 未关闭边界

- `relay-balanced-v2`的最终GOP、码率和VBV参数仍需Task 6用门禁选择，这是有意的实验决策点，不是遗漏。
- 尚未实施任何产品代码，也未执行服务重启、真实TURN持续验收、公司网/手机网或物理设备验收。
- 当前工作树存在本任务之外的未提交文档、日志、截图和`.playwright-mcp/`；实施与提交必须继续排除这些用户内容。
