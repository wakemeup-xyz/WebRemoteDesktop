# 稳定性与延迟整改实施记录

> **22:08 晚间续查更新：** 已部署诊断保存回执、固定入口摘要及独立抓屏状态观测，冻结候选db5d2b1/build067dfc41e8374b4e。Signal89188/Host89291在线；本地重启25.829s，tunnel/watcher与主HEAD/index保留。实际HTTP首次/重复提交均确认、pending0，入口完整JSONL与Host空闲capture已核对。旧版本正式短测maxgap10.566s；空闲窗口也有15.647s迟到及高换页，新版本短测继续复现，整体稳定性仍未通过。[晚间诊断](2026-10-17-evening-connectivity-followup.md)、[增量review](2026-10-17-evening-evidence-review.md)。下文按时间保留历史版本和失败证据。

> **15:16 部署更新：** 认证e996467、截图epoch修复83c513e已随冻结候选afd598a加载；本地restart-local25.679s，Signal28142/15:15:15、Host28181/15:15:18，health与Host在线、Viewer0、源码/资源及主仓HEAD/index保留核对通过。builda6e8b15122bde656及tunnel/watcher身份未变。新TURN窗口turn-long-20261017b最终131.953秒/132样本INCOMPLETE：客户端transport-close时PC与画面仍推进，maxgap783.3ms；5次Signal ping均有pong，本次没有长停帧或ping-timeout签名。七个已登记测试身份自然退出；三小时及真实input→visible仍未通过。

> **14:59 复核更新：服务在线，长会话验收未通过。** 已加载Host e279060（候选0ffb941），PID10658、Signal64505及builda6e8b15122bde656保持。本次计划10800秒的TURN实际采样256.072秒/256条，首次超限frameAge5262.4ms，已完成帧间隔先达6733ms、最终最大8116.308ms；Host心跳超时使控制租约失效，helper退出，INCOMPLETE。浏览器信令在清理前仍在线，不能归为Viewer先断开。线程采样被10秒预算终止且文件0字节，没有可用栈；旁证7个已登记测试进程自然退出，完整进程树退出仍未证明。原生input→visible仍NOT RUN。


> **前次状态（14:34核验）：服务在线，稳定性验收尚未完成。** 已部署Host JPEG传输准入/阶段观测和Viewer时钟/reset修复。JPEG暂停恢复短测PASS；随后TURN在31s内发生13.849s停帧与PC重建，Host同窗encode13.541s/loop lag12.771s。之后独立300s诊断窗口301样本无故障、最大画面间隔433.316ms，未触发线程采样，不能据此否定先前故障或代替三小时验收。已记录7个测试进程均自然退出；旧记录与完整子进程树的退出盲区保留。详见[实施记录](2026-10-17-remediation-execution.md)、[真实验收](2026-10-17-live-acceptance.md)、[Host停顿边界](2026-10-17-turn-host-stall-code-review.md)。业务输入到真实可见效果仍NOT RUN。

执行开始：2026-10-17。当前已同步 `afd598a`，网页 build **`a6e8b15122bde656`**（保留 `c30530f331a4def5` / `f5c2a9203e47f9e5`）。Host源码 `83c513e`（含e279060/d5ecb23/f492357）/ PID28181，Signal认证源码 `e996467`（心跳d1166ab）/ PID28142；13:12仅重启Signal，耗时5.861s，Host自动恢复，tunnel/watcher保持。Viewer本页时钟 `3ca62fe`、M6复位 `d057853`、控制撤销/释放复位 `c3abb21` 均已加载；最终534项相关回归和跨层独立复审通过，不能据此宣布运行验收完成。

加载后正式登录入口200、新build正确、登录表单可见，DOMContentLoaded约9.565s；同源health/status均200，Host在线。13:12时原普通Viewer自动重连、连接数1；该连接13:32已离线。后续自动化均重新核对零Viewer并取得一次性proof，不使用普通ticket接管。只读探测未登录/Start，browser.close API超时，manager.stop已完成，OS进程退出未取证，不能写为全部清理已确认。

