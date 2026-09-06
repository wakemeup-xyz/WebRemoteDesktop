# TURN 画质、延迟与周期抖动优化实施计划

> EnterPlanMode 仓库同步副本。原始规划产物：`~/.Codex/plans/turn-quality-latency-optimization.md`。

日期：2026-09-05
状态：Task 11–12 已合入并重启；Task 13 长跑 FAIL、场景仍有 NOT RUN；Task 14 两档候选均 FAIL、到250ms上限停止，产品验收未关闭

下一轮规划入口：[画质脉冲与出帧耗时计划](2026-09-06-turn-pulse-throughput-next-plan.md)。此处Task0–14保留历史状态，新计划已独立复审，尚未实施。
设计：`docs/superpowers/specs/2026-09-05-turn-quality-latency-optimization-design.md`
诊断：`docs/superpowers/reports/2026-09-05-turn-quality-latency-review.md`

## 实施原则

- 严格按阶段执行。时间线、统计语义、编码策略、性能实验一次只推进一个变量。
- 不自动降低用户分辨率，不改网络模式，不切TURN节点，不操作Cloudflare tunnel。
- 当前工作树已有用户未提交内容；只暂存本计划列出的文件，实施前后均运行scope检查。
- 每个阶段先写失败测试，再做最小实现，再运行对应回归。
- runtime验收需要本地服务重启时，先读`README.md`与`docs/runbook-safe-startup.md`，Host只能用`scripts/restart-host.sh`；不得调用任何stop/rotate tunnel脚本。
- 任何公网、公司网、手机网或物理设备未真实执行时标记`NOT RUN`。

## Task 0：冻结基线与证据格式

**文件**

- Modify: `docs/superpowers/reports/evidence/2026-09-05-turn-quality/encoder_probe.py`
- Create: `scripts/eval-turn-encoder-quality.py`
- Create: `scripts/test-turn-media-timeline.py`
- Create: `docs/superpowers/reports/2026-09-05-turn-quality-latency-acceptance.md`

**步骤**

1. 将现有离线probe整理为可从仓库根执行的只读评估脚本，固定随机种子、输入帧、字体/无字体fallback、PyAV/aiortc版本和机器信息。
2. 输出JSON必须包含policy、分辨率、码率、VBV、GOP、逐帧大小、IDR标志、PSNR、帧间变化和编码耗时。
3. 从现有日志提取720p与1080p基线摘要，但不把不同时间窗口称为受控A/B。
4. 在acceptance报告写入所有门禁，初始状态均为`PENDING`或`NOT RUN`。

**验证**

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 scripts/eval-turn-encoder-quality.py --policy relay-legacy-v1 --output /tmp/wrd-relay-legacy-v1.json
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m json.tool /tmp/wrd-relay-legacy-v1.json >/dev/null
```

**停止条件**

- probe不能稳定复现当前约1秒IDR质量脉冲时，停止编码参数工作，先修复probe。

## Task 1：修正RTP时间线

**文件**

- Create: `python-host/media_timing.py`
- Create: `python-host/test_media_timing.py`
- Modify: `python-host/host.py`
- Modify: `python-host/test_latency_timing.py`

**红灯测试**

1. 20FPS的连续时间推进必须得到4500 tick增量和`VIDEO_TIME_BASE`。
2. 重复时钟值仍生成严格递增PTS。
3. wall clock倒退不影响媒体时间。
4. 暂停后时钟前进只产生一个合法跳跃，不产生补帧序列。
5. 新track从独立时间原点开始。

**实现**

1. 实现`RtpFrameClock`，生产使用`time.monotonic_ns`，测试注入fake clock。
2. `ScreenCaptureTrack`创建并独占一个clock；正常、停止兜底和恢复帧统一调用。
3. 删除媒体PTS对`time.time()`与整数`90000` time base的依赖。
4. 保留现有async调用形状，避免无关调用方重构。

**验证**

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m pytest -q python-host/test_media_timing.py python-host/test_latency_timing.py
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 scripts/test-turn-media-timeline.py
```

**阶段门禁**

- 实际编码器返回的32位相对RTP时间戳必须为`0, 4500, 9000, 13500`或只差固定原点。
- 此阶段不得改GOP、codec、码率、VBV或采集频率。

## Task 2：修正Viewer统计语义

**文件**

