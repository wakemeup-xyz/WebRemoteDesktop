# WebRemoteDesktop 连接与控制连续性系统化整改计划

> EnterPlanMode 仓库同步副本。本文是实施前计划，不表示代码已经修改或生产验收已经通过。

日期：2026-09-28
关联事件：2026-09-27 教学会话中断连、画面卡顿、老师控制权丢失
状态：待实施，已完成方案 review
相关证据：[back-debug.log](/Users/macstudio1/AI/Claude/WebRemoteDesktop/back-debug.log)、[signal-server.log](/tmp/signal-server.log)

## 1. 目标和边界

目标是把“媒体质量、事件循环、WebRTC 恢复、输入复位和诊断”收敛成一条有明确所有者、状态和验收门禁的可靠性链路。完成后，短暂网络抖动不应直接变成长期控制锁定；编码器不能被无效的动态码率写入拖入重开循环；每一次控制恢复都必须能说明当前 attempt、generation、lease epoch 和 reset ACK 的归属。

本计划只处理桌面远程控制链路：

- Host 捕获、编码、事件循环和媒体 profile 应用。
- Viewer 的媒体质量状态、DataChannel/ICE 恢复和输入门禁。
- Signal 的控制租约、reset-only barrier、诊断接收与持久化。
- Relay/TURN 的会话策略、观测和真实验收。

明确不包含：

- 不改变 fail-closed 控制租约原则，不因为“好用”而跳过键盘/鼠标复位。
- 不把 Cloudflare Tunnel 当作媒体通道，不自动重建、轮换或迁移 tunnel。
- 不把 Strict STUN 失败静默改成 TURN，也不改变“手动选择外网中继”的产品契约。
- 不把 Terminal、PTY 或共享终端会话混入本次桌面故障修复。
- 不用离线编码结果、health 200 或 synthetic ACK 代替真实 TURN、浏览器和物理输入验收。

## 2. 事件模型和根因判断

### 2.1 事故链

```text
relay session
    │
    ├─ Host encoder/profile path receives repeated bitrate writes
    │       └─ fixed relay policy clamps them and reports reopen-required
    │
    ├─ encode/capture and Python event loop stall
    │       └─ frame cadence, DataChannel keepalive and input ACK are delayed
    │
    ├─ Viewer observes dc-stuck / pc-failed / dc-error / ice-disconnected
    │       └─ peer is rebuilt or viewer disconnects
    │
    └─ lease enters reset-only REVOKING
            └─ reset ACK is late/missing, so input remains safely locked
```

### 2.2 证据等级

| 结论 | 证据 | 置信度 | 计划处理 |
|---|---|---:|---|
| Host 媒体和事件循环在事故窗口内明显过载 | 事件循环出现约 118–158ms 严重卡顿；编码样本最高约 239–402ms；RSS 约 939MiB；采集曾降到 10.5 FPS | 高 | P0，先修复编码配置应用和资源回收 |
| 控制权丢失是 WebRTC 故障后的安全屏障，不是已证实的租约抢占 | Signal 记录 `pendingMouseReset=true`、`expiredPendingAcks=2`、`droppedEvents=2201`；现有代码明确要求 reset ACK 才能回到 FREE/ACTIVE | 高 | 保留屏障，缩短并观测恢复链路 |
| Relay RTT/抖动放大了问题 | RTT 约 96–332ms，jitter buffer 约 50–155ms；没有持续丢包证据 | 中高 | Relay 使用固定策略，质量信号不直接改固定码率 |
| 存在码率更新反馈/重开放大器 | 事故窗口内反复出现 `requested → clamped=3.2Mbps → applied=false → reopen-required`；但当前还需定位所有调用者 | 高（现象），中（调用源） | 先加来源计数和幂等协调器，再改行为 |
| Tunnel/origin 是主因 | 事故窗口内 Host 没有崩溃，Signal 没有 Host 掉线；没有对应 tunnel 故障证据 | 低 | 只做独立入口复核，不纳入主修复假设 |