此前上一build TURN300s PASS，JPEG69.744991s成功恢复后停帧5.2s而FAIL；新build现已完成JPEG111.236s短测PASS，后续TURN31.003s失败。原32分钟长测5.15s停帧及93s信令超时均保留。三小时、普通用户恢复资格、业务输入与真实可见效果未完成。JPEG首个停帧边界继续区分worker处理、结果回送与传输队列；不能用复位协议修复解释先前停帧。

用户本轮已授权开发、验收、启动本地 Signal/Host 并保持可用；原来的“仅诊断、不修复/重启”限制已被本轮指令取代。tunnel 的禁止停止、重启、重建限制保持有效。

## 1. 基线与执行边界

隔离工作区保留既有控制修复为基线 `2a2c5ff`；基于已 review 的总/子 spec 和 plan 开发。实施初期原工作区和运行中服务未加载改动；现已按本报告上线记录同步至 `5912f43`（Host `d5ecb23`、Signal `d1166ab`、Viewer `c3abb21`），W2 watcher 四文件仍明确延后。不能以工作区单元测试证明线上端到端验收通过。任务详细过程暂存于对应 worktree 的 `.superpowers/sdd/2026-10-17-reliability-latency-remediation-plan/progress.md`，最终结果归档于本报告。

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
| I2 持续验收工具 | 单次准入、流式采样、同身份与实际路径连续性、明确缺测；普通连接后不发送业务输入 | 原工具误判 PASS 已用反例修复于 `d2b5b80`，13 项 Python、10 项 JS 通过；独立 R1 通过；已运行生产短时测试，已有独立 300s 连续性 PASS，三小时未通过 |
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
| 本轮构建部署 | 已同步 `afd598a`；Host `83c513e`、Signal `e996467`（含d1166ab）、Viewer `c3abb21`；build `a6e8b15122bde656`；W2 watcher 四文件未激活 |
| 真实登录与媒体启动 | M6 公网 JPEG 85.034s / TURN 86.272s 暂停恢复短测均 PASS，含恢复后 60s 同会话。后续 TURN 93.094s 首次信令 ping timeout，视频仍出帧；此前连续性 INCOMPLETE；服务端心跳观测已加载，新一轮 300s 已 PASS，独立 3h 测试实际约 1922.5s 后因 5149.8ms 画面间隔取消，INCOMPLETE / 媒体连续性不合格 |
| 真实可靠输入与自动重连 | 业务输入 NOT RUN；proof 单次约束下普通用户自动重连未验收；C5 已部署，普通用户自动重连仍未作生产验收 |
| 输入应用到捕获/RTP/rVFC | M1/M2/M4 实现及离线关联验证已通过；NOT RUN 生产测量 |
| 输入到真实可见效果 | NOT RUN；需要真实 producer 事件与解码 marker，ACK 或下一帧不能替代 |
| 各路径连续三小时 | 未通过；保留首次媒体未 ready 零样本、173s 信令断开与 93.094s 已确认 ping timeout 三场未完成尝试。不得合并短程 PASS 作为三小时通过 |
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

## 6. C5：自动恢复不得抢占更新会话（已复审并部署）

真实短时验收先后出现普通 Viewer 接入、page-hidden 和租约到期。这些日志无法识别来源设备或区分人工动作与旧页自动重连，不作为特定客户端有故障的结论。独立审查另用真实 Signal handlers 固化两种源码反例：A 失联、B 已接入后，A 在 grace 内或 grace 到期后恢复，均会把 B 顶掉。离线时漏收 superseded 的旧页没有可靠的本地拒绝依据。

采用[准入补充设计](../specs/2026-10-17-viewer-admission-recovery-addendum.md)和[执行计划](../plans/2026-10-17-viewer-admission-recovery-plan.md)：服务端校验有界、单次的显式用户准入意图；自动恢复仅允许恢复当前 owner，不能顶替更新会话。保持单 Viewer、Host reset/rebind 屏障、一次性 proof 和人工 Viewer 优先。C5 经独立复审及 R1 修订后已同步生产，见下述上线记录。

