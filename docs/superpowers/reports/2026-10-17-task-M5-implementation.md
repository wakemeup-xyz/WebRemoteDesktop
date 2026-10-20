# M5 联合媒体资格门禁实施记录

日期：2026-10-17。工作区：`reliability-latency`。依据：媒体 spec §7.1、Task M5 brief。真实资格状态：**NOT RUN / disabled**。本记录是实施者自查，独立 review 由主任务另行安排，不能据此声称已独立通过。

## 完成范围

- `QualificationContext`、`MeasuredPolicyDecision`、纯资格校验及 selector：完整身份/tuple、五场景最小样本、encode P95、critical IDR PSNR、initial/safety 和 periodic MAE、超时/丢帧/合同错误、3 小时 runtime/ACK/loop 和正常资源证据均为门禁。拒绝 bool 伪数、NaN、缺字段、重复场景。资源样本保留当前 RSS、swap rates 和队列数值，没有引入新资源压力阈值。
- Host 新增 dormant `_request_measured_media_policy`：本地 context/qualification 默认均为 None，没有 Socket/DC 或其他生产调用入口；拒绝跨 path/尺寸/attempt/generation/profile scope。资格拒绝时不调用 apply；通过时一次请求既有 coordinator/codec-open observer，staged/rejected 的 applied 保持 false。未接入既有启动 fallback 或用户显式设置，不改 C2 authority、M3 quiescence 或 M4 capture provenance。
- 固定 `latency-joint-v1` 共 24 个配置：20/15/12 FPS × 四种准确尺寸 × libx264/VideoToolbox，相同尺寸始终固定相同 peak 码率/VBV/preset。15/12 peak tuple **未扩展**到生产 resolver。
- raw validator 实际调用现有 `_evaluate_resolution_gates` 和 `validate_full_matrix`；joint 参数仅改变明确的 FPS/PTS、尺寸预算及候选 GOP 期望，保留原质量、codec reopen、options、bitstream 和成本门禁。补充 source-hash manifest、逐帧 codec instance、配置与 request-token 一致性、timeout/drop、有限数值检查；摘要从原始帧重算，拒绝时不生成 qualified 产物。
- `_evaluate_resolution_gates` joint pulse 使用 0.8–1.5 秒，不能复用 20 FPS 的 16–30 帧常数；PTS 为 90000/FPS。critical IDR 包括 on-demand、initial、safety；initialSafety 排除 on-demand；零 periodic 样本 MAE 为 null。
- 新 CLI 路径实际调用既有 synthetic producer；producer 仅在 joint 配置下使用目标 FPS、准确尺寸和完整 policy，并保存真实 codec 名称/GOP 及来源哈希。legacy 分支仍用原 20 FPS/default resolution。现有 joint producer 的硬件路径没有完整资格支持，CLI 与 raw validator **显式 unsupported**，不接受空 options 作为硬件合格证据。
- 纯 raw → summary 函数可用于独立离线验收导入；CLI 本身只产生离线原始结果，runtime 恒为 NOT RUN。不存在可凭自报 `passed:true` 跳过 raw 门禁的生产入口。

## 红灯与绿灯

所有测试纯数据或 fake 依赖；没有启动 Host/Signal/Viewer、网络连接、native input、抓屏或真实编码，没有重建 dist/安装依赖。

1. 红灯：`(cd python-host && python3 -B -m unittest test_media_policy_selection -v)`，首次有效运行因 `QualificationContext` 不存在而 ImportError，符合新增 selector 红灯；未把旧 FPS fallback 当作 green。
2. 绿灯：同命令，**8 tests PASS**。完整 fixture 先由真实 raw validator 生成，再用于逐项门禁/缺字段/NaN/bool/Quality Lock/合法 candidate/Host fake coordinator 测试；没有 mock validator=True。
3. 绿灯：`python3 -B -m unittest discover -s scripts -p test_media_latency_qualification.py -v`，**8 tests PASS**，包括逐帧 PTS/inputHash/IDR/codec instance/options 篡改、质量、失败计数、runtime/resources、hardware unsupported、24 配置和 fake runner。
4. 绿灯：`python3 -B -m unittest discover -s scripts -p test_eval_turn_encoder_quality.py -v`，**17 tests PASS**（含 2 个 joint CLI/真实 probe 函数的 fake codec 测试）。其中 fake codec 测试曾以 15 FPS 仍产生 4500 而红灯；修正到实际 `_scenario_run` 后为 6000，12 FPS 为 7500，20 FPS 为 4500。错误落到 legacy 的初始编辑已撤销，没有留下旧入口行为改变。
5. 绿灯：`python3 -B -m unittest discover -s scripts -p test_turn_encoder_peak_headroom_experiments.py -v`，**3 tests PASS**，原有冻结 peak config/options 和 on-demand MAE 语义不变。
6. `git diff --cached --check` 在精确暂存后运行；提交只纳入 M5 文件/新增需求段落，排除原需求文档 7 行脏改动及其他任务。

## 验证映射与自查