- Modify: `web-client/js/webrtc-stats.js`
- Modify: `web-client/js/webrtc-stats.test.js`
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`

**红灯测试**

1. 累计`framesDecoded`从100到119时canonical derived FPS为19，即使浏览器报告90。
2. 浏览器报告值保存在`browserReportedFps`，不得覆盖derived FPS。
3. 每个`decodedDelta > 0`样本均更新最后解码进展时间，即使本次delta小于上次。
4. 第一份warmup样本不触发stall。
5. intentional pause不触发质量恢复。

**实现**

1. 将区间字段改为`receivedDelta / decodedDelta / bytesDelta`等明确名称。
2. UI、`LinkQualityController`、Host回传和paint state统一使用`derivedFps / decodedDelta`。
3. 保留旧日志字段时，在适配点转换一次；内部不再混用累计与增量。
4. `browserReportedFps`只进入诊断。

**验证**

```bash
node --test web-client/js/webrtc-stats.test.js web-client/js/webrtc.test.js web-client/js/link-quality-controller.test.js
cd signal-server && npm run build:web
```

## Task 3：建立独立H.264会话策略模块

**文件**

- Create: `python-host/h264_encoder_policy.py`
- Create: `python-host/test_h264_encoder_policy.py`
- Modify: `python-host/h264_videotoolbox_encoder.py`
- Modify: `python-host/host.py`
- Modify: `python-host/test_h264_idr.py`
- Modify: `python-host/test_quality_lock.py`
- Modify: `python-host/test_media_profile.py`
- Modify: `signal-server/.env.example`

**红灯测试**

1. relay的codec选择与`periodic_idr_frames`彼此独立。
2. 调整GOP不再自动把libx264切成VideoToolbox。
3. 720p、1080p和direct分别解析正确的min/target/max bitrate。
4. 未知`WRD_RELAY_ENCODER_POLICY`明确失败。
5. 旧generation的profile事件不能覆盖当前策略。
6. requested、clamped、effective和apply mode可从返回值与日志判断。

**实现**

1. 按spec实现`MediaSessionIntent`、`H264SessionPolicy`和`resolve_h264_policy()`。
2. 封装线程安全的当前policy provider，带`connectionAttemptId + generation`。
3. encoder factory向`H264VideoToolboxEncoder`提供policy；删除`codec_name_for_gop()`作为运行时决策入口。
4. 保留`relay-legacy-v1`用于回滚；先增加`relay-balanced-v2`结构，不在本任务选择最终参数。
5. 修正码率hot apply的真实性：不能确认生效时返回`applied=false`。
6. 保持现有配置传播职责：`run-host-launchctl.sh`从`.env`导出policy枚举；不修改`lib-turn-env.sh`。测试未配置、合法覆盖和未知值三条路径。

**验证**

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m pytest -q python-host/test_h264_encoder_policy.py python-host/test_h264_idr.py python-host/test_quality_lock.py python-host/test_media_profile.py
```

**阶段门禁**

- 使用legacy策略运行离线probe，结果必须与Task 0基线在容差内；否则说明重构改变了行为，先修正再继续。

## Task 4：合并关键帧请求与恢复路径

**文件**