验收尝试均保留完整失败/中断：`/tmp/wrd-public-relay-acceptance-20261017a` 为修复前首次媒体启动失败；`/tmp/wrd-public-relay-reconnect-20261017b` 为修复后短时 readiness 成功、baseline 被顶替；`/tmp/wrd-public-relay-acceptance-20261017c` 为另一轮 media-start-deadline，缺少足够 observer 证据，不能确定与同期普通 Viewer 活动的因果；`/tmp/wrd-public-relay-acceptance-20261017d` 在正式 admission guard 遇到现有 Viewer 而退出，未建立测试会话。均未计入连续性通过。

## 7. 已部署版本的补充观察（07:56:48–08:18:00 北京时间）

该固定窗口长 21 分 12 秒，Host 最后匹配日志止于 08:17:58；不与原 72 小时窗口混算。证据来自 `back-debug.log:17673` 起及 `/tmp/signal-server.log:64040` 起；脱敏提取与完整异常时间线见私有 `/tmp/wrd-postdeploy-evidence-review.md`。

- 08:17:28 左右本地 health 200/6.17ms、status 200/1.43ms，Host 在线、Viewer 1；这是本地瞬时存活证据。Signal 89620、Host 2777、cloudflared 84671 和 watcher 897 均存活，tunnel 起始时间未变。
- Signal 记录 14 次 Viewer socket 断开（10 次 ping timeout、4 次 server namespace disconnect）、8 次 lease-expired fail-closed 和 1 次 controller-disconnect；Host 有 8 个 offer、6 次 WebRTC connected、8 次 page-hidden 暂停。事件可重叠，不能当作独立故障/用户数，也不能据此归因到某个客户端。
- 首轮有真实捕获：一条 CAPTURE_STATS 的区间 fps=12.1、61 frames、1152×720，recv_total 平均 48.5ms（含 sleep 平均 33.2ms、convert 平均 2.9ms）。首轮关闭时 captureSeq=52；其后七次关闭仅 1、2、1、2、2、7、1。这不能代表持续投屏性能。
- 227 份完整低频 lag 摘要对应重叠的 60 秒滚动窗口，最大 lag 168.661ms，missedSampleCount 全为 0；窗口 p95 范围 4.977–112.316ms。不能把这些重叠 p95 再合成总体 p95。209/227 份 pcState=none，主要是空闲/恢复期，并非持续视频负载；不据此宣称 TURN loop P95≤50ms 已达标。
- Host task 7–14、线程 3–5，当前 RSS 44.80–352.24MiB；systemLoad1 为 3.486–19.710。整机短时 swap-in 最高约 449.06MiB/s、swap-out 最高约 1057.40MiB/s，来源为约 5 秒计数差分，缓存可能重复；不外推至整个窗口，也不归因给单个服务。当前窗口未见明显累计 task 爆涨，但不是无泄漏证明。
- 08:16:09.465 有一次 aiortc 内部 `RTCPeerConnection.__connect` 未取回异常：`InvalidStateError: RTCIceTransport is closed`。lease-expired 与受控关闭先发生；Host 在 await close 前已同步 detach 当前 PC，完成日志证明没有覆盖新 PC，下一 offer 在约 16 秒后才开始。尚无证据它导致本次租约丢失或破坏新连接；保留为未关联到具体 PC 的关闭竞态异常，不擅自过滤或计为独立断线。
- 所有 Host 摘要 inputEventCount/inputWaiters 均为 0，没有真实输入 timing/encoder sample。故该窗口的业务 ACK、输入应用到新帧、纯传输和实际可见效果仍缺测；本地 health RTT、capture 均值和 connected 状态不能替代。

原生可见效果验收的具体能力缺口和最小环境见[验收边界](2026-10-17-visible-effect-acceptance-boundary.md)。当前共享桌面不能建立独立输入/捕获边界；不伪造 probe、不改用 DOM 事件冒充原生输入，该项保持 BLOCKED。

C5 实现 `cd64e54`：真实 handler 原两项 RED 已转绿，实际 API/Socket.IO、Viewer Start/reclaim/自动恢复及原有控制回归共 473 项通过。30 秒/128 条有界 ticket 与固定大小 owner/顺序状态；proof 不申请普通 ticket，恢复不产生新意图。服务重启后未知恢复保守拒绝，旧页面需刷新并显式连接；这一兼容取舍已写入设计和[实现报告](2026-10-17-task-C5-admission-recovery.md)。独立复审未完成前不部署。

