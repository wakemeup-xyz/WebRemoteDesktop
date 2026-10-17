# 稳定性与延迟整改实施记录

执行开始：2026-10-17。状态：已部署至 `adfcb48` 的本地 Signal/Host；此前分支复审通过，真实验收发现的 C5 准入缺陷正在修复，尚未最终验收。

用户本轮已授权开发、验收、启动本地 Signal/Host 并保持可用；原来的“仅诊断、不修复/重启”限制已被本轮指令取代。tunnel 的禁止停止、重启、重建限制保持有效。

## 1. 基线与执行边界

隔离工作区保留既有控制修复为基线 `2a2c5ff`；基于已 review 的总/子 spec 和 plan 开发。实施初期原工作区和运行中服务未加载改动；现已按本报告上线记录部署至 `adfcb48`，W2 watcher 四文件仍明确延后。不能以工作区单元测试证明线上端到端验收通过。任务详细过程暂存于对应 worktree 的 `.superpowers/sdd/2026-10-17-reliability-latency-remediation-plan/progress.md`，最终结果归档于本报告。

离线阶段使用定向测试和临时目录构建，未调用 npm pretest。经独立复审后按用户授权构建并重启本地服务；真实 Viewer 测试均使用 fresh zero-Viewer 与一次性 proof，未执行业务原生输入。未修改、停止或重启 tunnel。

## 2. 已实现与复核情况

| 任务 | 结果 | 验证与复核 |
|---|---|---|
| C1 租约/reset/rebind | 不同操作采用新 epoch；当前 Host 确认后才续期；Viewer 立即 heartbeat | 修订后 139 项定向测试通过，独立 R1 通过 |
| C2 Host 异步权限与资源归属 | 等待初始化屏障；旧 offer/relay completion 不覆盖新身份 | 132 项 Python 回归通过，独立 R1 通过 |
| M1 延迟基础采样 | ACK、frame notice 分离；有界 scope/窗口；Host 执行阶段；缺测 null | 两轮复核修正 unordered ACK 分类与重试/缺测处理；独立 R2 通过 |
| W1a 登录 | 请求和 JSON 读取共用截止时间；临时故障保留凭据；Start 受鉴权状态约束 | 308 项相关测试通过，独立 R1 通过 |
| W1b 延迟组件 | CSS/JS/注册/init 分别管理；有界等待和可恢复重试 | 63 项定向及 865 项前端测试通过，独立复核通过 |
| W1c 发布资产 | 保留当前及上次构建，历史版本与字节数有界；构建身份、一次性版本查询 | 86 项相关测试通过，最后 fixture 调整后 6 项构建测试通过；独立复核通过 |
| W2a 守护截止时间 | 单调时钟总预算；恢复结束后冷却；独立采样；同 PID 持锁；未知历史保守窗口 | 初始 15 项 Python、26 项 Node 通过；R1 后 17 项 Python、2 项相关 Node 通过；独立 R1 通过 |
| C3 输入 ACK 恢复 | 可靠输入有业务截止时间；先冻结、权威 reset/release，再重获授权；不重放不确定输入 | 598 项组合与 413 项最终 UI 测试通过，独立复核通过 |
| C4 媒体恢复 | 暂停/恢复和 relay 按当前连接身份处理 | 初始 419 项 JS、63 项 Host 通过；独立复核发现实际刷新卡在 resuming、旧 PC 确认越界；`5382607` 修复后 318 项通过，独立 R1 通过 |
| M3 有界输入/JPEG worker | 输入同步准入、共享容量、原生完成屏障；抓图编码移出事件循环 | 独立复核发现 wheel 生命周期与 grant 开放状态缺陷，已修复于 `8112d3e`；14 项 Host 专项、161 项 Host 回归、227 项 Viewer 回归及 12 项最终专项通过，独立 R1 复核通过 |
| W2b 分层入口探测 | 入口错误分类、统一截止时间和子进程归属；探测失败不等同于允许恢复 | R1 修复嵌套 DNS/curl 子进程归属；10 项定向、2 项最终回归通过，独立 R1 通过 |
| M2 新鲜帧因果关联 | 仅真实 applied 输入关联后续新捕获；首包成功后提交；晚到 trace 保留原呈现时间；SSRC 唯一匹配 | `b61d37d` 已提交，定向验证及 15 分钟模拟流通过；`827688f` 修正真实回调时间接线后独立 R1 通过，已部署；真实输入因果呈现仍未测 |
| W3a 统一诊断 | 原始 capture/ID 重试，M1 指标直接快照，有界结束事件与持久化回执，长会话 schema 3 | 初始 203 项通过；独立复核发现同连接第二报告重试丢失和错误 dropped，`fe31866` 修复后 77 项通过，独立 R1 通过 |
| I2 持续验收工具 | 单次准入、流式采样、同身份与实际路径连续性、明确缺测；普通连接后不发送业务输入 | 原工具误判 PASS 已用反例修复于 `d2b5b80`，13 项 Python、10 项 JS 通过；独立 R1 通过；已运行生产短时测试，尚无连续性 PASS |
| W3b 留存 | 同一 Viewer 最新报告、有界日摘要、共享回执 ledger | `56f3987` + `30bd409`；R1 修复崩溃锁、首次接收查询漂移和状态字段路径问题，40 项定向验证与独立复核通过 |
| W3c 资源与事件循环 | 当前/峰值 RSS 区分，全量低频 lag、实际换页差分缓存、非阻塞队列摘要、断开原因白名单 | `40450f3`，14 项 Python、2 项 CLI、4 项 Node、3 项最终 Signal 通过；独立复核通过 |
| M4 捕获与编码阶段 | generator 消费计入编码，pause 独立；失败回退保留真实旧帧身份，reuse 日志/消息一致 | `3d88e1c`，16 项阶段、23 项前端指标、23 项相邻回归通过，独立复核通过 |
| W4a 输入追踪开销 | 业务/延迟处理后才采样；保留异常与可靠 ACK，增量字节计费 | `60ccbbe`，327 项定向验证与独立复核通过；I1 帧身份 fixture 复核通过 |

