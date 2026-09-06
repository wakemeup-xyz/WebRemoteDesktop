# TURN 画质脉冲与出帧耗时优化执行计划

> EnterPlanMode 路径的仓库内后续计划。沿用用户先前选择，不切换规划流程。For agentic workers: 实施时使用 superpowers:subagent-driven-development，Terra High逐任务开发并独立review；以下checkbox当前全部未执行。

**可行性状态：** 当前候选未通过实验，本计划是有界验证与优化路径，不能保证全部问题在这一轮解决。T2失败记NO_QUALIFIED_CANDIDATE，保留失败证据并进入后续设计；T7瓶颈未解决保持OPEN，均阻止T8推广。

**Goal:** 消除健康连接周期清晰度变化，降低Host生产流水线耗时，并完成真实文字、输入和有限丢包验收。
**Architecture:** 编码候选与吞吐优化分别验证。生产策略默认保持legacy，离线合格候选通过独立实验Signal/Host验证后才在单独提交中推广。
**Tech Stack:** Python3.11、aiortc/PyAV/libx264、MSS/OpenCV、Node/Socket.IO、Playwright、隔离Linux TURN fixture。
**Spec:** `docs/superpowers/specs/2026-09-06-turn-pulse-throughput-next-design.md`。
**Baseline:** main `91cf000`；历史Task0–14不重新执行。当前是计划交付，未授权由本次规划自动开始编码或服务实验。

**Review:** 两位Terra High分别完成架构/边界与执行/验收复审，PASS；详见 `docs/superpowers/reports/2026-09-06-turn-pulse-throughput-plan-review.md`。该PASS已由主线程补充自审限定；新发现与修订见 `docs/superpowers/reports/2026-09-06-turn-pulse-throughput-self-review.md`，不代表候选可行或产品已修复。

## 全局约束与执行入口

- 先读根AGENTS、产品需求和本spec；服务操作另读README、runbook与webremote-service skill。
- 原生产policy parser、控制lease、attempt/generation/profile-sequence、Quality Lock和恢复token必须保留。不得临时把v2环境配置放开以做实验。
- 不操作cloudflared、tunnel、URL文件、宿主机防火墙或其他业务进程。不提交密码、真实TURN端点、个人桌面截图、用户review-anchors改动。
- 每task按失败测试→最小实现→通过测试→独立review→窄范围commit。独立实验可并行开发，实际编码/桌面/网络负载实验必须串行。
- Python命令用本机已验证解释器；下文 `python3` 执行时解析为 `/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3`。不要误用系统Python环境。
- 新CLI均在相应任务实现后才可运行；此文不是声称这些命令已经存在或通过。
- 新证据目录：`docs/superpowers/reports/evidence/2026-09-06-turn-next/`；报告：`docs/superpowers/reports/2026-09-06-turn-next-acceptance.md`。

依赖图：`T1→T2`；T3和T4-legacy可独立实现；`T2离线PASS→T4-candidate`；`T3+T4→T5/T7`；`T4+T5→T6`；`T2+T5+T6+T7→T8`。T3的真实阶段验证依赖T4-legacy，纯测试不依赖T4。Docker daemon当前不可达，T6先验证设施，失败则标记BLOCKED并继续独立任务。

## T1：让preset真正进入codec配置（可独立交付）

**Files:** 修改 `python-host/h264_videotoolbox_encoder.py`、`python-host/test_h264_idr.py`、`docs/superpowers/reports/evidence/2026-09-05-turn-quality/encoder_probe.py`；必要的不可变实验参数只放 `scripts/turn_encoder_experiments.py`（新建），不把候选注册为生产枚举。

**Interface:** `libx264_zerolatency_options(bitrate_bps, gop, vbv_buffer_ms=100, *, preset="ultrafast") -> dict`；`_create_codec()` 使用 `self._policy.preset`。只允许ultrafast/superfast，未知值在创建codec前失败。

- [ ] 写失败测试，spy真实codec构造路径，不能只测options helper：
  ```python
  from dataclasses import replace
  import av
  import numpy as np
  from h264_encoder_policy import MediaSessionIntent, resolve_h264_policy
  from h264_videotoolbox_encoder import H264VideoToolboxEncoder

  intent = MediaSessionIntent("preset-test", 1, "relay", 1152, 720, 20, 0)
  legacy_policy = resolve_h264_policy(intent, "relay-legacy-v1")
  policy = replace(legacy_policy, preset="superfast")
  real_bgra_frame = av.VideoFrame.from_ndarray(
      np.zeros((720, 1152, 4), dtype=np.uint8), format="bgra"
  )
  encoder = H264VideoToolboxEncoder(policy=policy)
  codec = encoder._create_codec(real_bgra_frame, "libx264")
  assert codec.options["preset"] == "superfast"
  ```
  同时断言默认完整options与冻结legacy fixture相等；env设v2仍在Host构造前失败。