## 8. C5 修订、部署与新的验收边界

C5 `cd64e54` 增加显式 Start/reclaim 准入票据和独立于 socket/grace/TTL 的当前 owner；自动重连只允许当前 owner。初轮 473 项相关测试通过。独立复审发现 Start 在 bootstrap 完成前被拒绝/顶替时丢弃 TURN 配置，随后人工 reclaim 可能失败；`8e375fa` 保留并校验 pending bootstrap 的身份，reclaim 等待正确配置后才签发意图和创建连接。修订的 259 项相关测试通过，独立 R1 通过；数量有重叠，不求和。详见 [C5 独立复审](2026-10-17-C5-independent-review.md)。

08:53 北京时间仅更新并重启本地 Signal/Host，helper 完成耗时 16.356 秒；Signal PID 29105、Host PID 29164。08:53:43 health 200、Host 在线、Viewer 0；实际构建 `b73325b8166441a6`，保留前两构建 `7cdeb3e918582f7c` / `473f909ac58cea18`。原 checkout HEAD/index 保持不变；cloudflared PID 84671、watcher PID 897 和各自启动时间不变，quick URL 文件仍不存在。回滚快照保存于私有 `/tmp/wrd-c5-rollout-private-ilovzfv1/apply-8e375fad-2jvzvnqo`，未在版本文档保存凭据。

本次公网媒体生命周期验收 `/tmp/wrd-public-c5-media-relay-20261017a`：登录页、fresh zero-Viewer proof、真实表单登录通过；69.11 秒后 readiness 超时，62 个样本均无 Socket/PC，画面和输入指标均缺测，浏览器已关闭。复核发现私有验收工具只在一次 `startBtn.is_visible()` 为 true 时点击，没有等待实际可用，也没有记录点击证明，因此该次 FAIL 不能作为 C5 服务回归证据，具体不可见原因也不能从现有样本确认。工具修订须等待 core/auth 与真实按钮可交互、验证 `start-click` 标记增加，才进入媒体验收；不绕过 UI 直接调用 Start。此失败记录保留，后续结果单列。

最新公网各轮结果、实际传输分段与保留失败见[运行验收报告](2026-10-17-live-acceptance.md)。I2 Start 证明工具修订 `e2275a5` 已独立复审并同步，仅改验收脚本，无服务重启；[任务复审归档](2026-10-17-I2-start-proof-review.md)。JPEG 的运行复现与离线反例需完成 M6 后重验，不能因 TURN 短时 PASS 把整体验收关闭。

## 8. 后续准入工具与新发现（09:49 之后更新）

I2 `0a89ebe` 将一次性 proof 移到真实 UI/core/auth 就绪之后，删除额外 API 登录；25 项 Python + 10 项 Node 通过，独立复审 PASS。仅同步验收脚本，无服务重启。[独立审查](2026-10-17-I2-proof-timing-review.md)。首次长测原因仍未知，不能因工具改进断言其 proof 过期。

新一轮 TURN 请求 300s，实际 173.094s/174 样本，信令先断而视频仍刷新；Host 无同期明显事件循环停顿。服务端 transport close 与测试清理同窗，缺少首次客户端 reason，不归因 TURN 丢包或普通用户重连。详细窗口、失败分母和传输阶段见[运行验收报告](2026-10-17-live-acceptance.md)及[信令断开诊断](2026-10-17-turn-signal-drop-diagnosis.md)。

M6 [补充 spec](../specs/2026-10-17-jpeg-relay-recovery-addendum.md)和[执行 plan](../plans/2026-10-17-jpeg-relay-recovery-plan.md)已完成两项初稿问题修订，独立设计复审 R1 PASS：初始 generation 0 单独握手、完整来源 RTT sample key 均明确；源码已实现于 `5e6c26c`（106 Python、457 Node 最终通过），独立代码 review 进行中，尚未部署或验收。规格覆盖 ACK 槽 2000ms 单调过期、完整帧来源、5000ms 图像加载新鲜度门禁及安全 reset、经过 TTL 截断与合并采样说明的同钟 RTT。[设计 review](2026-10-17-M6-design-review.md)。