- Modify: `web-client/js/link-quality-controller.js`
- Modify: `web-client/js/link-quality-controller.test.js`
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`
- Modify: `python-host/host.py`
- Modify: `python-host/test_quality_lock.py`
- Modify: `python-host/h264_videotoolbox_encoder.py`
- Modify: `python-host/test_h264_idr.py`

**红灯测试**

1. `decodedDelta == 0 && receivedDelta > 0`触发`decoder-stalled`关键帧请求。
2. ontrack、Viewer stall、Host stall在cooldown内合并成一次请求；aiortc直接产生的PLI/FIR只标记`rtcp-or-unknown`。
3. 新generation解除旧generation的cooldown与episode状态，但旧事件仍被拒绝。
4. intentional pause不触发。
5. decoder refresh只在已发IDR后连续两个样本仍未恢复时执行，单episode最多一次。

**实现**

1. 删除Viewer“inbound仍流动就不请求关键帧”的特殊排除。
2. 将请求reason与generation传到Host和encoder统计。
3. 将周期IDR、应用请求和浏览器反馈统一纳入一份cooldown/episode状态。
4. 保持relay stall不自动restart ICE、不改分辨率。

**验证**

```bash
node --test web-client/js/link-quality-controller.test.js web-client/js/webrtc.test.js
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m pytest -q python-host/test_h264_idr.py python-host/test_quality_lock.py
```

## Task 5：补编码与paint观测

**文件**

- Modify: `python-host/h264_videotoolbox_encoder.py`
- Modify: `python-host/test_h264_idr.py`
- Modify: `web-client/js/webrtc.js`
- Modify: `web-client/js/webrtc.test.js`
- Modify: `web-client/js/diagnostic.js`
- Modify: `web-client/js/diagnostic.test.js`
- Modify: `scripts/prove-turn-relay.mjs`

**实现**

1. encoder每5秒聚合`WRD_ENCODER_SAMPLE`，不逐帧刷日志。
2. `requestVideoFrameCallback`聚合paint interval、最长gap、presented delta和video几何。
3. 更新`prove-turn-relay.mjs`的当前DOM字段，增加`--duration-seconds`和`--output`参数；严格验证selected pair的local candidate为relay，不能只凭`networkMode=relay`通过。
4. proof输出只保留candidate type、protocol和RTT，删除IP与端口；启动headless browser前检查无活跃人工Viewer，否则明确退出，避免严格单Viewer顶替用户会话。
5. 未测得的`encoderMs / rtpSendMs / endToEndVideoMs`继续为null。

**验证**

```bash
node --test web-client/js/diagnostic.test.js web-client/js/webrtc.test.js
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m pytest -q python-host/test_h264_idr.py
cd signal-server && npm run build:web
```

## Task 6：选择relay-balanced-v2参数

**文件**

- Modify: `python-host/h264_encoder_policy.py`
- Modify: `python-host/test_h264_encoder_policy.py`
- Modify: `scripts/eval-turn-encoder-quality.py`
- Modify: `docs/superpowers/reports/2026-09-05-turn-quality-latency-acceptance.md`

**步骤**

1. 按spec第6.5节顺序运行GOP、bitrate、VBV矩阵。
2. 每次只改变一个变量；记录失败候选，不在失败参数上继续叠加优化。
3. 选择第一个同时通过画质、IDR大小、编码耗时和恢复门禁的候选。
4. 把最终常量写入`relay-balanced-v2`并写行为测试。
5. 没有候选通过则停止：保留Task 1–5，默认继续legacy，不宣称周期画质问题已修复。

**验证**

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 scripts/eval-turn-encoder-quality.py --matrix relay --output /tmp/wrd-relay-matrix.json
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m pytest -q python-host/test_h264_encoder_policy.py python-host/test_h264_idr.py
```

## Task 7：按证据优化采集开销

**文件**

- Modify: `python-host/host.py`
- Modify: `python-host/test_media_profile.py`
- Create: `scripts/benchmark-turn-capture.py`
- Modify: `docs/superpowers/reports/2026-09-05-turn-quality-latency-acceptance.md`

**步骤**

1. 测量capture线程grab、resize、frame conversion各自p50/p95。
2. 比较capture倍率1.0×、1.25×、1.5×；选择保持paint FPS的最低倍率。
3. 比较`INTER_LINEAR`与`INTER_AREA`，只在文字质量提高且耗时通过预算时改变。
4. 不在此任务引入新的capture Adapter或RTP sender patch；若证据指向更大重构，另立设计。

**验证**

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 scripts/benchmark-turn-capture.py --output /tmp/wrd-turn-capture.json
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m pytest -q python-host/test_media_profile.py python-host/test_latency_timing.py
```

## Task 8：完整自动化与文档同步

**文件**

- Modify: `docs/需求文档/WebRemoteDesktop-需求文档.md`
- Modify: `README.md`
- Modify: `docs/runbook-safe-startup.md`
- Modify: `docs/superpowers/reports/2026-09-05-turn-quality-latency-acceptance.md`

**步骤**

1. 更新需求文档中“GOP 1秒即延迟优化”的旧结论。
2. 记录policy回滚配置、canonical FPS、paint gap和排障顺序。
3. 不写入Viewer密码、Terminal密码或TURN凭据。
4. 运行完整测试，而非只运行新增测试。

**验证**

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m pytest -q python-host
cd signal-server && npm test
git diff --check
```

## Task 9：本地服务与真实TURN验收

**前置**

1. 重新阅读`README.md`与`docs/runbook-safe-startup.md`。
2. 记录`/tmp/wrd-safe-current-url.txt`内容，不修改它。
3. 用`python skills/webremote-service/scripts/wrd_service.py status`确认现状。
4. 检查`/api/status`没有活跃人工Viewer；若存在，停止headless proof并由操作者安排测试窗口。

**步骤**

