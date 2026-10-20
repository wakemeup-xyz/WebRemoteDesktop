# Pacing v2 / R4-fix1 静态兼容性与资格缺口

**当前 NOT ELIGIBLE。** 本任务收到的事实是R4F1已加载、只读readiness通过，根代理正在准备新baseline，尚无该基线成功结果。本报告不读取/推断稍后可能新建的baseline输出，不预填PASS。仅静态有界代码/契约/既有证据核对；没有运行driver、导入操作模块、Git命令、测试、进程/状态/网络/日志/浏览器/native/sample/build/service操作，没有创建执行票据、nonce或上下文。仅此新0600报告写入。

## 已加载事实与保留失败

当前source归档41c7b0998859a7e9d088cefcc0f3a1eeab190684，Viewer fefc555aea9640b563bfd22f5b36b6b8ca6365ec，工具2822441791b59a021556c7e4eb24715df9d5b277，Signal/Host代码dfb15434e79da90b803b763c533836e16c080c71，diagnostic module35不变。现有真实记录：四文件apply SHA4eb2f339a6c0f3035e7ba7204ae78c658f247c5e4e790f9cd6b9eb05b02c1ad0；Signal33179/birth1792348311.587397，同Host36877/birth1792322600.528357；Viewer builda3671ba674ad7516/builtAt1792348315201及完整14文件图。readiness SHA1064eeaa41ac546ad9bd22d3ee05f5042be75f2423edda82f3f0137f0e60a74c 为runtime-ready-observed/errorClass=null。

原reload SHAff6ff0b8b356c1f889dea3e0b1d39d68c527678066390711c4f28f41907b410f 仍failed-or-indeterminate/errorClassRuntimeError，helper observation-unavailable未被改写。continuation_common.ready_context→readiness_records.reload_record使用原有reconcilable_helper窄规则追踪同一reload、成功apply、实际新Signal/原Host、runtimeValidation及quiescence；readiness是合法只读重对账，不是重新restart、放松门槛或完整进程树证明。pacing读取当前attempt_context时会沿此既有链，不要求把原reload强改成completed。以上来自已存记录，不是本任务的新鲜健康检查。

## 静态接口核对

| pacing v2调用 | 当前R4F1/工具事实 | 结论与限制 |
|---|---|---|
| load_ops + package_guard | continuation_common及ordinary-continuation-supervisor均为定义入口；manifest/独立审批逐文件校验，目录绑定 | 可绑定R4F1精确manifest；不能沿用历史R3/R5包或以路径名推断批准。新的Python解释器需防既存模块缓存串包，已有common.__file__父目录检查会拒绝不符。 |
| attempt_context(SimpleNamespace attempt_dir/attempt_sha256) | 返回path,sequence,reference,attempt,manifest，并填args.runtime_manifest_sha256；沿ready_context构建_deployment、expectedServices、assets、componentTrees | v2读取这些字段及参数的形状相容；实际成功baseline和其runtime manifest必须属于该精确包/sequence/部署。 |
| check_runtime_binding(manifest,bm,reference,pins,admission=True) | schema1 exact keys；baseline/relay、新nonce；后端dfb树hash，Viewer来源fefc及实际build；origin和signalLog、有效时间 | 当前接口相容。工具282由sourceFiles/attempt_context固定；没有在manifest中把工具TIP冒充后端/Viewer。 |
| Rows / ObservationGate / load_passive_validators / completed_result | 当前R4F1相同调用签名；严格行、状态/latch及summary/lifecycle验证；completed_result(out)读取out/session | v2 prior_output/session与新folder/session布局相容，所有行先过真实消费者。最终terminal sample能否供media()取得观测transport/分辨率，仍须用实际成功baseline证明，缺失时拒绝，不填默认值。 |
| source_assets_guard、health(require_idle=False) | 当前前者执行实际asset_context+完整live source/dist检查；health默认严格idle，False只用于终态health | 调用相容；未缓存live数据。v2另核对确切Host/Signal/tunnel/watch身份。它不直接调用R4 current_gate/service_set的全局lsof/candidate-uniqueness门槛，因此不能声称执行了完整部署所有者门槛；这是原诊断契约的已知PID观察范围，需最终集成review明确接受，不能偷换成global exclusive-owner证明。 |
| runner._gates(sample,'relay') / native CLI | 当前282提供该签名；--origin,--mode,--scenario,--runtime-manifest,--runtime-manifest-sha256,--runtime-config,--output-dir均存在；基线仍300s | 未见参数/签名破坏。admission detach被纳入原cleanup coordinator，无需v2改producer或生命周期schema。 |
| 原SUP Registry / SampleObservation / sample_limits | v2固定SUP SHA d03cc202…，直接Registry；R4普通wrapper使用module35 instrument_registry | v2并未获得context-decorated诊断字段，不能声称它与新版wrapper有同一错误定位能力；原coverage/signals veto仍有效。无须为兼容擅自改SUP/Registry，未来若需context数据须另行窄修改/review。 |