媒体性能复查进一步区分了输出、新采集和浏览器回调：该 172s 健康窗口约 19.39 解码帧/s、8.84 新采集/s、11.18 rVFC 回调/s；后者未导出 presentedFrames，不能直接推导视觉丢帧比例。稳定捕获日志中 54.80% 输出为缓存复用；缓冲正值峰及后段 loss/NACK/解码空窗真实存在，具体传输/截图/调度瓶颈仍缺证据。另确认 `processStatsSnapshot` 的缺测 RTT/缓冲转 0 缺陷待修，不能将缺测当零延迟；本轮 artifact 原始 LatencyMonitor 值不受此转换影响。详见[媒体性能诊断](2026-10-17-turn-media-performance-diagnosis.md)。README 的旧 2 倍采集及 superfast 默认说明已按生产工厂/编码策略源码修正。

## 9. M6 本地部署与当前验证

`5e6c26c` 实现后独立 review 无 Critical/Important，一项共享延迟提示问题由 `966890b` 修复并通过 scoped R1。原实现最终 106 Python / 457 Node 通过；R1 7 项针对性检查通过，数量有重叠。[独立 review](2026-10-17-M6-independent-review.md)。

约 10:39 北京时间，经过 fresh zero-Viewer 检查、逐文件基线验证和备份，将 `86c2e34..966890b` 18 条路径同步到原 checkout，保留原 HEAD/index 与既有脏文档。仅重启本地 Signal/Host，耗时 18.620 秒；Signal PID 85909，Host PID 85937。实际部署源码三文件精确匹配候选；schema 2/build `f5c2a9203e47f9e5`，保留 `b73325b8166441a6` / `7cdeb3e918582f7c`。health/status 正常、Host 在线、Viewer 0。cloudflared 84671 与 watcher 897 启动身份不变，quick URL 仍不存在；W2 四文件仍未激活。私有回滚快照 `/tmp/wrd-c5-rollout-private-ilovzfv1/apply-966890b8-8qje3zln`。这证明加载与本地存活，不代表公网 M6 验收通过。

I2 信令首断 observer `10d4146` / 报告 `1e34602` 已实现：20 JS / 39 Python 通过，独立 review 进行中，尚未同步生产验收脚本。保留单次 proof 与首断严格失败；无法证明真实进程退出时保持 not-observed。媒体缺测两字段修复的[最小 plan](../plans/2026-10-17-media-null-observation-plan.md)沿 M1 契约，不扩展测量或修改网络阈值。

M6 公网 JPEG 短测 PASS：85.034s/84 样本，暂停恢复 4.009s，随后 60.0025s 当前来源连续出图、RTT 反馈与门禁通过；两次槽过期回收后仍有进展。详见[真实验收](2026-10-17-live-acceptance.md)。不扩展为三小时或业务输入已验收。
I2 首断工具独立 review 初轮发现两项证据失真风险，`0f0e902` 修复 startup-summary 失败误 PASS 与初始证据写失败仍连接；实际健康 fake 反例及 5 个针对性测试通过，独立 R1 APPROVED。[I2 审查记录](2026-10-17-I2-signal-observer-review.md)。

## 10. Nullable 部署与整轮增量复审

`9e57bf4` 修复 RTT/缓冲 unknown→0，从真实 Viewer/UI/控制器到 Signal/Host 日志保持 number|null；真实0和已有 stall/loss恢复保留。[实现](2026-10-17-media-null-implementation.md)、[独立 review](2026-10-17-media-null-review.md)。已同步原 checkout 15 条路径（12 源码/测试及3份保持原内容的文档），私有备份 `/tmp/wrd-c5-rollout-private-ilovzfv1/apply-9e57bf47-t4k_adk1`。本地重启22.553s后 Signal3905/Host4164、build c30530f331a4def5，health/Host通过；tunnel/watch及原Git身份保持。