1. Viewer和Host代码完成后先执行一次`restart-local`，使signal-server重新构建并托管新bundle，同时加载Host修复。
2. 只读取并保存`.env`中`WRD_RELAY_ENCODER_POLICY`原值；不得输出`.env`全文。用该单一非敏感字段切到`relay-legacy-v1`验证时间线与统计修复，再只用`restart-host`切到`relay-balanced-v2`，使用同一TURN节点和同一Viewer分辨率做A/B。
3. 默认720p运行10分钟，显式1080p运行5分钟；执行静止文字、滚动、拖动、暂停/恢复、刷新画面和一次有限丢包。
4. 记录spec第11节全部门禁；失败立即回滚legacy并保留日志。
5. 重启后从本机运行配置读取并回报`VIEWER_ACCESS_PASSWORD`与`WRD_TERMINAL_ADMIN_PASSWORD`，不得写入版本化文件。
6. 确认重启前后temporary quick tunnel URL完全一致；若变化，停止并报告异常。
7. A/B失败时恢复原policy值；通过时按spec保留v2默认。不得改动同一`.env`中的密码、TURN地址或凭据。

**命令**

```bash
python skills/webremote-service/scripts/wrd_service.py status
python skills/webremote-service/scripts/wrd_service.py restart-local
python skills/webremote-service/scripts/wrd_service.py restart-host
node scripts/prove-turn-relay.mjs --base-url http://127.0.0.1:8080 --duration-seconds 600
```

**通过条件**

- selected pair明确为relay。
- 720p和1080p满足spec第11.3节；用户描述的约1秒画质/画面脉冲不再复现。
- local signal/Host健康，URL未变化，输入与媒体暂停没有回归。

## Task 10：最终Review与交付边界

1. 对照spec逐条标注`PASS / FAIL / NOT RUN`。
2. 检查`git diff --stat`、`git diff --check`和`git status --short`，确认没有纳入既有用户文件、日志、截图或`.playwright-mcp/`。
3. Review必须覆盖：时间线正确性、模块深度、全局policy generation、编码参数证据、恢复上限、统计语义、文档同步和运维边界。
4. 有P0/P1失败则不得标记完成，不得把green unit tests当成真实TURN通过。
5. 用户未明确要求commit/push时停在可审阅工作树；若之后授权commit，使用窄范围staging并执行仓库commit closure检查。

## 完成定义

以下 Task 11–14 为 2026-09-06 用户要求继续后的纠正工作，沿用原 EnterPlanMode 路径和设计门禁。原始 Task 0–10 不重新派发；已合入代码保留，产品未验收项继续开放。运行结果见 `docs/superpowers/reports/2026-09-06-turn-pulse-followup-implementation.md`。

## Task 11：修正连续呈现采集器（已实施）

**范围：** `scripts/turn_runtime_collector.py`、`scripts/test_turn_runtime_collector.py`，必要时新增直接执行采集 JS 的 Node 测试。不要改线上 Viewer/Host、恢复协议或编码默认。

1. 先用实际 `SAMPLE_JS` 建立失败测试：帧回调 0ms 和 1490ms，采样 1000ms 和 2000ms；必须识别 1490ms 间隔，不能因帧龄为 1000/510ms 而通过。
2. 将采样帧龄明确命名为 `paintAgeMs`，另采集逐帧 `maxPaintGapMs`；持续无帧尚未结束也必须被检出。采用有界累计统计，覆盖 phase 边界、首帧等待、跨采样间隔、attempt 改变、video 元素更换、旧回调取消/失效。不得将其他 phase 的暂停/恢复间隔计入当前窗口，也不得让 tracker 重置掩盖当前窗口故障。
3. 采样中 `getStats()` 异步等待结束后的帧龄不能为负；采集 video 的 x/y/width/height 和变化范围，支持不大于 1 CSS px 的门槛。缺测、非有限值、attempt/尺寸变化必须诚实失败，不能沿用旧帧龄字段冒充完整证据。
4. 汇总检查每个区间及累计最大间隔，不因最终恢复或 FPS 中位通过而放过卡顿。旧 artifact 缺少新字段不能通过新门禁。
5. 修正报告语义；保持静止文字、输入和丢包等未执行项 `NOT RUN`。不能让采集器单凭帧间隔宣称画质脉冲消失。

**验证：** Python collector 测试和直接执行生产采集 JS 的确定性测试，包含 1490ms 反例、健康 20FPS、无首帧、持续 stall、phase reset、attempt/video 更换、异步统计期间的新帧、几何变化。允许本地纯合成页面，不得连接或抢占现有 Viewer。独立 review 后才能集成。

## Task 12：验证 Host 耗时机制与候选选择正确性