### 2.3 必须保留的现有契约

需求文档已经规定：relay-peak-sliced-v1 是固定的会话编码策略；Viewer 需要真实 fresh frame 才进入 media live；输入只有在 `control=active`、`media=live`、`socket=online` 时开放；reset barrier 是安全确认屏障。计划不能重新引入自动静默切换、旧 attempt 事件解锁输入或“日志显示 applied 就算生效”的假成功。

## 3. 目标架构

### 3.1 会话级媒体意图

每个 connection attempt 只生成一个带身份的 `MediaSessionIntent`：

```text
attemptId + generation + networkPath + resolution + targetFps
    └─► immutable policy fingerprint
          ├─ codec
          ├─ bitrate target/min/max
          ├─ VBV / preset / slice settings
          └─ keyframe/reopen rules
```

Viewer 的 RTT、jitter、FPS 和丢包只产生 `QualitySignal`。在固定 relay policy 下，QualitySignal 可以请求 keyframe、标记媒体退化或建议用户切换模式，但不能直接把新的瞬时码率写入编码器。

### 3.2 单一媒体应用协调器

Host 增加一个按 `attemptId + generation` 归属的 media apply coordinator，负责：

1. 对 profile、resolution、FPS、bitrate 和 codec policy 做 fingerprint 比较。
2. 相同 fingerprint 直接返回 `no-op`，不调用 encoder setter，不触发 reopen。
3. 不同 fingerprint 只允许一个 pending apply/reopen；后续请求合并到最新序列。
4. 只有下一帧真正使用新 policy 后，才记录 `applied=true` 和新的 generation。
5. 旧 attempt、旧 generation、旧 profileSequence 一律拒绝或记录 stale，不得改变当前编码器。

`set_target_bitrate()` 保持诚实语义：PyAV/VideoToolbox/libx264 未证明热更新成功时仍返回 `applied=false`。新协调器只负责避免无效调用和无限 reopen，不把未验证的 assignment 标成成功。

### 3.3 控制恢复状态机

沿用现有 Signal `FREE → GRANTING/ACTIVE → REVOKING`，补充可观测的恢复阶段：

```text
transport fault
  → control frozen
  → mouse reset pending + keyboard reset pending
  → ACK validated by inputType/leaseEpoch/attemptId/inputId/seq
  → current fresh frame + socket online
  → ACTIVE input gate
```

任何 ACK 都必须匹配当前 reset owner；键盘 ACK 不能清鼠标屏障，旧 attempt ACK 不能解锁新 attempt。重试必须有界，失败保持 blocked 并给出可操作原因。

### 3.4 诊断闭环

每条事故链使用同一组安全关联字段：`connectionAttemptId`、`generation`、`leaseEpoch`、`profileSequence`、`reason`、`transport`、`inputType`、`status` 和本机耗时。禁止写入 key、正文、坐标、token、密码、SDP、完整 inputIds。

诊断分为三层：

- 实时 Host/Viewer 日志：事件级、有界、采样。
- Signal summary：每次连接/恢复/控制转换的最终摘要。
- 持久化 incident bundle：只保留脱敏摘要、计数、关键时间线和版本信息，便于按 attempt 重建链路。

## 4. 实施阶段

### Phase 0：冻结基线和部署闸门

**目标：** 在任何行为修改前，固定事故基线、调用来源和回滚入口。

**工作项：**

- 从 `back-debug.log` 和 `/tmp/signal-server.log` 生成一次只读 incident summary，明确本地时区、UTC 时间、attempt、generation 和日志版本。
- 静态枚举所有 `target_bitrate`、`set_target_bitrate`、`stage_policy_update`、`apply_media_profile` 调用；临时增加受控 `source` 计数，确认高频写入到底来自 Host profile、aiortc sender、旧进程还是重复部署。
- 增加统一的 `WRD_MEDIA_APPLY` 摘要字段：`requestedFingerprint`、`currentFingerprint`、`decision`、`source`、`attemptId`、`generation`。
- 保存现有 `relay-legacy-v1` 和 `relay-on-demand-v1` 回滚开关，默认不改变生产策略。
- 确认 LaunchAgent 实际注入 `WRD_ENABLE_DIAG_PERSIST=1`；若未注入，只修部署环境或 runbook，不把持久化开关散落到代码默认值。

