# Host 抓屏节奏与退出归属：实施和验收记录

本轮是已授权稳定性整改的追加实施。以下严格区分源码修复、离线测试、运行加载和真实连接验收；旧版本三小时 PASS 不作为新 Host 的验收。

## 新增定位与实际修复

| 问题 | 证据与修复 | 边界 |
|---|---|---|
| 抓屏线程启动时状态未就绪 | 旧构造器先启动线程，后初始化 trace/context/lock；立即执行的 fake Thread 复现首次发布丢失。先完成所有状态初始化，再启动现有线程 | 是确定的源码竞态，不宣称已唯一解释历史全部失控 |
| 退出/暂停后迟到画面重新发布 | 实际旧循环在 stop 或 suspend/resume 跨代后仍填回清空缓冲，两个行为 RED 均复现。发布锁内同时检查 running、suspended 与 capture generation | 成功 grab 仍计完成，丢弃与发布独立；不改变控制权或媒体策略 |
| 2秒 join 后仍可能等待原生 close | 现有 MSS 的 grab/close 共用实例锁；Darwin close 继承 no-op。现有抓屏 worker 独占关闭，shutdown 仅保留2秒 join、非等待 executor 请求与清空引用 | 避免调用方在 join 后继续等 close；不宣称原生并发销毁、永久阻塞可被强制终止或全部资源已释放 |
| 交叠关闭漏掉旧 invocation 完成 | A 等待时 B 推进 authority，旧代码因 fence 丢失 A 的 terminal；已用实际 AST 反例复现。每次 invocation 的 finally 记录 detached 旧对象事实 | 保留 reset→PC→track 的顺序、异常/取消与写入 fence；未执行后续阶段保持 not-started |
| 抓屏节奏解释不完整 | 新增最多60个完成秒桶，成对记录开始间隔=grab+postGrab+实际 pacing+other；发布锁为 postGrab 子集 | 无总体 P95；计数/覆盖时间不是内容新鲜 FPS 或输入到画面耗时 |
| 新观测自身污染抓屏耗时 | 初版新 observer 把7ms计算错记为非CPU等待，独立 review 后已修。10ms grab 保持10ms wall/10ms CPU/0ms非CPU，7ms落在 postGrab | 记录原始 RED/GREEN，不把观测开销混入 native grab |

选择现有 worker 归属修复和有界观测；没有新建清理 executor/定时器，没有调低分辨率、码率、质量、FPS、超时或验收阈值。

## 源码与离线验证

- 基线：4d591bb27434cca0c6071aadf7478cb8fba956ca。设计/计划 d3bdf81；Task1 9d25cd9 + R1 d3eaa28；Task2 2d35832；Task3 c239482（独立任务 review Approved）。
- Task1 最终67项相关纯测试通过；Task2 最终84项通过；Task3 最新相同源码的六组相关纯测试103项通过。范围重叠，不相加为独立用例总数。
- 仅纯 Python 和实际方法的 AST 提取：fake Thread/callback/手动 coroutine，无真实线程、睡眠、子进程、Host/MSS/Quartz/PyAV/aiortc 导入或业务原生输入。
- 最终相关命令（cwd python-host）：指定 Python3.11 的 unittest test_peer_cleanup_observation test_capture_resource_owner test_capture_shutdown_contract test_capture_cadence test_capture_observation test_runtime_observability。103 tests / 30.241s，exit0，OK；diff --check 无输出。
- Task1 review 的计时归属问题已由原实现者修复并定向复审 Approved；Task2、Task3 独立并发 review 均 Approved；最终整体 Astra review 也已 Approved，可在 fresh preflight 后受控 Host-only 加载。四份任务 review 与固定测试事实已归档到 [证据目录](evidence/2026-10-18-host-cadence-cleanup/source-review.md)。
- 早期命令工作目录/路径错误已纠正，只是工具执行错误，不当作行为 RED 或产品故障。

## 上线前的实际运行状态

目前生产仍为原有53ed5d7/build79bf9a5afea0458e，Signal45287/Host94398；本轮新 Host 源码尚未同步、未重载。最近一次本地 status 健康/Host在线；canonical 公网 health 返回200。这是瞬时可达性，不是新增会话验收。

08:13:03.731684–13:14:36.733746 CST 的新增日志只读审计：3253条 Host lag 窗口、302条 Signal entry 窗口，Viewer登录/verify/admission/bootstrap/namespace accepted 和 inputEventCount 都为0；没有新真实业务会话，不能用“无故障”证明控制已恢复。Host空闲 lag 最大883.333ms，非总体延迟分布；没有缺失轮转段或JSON解析失败。

维护包 R0 的两个 P1（Git执行位与实际权限混淆、遗漏已部署未进主索引的261个源码文件）已在独立 R1 修正并 Approved。覆盖890个 BASE regular 文件，含629个原索引 regular 文件；四个既有脏文档与四个W2未部署路径只保留原字节/权限。主HEAD/index、14个dist文件、node_modules类型、Signal/tunnel/watch/quick状态均为保护条件。原子发布仅限单文件，保留备份并禁止自动回滚/重试；完整进程树退出依然不可由登记轮询保证。维护包尚未执行，不等于产品已加载。

## 新 Host 加载与运行验收

NOT RUN。独立任务和整体源码 review 已全部 Approved；接着核对 fresh health/Hostonline/Viewer0/relay0，按现有 safe helper 仅 restart-host；重载后单独回报两项本机运行密码，密码不进入本报告。Signal、Viewer build/assets、tunnel/watcher、quick URL状态保持。

随后新的正式路径300秒与10800秒被动连续性分别记录；使用正常UI登录、一次Start、一次性proof和既有已审查SUP。短测失败先定位，不拼接旧PASS；真实MSS close返回、线程状态、join与executor请求分别取证。新计时仅解释观测范围，不构造全会话P95、单向网络耗时或内容新鲜度因果结论。

## 尚未验收的边界

真实业务输入ACK、Host排队/应用、应用后帧、真实可见效果、物理显示，当前仍无新增有效输入样本；保留null/NOT RUN。普通用户自动恢复、多设备网络、启动时延分布也未获得新资格。共享WindowServer缺少可证明的隔离目标，不能用DOM事件、PID/CLI标志或另一种HID目标伪装真实原生验收；用户无暇测试时继续独立修复，不再重复请求人工试用。

旧三小时的10801行、10800.000087秒PASS只属于原53ed/build79会话。输入门禁全真和rVFC推进可包含复用帧，不能证明真实输入成功或所有性能目标已达成。

设计与计划：[spec](../specs/2026-10-18-host-cadence-cleanup-design.md)、[plan](../plans/2026-10-18-host-cadence-cleanup-plan.md)。当前总览与运行结果将在本次真实验收后更新。