`8e375fa..9e57bf4` 37路径整轮增量 review PASS，无新源码 P0–P3 项；[报告](2026-10-17-runtime-followups-final-review.md)。最新 JPEG/TURN短测、93s失败与入口复查见[运行验收](2026-10-17-live-acceptance.md)。下一步仅设计有界服务端心跳事件/flush观测，不因相关性盲改超时、网络模式或tunnel，也不为让验收成功而绕过单次proof。

## 11. 服务端心跳边界补齐与加载

`d1166ab` 只给已准入主 Viewer 的既有 Engine socket 附加只读 heartbeat 监听：32 条 ring、8 recorder 上限、关闭时一次 <=4096 字节 JSON；pc 表示 pingCreate、pf 表示 flush 意图、pr 表示服务端接收 pong。没有修改超时、准入、重连、控制或媒体协议。shutdown snapshot/清理先于 runtimeObserver.stop；所有自身 listener 在关闭时解绑。

实现定向测试 14 项，signaling/runtime 115 项通过；独立 reviewer 另执行 heartbeat/runtime 18 项和 targeted signaling 3 项通过，两种 verdict 均 PASS，计数有重叠不能相加。完整报告见[实现](2026-10-17-server-heartbeat-implementation.md)、[复审](2026-10-17-server-heartbeat-review.md)。

在 fresh Host online/Viewer0 后，以已同步 `9e57bf4` 为基线应用冻结 `58ad766`：24 路径，5 源码/测试路径，包含此前文档更新。primary HEAD/index 原样保留；README/runbook/需求原有改动经三方合并保留。仅 webremote-service restart-local，14.906s，Signal15135、Host15287；HTTP health/status200、Host在线、Viewer0。build 仍 c30530f331a4def5，保留 f5c2a9203e47f9e5/b73325b8166441a6。cloudflared84671（10月16日19:44:27启动）、watch897（10月1日15:47:50启动）及四个 deferred watcher 文件未变；quick URL 文件仍不存在，正式入口未改。

新 guarded 300s TURN 测试 `/tmp/wrd-public-server-heartbeat-turn-20261017a` 已进入真实媒体采样，结果另记真实验收；本节加载成功不等于会话稳定性通过。测试仍在首次不连续时失败，不消耗第二次 proof 重连。

S1 加载后的 guarded TURN 300s 已 PASS（301样本、0missing/late/identitychange），客户端无异常首断，server正常收尾 pc/pf/pr各11；不是三小时通过。独立3h试验已启动，详见真实验收。

## 12. 最新媒体性能与资源限制

300s 已通过会话内：解码18.210帧/s、rVFC17.913次/s，严格位于浏览器窗口内的新captureSeq速率9.7408次/s；60个Host输出窗口49.14%复用缓存。窗口范围不完全相同，不强行一一相除。接收buffer snapshot的last中位7.9ms、最大121.7ms，>=100ms仅startup tick4/6；稳定后最大70.4ms，实际framesDropped0。Host编码有448.357ms长尾、事件循环滚动max最高312.539ms及明显swap-in；这些是局部/重叠窗口统计，不是每帧全量P95，也不证明哪一资源因素造成截图频率约9.7/s。没有新确认的源码缺陷，真实MSS grab阶段仍缺证据。详见[最新媒体复核](2026-10-17-latest-media-performance-review.md)。

11:44左右只读进程快照969进程；最高RSS为Chrome Renderer约2897MiB、VS Code Helper约1670MiB、若干Codex Renderer约1278–1548MiB，Host约400MiB。RSS不能当作物理内存独占量相加，也不能仅凭这个瞬时排序归责换页。没有退出其他应用或清理身份不明的进程；保存私有resource-snapshot-longrun-20261017a.json用于后续同窗口关联。

## 32 分钟终态与单调时钟缺陷

长测 1922 样本，0 缺失/迟采/身份变化；97 failedObservations 是首次超限加累计最大 gap 的重复观察，不是 97 次断线。信令全程 connected，74 轮 ping/pong；唯一关闭为主动停止自己的测试浏览器。服务仍在线，三小时未通过。完整 [媒体事件](2026-10-17-longrun-gap-diagnosis.md)与[心跳报告](2026-10-17-server-heartbeat-runtime-diagnosis.md)保留原证据。