未发现必须为fefc/282/R4F1更改CLI或上述函数签名的静态不兼容。当前结论是“候选静态相容”，不是已做真实接口集成、原始Registry平台覆盖或执行批准。当前原代码/包一字未改。

## 执行前仍需成立的事实与时序

1. 根先完成该精确R4F1部署的新baseline300：qualification-result必须observed-qualification-completed、scenario baseline、sampleTriggered=false、durationSeconds300，精确attempt/result哈希，完整samples行数及summary/lifecycle可被原消费者重验。不能用旧三次失败、cleanup-incomplete、readiness PASS、离线结果或带sample的baseline替代。若新baseline触发过普通unexpected-stall sample，v2拒绝本次前置资格。
2. baseline currentReadiness.observedAtEpoch距诊断初始检查≤900s且无倒退；旧baseline runtime manifest在attempt_context检查时也必须尚有效。v2读取完成标记outputDirectory，重验每行与terminal qualification，并取最后一行sample的真实codec/分辨率/transport类型作为新会话比较值。缺行、null、未知transport或漂移都不是通过。
3. 先完成耗时审阅/所需输入准备，再由根产生新diagnostic-only decision；createdAtEpoch初次及worker前均≤60s且不倒退，不延长/绕过。R4批量Git优化有助于减少fork，但v2 admission仍会重复context/source资产与行重验，不能保证60s内；若超时必须保留拒绝，不自动freshdecision/freshq或重跑。900s资格和runtime余量同理不得预设足够。
4. 决策绑定pacing manifest fd58e215…、ops manifest bcd09baa…、真实baselineAttempt/result及新runtimeManifest；experimentId/runNonce新的独立32hex，排除代码检查到的旧baseline attempt/sequence/nonce，另由根保证不复用其他历史身份。nonce文件和experiment目录独占创建，旧记录不覆盖。pacing不消费普通sequence的within/after/continuity reservation，也不能产生可冒充普通qualification的结果。
5. 新runtime manifest在baseline完成后创建，新的runNonce、baseline/relay、实际后端树/Viewerfefc/builda367及原baseline相同deploymentEvidence/originEvidenceSha256/signalLog。admission要求创建≤900s、有效期剩余至少420s（300+120），最长12h；实际driver上限428s另加cleanup/最终重验，因此根必须给合理足够的原始有效期，不能把420s当必然足够或事后延长。
6. fresh strict idle两处重查，server vacant-only admission/单Start保留人类优先；只要人类Viewer、pending intent或拥有者冲突出现，拒绝/停止，禁止reclaim/clear。不要与within-grace、after-grace或continuity同时运行。诊断独立占用一次300s会话；其干扰和时间不计入任何资格，之后下一普通场景仍须新的root decision/fresh idle，不能把诊断结果当predecessor。

## 已知身份范围与不会自动关闭的缺口