M5 `47cd1c5` + `36dec3a` 已通过 R1 独立复核，修正旧媒体策略覆盖和资源窗口失败计数丢失；无真实资格时自适应仍禁用。W4b `e5e086d` + `5b4baca` 已修正 UI 多处写入与缓存冲突，520 项回归通过，独立 R1 复核通过。测试数量对应不同范围和不同版本，存在重叠，不相加为独立用例总数。

## 3. 实施期间补充的运行证据

本节是原 72 小时诊断窗口之后的新证据，不覆盖或改写原窗口统计。

- 04:50 左右只读快照：本地 `/health` 200、约 20ms；`/api/status` 200、约 5ms，Host 在线、Viewer 数量 1。这只是瞬时状态，不能代表会话连续性或输入可用。
- 同次系统快照：12 个逻辑 CPU，load average 约 45.89/37.81/42.55；swap 已用 32233.50MiB。swap 存量不能证明此刻仍在大量换页，验收需补充单位时间换页增量。
- 对现有 `back-debug.log` 的 2026-10-17 02:15–04:55（北京时间，左闭右开；本次读取最新匹配记录止于 04:52:54，不能声称覆盖完整末尾）筛选：1735 条阈值型 event-loop 告警，其中 281 条达到 1 秒，最高 52607.894ms；这不是全量采样分位数。首条匹配告警出现在 02:36:59，因此也不能据此推断之前无异常。
- 最大停顿出现在 03:43:03，记录的 systemLoad1 为 509.772、inputWaiters 为 0、PC 状态 new。03:31:18 的停顿为 30147.697ms、systemLoad1 为 592.688；说明本轮不稳定还包含严重整机调度/资源压力，不能只归因于网络或输入队列。
- 同一筛选窗口出现 46 次 new-offer 关闭、22 次 viewer-disconnected 关闭、6 次 signal-disconnect 关闭。关闭日志是事件数，不是独立故障次数；不同事件可能属于同一恢复链。
- 日志还出现旧 offer 访问空 localDescription/emit、BadNamespaceError、InvalidStateError 等异常；C2 已对异步完成后的身份和对象归属加 fence，但是否消除对应线上异常必须在加载后验证。
- 无 PC 时仍有约 154 个 asyncio task 的样本，最多 241。暂不能仅凭总数确定泄漏；后续采样需给出受控 task 类别和生命周期变化，避免把存活任务直接计为泄漏。
- 后续只读资源采样：物理内存 34359738368 bytes（32GiB），约 962 个进程。`vm_stat` 相邻样本间隔 2020.4ms、pageSize 4096，swap-in 172980679.9 bytes/s、swap-out 194680808.7 bytes/s。这证明该短窗口存在实际换页，不能把速率外推至三天或整个实施期间。同期 Host PID 22537 当前 RSS 55048KiB、Signal PID 22232 当前 RSS 39672KiB；当前 RSS 低不代表本任务过去未产生压力，且不能由全机 swap 直接归因单一进程。
- 原生产服务进程此时仍是此前版本（运行约 1 天 4 小时），本轮未重启；单点在线并不说明控制、媒体或连续性已通过。