- [ ] 运行 `python3 -m pytest -q python-host/test_h264_idr.py python-host/test_h264_encoder_policy.py`，记录新测试失败。
- [ ] 实现keyword参数和真实调用；每次真实 `_create_codec()` 发出 `CodecCreationRecord(scenarioId, resolution, creationIndex, requestedPreset, submittedCodecOptions, generation, reopenReason)`。probe从调用现场收集，禁止重调helper生成回报。两种preset均验证每次创建记录匹配、缺记录或意外reopen失败；不调线程、码率或VBV。
- [ ] 用真实PyAV帧验证输出可解码、PTS单调、强制IDR token关联和无意外reopen；原测试转绿。
- [ ] Terra High独立review后窄提交 `fix(turn): honor explicit encoder preset without changing legacy`。

## T2：有界preset矩阵与成熟关键帧质量

**Files:** 新建 `scripts/turn_encoder_experiments.py`、`scripts/test_turn_encoder_experiments.py`；修改 `scripts/eval-turn-encoder-quality.py`、`scripts/test_eval_turn_encoder_quality.py`及原probe。旧relay/VBV矩阵输出意义保留。

**Interfaces:** `build_preset_experiments() -> tuple[ExperimentConfig, ExperimentConfig]` 返回spec4.2的对照和唯一superfast候选；`validate_comparison(base, candidate) -> list[str]`；`evaluate_preset_matrix(probe) -> dict`。ExperimentConfig固定包含id、preset、codec、profile、fps、bitrateByResolution、vbvMs、periodicIdrFrames和其余options digest，不接受可执行配置。

- [ ] 建立失败测试：真实传参仍为ultrafast、其余options漂移、缺失任意场景或帧、对照无效、NaN、意外IDR/reopen均拒绝；对照质量失败但完整可比允许测候选。
- [ ] 新CLI `--matrix relay-preset-refinement`；probe入口扩展 `evaluate_resolution(..., preset, scenario)`，把preset放入实际policy。使用spec4.2的ScenarioRun和五个必需场景，每档独立聚合，不复用旧65帧/一次IDR门禁。滚动后静止沿用同一encoder/decoder，索引300..599；其请求在305/500。每次请求IDR有唯一标识，成熟关键帧同样纳入28dB门槛。
- [ ] 安全网探针全新codec，0..1225不发送额外请求；bitstream需出现initial及1201的encoder-safety-net。未观察到、额外出现、PSNR<28、changeMAE>3或场景成本失败均不能OFFLINE_PASS；IDR bytes保留给T8缓冲门槛，不能只做观察。
- [ ] 健康逻辑序列与真实codec输出分开；输出configuredOptions、逐帧inputHash、PTS/IDR原因、decode/quality/encode结果、场景长度。码控QP若绑定无法可靠读取，记录null，不能编造内部原因。
- [ ] 纯测试转绿后，确认无活动Viewer，执行一次：
  ```bash
  nice -n 15 python3 scripts/eval-turn-encoder-quality.py --matrix relay-preset-refinement --output /tmp/wrd-next-preset.json
  ```
- [ ] 逐场景重算质量/成本/完整性；原门槛全部通过才生成冻结manifest，失败输出 `no-offline-winner`。所有runtime仍为NOT_RUN；失败不自动试其他preset或硬件。
- [ ] 归档JSON、源文件/配置/输入digest与复现命令，独立review后窄提交 `test(turn): evaluate one preset against a fresh controlled baseline`。

## T3：建立可信的流水线阶段耗时

**Files:** 新建 `python-host/media_stage_metrics.py`、`python-host/test_media_stage_metrics.py`、`python-host/rtp_frame_observer.py`、`python-host/test_rtp_frame_observer.py`、`web-client/js/webrtc.frame-trace.test.js`；修改 `python-host/host.py`、`python-host/h264_videotoolbox_encoder.py`、`python-host/test_latency_timing.py`、`python-host/test_frame_worker.py`及 `web-client/js/webrtc.js` 诊断接收。现有frame_timing字段保持兼容。

