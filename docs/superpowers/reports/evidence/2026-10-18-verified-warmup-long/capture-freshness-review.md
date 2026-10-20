# 最新 3 小时 capture freshness 窄范围只读复核

结论：当前代码和有界日志能够证明“输出持续，但源采集更新慢于输出”，尚未证明一个应立即修改采集策略的确定性性能缺陷。不应仅凭 reuse 比例改变 FPS、倍频或等待策略。此次不执行测试、构建、Host 导入、网络、浏览器、进程采样、服务操作或参数修改；未修改 tracked 文件或 index。

核对范围为工作树 HEAD `30ca224bb446b2894056241e6cca7d20e8ba4988` 中 `python-host/host.py`、`capture_experiment.py`、`runtime_observability.py`，以及 `/tmp/wrd-verified-warmup-long-log-audit.json` 的已聚合有界数值。线上产品源码为 `53ed5d72e331b808245b7d650a6c4ff7b2969c85`、build `79bf9a5afea0458e`；本复核没有独立重新验证线上文件或进程身份。日志字节窗口的完整性由独立日志审计负责。

## 当前数据意味着什么

- 2,151 个 `CAPTURE_STATS` 输出窗口累计 210,340 输出，124,232 次 reuse，即 59.062470%。这些是已记录窗口的输出/复用计数，不是每次抓屏耗时的完整分布。窗口输出 FPS 的算术平均为 19.458252，不能当 fresh-content FPS。
- 第一次/最后一次 track-lifetime 快照完成计数为 14 / 88,321，时间跨度 10807.710505 秒；完成计数差估计 8.170741 captures/s。边界是两次稀疏日志快照，不能替代逐次采集间隔分布。最后快照 attempted=completed=88,321、failed=0；成功抓屏不保证像素发生改变，也不保证抓到某次输入效果。
- 成对的 track-lifetime 最大抓屏区间为 310.232 ms = 同一抓屏线程 CPU 16.225 ms + 非 CPU 294.007 ms。非 CPU 是算术剩余，不能单独归因于 WindowServer、OS 调度、某个外部进程或网络。此极值不是所有 capture 周期的解释。
- 3 小时 requestVideoFrameCallback 连续性 PASS 证明浏览器持续收到/呈现视频帧回调；缓存复用帧也能产生回调。因此这不能证明每个回调都有新截图，不能替代真实输入到可见画面、应用后新帧或物理显示验收。真实 native/visible input 保持 NOT_RUN。

## 源码与计数边界

| 位置（仓库内 1-based 行） | 已确认行为及含义 |
| --- | --- |
| `python-host/host.py:2209–2219`；`python-host/capture_experiment.py:12–13,27–32` | 生产使用 `CaptureExperiment(1.0, 1)`，第 2 参数是 `opencv_threads=1`，不是 FPS headroom。倍率 1.0 得出 `target_fps`，target20 的采集节拍上限为20/s，并不保证达到20/s。`host.py:2212–2214` 的 “single frame of headroom” 说明与当前计算不一致，是注释准确性问题，未证明运行时性能缺陷。 |
| `python-host/host.py:1441–1488` | 单采集线程串行 grab。计时从 grab 前开始；结尾 sleep 为 `max(0, min_interval - elapsed)`，已经扣除抓屏及发布耗时。没有源码证据表明每次 grab 后又固定额外睡一个完整 frame_interval。若调用耗时已超节拍则不再主动补睡。 |
| `python-host/host.py:1469–1477,1622–1645` | 仅一个 latest capture buffer，消费即清空；新抓屏可覆盖未消费截图，无截图队列积压。输出按 capture_seq 判断本次是否有新截图。没有新截图时继续输出最近处理过的缓存内容。不能将 reuse 直接当网络丢帧或 grab 失败。 |
| `python-host/host.py:1610–1620,1690–1707,1750–1790` | 输出 recv 有自己的节拍；没有新截图时 `_total_reuse` 增加，窗口 FPS 统计输出帧数，包含复用内容。`capture_wait=0` 仅说明 recv 不等待 capture线程，不说明截图采集或内容年龄为零。 |
| `python-host/host.py:1947–1991` | 正常无新截图走缓存复制；处理/转换失败也可能回退缓存并标记 reused。复用比例本身不区分这些原因；需结合有界错误统计。每次构造独立 PyAV frame 的所有权理由见1942–1945，不能据复用比例直接删除复制或复用 VideoFrame。 |
| `python-host/host.py:1863–1934` | `outputsWithCapture` 为本输出成功使用新截图；`reusedOutputs` 是输出复用。`captures` 在采集线程发布截图时增加，输出窗口在 recv 侧切分；5秒窗口边界可能跨线程错位，不能要求每窗 capture/fresh output 完全相等，也不能把这类不等直接判为丢帧。 |
| `python-host/host.py:1450–1467`；`python-host/runtime_observability.py:69–119,121–153` | CaptureObservation 是单写入、不可变标量发布，计数为 track lifetime。lastDuration 是最近一次已完成 grab；maxDuration CPU/非CPU为同一次最大 wall grab 配对。快照是稀疏观测，不是每次操作样本。没有 sleep实际耗时、两次 grab 开始间隔或发布/锁等待的完整计时。 |

## 未知点和处置

约 8.17 captures/s 明显低于约 19.46 output FPS，仍有内容新鲜度的性能空间；但现有数据不足以把差额定位为某个源码中的固定额外延迟。尤其不能把稀疏快照 lastDuration 的均值（约30.93 ms）当所有抓屏平均，再和 capture rate 强行拼成周期模型。两次 grab 之间的实际调度/睡眠、发布开销以及抓屏持续时间分布并未完整测量。

建议保留“源采集 cadence / 内容年龄尚未完成验收”的明确状态。若后续要确定是否应改策略，应先获得有界、同线程同单调时钟的 capture start-to-start、实际 pacing sleep、发布耗时与抓屏 wall/CPU配对摘要，以及能与输入 applied 后新截图相关联的有效样本；该建议不是本轮已经实施或验收的能力。当前无需凭 reuse 比例增加倍频、降低画质、改变 FPS、在 recv 等待新截图或禁用缓存续帧。此次没有可从当前源码明确证明的阻断性性能 bug，注释不一致单独记录，不构成重启或策略变更依据。