| 契约 | 验证 |
|---|---|
| N3 无资格不得自动转软件 | missing qualification 的 15/12 FPS 保持 current；Host apply 调用数为 0 |
| 全字段身份/tuple/scene/runtime/resources | 独立 raw fixture 生成摘要；逐项缺失、篡改、bool/NaN、Quality Lock 拒绝 |
| Raw 完整门禁 | 真实复用旧两个 validator；逐帧 PTS/hash/IDR/quality/options/codec 检查与 violation 计数 |
| Coordinator 结果诚实 | 合法 candidate 仅调用一次；stale coordinator 拒绝不返回 applied；capture/intent/generation 未提前写入 |
| Legacy 和显式设置边界 | Host 仅新增局部 dormant method/None context；legacy probe 默认分支与两个旧门禁默认行为保留 |
| 资格与实测分离 | 所有 CLI 离线结果 eligible=false，runtime NOT RUN；hardware unsupported；无部署或自动重试 |

自查特别限制：当前没有本地资格安装路径或自适应调度器；未来启用必须先提供经独立复核的真实矩阵和 runtime，并绑定 Host 本地 context。这个提交建立保守门禁和测试，不宣称当前生产 codec/15/12 FPS 已获得新资格。

## 后续维护窗口（本轮均 NOT RUN）

未来受控维护窗口可运行：

```bash
python3 scripts/eval-turn-encoder-quality.py --matrix latency-joint-v1 --output /tmp/wrd-latency-joint-evidence.json
```

真实硬件 producer 仍需补足契约并单独 review，不能忽略 unsupported。真实 direct/TURN/Socket/JPEG、正常/慢 worker/压力分桶、完整 W loop/资源窗口、业务 ACK、RTP+rVFC+marker 可见效果、设备与光学测量、每路径至少 3 小时会话均 **NOT RUN**。没有资格前继续 disabled，不把 fixture PASS 当作真实延迟达标。

## R1：独立 review 两项 P2 整改

冻结 `47cd1c5` 的独立 review 未通过：新自适应入口缺少 C 当前 authority/coordinator 约束，且 raw 资源摘要能抹掉完整窗口的失败计数。本轮只修这两个 M5 问题；不改旧 startup/显式 profile helper 的既有行为。

- Host 在进入真实 `_apply_encoder_bitrate_kbps` 前校验现有 C authority snapshot、active viewer/lease/attempt/attempt sequence/connection generation，以及 coordinator 已绑定 attempt 和 pending/current 的 generation/profile 顺序；纯 selector 返回后再次检查 authority snapshot 与 coordinator 对象/attempt。不能让自适应入口调用旧 helper 的 rebind 路径，缺失 authority 或有更新工作时直接拒绝，保留 pending、统计和 sender/encoder 状态。
- Host 测试现在 AST 提取实际 `_apply_encoder_bitrate_kbps`、`_capture_authority` 和 `_authority_matches`，只将 encoder/sender 替换为 fake；移除了会绕过 helper rebind 行为的测试 stub。覆盖不同 attempt 的新 pending、同 attempt 较新 generation、校验期间 authority revision 变化、缺少/不匹配 active binding，以及正常路径实际 stage 一次且 applied=false。
- raw 资源证据必须包含完整 sampler 的 condition、sampleCount、unknownCount、pressureWarningCount，count 必须是非 bool 整数；condition 必须 normal，unknown/warning 必须是实际零值，sampleCount 必须与完整保留 samples 数量一致。所有行仍需完整正常。摘要原样保留这些已校验结论，不能通过单行 normal 覆盖全窗口 pressure/unknown。

R1 RED：

```bash
python3 -B -m unittest discover -s python-host -p test_media_policy_selection.py -k HostAdaptiveAdapterTest -v
python3 -B -m unittest discover -s scripts -p test_media_latency_qualification.py -k complete_window -v
```

前者 5 tests 中 2 FAIL：真实 helper 对 missing/mismatched authority、旧 attempt 都发生了一次 encoder stage；后者 1 FAIL：raw resources condition=pressure 时 validator 返回 `[]`。这是新增回归先运行于未修代码的实际结果。

R1 GREEN：

```bash
python3 -B -m unittest discover -s python-host -p test_media_policy_selection.py -v
python3 -B -m unittest discover -s scripts -p test_media_latency_qualification.py -v
```

分别 **11 tests PASS** 与 **9 tests PASS**。raw-to-summary 额外覆盖 condition=pressure、unknown/warning 非零、sampleCount 不一致、bool/NaN 和完整窗口字段缺失，均拒绝 summary 产物。仅运行上述纯定向测试；没有重跑无关 I1 失败项或大范围 suite。

R1 自查：修改限 M5 Host adapter、raw summary、两个测试与本记录；不改 shared coordinator、C authority 实现、旧 helper 或任何服务。真实 codec/设备/公网/光学/3 小时资格仍 **NOT RUN**，硬件 producer 仍 unsupported，自适应仍 disabled。整改提交后等待再次独立 scoped review；本实施者记录不代替独立 PASS。
