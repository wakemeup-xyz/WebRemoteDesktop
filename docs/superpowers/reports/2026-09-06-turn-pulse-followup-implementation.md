# TURN 抖动后续修复与验收记录

日期：2026-09-06。基线：`d93ff2d`。延续原 EnterPlanMode 设计与计划 Task 11–14。代码和验收结论分开记录；此记录不覆盖先前每秒画质脉冲尚未关闭的结论。

## 已实施：连续呈现测量

- `paintAgeMs` 仅表示采样时的帧龄；`maxPaintGapMs` 保存本 phase 的累计最大间隔，`intervalMaxPaintGapMs` 保存区间内观测。已结束及尚未结束的卡顿都会被保留。
- phase 开始重置，attempt/video/lifecycle 变化使旧回调失效；缺少首帧、旧 schema、无效数值不能通过连续性门禁。
- 逐帧记录呈现分辨率与 CSS 几何范围；改变后在下一秒采样前恢复也不能隐藏变化。
- Terra High 独立审查发现的瞬时分辨率和 null 几何缺口均补了失败测试再修复，复审通过。
- 真实基线发现截图先于采样导致额外迟到（仅截图索引 0/30/59 分别迟到 293/530/804ms）。现将截图移入采样记录完成后的 sidecar；500ms 截图不再改变已测样本时间，1500ms 截图仍使下一样本迟到 500ms 并失败。逐帧跟踪不会在截图期间停用。

确定性生产 JS 测试复现 1490ms 间隔，即使相邻采样的帧龄是 1000/510ms 仍保留真实间隔。Python 汇总拒绝旧帧龄 artifact。

隔离 Chromium 使用内存 canvas 视频，禁止所有网络请求；本轮首次验证得到健康最大间隔 67ms、持续 stall 1617ms、恢复后帧龄 4ms 但累计间隔仍为 1678ms，同时捕获到移动后回原位的 3px x 范围。此为浏览器回调正确性验证，不是 TURN、文字质量或真实 Host 性能验收。

复现命令：

```bash
node --test scripts/turn_runtime_collector.sample.test.mjs
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m pytest -q scripts/test_turn_runtime_collector.py
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 scripts/verify-turn-collector-browser.py
```

## Host 耗时机制与修复边界

只读审查确认：`recv()` 仅把缩放交给 `imgproc`，随后仍在事件循环上复制复用图像、构造 PyAV 帧。将这些同步操作移到同一个现有单线程处理池，是移除事件循环阻塞点的修复；不自动降低总 CPU 或保证 20FPS。线程、捕获倍率、编码默认和分辨率保持原策略。

一轮有界低优先级合成 BGRA 探针（PyAV 16.1.0，各尺寸/执行位置各 10 次）在主循环构造帧时测到 720p 最大 15.895ms、1080p 最大 90.946ms。该探针含冷启动、缓存及调度差异，不可作为移动到 worker 后的性能 A/B；它仅说明当前同步调用可能占用事件循环预算。

另外两项后续实验候选：捕获当前仍为目标帧率 2 倍；同 Python 环境独立导入 OpenCV 得到默认 12 线程，而 x264 明确为 1 线程。捕获倍率与 OpenCV 线程数的收益、资源竞争贡献尚未受控量化，本轮不改变它们。

## 执行状态

| 项目 | 状态 | 证据边界 |
|---|---|---|
| Task 11 采集器修正 | 实现并独立复审通过 | Python 18、直接 JS 8；截图调度补丁纳入最终综合复核 |
| Task 12 Host 帧构造隔离 | 实现并独立复核通过 | 线程响应、真实 PyAV 内容、暂停/停止/profile 测试通过；性能增益待实测 |
| Task 12 候选选择提前返回 | 实现并独立复核通过 | 只修选择逻辑，不改变当前 no-offline-winner 或生产准入 |
| 真实 720p/1080p 长跑 | 已运行，FAIL | 601/301 样本，FPS 中位 13/6；无活动 Viewer 时准入 |
| 静止文字、滚动、输入效果 | NOT RUN | 需要受控 Host 内容及输入关联 |
| 有限丢包 | NOT RUN | 需要隔离的 TURN 丢包环境 |
| 每秒画质脉冲关闭 | 未完成 | legacy 编码策略仍在，不能由测量修复推断消失 |

## 部署前 60 秒基线