v2对新成功baseline结果的owned/sampleOwned已记录PID+birth逐一即时验证gone（NoSuchProcess）、zombie或不同birth；alive同身份或unknown拒绝。它不枚举ambient children或未知进程，不信任退出标签而省略fresh检查；但该范围不是所有历史21身份的额外fresh扫查，也不证明fulltree。旧三失败/21身份仍由R4部署链保留；若根还要求运行前额外重验这些历史knownIDs，应以单独经批准的有限证据处理，不能声称v2已经做过。

Host36877必须两pidfile一致、birth/status前后稳定，sample前后及监督tick继续核对；Signal33179与tunnel/watch在前后按已知身份核对，quick URL仍应不存在。新诊断Registry只拥有自己创建且登记的worker/sample。登记失败只能观察保留的Popen至原deadline；不能按未知PID补找或发signal。worker428s、sample10s和各自有界cleanup不升级为硬实时保证。原helper reload的observation gap与完整树UNKNOWN不会被新诊断健康或退出0消除。

## 触发与归因边界

先从Host当前EOF开始读取，非旧日志回放；同device/inode、不截断、≥250ms poll，64KiB/read、32KiB/line、2MiB总量，最多20投影/128KiB。只接受严格host_event_loop_lag/capture cadence schema、connected/high/target20/minInterval50、无clip/failure/discontinuity/counter reset。新会话首个有效媒体baseline起算，10–60s稳定窗口；Viewer文件已完整drain且mtime≤1.5s、最新Viewer≤1.5s、Host事件≤2s、完成age≤1000ms。首个Host投影只是seed；第一次严格更新的闭合interval且pacingExcess≥100ms才消费唯一sample令牌。历史max、重复interval不触发。

若只有seed、缺Host投影、过期/窗口外记录或缺新interval，结果INCONCLUSIVE并保留有界missing reason。只有实际新鲜有效coverage且始终低阈值才能NOT_TRIGGERED，它不证明问题消失。采样只允许一次 /usr/bin/sample 对确切Host，3秒/10ms、8MiB0600文件、外部10s观察；raw sample/stdout前缀保持私有。该会话被标为diagnosticPerturbed=true、qualificationCreditSeconds=0。采样引入的暂停/调度效应不能混入未经干扰的baseline或其它资格。

capture native TID仍null/UNKNOWN，因此任何触发结果都INCONCLUSIVE，即使采样exit0和日志完整。Host事件约5–6s发出一次；新鲜事件时间不是异常开始时刻，同PID/birth不消除check-to-attach race。不能仅凭栈认定GIL、QoS、App Nap、kernel、资源压力或某未知进程是唯一原因；idle loop lag与active capture pacing是不同上下文。该工具本身不是idlelag采样器，必须有真实active媒体；无媒体的idlelag不能满足其触发条件。六input/可见/物理指标继续null/NOT_RUN。

## 既有纯证据与必要的下一步

v2 scoped review关闭两项修正，23纯PASS真实但没有平台运行；whole-driver fake checker5路径PASS/7 audit selfchecks已独立Approved-offline-only。该checker替换了ops/core/context/Registry及普通Rows/ObservationGate/completed_result/_gates，不能证明当前实际R4F1接口和真实native-shaped行契约。当前R4混合producer→consumer离线证据也不是pacing驱动集成证明。

最小后续步骤是：先等真实未采样baseline结果，再独立复核本静态接口与准确输入绑定；若要求可执行级接口闭合，另经授权准备/运行小型全fake边界检查，使用真实R4F1 attempt/strict consumer/282 producer形状替代旧checker的简化接口，仍不接触live系统。缺失该批准前不从旧whole-fake PASS推导可执行资格。然后由根决定是否签发独立诊断execution review/decision/runtime manifest。当前不要求改pacing/source，也不制造这些记录。

## 读取证据（SHA256）