进一步 [源码时钟审查](2026-10-17-media-clock-review.md)确证 recv 与 JPEG 循环用墙钟节流；模拟回拨 4.24s 会把 30ms 等待变为 4.27s。已补 [spec](../specs/2026-10-17-media-monotonic-clock-design.md)和[plan](../plans/2026-10-17-media-monotonic-clock-plan.md)，待实现复审。该机制与第二次停帧吻合，仍不能分摊整段 5.15s 或解释第一次真实 2.7s Host loop stall；尚未据此声明线上修复。

当前阶段计时能力见[Host 清单](2026-10-17-host-stage-clock-inventory.md)：已有成功 grab、私有构图排队、编码等单调计时，但 detailed trace 默认关闭，且尚未证明当前每个边界都实际装配。不能用已有类/字段存在代替真实样本。12:26后独立两秒系统采样 load1=5.777、swap-in约18.80MiB/s、swap-out约68.33MiB/s；这是恢复后的短时现状，不是前述卡顿的逐帧资源证据，也不等于内存压力已消除。

媒体时钟源码 `f492357` 已独立复审 PASS：[实现](2026-10-17-media-clock-implementation.md)、[review](2026-10-17-media-clock-task-review.md)。实际方法回归 RED14失败→GREEN104通过；尚待加载。另一个[Viewer 时钟审计](2026-10-17-viewer-clock-review.md)确证本页 ACK/恢复受墙钟跳变影响，已写[spec](../specs/2026-10-17-viewer-control-clock-design.md)和[plan](../plans/2026-10-17-viewer-control-clock-plan.md)，待实现。

[已有详细 trace 操作审查](2026-10-17-existing-frame-trace-operational-review.md)发现首 offer 的 track context 未同步装配，单开 flag 不能保证有效抓图/发送关联；当前保持默认关闭。此诊断能力缺口不影响默认关闭时媒体路径，未为了补数据擅自开启更高频 trace，也未将缺测写为零。

## Host 单调时钟修复加载

审核源码 `f492357` 随文档冻结树 `836dccd` 同步到主工作区；只调用既有 helper 的 restart-host，耗时5.913s。新 Host42127、Signal15135保持，build仍c30530f331a4def5；本地health/Host在线、Viewer0，源文件hash匹配冻结提交，HEAD/index/四个延后WATCH文件/tunnel84671/watcher897/quick文件不存在状态均保留。备份和验证存本机 apply-836dccd2-0_vtrc9c。未调整系统时钟或高频trace配置。

新300秒TURN观察 `/tmp/wrd-public-media-clock-turn-20261017a` 已启动，属于修复后新会话，不能与旧300秒PASS合并。Viewer本页控制时钟源码仍在实现，尚未部署。

Host时钟修复后新TURN300s PASS：301样本0missing/late/failed/identitychange，maxgap449.998ms；decoded18.71fps、rVFC18.49/s、新capture约10.11/s、reuse48.52%。[性能细节](2026-10-17-media-clock-short-performance.md)、[信令细节](2026-10-17-media-clock-short-signal.md)。这不是三小时或真实业务输入验收。

随后JPEG媒体生命周期测试实际69.744991s/69样本FAIL：初始/暂停/恢复全部通过，但恢复后qualified load age到5200ms，输入门禁按新鲜度保护关闭；socket仍connected。失败原因是post-recovery-not-healthy，完整现场在本机`/tmp/wrd-public-media-clock-jpeg-20261017a`，继续分层诊断，不能用前一TURN通过覆盖此失败。

Viewer时钟`3ca62fe`已独立review PASS、主要427测试PASS；相邻两项失败独立确认为缺M6认证scope的旧fixture，正在单独修复测试，生产校验不放宽。[实现](2026-10-17-viewer-clock-implementation.md)、[review](2026-10-17-viewer-clock-task-review.md)。临时候选buildb6d77cd86c6f9d02保留c305/f5，尚未上线。

## 可丢诊断通道准入增量（已于14:47部署）

