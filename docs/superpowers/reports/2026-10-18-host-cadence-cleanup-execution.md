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

## 实际加载及维护结果

本轮已实际加载：运行包 e5927c7（产品 Host 代码 c239482），Host **76982 / birth1792305148.350696 / 10月18日14:32:28 CST**；Signal45287/birth1792269606.193945、Viewer build79bf9a5afea0458e及14项dist字节保持。主仓HEAD b6bd0c1和原索引SHA73b61eb5…保持；四项W2未部署文件、四个既有脏文档、node_modules类型、tunnel84671/watcher897及quick URL文件缺失状态保持。没有操作tunnel。

R1独立审查修正Git权限/实际权限混淆与遗漏261项已部署源码后，保护890个BASE regular文件（629项原索引+261项非索引），实际冻结/逐文件原子发布22项（10Host/12文档）。原子性只覆盖单文件；不是整体事务，也未自动回滚。只执行一次safe helper→restart-host.sh，helper exit0、29.29秒；30项登记身份记录exited、0signals。运行密码已从本机配置读取并在聊天单独回报，不写入本报告。

**原维护结果保持failed-or-indeterminate**：唯一额外覆盖标签为observation-unavailable；完整进程树退出UNKNOWN。不重跑、不覆盖、不升级原记录。独立审查的R2只读核对另记 **runtime-ready-with-lifecycle-uncertainty**，两次新观察确认同一Host/Signal、源文件、dist、健康/Host在线/Viewer0/relay0；它不修复原生命周期证据或验收结果。最终文档同步必须同时钉住原失败记录与该readiness记录，不重载服务。

## 新 Host 的三次独立运行

| 运行 | 实际结果 | 关键事实 |
|---|---|---|
| short A，14:35:47–14:43:49元数据窗口 | **INCOMPLETE** | 301行、0缺样/迟到/gate失败/身份变化，max rVFC983.2ms；browser.close API 4.626s超时，不能改成PASS。真实Host旧track清理164.372ms在该浏览器失败之后，不是其直接原因 |
| short B，14:50:57–14:57:53元数据窗口 | **PASS** | 同代码、同参数独立重测，301行/300.0001202058047s，0缺样/迟到/失败/身份变化，max rVFC416.7ms；browser.close164ms、manager.stop31ms。未把A失败删除或声称中间修复了未知浏览器原因 |
| long A，14:59:46–15:03:29元数据窗口，计划10800s | **INCOMPLETE，三小时未通过** | 37行/36.002444840s采样跨度、helper36.321748069s；第36行发生socket/lease/input gate失效，1失败/1lease身份变化，无缺样/迟到，max rVFC300ms。媒体仍推进，随后测试按连续性契约退出 |

三次均使用正式relay路径、正常UI登录/一次Start/一次性proof；不发业务原生输入，不重放/重领proof。A/B/long的登记7项测试身份均记录exited、0signals；完整进程树退出仍UNKNOWN。long另有observation-unavailable。short通过不替代长测失败。旧53ed/build79版本10801行/10800.000087秒PASS也不属于本次新Host。

## 新增长测故障与延迟定位

首个当前Engine事件为WebSocket1006、wasClean=false、transport-close；它比helper preclose早75ms，真实异常关闭先于测试清理。最后好→首坏样本：PC/attempt/media generation/build/relay身份不变，rVFC和decoded各+19、字节+15605，首坏帧龄16.436ms；socket、lease和输入gate关闭。**这是信令中断造成的控制中断，不能宣称频繁失控已经彻底解决。** 初次连接click→bootstrap9.1ms、signal5217.8ms、首帧10410ms，仅一次启动点，不是总体P95。

15:01:15.585 CST检测失败；Signal记录transport close在15:01:15.853，晚于浏览器close开始，不能用该服务端记录确认最初关闭发起方。服务端仅一次ping/pong、最终age19537/18711ms，Node60样本max65ms/P954ms/missed0，实际原因不是ping timeout。浏览器1006不能唯一归因Cloudflare、网络或服务端；当前缺少能区分该网络跳点的证据。

另定位到发生在断线约8秒后的确定清理竞争：控制transition A已detach旧PC/track并等待关闭，随后zero-viewer-status B再次空清理并推进peer authority。A实际57.565ms返回、owner closed/thread false/join returned/PC closed，但authorityCurrent=false，首个reset ACK可被旧fence压掉；Signal等1秒重试后FREE。**它是可修复的后续恢复延迟，不能解释更早的首次WS关闭。** 后续应以实际交叠行为RED、保留新offer/新peer/Signal身份fence的最小修复处理，不可直接放松authority检查。

抓屏仍是性能限制：short A最大成对间隔1595.024ms=grab1586.578+postGrab7.193+pacing0+other1.253；同次grab CPU36.211/nonCPU1550.366ms。B最大成对间隔701.983ms、其中grab698.717ms；long断线前最大间隔411.606ms、其中grab407.989ms，active滚动速率约5.98–10.35Hz，低于20fps目标。不同滚动窗口不可拼接计算全会话P95，nonCPU差值不唯一证明OS/调度器原因。编码short A局部max1666.208ms；质量、FPS、分辨率、码率和deadline未调低。

独立浏览器审计、Signal/Host字节边界审计和short A节奏审计见[证据目录](evidence/2026-10-18-host-cadence-cleanup/runtime-audit-provenance.json)。各自报告注明真实窗口、字节范围、头部保守丢弃和覆盖缺失；没有用阈值告警充当完整延迟分布。

## 尚未完成与下一步

真实业务输入ACK、Host排队/应用、应用后帧、真实可见效果和物理显示：六项有效输入样本仍为0，last/P95=null，**BLOCKED/NOT_RUN**。共享WindowServer缺少可证明的隔离目标，不用DOM事件、PID/CLI标志或其他HID目标冒充原生验收；不重复要求用户人工试用。

当前proof测试有意不允许普通恢复，首个中断即退出。普通用户自动恢复还没有真实生产资格；不能通过proof重放、清标记或重新Start掩盖。只读架构审查发现现成ordinary Start缺少原子vacant-only自动入场条件，先poll状态再Start仍可能抢占人类；直接复用发行器还会使已发给人类的待用Start票失效。下一独立spec/plan须明确保护待处理人类意图、issue/consume两处vacancy+epoch、复用现有C5 current-owner恢复、保留proof和所有控制fence，再实施与独立review；不是在本Host-only规格下悄悄扩大权限。

15:03:29.437 CST末次边界：本地健康、Host在线、Viewer0/relay0；同一Host/Signal/build/tunnel/watcher。这是瞬时健康，不是三小时或输入验收完成。接下来继续修复清理ACK竞争、补足信令证据和普通恢复验收，长测失败状态保留。

设计与计划：[spec](../specs/2026-10-18-host-cadence-cleanup-design.md)、[plan](../plans/2026-10-18-host-cadence-cleanup-plan.md)。保留分支/worktree及先前修改；未merge、push或操作tunnel。