最终综合代码审查：PASS，无遗留可执行发现。最终回归：Python Host+collector+selector 281 passed（仅现有 MSS 弃用警告）；Viewer 704 passed；Signal 339 passed 且构建成功；采集 JS 8 passed；真实 Chromium 合成回调验证通过。首次将目录直接传给 `node --test web-client` 的调用未发现模块，已改用仓库测试文件 glob 完整执行，不算产品测试失败。

本地 selected-relay 运行 `turn-runtime-844f8163c2ed32e7`，61 个样本，目标 720p；FPS 中位 15，jitter-buffer P95/max 为 156.7/170.5ms，真实最大呈现间隔 434ms。暂停/恢复和刷新标记通过；FPS、缓冲及采样 cadence 均失败。三处 cadence 失败与截图点一致，已用后续补丁修正采集顺序；该基线不能称为通过，也不能豁免完整长跑。

截图显示实际桌面文字内容，开始与中途清晰度存在明显差异；截图不是逐帧 IDR 对齐测量，且 clip 内可包含 Viewer 浮层，因此不把它们作为编码画质的定量参考图。原始截图留在本机 `/tmp`，不纳入版本控制。

## 合入与部署

实现提交 `6a80191` 已通过 `5ac5847` 合入本地 main，保留用户同期 `7f80478` 文档提交。部署前在 main 再次执行 Python 回归通过。使用仓库 service helper 的 `restart-local` 重启本地 Signal 与 Host；新 PID 分别为 74799、74867，Host 在线。重启前后 quick tunnel URL 文件摘要及 cloudflared PID 集合一致，未操作 tunnel。密码从本机运行配置回报，不落版本化报告。未推送远端。

部署后 720p 60 秒短测 `turn-runtime-05b96dbad70b9f62`，artifact 为 `/tmp/wrd-turn-worker-after-20260906.json`：61 样本，FPS 中位 15，缓冲 P95/max 89.8/111.1ms，真实最大呈现间隔 320ms。采样 cadence 不再失败，FPS 与未执行的静止文字/输入仍失败。前后运行桌面内容及负载未受控，不能将数值变化解释为修复的因果收益。

## 剩余耗时机制的证据边界

16:38:35 对部署后的 Host 做过约 1 秒、10ms 间隔的原生线程采样；该轻量采样位于长跑期间，因此长跑不是完全无干扰的性能 A/B。捕获线程大量样本位于 CoreGraphics/SkyLight 原生捕获等待及像素复制；OpenCV 内部并行 resize 也确实活跃。新 PyAV 帧构建已位于 imgproc worker，与实现目标一致。单次栈快照不能量化各阶段耗时份额，也不能证明 WindowServer CPU、OpenCV 过度并行或 GIL 竞争就是低 FPS 的原因。

下一次耗时实验应先在同一窗口分别测量 capture grab、worker 排队、缩放和帧构建的 P50/P95/max，再选择捕获倍率或 OpenCV 线程数中的一个变量做 A/B。本轮不把这两个未经受控验证的变量一起修改。

## 部署后完整维护长跑

运行 `turn-runtime-2bf80329b39ca358`，2026-09-06 16:38–16:53。本地入口建立的实际 selected TURN/UDP 媒体路径；不属于正式公网入口浏览器验收。无活动 Viewer 时经 proof admission 准入，运行结束后 Viewer 计数恢复 0，Host 在线。

| 指标 | 720p：600 秒 | 1080p：300 秒 |
|---|---:|---:|
| 分辨率 | 1152×720 | 1728×1080 |
| 样本数 | 601 | 301 |
| FPS 中位 / 最低准入目标 | 13 / 18 | 6 / 15 |
| jitter buffer P95 / max | 110.5 / 153.0ms | 54.9 / 86.2ms |
| 最大真实呈现间隔 | 949ms | 967ms |
| 累计解码 / 接收帧 | 7325 / 7331 | 1856 / 1856 |
| packetsLostDelta 累计 | 33 | 16 |
| framesDroppedDelta / freezeDelta 累计 | 6 / 48 | 0 / 9 |
| NACK / PLI / FIR 累计 | 352 / 0 / 0 | 104 / 0 / 0 |
| 最大采样迟到 | 163ms | 126ms |

两阶段每秒样本均保持 relay、connected；phase 内 attempt/video、逐帧分辨率及 CSS 几何稳定；没有发生超过 1 秒的呈现间隔，但 949/967ms 的停顿以及 freeze 计数仍说明体验不流畅，不能把门槛未触发等同于用户体验合格。两阶段暂停、恢复后的新帧和刷新后 relay 恢复通过。