`e279060`仅对frame_timing、capture_stats和两类detail批次增加4096B同步字节准入，拥塞时丢弃并按固定字段统计；可靠input_ack、M2binding、时钟及labflush路径不变，不重试/补发旧诊断。65项Python及45项Node回归通过，独立task review通过；一个已有trace fixture失败经独立归类，在`616a79d`补当前receiver/SSRC及detail启用条件，保留全部原断言，6项安全Python/21项Node检查及独立复核通过。测试范围有重叠，不相加为唯一用例数。详见[实现](2026-10-17-dc-diagnostic-admission-implementation.md)、[准入复核](2026-10-17-dc-diagnostic-admission-review.md)、[fixture复核](2026-10-17-trace-integration-fixture-review.md)。跨层最终复核通过，独立66项Python/45项Node通过；现已随冻结候选0ffb941加载。4KiB不是完整SCTP/ACK内存界，也不是13.8s停帧根因修复的证明。

## 15:15 登录与截图失效修复加载

[两项增量](2026-10-17-auth-epoch-increment.md)及[最终复审](2026-10-17-final-auth-epoch-review.md)均通过，唯一P3历史状态歧义已独立关闭。29个路径（4个源码/测试路径）同步，既有修改与四个WATCH文件保留；本地Signal/Host由helper重载25.679s。Host文件SHA256 a9e40ef6520ce602ffa6df81c6bfe975bbb8440f612b3f0a83e2afdc92c86999。备份apply-afd598a8-fsxwqk51留本机私有目录。密码仅从运行.env读取并在会话回报，未写入版本文档。

下列章节按各自时刻保留历史观察；当时的“尚未加载/待实现”不能覆盖文首最新部署。新TURN长测独立记录，不拼接此前短测，且未获得三小时或真实输入可见效果结论。

## 当前剩余验收与解决方向

1. 已确认代码缺陷均按各任务测试/review/部署记录处理；最新auth与图像epoch修复已加载，不再把“已review”当“线上已验收”。
2. 之前Host停帧具有本机采集/调度停顿及大量换页证据；新窗口没有同等停顿，但仍低于目标新帧率。需要稳定资源窗口，不能通过杀其他应用或降低用户分辨率伪造改善。
3. 本次独立WS transport-close尚无关闭码/发起方证据。先补最小关闭元数据与同条件对照；保持既有公网入口和tunnel，不直接增加timeout。
4. 普通用户自动恢复与真实input→visible需要独立设备实际证据。已请求人工操作；自动proof不重用/重发/接管。三小时连续性仍未完成，不宣布“彻底稳定”。

本轮新失败见[验收终态](2026-10-17-live-acceptance.md)。服务仍保持运行；等待人工操作期间只做不创建Viewer的离线/文档工作。

## 15:51 诊断工具同步复核

验收工具1677473与截至0f29c45的文档已同步到主工作区，22项Node、42项Python离线检查及独立task/final增量review均通过。只更新4个验收脚本/测试，无产品服务代码和build变化，无重启。原HEAD/index、未改文件、tunnel/watcher/quick状态保留；服务健康、Host在线、Viewer0。

私有supervisor仅成对更新已审查helper/sampler SHA，现SHA为76106a958fde1fe80650524ca43952a12bc7c7ce36ee348f30ebebce95e0e884；16项纯fake回归通过，3项会启动真实子进程的测试按本次边界未运行。历史run、失败结果和hash未改。真实关闭元数据尚未采到，人工输入、普通恢复和三小时资格仍待验收。

条件性本地/公网对照工具准备完成，私有supervisor只增加两端点精确白名单及固定originClass。19项纯fake测试和独立spec/quality/integration review通过；当前supervisor SHA为2bfc3e7c5cffa72ad3fda45ae78c91bb4c83cb9684d05356acffeaab84b39f7a（替代15:51的仅pin更新版本），helper/sampler配对hash不变。工具尚未运行真实对照，人工测试仍pending、未创建Viewer；输入origin类别不等于实际路由证明。维护授权仍有效，无需重新询问许可。见[对照设计](2026-10-17-origin-comparison-design-review.md)和[独立review](2026-10-17-origin-comparison-task-review.md)。