**Interface:** `FrameKey(attempt_id, generation, stream_id, capture_seq, encoder_timestamp)`；`FrameTraceRegistry.register_capture(key, frame_pts)` / `annotate_encoder(key, idr_kind, reason, policy_digest)` / `bind_wire(key, ssrc, wire_timestamp)`；`StageMetrics.record(key, stage, start_ns, end_ns)`；`snapshot(reset=False) -> dict`。字段/容量/TTL及 `frame_trace_batch` schema遵守spec5.1。Host在赋PTS时注册，sender-bound context把同一registry传给encoder，不能给PyAV帧随意挂可变属性。允许的stage仅 `grab/age_at_recv/worker_queue/prepare/build/reformat/encode/packetize/encode_total`，时间为Host同钟ns，输出单位ms。

- [ ] 使用注入时钟写失败测试：1ms/9ms两个样本的分位数、2048条上限、无样本null、跨generation拒绝、复用帧独立RTP身份、负区间拒绝；不能将不同线程的重叠阶段相加。
- [ ] 实现recv→encoder registry join；每流2048条/120秒、淘汰/冲突/跨generation显式失败。复用capture允许，输出PTS必须唯一。在MSS grab、worker和codec/packetize实际调用两侧加观测；不能独立测出的转换为null，不新增一次转换。
- [ ] 实现只观察的sender adapter：`_next_encoded_frame`返回时保存发送task/SSRC的帧描述，DTLS `_send_rtp`之前从真实RTP包头读wireTimestamp；确认随机origin/uint32回绕关系。排除RTCP/RTX/异步重传、空payload，版本/签名不匹配使关联失败而不影响正常发送。禁止直接用encoderTimestamp查rVFC。
- [ ] 新增端到端fixture：非零随机origin、uint32回绕、两帧/一次显式IDR、一次capture复用、一次generation切换、乱序/晚到diagnostic、RTX及冲突/缺失metadata。断言仅正确frame匹配ROI，缺配对不得PASS；零origin测试不足。
- [ ] 发送有界 `frame_trace_batch`（100ms一次、最多64条），Viewer按attempt/generation/streamId/wireTimestamp索引，晚到最多等2秒；丢diagnostic可继续视频但须使验收UNALIGNED。
- [ ] 每5秒生成有界摘要；捕获数、覆盖数、复用数、CPU时间和来源覆盖率与stage关联；禁止每帧同步log。
- [ ] 测试开/关观测输出像素、PTS和生命周期等价，新增阶段不触碰媒体策略；相关Python测试转绿。
- [ ] 在隔离Host用legacy运行相同60秒场景验证覆盖率及观测开销，缺少某关键阶段则不宣称已定位该瓶颈。观测带来可辨认回归时收窄采样后再测。
- [ ] 独立review后提交 `feat(turn): measure frame stages with monotonic bounded evidence`。

## T4：独立实验Host与不可绕过的生产边界

**Files:** 新建 `scripts/turn_lab.py`、`scripts/turn_lab_host.py`、`scripts/turn-lab-signal.js`、`scripts/test_turn_lab.py`、`scripts/turn-lab-signal.test.js`；修改policy provider的resolver依赖注入、Host策略selection构造方法及相应测试。复用Signal `createServerApp`，不改默认startServer。

**Interfaces:** `PolicySelection(policy_id, resolver, manifest_digest)`；`H264SessionPolicyProvider(*, resolver=resolve_h264_policy)`；普通 `WebRemoteHost._create_policy_selection()` 仅返回生产选择。`LabWebRemoteHost(verified_context)` 覆盖该方法返回已验证实验selection，resolver严格接受其policy_id，不忽略收到的legacy值。`LabRun.start(mode, manifest=None) -> LabIdentity(run_id, origin, epoch)`、`LabRun.close()`。mode只允许legacy/candidate，candidate必须有T2完整可重算证据。LabIdentity包含realm，不能混用生产和实验proof。