结论均为 FAIL：`fps-p50`、`static-text-and-input-not-run`。静止文字、滚动/拖动/键盘缺少受控 Host 页面与输入事件关联；有限丢包仍 `NOT_RUN`，自然出现的少量丢包不能代替有边界的丢包注入测试。画质脉冲没有新的逐帧实际桌面定量证据，仍未关闭。低 FPS 与较低缓冲同时存在，支持继续量化生产端各阶段耗时；不能仅据此排除网络或确定唯一根因。

三份运行原始 JSON 以无修改 gzip 归档在 `evidence/2026-09-06-turn-followup/`，`runtime-manifest.json` 保存解压后和压缩后的 SHA256。长跑原始 JSON SHA256：`8c5244aeb4b28f07c7d0b26bf43f7e734cd6a78b3cf708aa90f25b4a96b95dce`。原始截图不归档。

同 attempt 的 Host 编码窗口也保存在 `endurance-encoder-windows.json`。720p 118 个窗口、7301 帧，加权 `encode()` 墙钟平均 40.768ms，最大 538.272ms；1080p 59 个窗口、1861 帧，平均 91.018ms，最大 843.438ms。该计时包含转换、编码、打包和调度等待，不能当作纯 x264 CPU 时间；窗口边界不与 Viewer 样本完全对齐。1080p 此阶段平均值已超过 20FPS 的 50ms 帧预算，是下一轮降低耗时必须处理的实际证据。日志均为 legacy，周期 IDR 计数 366/94；GOP 按帧数调度，低 FPS 下不能把它机械解释为严格每 1 秒一次。

## Task 14：VBV 细化结果与停止条件

新增独立 `--matrix relay-vbv-refinement`，历史 relay 矩阵和生产准入保持原语义。先生成新的双分辨率 VBV200 对照，再测225；只有完整可比的225自身离线失败才测250。对照只需测量完整有效，不要求它先解决目标画质问题。独立 review 找到的两项 P1（缺失/漂移证据仍可通过、无效对照仍运行后续候选）已补失败测试并修复，Terra High 复审 PASS。probe 仅增加 preset/tune/profile/targetFps 配置记录，没有改变编码行为。

长跑结束、Viewer 数为0后，以 `nice -n 15` 串行运行一次新矩阵。三组均为 libx264/ultrafast/Baseline/20FPS、仅按需 IDR、720p 3.2Mbps / 1080p 5Mbps；唯一改变是 VBV。每组每档65帧，直接强制 IDR 在第5帧。

| VBV | 720p 按需 IDR PSNR | 1080p 按需 IDR PSNR | 720p / 1080p 编码 P95 |
|---|---:|---:|---:|
| 200ms 新对照 | 24.378dB | 26.156dB | 13.533 / 29.959ms |
| 225ms | 24.472dB | 26.083dB | 15.507 / 31.261ms |
| 250ms | 21.662dB | 23.417dB | 16.557 / 42.608ms |

全部低于按需 IDR PSNR ≥28dB 的门槛。离线周期 IDR/脉冲调度与编码耗时门槛通过，但不能覆盖 IDR 画质失败；250ms 也没有呈现画质单调改善。结果为 `no-offline-winner`，所有 runtime gates 仍 `NOT RUN`，默认继续 legacy。不能以离线按需 IDR 不产生周期脉冲推断当前生产脉冲已经修复，也不能将这里的静态 RGB 探针耗时直接与真实桌面流水线耗时做 A/B。

已到本轮允许的250ms上限，停止扩大 VBV。下一轮应分别处理：生产流水线阶段耗时的受控测量，以及既定码率/画质约束下的下一种编码配置设计与验证；不要同时改捕获、线程、preset和VBV。受控静止文字、滚动/输入及隔离有限丢包仍是后续 runtime 准入的缺项。

新逐帧结果：`evidence/2026-09-06-turn-followup/vbv-refinement.json`；SHA256 `04a17824ea01799ab768e3b8a9630e27b7e2654fef30526d0bd2656b4a04c565`。本轮最终相关回归 Python **291 passed**（含2个subtest，仅现有 MSS 弃用警告）、直接采集 JS **8 passed**；此前已执行的 Viewer **704 passed**、Signal **339 passed** 和构建、Chromium 回调 smoke 均通过，后续新增改动仅为离线脚本及证据文档。运行证据与交付口径独立 review PASS。

**最终结论：代码修复与本轮有界实验已完成，TURN 性能和每秒画质脉冲仍未完成产品验收。**
