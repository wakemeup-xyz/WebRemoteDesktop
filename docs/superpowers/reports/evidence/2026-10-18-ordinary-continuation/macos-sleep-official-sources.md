# macOS / CPython 3.11 sleep 超时：官方资料核对

检索日期：2026-10-18（Asia/Shanghai）。范围：只读官方文档与公开源码；没有运行、采样、调试或改变 Host/服务/进程，没有读运行环境、argv、密码或项目日志。唯一产物为本报告。

使用技能：[agent-reach](/Users/macstudio1/.agents/skills/agent-reach/SKILL.md)，经 Exa 搜索与 Jina 阅读；Apple 域名在 Jina 被限流、备用 web-reader 未配置后，改用现有网页工具读 Apple 原文；Python/Apple 官方开源文件经 GitHub CLI 只读 API 获取。正文事实来源仅为 Python 官方与 Apple 官方材料。

## 可以确认与不能确认

给定背景只有：捕获线程请求约 22ms sleep，报告约 126ms 间隔，进程 CPU 较低。若此 126ms 的测量确实严格包围同一次 `time.sleep()`，额外约 104ms 可以发生在系统等待、到期后的调度及重新取得 GIL 等阶段；现有背景不足以分摊。若测量的是整轮间隔，还须包含该轮其他工作，不能称为内核实际 sleep 时长。