- [ ] 写失败测试：普通Host的v2 env仍拒绝、注入candidate参数TypeError；lab缺VerifiedLabContext拒绝；publish/refresh/重建均把准确实验policy_id传给同一resolver，收到legacy应拒绝；Viewer payload不能选择selection；未知manifest字段或hash不符拒绝。
- [ ] 实验Signal独立runtime、随机临时认证、loopback随机端口；拒绝8080/非loopback。Host SERVER_URL在import前设置，实验policyId明确标记experiment/digest。未取得生产proof或发现人工Viewer时不启动实验。
- [ ] driver监测生产admission epoch、人工Viewer与实验lease；生产Viewer接入、实验身份变化、子进程退出时停止实验及受控输入，清理自身PID/socket/临时凭据，不操作生产进程。finally与独立超时清理均覆盖测试。
- [ ] 先用legacy验证单Viewer、relay连通、暂停恢复与profile切换。T2不通过时禁止candidate模式，但允许legacy开发T5/T6。
- [ ] candidate模式逐帧验证运行policy参数digest与manifest一致，profile切换不得悄悄回legacy；不得修改PRODUCTION_RELAY_POLICY_VERSION。
- [ ] 运行 `python3 -m pytest -q scripts/test_turn_lab.py python-host/test_h264_encoder_policy.py` 与 `node --test scripts/turn-lab-signal.test.js`；独立review后提交。

## T5：闭合受控文字、输入和画面因果链

**Files:** 修改 `scripts/turn-runtime-controlled-producer.html`、`scripts/turn_runtime_collector.py`、`scripts/test_turn_runtime_collector.py`；新建 `scripts/turn_controlled_scene.py`、`scripts/test_turn_controlled_scene.py`、`scripts/turn-controlled-scene.test.mjs`、`scripts/turn_lab_input_guard.py`、`scripts/test_turn_lab_input_guard.py`。复用T3有界诊断，不新增输入旁路。

**Interfaces:** `ProducerProof(run_nonce, scene_id, origin, attempt_id, generation)`；`SceneResult(status, execution_mode, input_ids, ack_samples, visual_samples, failures)`；`run_controlled_scenes(viewer, producer, proof) -> SceneResult`。status取PASS/FAIL/NOT_RUN/BLOCKED/UNALIGNED，execution_mode严格区分spec7的automatic-isolated/operator-remote/producer-local；模式不能代替验收。producer必须在Host实际捕获画面中可见，Driver读取DOM只证明事件到达，不证明Viewer出画。

- [ ] 写失败测试：仅传controlled-producer-id、仅有截图、仅有applied ack、nonce不符、页面失焦、旧attempt均不得PASS，且不得继续发输入。
- [ ] 按spec7实现32×16格/双192bit/CRC32固定marker，不用OCR。测试两档真实H.264 encode/decode、压缩损坏、尺寸/缩放错位、nonce/校验不符；单帧两副本不一致即UNALIGNED，不跨帧拼接。
- [ ] 静止marker全部像素冻结，tick仅随明确场景/动作改变；测无marker/冻结marker对照，记录质量与成本影响。文字ROI排除marker和动态诊断，逐帧身份使用T3。增加静止60秒不变与动作后可解码转换测试。
- [ ] 实际自动输入前验证专用实验桌面和fixture窗口；lab input guard在实际执行边界再核对窗口，调用原InputAdapter/InputHandler。Quartz全局输入无法因focus预检变为原子目标绑定，禁止在共享个人桌面自动执行。没有专用桌面可由操作者从实验Viewer发送远程动作，driver只读采样，无操作者则BLOCKED。直接在Host页面操作为producer-local，只能证明场景/可见变化，远程输入gate保持NOT_RUN；增加测试禁止其清除marker_failures或进入推广predicate。
- [ ] operator-remote与automatic-isolated使用相同机器核验：真实Viewer inputId、Host applied ack、producer nonce/action状态、解码marker与Viewer同钟时延缺一不可；伪造inputIds列表、模式标签或人工确认都不能PASS。
- [ ] operator-remote必须有独立控制端及已有授权的loopback端口转发；不得在被捕获桌面自指操作，不因测试开启新的公网监听/远程登录或改tunnel。缺此条件则BLOCKED，不降级为producer-local冒充远程测试。
- [ ] 通过现有Viewer Input接口执行spec7固定序列，原lease/InputHandler链路不变。保存send→ack与send→visual两个浏览器同钟结果；20个必达文本样本不得用合并mousemove凑数。
- [ ] 接入实际视频ROI及T3的wire-RTP对齐；缺rVFC rtpTimestamp时marker只能证明场景身份，IDR-ROI门槛仍UNALIGNED，不补0或猜帧号。至少通过非零origin的端到端join fixture才可声称关闭IDR周期谷值。
- [ ] `marker_failures()` 只在SceneResult完整通过时取消固定NOT_RUN；无producer的既有collector保持旧失败语义。暂停恢复加入2秒计时门槛，不能只看最终freshFrame布尔值。
- [ ] 实现spec9的逐帧periodic-paint-stall门禁及有界导出，不能由每秒max重建时间。600次[50ms×17,150ms]必须FAIL；均匀50ms、孤立150ms、场景/暂停/generation边界、丢样本均有回归。先校验legacy/健康对照与开销，再冻结门禁，候选后不得放宽。
- [ ] 验证小于采样周期的瞬时画质/尺寸变化仍被捕获，IDR前后ROI不含Viewer浮层。运行collector Python、直接JS和新producer测试；实际测试必须经T4。
- [ ] 独立review后提交 `test(turn): verify controlled input and decoded scene identity`。

