# TURN 抖动后续修复与验收记录

日期：2026-09-06。基线：`d93ff2d`。延续原 EnterPlanMode 设计与计划 Task 11–13。代码和验收结论分开记录；此记录不覆盖先前每秒画质脉冲尚未关闭的结论。

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
| 真实 720p/1080p 长跑 | 待部署后维护验证 | Viewer 退出后已完成旧服务 60 秒基线；未抢占活动 Viewer |
| 静止文字、滚动、输入效果 | NOT RUN | 需要受控 Host 内容及输入关联 |
| 有限丢包 | NOT RUN | 需要隔离的 TURN 丢包环境 |
| 每秒画质脉冲关闭 | 未完成 | legacy 编码策略仍在，不能由测量修复推断消失 |

## 部署前 60 秒基线

最终综合代码审查：PASS，无遗留可执行发现。最终回归：Python Host+collector+selector 281 passed（仅现有 MSS 弃用警告）；Viewer 704 passed；Signal 339 passed 且构建成功；采集 JS 8 passed；真实 Chromium 合成回调验证通过。首次将目录直接传给 `node --test web-client` 的调用未发现模块，已改用仓库测试文件 glob 完整执行，不算产品测试失败。

本地 selected-relay 运行 `turn-runtime-844f8163c2ed32e7`，61 个样本，目标 720p；FPS 中位 15，jitter-buffer P95/max 为 156.7/170.5ms，真实最大呈现间隔 434ms。暂停/恢复和刷新标记通过；FPS、缓冲及采样 cadence 均失败。三处 cadence 失败与截图点一致，已用后续补丁修正采集顺序；该基线不能称为通过，也不能豁免完整长跑。

截图显示实际桌面文字内容，开始与中途清晰度存在明显差异；截图不是逐帧 IDR 对齐测量，且 clip 内可包含 Viewer 浮层，因此不把它们作为编码画质的定量参考图。原始截图留在本机 `/tmp`，不纳入版本控制。