## 4. 真实验收状态

| 项目 | 当前证据 |
|---|---|
| 正常浏览器访问登录页 | 初步独立 Chromium：本地和正式域名均 200，登录表单可见；未登录、未创建 Viewer |
| 命令行 HTTP 客户端 | Python urllib 对正式域名返回 Cloudflare 403/1010；正常浏览器成功说明此结果不能单独代表网页不可用 |
| 本轮构建部署 | 已部署至 `adfcb48`；build `7cdeb3e918582f7c`；W2 watcher 四文件未激活 |
| 真实登录与媒体启动 | 公网 TURN 登录、当前帧进展和有效 input gate 短时 PASS；完整 baseline 被另一普通 Viewer 顶替，不能计连续性 PASS |
| 真实可靠输入与自动重连 | 业务输入 NOT RUN；proof 单次约束下普通用户自动重连未验收；C5 准入修复进行中 |
| 输入应用到捕获/RTP/rVFC | M1/M2/M4 实现及离线关联验证已通过；NOT RUN 生产测量 |
| 输入到真实可见效果 | NOT RUN；需要真实 producer 事件与解码 marker，ACK 或下一帧不能替代 |
| 各路径连续三小时 | NOT RUN；新工具已实现连续采样和严格判定，实际运行未完成三小时 |
| 正常资源与高压力分别验收 | NOT RUN |

04:50 曾观察到在线 Viewer；05:41 后续快照 viewerCount=0。自动化接入前仍须重新检查并取得服务端一次性准入，不把旧快照当作持续空闲证明。


## 5. 上线与验收顺序

1. 完成剩余任务与独立复核，运行覆盖交互边界的集成回归和临时目录构建。
2. 再核对原 checkout 自基线以来的变更，只同步本轮已审查补丁；保留原有未提交工作，准备可逆恢复快照。
3. 通过服务 helper 依次重启本地 Signal 和 Host，确认构建身份、健康、Host 在线、日志异常；tunnel 进程和 quick URL 文件不变。
4. 正式入口使用真实浏览器正常登录。创建自动化 Viewer 前检查现有会话与一次性准入；不得绕过单 Viewer 保护。
5. 验证画面、连接状态、当前身份和允许的控制路径；连续采样记录中断与缺测，不把最终一次快照当成三小时连续通过。
6. 完成报告中的实测表后交付。真实跨设备、可见 marker 或物理显示若未测量，分别保留未验收状态，不用 ACK/RTT 替代。


补充入口观察（旧生产版本，未创建 Viewer）：正常 Chromium 登录页 HTTP 200、DOM 就绪 14190.4ms；同页三次 `/health` HTTP 200 且应用 status=ok，客户端总耗时 2203.8/1255.9/1282.8ms。样本说明可达但偏慢，不能据此构造总体 P95，也不能把客户端总耗时称作纯传输耗时。测试浏览器已关闭。