1. 只读分析捕获、缩放、颜色转换、PyAV 编码、线程池与调度路径，并检查当前进程/日志；将事实与资源竞争假设分开。没有受控证据不直接改捕获倍率、线程数或编码默认。
   - 已确认的事件循环同步工作：复用帧 `.copy()` 和 `VideoFrame.from_ndarray`；将它们及已有缩放统一在现有 `imgproc` 单线程池中顺序执行，每次返回独立 VideoFrame，PTS/time_base 在 await 后由 track 设置，不缓存或跨线程并发修改 VideoFrame/codec。
   - 优先保持原 ndarray 缓存、异常回退与尺寸语义；暂停、停止和分辨率切换期间不能返回过期帧。不得增加无界队列或额外线程池。
   - 先写失败测试证明构帧等待期间事件循环仍可执行心跳，再实现；用真实 PyAV 测试验证像素/格式/尺寸及逐帧 PTS。覆盖 fresh/reuse/fallback、暂停/停止和 profile 变化。
   - 只有确定性事件循环隔离与内容测试通过才保留代码。运行增益依然标记待实测，不用合成探针证明真实 FPS 达标。
2. 修复 `select_relay_candidate()` 遇到首个待验证候选就提前返回的问题：若后续候选完整通过门槛，应选首个完整通过的候选；否则保留首个离线合格候选等待运行验证；全部离线失败仍返回 `no-offline-winner`。先失败测试再实现。
3. 将发现的可验证耗时优化及下一组编码实验写入复核报告，保持一次改变一个变量。允许有界、低优先级的离线探针；有活动 Viewer 时不运行高负载矩阵，也不把离线结果当真实 TURN 通过。

## Task 13：复核、可用维护窗口验收与交付

1. 对 Task 11、12 分别进行 spec/质量复核，修复 P1 后执行相关测试及一次全范围代码审查。
2. 保留既有用户脏文件；只将本轮文件纳入分支。有活动 Viewer 时不重启或启动第二个 Viewer。
3. Viewer 退出且服务准备就绪后，按修正采集器重跑 720p 10 分钟、1080p 5 分钟及场景测试。无受控 Host 内容或隔离丢包环境时如实保留对应 `NOT RUN`，不能把它们替换为截图或 HTTP 限速。
4. 原编码候选未合格前保持 legacy；修好采集器不等于关闭画质/性能问题。后续部署遵循已授权的 main 合入与本地重启范围，tunnel 保持不动。

## Task 14：有界 VBV 细化实验（不改变生产）

已有候选中最接近目标的是仅按需 IDR、上限码率、VBV200；其强制 IDR PSNR 为 24.378/26.156dB，未达到 28dB。原 spec 允许 VBV 至 250ms，但旧矩阵只测到 200ms。

1. 在 `scripts/eval-turn-encoder-quality.py` 添加独立 `--matrix relay-vbv-refinement` 路径；保留旧矩阵及历史证据含义，不改任何 Host 生产准入、codec/preset/码率/GOP/capture 配置。配套纯逻辑测试可在长跑期间运行，实际编码实验必须等长跑结束。
2. 新路径首先新测同一基线：libx264 / ultrafast / Baseline / 20FPS / 仅按需 IDR / 720p 3.2Mbps、1080p 5Mbps / VBV200。然后只测 `on-demand-cap-bitrate-vbv225`；225 自身全部离线门槛通过则不测250，否则再测 `on-demand-cap-bitrate-vbv250`。绝不超过250ms。
3. 基线是测量对照，不要求其已经修复目标问题。它必须有完整有效的双分辨率测量、输入/版本记录、实际编码配置与有限逐帧结果；候选与基线只有VBV不同，输入、版本和其余编码参数须一致。丢失/非有限数据或参数漂移时立即停止本轮并标明原因；仅完整可比的225自身未通过离线门槛时才测250。
4. 候选自身仍必须通过 spec6.5 全部离线质量/按需IDR/编码时间门槛，所有真实 TURN/丢包/输入门槛保留 `NOT RUN`，因此默认policy始终legacy。不能因为基线测量完整就把候选全局PASS；不能用更高PSNR覆盖成本失败。
5. 先补纯逻辑失败测试：失败质量的有效基线不误阻挡完整合格候选；缺失/漂移基线仍阻挡；225通过短路250；225失败才执行250；二者失败保留no-offline-winner；无runtime证明不修改生产默认。
6. 独立复核后，在长跑结束且无活动Viewer时，串行低优先级执行一次该路径，保存双分辨率逐帧JSON及SHA256摘要。新增结果单独落盘，不覆盖9月5日历史矩阵，不据离线PASS开放生产v2。

## 总体完成定义（继续保持）

- 产品代码、测试、构建和文档均通过。
- 时间基错误已由单元测试和实际编码器时间戳probe关闭。
- 约1秒周期画质脉冲已由离线逐帧结果与真实TURN观察共同关闭。
- 720p真实TURN满足全部硬门禁；1080p达到目标或诚实记录限制，没有自动降分辨率。
- 服务、密码回报、tunnel URL保持和未执行项均按runbook闭环。