- state.json 读取快照 `8c8173fafc052b9a437ac7dc25719150cc18ee8225d2157f8a0115cc9f8e9d4a`（可变汇总，不代表持续实时状态）。
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-capture-pacing-private-v2-fgbxntxg/SHA256SUMS.json` — `fd58e215e2218e2b33a04932c14ed16f36001e191882280040431766a86283a1`，1463 bytes。
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-capture-pacing-private-v2-fgbxntxg/run-experiment.py` — `bd7f26f537a88177cd803640ad34385af70ce38c3d392a05ae05254ab8cd9071`，19420 bytes。
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-capture-pacing-private-v2-fgbxntxg/pacing.py` — `37033af442fd327dd8d126651a80b020c4a8bb1e405f8d04007d0dc688e8a2c9`，8716 bytes。
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-capture-pacing-private-v2-fgbxntxg/CONTRACT.md` — `1cc38c6fdf22fba940610c37a5849f8ab0aeef8fa4b0d6eaee25bc8682983622`，9516 bytes。
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-capture-pacing-private-v2-fgbxntxg/REPORT.md` — `8844f10cabe7f05182baa1da3674d9a0557d31efde2d01d7faf8533a25f4d946`，7460 bytes。
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-capture-pacing-private-v2-fgbxntxg/amended-full-GREEN.log` — `91c2ba95e92bfca879c1a6e1d78c1c670886913bd7f86a83d861f8d765257fd0`，3197 bytes。
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/SHA256SUMS.json` — `bcd09baaa0b0936e7424cd0dea5e51fb067503399ca49d3a236e789fc0fa6861`，6096 bytes。
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/continuation_common.py` — `d0fe02e028f6c5ba3b27f67628639f99d7c4d835f8eaeaf7ed569bf36870c897`，13902 bytes。
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/ordinary-continuation-supervisor.py` — `b485f982befac8e284861af24e6684b006850b67c43847219a5503ec234308df`，13626 bytes。
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/qualification_evidence.py` — `ea398d2260c405a6115808c3c5f3f975974974e62bc6cb88be61c414e0c941b4`，21711 bytes。
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/readiness_records.py` — `ce35cf06b063e700fe693301608e63a6de4232fb20d91c6a62472868dce1edc9`，1948 bytes。
- `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/owned_reload.py` — `3ac947969760350f8c09ed5cc7b2c069a4f1eca2d152eb69f2cccad9e851320a`，5405 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/deployment-1a71096791fb71844ae08c95c50fb9cc/apply-result.json` — `4eb2f339a6c0f3035e7ba7204ae78c658f247c5e4e790f9cd6b9eb05b02c1ad0`，3113 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/deployment-1a71096791fb71844ae08c95c50fb9cc/reload-result.json` — `ff6ff0b8b356c1f889dea3e0b1d39d68c527678066390711c4f28f41907b410f`，8470 bytes。
- `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r4-fix1-2spiaymm/deployment-1a71096791fb71844ae08c95c50fb9cc/readiness-result.json` — `1064eeaa41ac546ad9bd22d3ee05f5042be75f2423edda82f3f0137f0e60a74c`，5337 bytes。
- `/tmp/wrd-capture-pacing-experiment-v2-fix1-review-20261018.md` — `e4146c2c76d4499920f18983c987983325392e331a2eb7e358a53c6f3fd769f2`，5658 bytes。
- `/tmp/wrd-capture-pacing-v2-whole-fake-integration-20261018.md` — `27ce8300c3251cd798a3e9ba257d94512df2320f73ea33dea810f50d2092607c`，9318 bytes。
- `/tmp/wrd-capture-pacing-v2-whole-fake-integration-review-20261018.md` — `a8914e32153b7f69d998753f7e34a04846ded914b1bf3e1a56f1a731a1165666`，8807 bytes。
- `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop/scripts/ordinary_session_recovery.py` — `0203396cad0a65871f97604a3dbf275f95331939e4e42bc07e392a248fd85341`，89343 bytes。