追加一次旧版入口分段测量（独立浏览器、未登录）：本地 DOM 190.7ms，DNS 0.1ms、建连 0.5ms、请求到首字节 8.5ms、响应体 3.3ms、响应结束到 DOM 173.4ms；正式域名 DOM 2098ms，DNS 缓存为 0、建连 688.8ms（含 TLS 687.9ms）、请求到首字节 430.3ms、响应体 1.3ms、响应结束到 DOM 975.7ms。TLS 是建连子阶段，不能重复求和；首字节等待包含网络和服务处理，响应后 DOM 也包含资源加载/调度，均不等于单向传输。与此前 14.2 秒样本差异很大，说明需要分布和环境分桶，不能取一次较快值宣称已解决。

补充整机进程分类快照（06:53 后，瞬时值）：30 个 Codex Renderer 合计约 230.9% CPU / 9.07GiB RSS；124 个 Chrome Renderer 合计约 85.4% CPU / 6.36GiB RSS；92 个 Node 进程合计约 2.54GiB RSS；10 个 Python 合计约 183.9% CPU / 1.36GiB RSS。RSS 汇总可能重复共享页面，CPU 是 `ps` 快照；不能据此认定某个单独会话或本工程造成全部压力。观察到大量并发桌面/开发进程，解决方案还需要减少无关并发或为远程桌面提供独立资源；本轮不会擅自结束用户其他应用。服务侧已用有界队列、单 worker、完整资源采样和失效隔离降低放大效应，但不能承诺在整机停顿几十秒时仍无中断。

集成首轮（`e5e086d`）：Host 23 文件共 290 项通过；JavaScript 79 文件共 1411 项，1409 通过、2 项失败。两项失败分别是代理可信地址测试依赖不存在的 worktree dist，以及诊断重试测试仍从旧根目录计数；均在修正隔离 fixture，不放宽生产资源校验或持久回执要求。临时构建成功由 schema1 迁移到 schema2，buildId `9390fef905cc0d41`，未写生产 dist。最终部署需使用复核后版本重新核对构建身份。

I1 两项 fixture 兼容修正已提交 `9a8bf3a`，对应 49 项通过：生产代理可信地址测试使用临时合法哈希资源清单，诊断测试通过真实读取 API 核对持久事件及回执 hash。未启用源码回退、未绕过磁盘回执，也未重建生产 dist。

最终分支交叉审查未发现新的 P0/P1，发现两项 P2 统计接线错误，已在 `1b706d3` 修复：Host 的 adapter 子阶段误含外层准入等待；真实 M2 帧关联没有更新 freshness。修复保留原协议边界和原始 rVFC 时间，旧帧/重复帧/暂停帧不能刷新 freshness；11 项 Python、44 项 JavaScript 定向检查通过，独立 scoped 复审已通过。外层输入排队仍是未单独计量的阶段，不能把 ACK RTT 减去 adapter 耗时当作纯网络。

隔离浏览器 bootstrap（`5b4baca`，独立临时 Signal，无 Host）：登录页 200、真实表单登录至核心就绪 653.6ms；桌面结构正常、390px 移动视口无横向溢出、pageerror 为 0。未创建生产 Viewer，不代表生产投屏验收。最终 `1b706d3` 临时构建成功，schema 2、buildId `7cdeb3e918582f7c`，保留实际生产上一 release `473f909ac58cea18`；独立复审已通过，随后已部署。