## T6：建立隔离的真实TURN有限丢包fixture

**Files:** 新建 `scripts/turn-loss-fixture/README.md`、`compose.yaml`、`controller.py`、`test_controller.py`；在T4 driver接入独立fixture清单，不给生产collector增加通用--loss开关。

**Interface:** fixture清单含runId、媒体路径realm、允许的namespace/接口/UDP leg selector、控制端点、临时凭据文件引用、版本digest；`apply_loss(run_id, pattern, duration_ms)` / `clear_loss(run_id)`。控制器仅接受 `every_100th_for_30s` 和 `all_for_200ms` 两个枚举，最长35秒强制撤销。

- [ ] 先检查Docker daemon或已提供的隔离Linux环境；当前daemon不可达须记BLOCKED，不凭docker二进制存在宣称可跑。实际启动既有运行时后才能继续；无可用设施时其他任务可继续，T8禁止推广。
- [ ] compose/namespace固定测试TURN的监听与relay范围，独立凭据和资源标签；容器镜像解析到digest并归档。NET_ADMIN仅在隔离fixture，不使用host networking或host pid namespace。
- [ ] selected TURN/UDP链路建立后，从实际媒体路径取得allowlist selector，先做无损dry-run计数证明流经注入点；source/destination/端口不能凭默认值猜测，零计数即失败。
- [ ] 测试控制器拒绝生产realm、宿主接口、越界持续时间、错误runId；超时/异常/连接断开撤销成功。保留接收序号缺口和实际drop计数，控制通道不能被规则匹配。
- [ ] 经T4/T5各执行一次固定有限丢包，中间健康10秒；2秒恢复、IDR请求/输出/新画面关联、无Peer重建/分辨率变动全部检查。
- [ ] 归档真实网络fixture与媒体证据；不能用sender hook或HTTP限速结果替代。独立review后提交fixture及报告，未执行保留NOT_RUN。

## T7：依据阶段数据优化吞吐，每次一个变量

**Files:** 修改 `python-host/host.py`、`python-host/test_frame_worker.py`；扩展T4 driver和新 `scripts/turn_capture_experiments.py`、`scripts/test_turn_capture_experiments.py`。实验配置只由T4内部注入，生产默认保持现状直到选中。

**Interface:** `CaptureExperiment(capture_multiplier, opencv_threads)`；`evaluate_repeated_runs(aba, bab, declared_cost_metric) -> dict`按spec5.2的六次run范围计算，只返回candidate-requires-confirmation/INCONCLUSIVE/无收益，不以手写PASS选择。capture策略构造时固定，暂停/profile更新继续读取合法targetFPS。

`ScreenCaptureTrack(..., *, capture_strategy=None)` 的None保留当前采集公式；普通Host `_create_screen_track()` 传默认值，Lab子类override该工厂注入冻结实验策略。替换原Host的直接构造调用，不允许事后私改track倍率。OpenCV线程仅Lab启动前设定。

- [ ] 失败测试覆盖目标20时新候选采集20Hz、legacy40Hz；暂停不采集、恢复新帧、无旧尺寸、PTS递增及输入效果。缺样本、场景不一致、顺序结论反转和事后切换成本指标均拒绝筛选，不做逐帧独立样本的显著性推断。
- [ ] 保持legacy编码，以T5受控场景运行两档A/B/A及B/A/B各60秒：只改capture 2x→1x，每档六个独立会话。保存整个窗口和run级分布，不选择最好小段。
- [ ] 按spec预声明指标比较三次A/B范围，只得到待确认候选或INCONCLUSIVE/无收益，不以任意10%认定成功，不追加重复直到变绿。
- [ ] 只有阶段证据指向resize主导才实施OpenCV单线程独立六次实验；进程启动时设置，失败capture候选不叠加。线程实验遵守同一run级规则，最终仍需原产品门槛。
- [ ] 将胜出的吞吐参数与T2离线合格编码候选组合，在T4再跑完整场景；独立单项通过不等于组合通过。
- [ ] 如果encode仍超过预算，输出实际reformat/encode/packetize贡献，停止宣称吞吐已解决；进入独立硬件/编码后端设计，不在此任务顺手迁移后端。
- [ ] 独立review后提交只有证据支持的实现；实验失败则只提交诊断/实验与失败报告，生产参数不变。