**文件范围：**

- `python-host/h264_videotoolbox_encoder.py`
- `python-host/h264_encoder_policy.py`
- `python-host/host.py`
- `signal-server/lib/config.js`
- `signal-server/lib/diagnostics.js` 及其测试
- 只读新增 `scripts/summarize-wrd-incident.py`

**门禁：** 未确认高频 setter 来源前，不改变 setter 的结果语义，不做生产重启。

### Phase 1：停止无效码率/策略更新循环（P0）

**目标：** 固定 relay policy 的实际行为，使相同 policy 不再反复触发 encoder reopen。

**实现：**

1. 在 `h264_encoder_policy.py` 输出稳定 fingerprint，并明确 fixed relay policy 的 bitrate bounds。
2. 在 `h264_videotoolbox_encoder.py` 让 `set_target_bitrate()` 先比较当前有效 policy/target；相同目标返回 `no-op`，不重置 pending state。
3. 在 `host.py` 将 `on_media_profile_change()` 和所有潜在 sender 回调统一接入 media apply coordinator。
4. profileSequence、attemptId、generation 采用单调门禁；重复 profile 只允许 keyframe continuity action，不允许码率重开。
5. `pending_reopen` 按 generation 去重；一个 generation 最多一次安全 codec reopen。
6. 把逐调用 `WRD_ENCODER_RATE` 改为有界聚合，并保留 `no-op`、`staged`、`reopen-required`、`applied` 四种可审计结果。

**必须新增的测试：**

- 相同 relay policy 连续 100 次 profile/bitrate 请求只产生一次实际 apply，且不会重复 reopen。
- 不同 generation 的旧请求不会覆盖当前 target。
- `applied=false` 时不推进 generation；真实新 codec 首帧后才推进。
- setter 来源统计能区分 profile、sender、测试调用；未知来源进入拒绝/告警路径。
- legacy/on-demand 的既有动态行为保持兼容。

**文件范围：** `python-host/h264_encoder_policy.py`、`python-host/h264_videotoolbox_encoder.py`、`python-host/host.py`、`python-host/test_h264_idr.py`、`python-host/test_h264_encoder_policy.py`、`python-host/test_quality_lock.py`、`python-host/test_media_profile.py`。

**退出条件：** 离线测试通过；固定 relay policy 的真实调用频率降为每个有效 fingerprint 一次；没有 `applied=false` 高频循环。

### Phase 2：媒体资源和事件循环稳定性

**目标：** 防止编码、capture、旧 Peer 和诊断任务阻塞 Python event loop。

**实现：**

- 将 capture/convert/encode 的耗时聚合为 5 秒窗口，保留最大值、P95、reuse、drop 和当前 peer 状态。
- 检查 Viewer disconnect、new-offer、ICE close 后的 sender、track、stats sampler、frame callback、timer 和 pending task 是否全部释放。
- 为 encoder reopen、decoder refresh、keyframe request 设置独立的有界队列；不能由两个恢复路径同时 `codec=None`。
- 当 event-loop lag 超过 50ms/100ms 时记录当前 task、encoder、capture 和 peer context；不在高频路径打印完整 payload。
- 对 RSS、process CPU、system load 设定软门槛；连续超阈值时只告警并停止自适应升档，不自动重启服务。

**测试与验证：**