上线记录（北京时间约 07:33–07:34）：已将 `2a2c5ff..1b706d3` 经过审查的本地运行补丁同步到原 checkout，保留原 HEAD/index/未提交变更并三方合并三个文档。私有回滚快照位于 `/tmp/wrd-rollout-final-private-o9hkryk0`。`restart-local` 42.9 秒成功；Signal PID 89620，Host PID 89667，health 200、Host 在线、Viewer 0；实际 dist buildId `7cdeb3e918582f7c`，保留上一构建 `473f909ac58cea18`。cloudflared PID 84671/start Oct16 19:44:27 保持不变，quick URL 文件仍不存在。原有 shell watcher 会动态读取 checker/recovery helper，因此明确延后四个文件的激活：watch-fixed-domain.sh、lib-fixed-domain.sh、restart-fixed-domain-tunnel.sh、wrd_entry_health.py。W2 实现和离线 review 已完成，但本次运行仍使用旧 watcher；没有重启/重建 tunnel。

真实 I2 首轮暴露回归（约 07:34）：正式域名真实 UI 登录和 proof 准入成功，TURN ICE/DC connected，但 45 秒内 rVFC 无进展，持续 decoded/received/bytes=0，Host captureSeq 停在 2，因此验收为 INCOMPLETE/media-start-deadline，未作成功声明。根因已从实际日志和真实调用顺序定位：connection-attempt-bind 为隔离旧 producer 设置暂停标记，新 offer 继承该标记；Viewer 初始 generation 0 不重放 active intent，形成首次媒体启动死锁。已补首次 bind→offer 与显式暂停保留的行为回归，并于下述 `adfcb48` 修复。此故障属于本轮上线后发现的集成回归，不冒充最近三天历史故障的既定根因。

I2 启动补丁 `adfcb48`：独立 scoped review 通过，125 项 Host + 258 项 Viewer 回归通过。07:56:40 左右仅重启 Host，helper 8.91 秒成功，Signal 构建未变。修复后公网 TURN 实测通过登录、一次性准入、当前 receiver track 播放、连续 rVFC/decoded 进展和有效 input gate；三次连续健康样本通过，实际画面尺寸 1152×720。之后另一普通 Viewer 接入并按单 Viewer 规则 supersede 测试 Viewer，导致 baseline 提前结束；该次完整运行仍记 FAIL，不把短时 readiness PASS 写成连续性或重连 PASS。测试未发起接管，未执行业务输入。后续现有会话只读观察，不主动抢占。

重连验收工具边界：一次性 proof admission 在首次连接后被消费，Socket.IO 重连继续携带它会被保护逻辑拒绝；在 grace 内旧 Viewer 仍占 map，不能重新申请 zero-Viewer proof。因此这个工具不能直接证明普通用户的无修改自动重连；不清 proof、不绕过保护，不把保护拒绝误报成普通用户重连故障。


## 6. C5：自动恢复不得抢占更新会话（实施中）

真实短时验收先后出现普通 Viewer 接入、page-hidden 和租约到期。这些日志无法识别来源设备或区分人工动作与旧页自动重连，不作为特定客户端有故障的结论。独立审查另用真实 Signal handlers 固化两种源码反例：A 失联、B 已接入后，A 在 grace 内或 grace 到期后恢复，均会把 B 顶掉。离线时漏收 superseded 的旧页没有可靠的本地拒绝依据。

采用[准入补充设计](../specs/2026-10-17-viewer-admission-recovery-addendum.md)和[执行计划](../plans/2026-10-17-viewer-admission-recovery-plan.md)：服务端校验有界、单次的显式用户准入意图；自动恢复仅允许恢复当前 owner，不能顶替更新会话。保持单 Viewer、Host reset/rebind 屏障、一次性 proof 和人工 Viewer 优先。C5 完成独立复审后才同步生产。

验收尝试均保留完整失败/中断：`/tmp/wrd-public-relay-acceptance-20261017a` 为修复前首次媒体启动失败；`/tmp/wrd-public-relay-reconnect-20261017b` 为修复后短时 readiness 成功、baseline 被顶替；`/tmp/wrd-public-relay-acceptance-20261017c` 为另一轮 media-start-deadline，缺少足够 observer 证据，不能确定与同期普通 Viewer 活动的因果；`/tmp/wrd-public-relay-acceptance-20261017d` 在正式 admission guard 遇到现有 Viewer 而退出，未建立测试会话。均未计入连续性通过。