## T8：合并验收、冻结策略与可回滚发布

**Files:** 原policy/Host生产参数、对应测试、README、`docs/runbook-safe-startup.md`、产品需求、本轮acceptance报告、原验收报告的最新状态链接。仅此任务可在已验证条件下开放固定v2，不能发布manifest加载器。

- [ ] 汇总T2/T5/T6/T7完整证据及源代码hash；同一冻结配置须全通过，任何BLOCKED/NOT_RUN/FAIL阻止推广。producer-local和只有人工可读性观察不能满足远程inputAck gate，必须有spec7完整远程因果链，不按executionMode标签放行。
- [ ] 实验环境下按修正collector跑720p600秒、1080p300秒，保留逐帧gap分位数、freeze、buffer、IDR/ROI、loop lag和input ack；按原硬门槛及spec9新增周期短停顿门禁评估，不能只看退出码或连接正常。
- [ ] 按spec6区分完整源码hash与encoderParameterDigest，生成唯一参数集发布提交；逐项审查固定策略注册/默认选择/已验证吞吐常量的推广差异，测试实验与生产参数相等。若改codec/Host/观测/采集实现，受影响证据作废并重跑。更新 `PRODUCTION_RELAY_POLICY_VERSION` 与参数解析必须同时发生，env未知值拒绝仍保留。测试确保无placeholder GOP20回落。
- [ ] 完整回归：
  ```bash
  python3 -m pytest -q python-host scripts/test_turn_runtime_collector.py scripts/test_eval_turn_encoder_quality.py scripts/test_turn_encoder_experiments.py scripts/test_turn_lab.py scripts/test_turn_controlled_scene.py scripts/test_turn_lab_input_guard.py scripts/test_turn_capture_experiments.py scripts/turn-loss-fixture/test_controller.py
  node --test web-client/**/*.test.js
  node --test scripts/turn_runtime_collector.sample.test.mjs scripts/turn-lab-signal.test.js scripts/turn-controlled-scene.test.mjs
  npm test --prefix signal-server
  git diff --check
  ```
- [ ] Terra High独立审查代码、架构边界、实验/生产证据与文档；修复所有P1后再合入。保留用户脏文件，只stage本轮文件。
- [ ] 已授权实施后的维护窗口合入main，仅用service helper/restart-host脚本重启本地服务。核对Host配置和帧日志为冻结参数，tunnel hash/PID不变，并从运行配置回报两项密码。
- [ ] 最终生产selected-TURN窗口重跑720p600秒/1080p300秒及受控交互；丢包仍只在专用fixture进行。生产结果与实验fixture属于不同证据层，不把后者冒称正式公网验证。
- [ ] 单独运行spec9原报告客户端/入口的最终复验，记录浏览器、DPR/缩放、实际TURN路径和Host负载。机器门禁与操作者观察均通过才记USER_SCENARIO_PASS；未运行记USER_SCENARIO_NOT_VERIFIED，不用本地生产长跑替代，不在生产注入丢包。
- [ ] 生产失败：仅回滚本轮固定policy/吞吐参数并重启本地Host，保留有用观测，重新检查健康与tunnel；报告总体FAIL。生产及原用户场景全部必需项通过后才可声明本轮画质脉冲和性能验收完成；观察到残留脉冲则问题继续OPEN。

## 交付状态枚举

`IMPLEMENTED` 表示代码与自动化通过；`OFFLINE_PASS` 表示所有场景质量/成本合格；`LAB_PASS` 表示隔离TURN、输入、丢包通过；`PRODUCTION_PASS` 表示冻结版本的真实生产维护窗口通过。`BLOCKED` 说明设施/受控场景缺失；`INCONCLUSIVE` 说明测量或环境不可比。`USER_SCENARIO_PASS` 才表示原报告客户端场景也已验收；缺失为USER_SCENARIO_NOT_VERIFIED。任何前一层状态不能代替后一层，也不保证所有客户端/网络条件永不抖动。