- Python 单测覆盖 disconnect/reconnect 20 次后的 task、sender 和 sampler 数量。
- 受控本地 session 连续 30 分钟，要求无 critical lag、无 task 单调增长、RSS 不持续上升。
- 只在用户明确要求重启服务时按 runbook 重启本地 Signal/Host；不得操作 tunnel。

### Phase 3：控制恢复闭环

**目标：** 让控制权丢失时安全、可解释、可恢复。

**实现：**

- 在 `web-client/js/input.js` 和 `webrtc.js` 统一 dual reset cycle 的 owner，所有 reset 记录 attempt/generation/leaseEpoch/inputId/seq。
- 在 `signal-server/lib/desktop-control-lease.js` 与 `control-transition-retry.js` 保持 fail-closed，但给出明确的 retry attempt、deadline、blocked reason。
- 保证 Socket.IO reset fallback 只复用当前认证 Viewer，不创建临时 Viewer socket，不触发单 Viewer 顶替。
- 让 `dc-error`、`ice-disconnected`、`pc-failed` 进入同一恢复预算，避免多个 recovery timer 互相重入。
- 恢复成功必须同时满足 reset ACK、当前 socket online、当前 attempt fresh frame；单独的 READY、旧 frame 或同 lease 重绑不能解锁。
- UI 显示“控制恢复中/已安全锁定/可重试”的实际状态和耗时；不提供绕过 reset barrier 的按钮。

**必须新增的测试：**

- ACK 乱序、迟到、旧 epoch、旧 attempt、错误 inputType 都不能解锁。
- DataChannel 关闭但 Socket 可用时，复位可以幂等完成；两通道都断时进入可见 blocked。
- 同一恢复周期最多一次自动重试，用户重试能建立新周期。
- `dc-error` 后不会同时触发多次 refresh/rebuild。

**文件范围：** `web-client/js/input.js`、`web-client/js/webrtc.js`、`web-client/js/keyboard-transport.js`、相关测试、`signal-server/lib/desktop-control-lease.js`、`signal-server/lib/control-transition-retry.js`、`signal-server/websocket/signaling.js` 及测试。

### Phase 4：Relay/TURN 策略和真实链路验收

**目标：** 将中继的结构性 RTT 与媒体退化区分开，避免把正常 relay RTT 误判成码率震荡。

**实现：**

- 保持 `relay` 必须使用 TURN、`auto/stun` 不静默切换的现有契约。
- Relay 模式确认 selected candidate 为 relay 后，使用固定 720p/20fps policy；结构性 RTT 只进入诊断，不直接降码率。
- 只有持续 `decodedDelta=0`、关键帧未恢复、或明确的丢包/媒体失败才触发受限 keyframe/decoder refresh。
- 诊断同时记录 selected candidate type、RTT、jitter buffer、derived FPS、paint gap 和 encoder sample，便于区分网络与 Host 过载。
- TURN fingerprint、Host ready、Allocate、selected pair 和首帧必须作为一个验收结果，不允许只凭 `/health` 或 `networkMode=relay` 判定成功。

**真实验收：**

- 新浏览器上下文、正式入口、真实 TURN、至少 30 分钟 relay 会话。
- 受控网络抖动、短暂断网、浏览器刷新和单 Viewer 顶替场景分别执行。
- 每个场景生成 immutable JSON + SHA-256；未真实执行的公网、手机、物理 Quartz 场景标记 `NOT RUN`。

### Phase 5：诊断持久化和发布运维

**目标：** 下一次事故可以按 attempt 在 10 分钟内判断是入口、Signal、Host、Relay、媒体还是控制恢复。

**实现：**

- 确保 LaunchAgent 与 `scripts/run-signal.sh` 使用一致的 diagnostics persistence 配置；启动日志只记录 enabled/source/path，不记录凭据。
- `/api/diagnostics` 保存脱敏 summary，设置大小、数量、时间和轮转上限；原始输入和密码永不持久化。
- 增加告警聚合：event-loop critical、encoder no-op/reopen 高频、0 FPS、dc-error、reset-blocked、Host offline、TURN fingerprint mismatch。
- 在 README/runbook 补充“只重启本地 Signal/Host，不重建 tunnel”的故障处置路径，以及复位卡住时的证据采集命令。

