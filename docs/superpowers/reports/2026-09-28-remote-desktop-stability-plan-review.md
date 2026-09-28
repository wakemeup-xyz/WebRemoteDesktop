# WebRemoteDesktop 系统化稳定性计划 Review

日期：2026-09-28
被审计划：[2026-09-28-remote-desktop-stability-system-plan.md](../plans/2026-09-28-remote-desktop-stability-system-plan.md)
Review 类型：实施前架构、范围、证据、验收和回滚审查

## Review 结论

计划可以进入实施，但必须按 Phase 0 → Phase 1 → Phase 2 → Phase 3 的顺序推进。不能先调整 RTT 阈值、降低分辨率或放宽控制租约来掩盖 Host 编码/事件循环问题。计划把已证实的现象、尚未证实的调用来源和必须真实验收的公网边界分开，范围没有扩展到 Terminal 或 tunnel。

## 已通过的审查项

### 1. 根因链是可证伪的

计划没有把“断连”简单归因于网络。它要求先证明高频 setter 的调用来源，再修 profile/policy 应用；同时保留 RTT、丢包、编码耗时、event-loop lag 和控制 ACK 的独立证据。这样可以区分：

- Host 过载导致 DataChannel/媒体停顿。
- Relay 的结构性高 RTT。
- ICE/Peer 的实际失败。
- reset barrier 的安全锁定。

### 2. 没有削弱安全语义

计划明确保留 reset-only barrier、旧 attempt 拒绝、ACK 归属检查和单 Viewer 规则。它只优化重试、去重和可见状态，不允许“只要重新拿到 lease 就自动清空旧状态”这种不安全捷径。

### 3. 没有把离线结果冒充真实验收

计划把单测、离线编码、真实 TURN、正式入口、浏览器长跑和物理输入分层，并要求 `PASS/FAIL/NOT RUN` 分开记录。这与需求文档关于 fresh frame、selected relay candidate 和真实输入验收的约束一致。

### 4. 回滚路径具体

计划保留 `relay-legacy-v1` 与 `relay-on-demand-v1`，同时要求每个阶段独立发布和回滚；不会用 tunnel 重建解决本地媒体问题。控制恢复失败时回滚到更安全的 fail-closed 行为，而不是放开输入。

## Review 发现和已作出的修正

### Finding R1：不能假定高频码率写入只来自 media-profile

当前 `host.py` 的显式 profile 日志数量少于事故窗口里的 `WRD_ENCODER_RATE` 日志数量，而 `rg` 只能看到少量显式调用。因此计划第一阶段新增调用来源计数和静态审计，先定位 sender/aiortc/旧进程/重复部署，再改变 setter 行为。没有这一步，直接把 setter 改成 no-op 可能掩盖真正的调用者。

### Finding R2：`applied=false` 不能被改成假成功

当前 encoder 代码已经正确表达“无法证明热更新已经生效”。计划只增加 fingerprint 去重、pending reopen 合并和真实首帧确认，保留 `applied=false` 的事实语义，并要求 generation 只有在新 codec 实际使用后才推进。

### Finding R3：Relay quality lock 已存在，不能重复造一套阈值

`web-client/js/link-quality-controller.js` 已区分 structural relay RTT、jitter、0 FPS 和 recovery。计划只要求固定 relay policy 下 QualitySignal 不直接写码率，并通过现有 controller 的 keyframe/recovery 入口处理退化；不重写整个质量状态机。

### Finding R4：现有输入恢复代码已经复杂，新增状态必须有唯一 owner

`web-client/js/input.js` 已经包含 mouse/keyboard dual reset、attempt、lease epoch 和 pending ACK 逻辑。计划要求所有新指标和 retry 都归属现有 recovery cycle，不再新增平行的“恢复状态真相源”。新增测试应覆盖事故路径，而不是复制大量已有 reset 测试。

### Finding R5：诊断持久化是部署配置问题和代码问题的交界

`signal-server/.env.example` 和 `scripts/run-signal.sh` 已有 `WRD_ENABLE_DIAG_PERSIST`，但现场日志出现 `persisted=false`，说明 LaunchAgent 的实际环境仍需核对。计划要求先验证真实启动入口，再决定修代码、LaunchAgent 或 runbook；不把持久化默认值偷偷改成全局开启。

### Finding R6：事件循环和 RSS 证据不能仅靠单测关闭

单测只能证明去重和状态机契约，不能证明 PyAV、macOS 捕获、aiortc 和真实浏览器的长跑行为。计划增加 30–60 分钟本地/真实 TURN 长跑，并把 task、sender、sampler、RSS、event-loop lag 作为发布门禁。

### Finding R7：Phase 0 摘要不能复制任意日志行

初版摘要工具为了提供 examples 会保存匹配日志的尾部文本，这会把未来新增的 token、输入或其他敏感字段带入证据文件。已改为只保存时间前缀和白名单事件名，并增加敏感内容回归测试。

## 实施前必须确认的事项

1. 当前工作树存在用户已有修改和日志轮转文件；实施时只能暂存计划明确的文件。
2. 真实服务验证前必须再次阅读 `README.md`、`docs/runbook-safe-startup.md` 和 `skills/webremote-service/SKILL.md`。
3. 任何本地服务重启只允许使用 `restart-local` 或 `scripts/restart-host.sh`；不允许调用 stop/recreate tunnel 脚本。
4. 真实浏览器验收必须使用单一明确的 Viewer，避免自动化浏览器顶替正在使用的教师会话。
5. 先记录当前正式入口、TURN fingerprint、Host/Signal commit 和进程状态，再执行灰度。

## 推荐执行顺序

```text
Phase 0 调用来源和基线
        ↓
Phase 1 fixed-policy apply 去重
        ↓
Phase 2 encoder/capture/Peer 资源长跑
        ↓
Phase 3 dual-reset 恢复闭环
        ↓
Phase 4 真实 Relay/TURN 验收
        ↓
Phase 5 持久化、告警、runbook 和文档收口
```

如果 Phase 1 仍然出现 `applied=false/reopen-required` 高频循环，应停止后续网络调参；如果 Phase 2 出现资源单调增长，应停止控制 UX 工作；如果 Phase 3 出现误解锁，应立即回滚并保持安全锁定。

## Review 结论状态

- 范围：通过
- 根因假设：通过，调用来源保留为 Phase 0 待证实项
- 代码落点：通过，沿用现有 policy、quality lock、lease 和 diagnostic owner
- 测试策略：通过，增加事故回归和真实长跑门禁
- 回滚策略：通过
- 生产发布：未执行
- 公网/真实 TURN/物理输入：`NOT RUN`