| 主题 | 官方资料支持的事实 | 对本问题的边界 |
|---|---|---|
| `time.sleep()` | 只暂停调用线程，返回可以任意晚于请求时间；3.11 的 Unix 路径按构建能力选择 `clock_nanosleep`、`nanosleep` 或 `select`。API 的时间单位/分辨率不是准点调度承诺。[Python 3.11 time 文档](https://docs.python.org/3.11/library/time.html#time.sleep) | 22ms 请求并不保证 22ms 完成；不能仅从操作系统名称认定本机具体构建选中了哪条路径。 |
| GIL | 固定版本 CPython v3.11.0 的 `pysleep()` 在 OS 等待前释放 GIL、返回后重新取得 GIL；`take_gil()` 在锁被持有时进行条件等待。[sleep 源码](https://github.com/python/cpython/blob/v3.11.0/Modules/timemodule.c#L2121)、[GIL 源码](https://github.com/python/cpython/blob/v3.11.0/Python/ceval_gil.h#L211)、[宏语义](https://docs.python.org/3.11/c-api/init.html#releasing-the-gil-from-extension-code) | Python 层的 sleep 返回测量包括重新取得 GIL的可能等待；这只是可行机制，不证明本次 GIL 争用，也不说明哪个线程持锁。 |
| App Nap | 可降低 CPU 优先级、限制 timer 和 I/O；采用应用活动、可见性、音频等启发式条件。Apple 提供 Activity Monitor 的 App Nap 栏作观察入口。[Apple App Nap](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html) | 低 CPU、后台运行、无窗口或 LaunchAgent 身份均不能单独证明 App Nap 当前生效。对无对应可见行的进程，状态应记 unavailable。 |
| 定时器合并/QoS | Apple 把 `nanosleep`、`select`、条件变量超时等列为低层 timer API；timer 即使未指定 tolerance 也没有精确触发保证。QoS 影响调度、I/O 与 timer latency。[Apple Timers](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/Timers.html)、[Apple QoS](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/PrioritizeWorkAtTheTaskLevel.html) | 不能把 NSTimer 示例中的 10% tolerance 当成本机 Python sleep 的容差；约 100ms 的形状不是某策略的唯一指纹。 |

## launchd 静态配置的含义

父任务提供的静态事实：Host 是 GUI 用户 LaunchAgent；plist 省略 `ProcessType`/`LowPriorityIO`/`Nice`，wrapper 直接 exec Python 3.11，没有主动调整 QoS/优先级/电源断言。这些文件事实没有在本调研子任务重新读取。

本机 Apple 静态 [launchd.plist(5)](/usr/share/man/man5/launchd.plist.5:584) 明确说明：

- 省略 `ProcessType` 与 `Standard` 等价；文档描述系统会给予轻度 CPU/I/O 资源限制。
- `Background` 用于非直接用户请求的工作；`Adaptive` 根据 XPC 活动在 Background 与 Interactive 间变化；`Interactive` 用于响应性依赖它且不能采用 Adaptive 的任务。
- [LegacyTimers 条目](/usr/share/man/man5/launchd.plist.5:774) 说明 10.9 及以后 launchd job 的 timer 默认合并；当前本机手册还警告，`ProcessType` 未设为 Interactive 时此键可能无效。

对应公开 Apple 源码可固定到 [launchd-842.92.1/man/launchd.plist.5](https://github.com/apple-oss-distributions/launchd/blob/launchd-842.92.1/man/launchd.plist.5#L341)，[commit 49a9c79](https://github.com/apple-oss-distributions/launchd/commit/49a9c79b2949192dfca697b1054245cdfb645788) 的导入日期为 2021-10-06；这不是该功能或当前 macOS 的发布日期。该历史源码的 LegacyTimers 段没有本机手册中的 Interactive 限制，因此具体语义优先核对部署机器的手册。

解释边界：`ProcessType=Standard`、线程 QoS 类、App Nap、timer coalescing 是不同层面的信息。省略 Nice/LowPriorityIO 或 wrapper 未调用 taskpolicy，并不能推出“无系统资源限制”或“线程不是 Background QoS”。plist 是请求策略的静态证据，不是运行期有效策略，也不能证明本次延迟的原因。本报告不把设置 Interactive/LegacyTimers 作为已验证修复。

## sample 能说明什么

本机 Apple [sample(1)](/usr/share/man/man1/sample.1:23) 说明它在采样点暂停进程、收集所有线程的堆栈再恢复；默认间隔 1ms，可能遗漏采样点之间的短函数。它有观察扰动，不能视为零开销的连续事件追踪。Apple 的[采样说明](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/CodeSpeed/Articles/DiagnosingSlowness.html)同样将 sample 定义为周期堆栈统计；该网页是 2014-03-10 更新且已退休的文档，仅用于说明采样原理。

必须沿完整调用链定位：捕获线程若反复落在 `pysleep` 下的 OS sleep 路径，支持“采样时仍在系统等待”；若落在 `PyEval_RestoreThread`/`take_gil` 下的条件等待，支持“采样时正在重新取得 GIL”。单独的 semaphore/condition-wait 叶函数可以服务多种锁，不能据叶符号认定 GIL。优化/内联/缺符号也可能隐藏关键帧。

一次 sample 不能重建 timer 的请求 deadline、内核何时把线程变成 runnable、真正获得 CPU 的时刻，以及 GIL 的持有者/交接顺序；所以不能把整个额外 104ms 归因于栈上出现的单个函数，也不能因未采到 GIL 帧而排除短暂 GIL 等待。这一结论是由采样机制推得的限制，不是某篇文档对本项目的直接诊断。

## 后续只读诊断建议（本子任务均 NOT RUN）

1. 先核对现有计时字段边界、单位、线程与时钟。Python 官方建议用 `perf_counter` 测量短区间；它包含 sleep，`monotonic` 不受系统时钟调整影响；`process_time`/可用时的 `thread_time` 是 CPU 时间，不能替代墙钟延迟。[Python clocks](https://docs.python.org/3.11/library/time.html#time.perf_counter) 记录已有窗口的请求值、测量值、样本数与 p50/p95/p99；不要把进程平均 CPU 当作捕获线程某一段的等待证明。
2. 先读已有 sample 的捕获线程完整分支，同时保留其他线程的解释上下文。若需要再采样，应限定已知 Host PID、短窗口并单独记录采样时段，避免把 sample 造成的扰动混入无采样基线。符号不清时保持 unknown，不用通用 wait 叶函数替代原因。
3. 对实际有效策略，优先读已有 per-target policy/trace 证据。Apple DTS 于 2024-02 推荐 System Trace，并指出 `taskinfo` 可帮助读内核策略；其关于 `thread_info` 的提议明确未经验证，不能当作既定方案。[Apple DTS 回答](https://developer.apple.com/forums/thread/747437) 本机 [taskinfo(1)](/usr/share/man/man1/taskinfo.1) 列有 `--threads`/`--boosts` 和 PID 选择，同时声明并非供用户直接使用。若父任务已有此工具的只读授权与可用权限，可仅对已知 PID读取必要的 requested/effective thread QoS、base/override/background/timer policy 摘要；权限拒绝或字段不明就记 NOT RUN/unknown，不请求 sudo，不作全机扫描，不读取 env/argv/完整 launchctl 输出。
4. App Nap 与 Idle Wake Ups 可在 Activity Monitor 对已知进程做同一时窗观察；App Nap 的 Yes/No 是该时点状态，wakeups 是窗口均值，均不能独立证明某一次 sleep 的延迟来源。[App Nap 观察](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/AppNap.html#//apple_ref/doc/uid/TP40013929-CH25-SW1)、[timer 观察](https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/Timers.html)
5. 若已有可用且获准的 Instruments/System Trace，检查同一捕获线程的 blocked → runnable → running 时间线及当时 QoS。Apple [WWDC16 System Trace](https://developer.apple.com/videos/play/wwdc2016/411/) 明确区分资源等待与 runnable 后等待 CPU；[WWDC26 系统阻塞段 20:29 起](https://developer.apple.com/videos/play/wwdc2026/268/?time=1229)给出同一诊断思路。若 timer deadline/到期事件不可见，仅能报告系统等待延长，不能细化为 timer coalescing；如果不能获取足够事件和有效策略，保持原因未定。工具未安装/权限不够则 NOT RUN，不安装、不提权、不改优先级或电源断言。

## 版本与可信度

- Python：以 3.11 系列官方滚动文档说明 API 合约；实现证据固定为 v3.11.0。未识别、未执行本机 Python，因此本机 patch、构建宏与符号差异仍未知。
- Apple：App Nap/Timers/QoS 指南均更新于 2016-09-13，是官方历史机制说明，不保证当前实现阈值。公开 launchd 源码使用固定历史 tag；本机 launchd 手册日期字段为 2019-07-30，本机 sample 手册为 2013-03-16；这些是文档日期，不是操作系统构建版本。
- 稳定事实：sleep 不保证准点完成；GIL 在 sleep 的 OS 等待前后释放/重取（所核对版本）；采样并非连续追踪；blocked/runnable/running 含义；launchd 手册所列分类语义。
- 待证推断：当前 App Nap 状态、实际有效 QoS/后台策略、timer 合并预算、本次 GIL 等待比例、104ms 额外延迟的来源。没有官方资料能仅凭所给两个间隔与低 CPU 把这些推断升级为本机事实。