## 5. 测试和发布矩阵

### 5.1 自动化门禁

```bash
node --test web-client/js/*.test.js signal-server/lib/*.test.js signal-server/websocket/*.test.js
python -m pytest -q python-host/test_h264_encoder_policy.py \
  python-host/test_h264_idr.py \
  python-host/test_quality_lock.py \
  python-host/test_media_profile.py \
  python-host/test_input_handler.py
cd signal-server && npm run build:web
```

实施时每个阶段必须先写一个能捕获事故的 RED 测试，再实现 GREEN；不能用源码字符串匹配代替行为测试。

### 5.2 运行时验收门槛

| 指标 | 通过标准 | 失败动作 |
|---|---:|---|
| relay 会话 FPS | 30 分钟 P95 ≥ 18，不能出现持续 0 FPS | 回滚 peak policy 或停止发布 |
| Host event-loop lag | 无持续 >50ms；critical >100ms 为 0 | 停止升档，检查 encoder/task/resource |
| encoder apply | 相同 fingerprint 无重复 reopen；无高频 `applied=false` | 回滚 media coordinator |
| 输入 ACK | P95 <100ms；超时可解释且有界 | 检查 DataChannel/Socket fallback |
| 控制恢复 | 故障后 ≤3s 恢复或进入可见 blocked | 不得绕过 reset barrier |
| 资源 | session 断开后 task/sampler/sender 回收；RSS 不单调增长 | 停止长跑发布 |
| TURN | fingerprint 一致、selected candidate=relay、首帧真实出现 | 标记 relay 不可发布 |

### 5.3 分阶段发布

1. **本地离线：** 单测、模拟 profile storm、模拟 ACK/断连、静态调用来源审计。
2. **单机灰度：** 固定 relay policy，开启聚合指标，观察 30–60 分钟；不接入教学流量。
3. **受控真实 TURN：** 一个浏览器、一个 Host、真实公网入口，执行短时断网和刷新。
4. **教学灰度：** 单一教师 Viewer，保留 legacy/on-demand 回滚开关，连续两个会话通过后再扩大。

每一步发布前记录 commit、配置 fingerprint、Host/Signal 进程版本和 tunnel URL 是否保持不变。任何阶段失败只回滚本阶段代码/配置，不重建 tunnel。

## 6. 回滚和停止条件

- `relay-peak-sliced-v1` 出现新的 0 FPS、critical lag 或 encoder reopen storm：切回 `relay-on-demand-v1`，保留证据，停止继续优化参数。
- 控制恢复出现误解锁、旧 ACK 解锁或卡键：立即回滚 Phase 3，保留 fail-closed 版本，禁止以 UX 便利换安全性。
- RSS、task、sender 或 sampler 在 disconnect/reconnect 中单调增长：停止真实灰度，先修资源生命周期。
- TURN fingerprint 不一致、selected candidate 不是 relay 或公网验收缺失：不得把 relay 标记为 PASS。
- 任何测试需要关闭或重建 tunnel 才能通过：该测试不符合本计划边界，停止并修正测试环境。

## 7. 完成定义

本计划只有在以下条件全部满足时才算完成：

1. 事故链的每一段都有可关联证据，且不存在高频无效码率更新。
2. 固定 relay policy 的相同意图不会反复重开编码器。
3. Host 断连后资源回收、事件循环和 RSS 长跑稳定。
4. 控制恢复保持 fail-closed，同时能在有 ACK 时有界恢复、无 ACK 时明确 blocked。
5. 真实 TURN/浏览器/公网短时和 30 分钟长跑验收通过；未执行的物理边界仍明确标记 `NOT RUN`。
6. 诊断持久化、告警、runbook 和需求文档与实际代码状态一致。
