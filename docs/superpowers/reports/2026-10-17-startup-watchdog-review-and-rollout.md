# 启动控制通道超时：review、部署与验收记录

更新：2026-10-17，Asia/Shanghai。当前运行源码 `3cafc64a303c10d69cd890248e70a4bf69a7d8e0`，网页 build `22d13d54ac6b458a`。

## 根因与修复边界

22:09 的旧版实测中，故障抓取时间 22:09:25.165 早于 Host 首次 answer 的 22:09:25.547。原 10 秒控制通道超时从创建 peer/channel 就开始计时，包含信令连接、控制租约和 relay ICE gathering 等协商耗时，可能在应答尚未到达时重建连接。

本次将协商限定为 30 秒，当前 answer 成功安装后另给通道 10 秒；只在既有 connecting/checking 条件下允许两次 10 秒延期。使用绝对单调时钟截止、所属 peer/channel/socket/attempt 校验和清理边界。它修复过早判定及旧回调干扰，不保证外部网络或 Host 调度一定按时完成。约 60 秒是计时策略上限，浏览器暂停可能推迟实际回调。

诊断增加固定 14 字段阶段摘要，经同一白名单函数贯通采集、浏览器缓存、服务端持久化；不记录原始网络地址、SDP、输入正文或凭据。缺失/无效时钟保持 null。失败快照先被抓取保存；取消、打开、退休和新尝试时清理当前快照，避免将旧故障标为新连接的当前状态。

## 决策及代价

| 决策 | 原因 | 代价或限制 |
|---|---|---|
| 分开 30 秒协商与 10 秒通道等待，保留最多两次延期 | 实测证明应答前已触发 dc-stuck | 真正无应答会等到 30 秒；并非启动性能目标放宽 |
| 固定阶段状态放在 schema3 的 startup 下，使用共享白名单 | 旧版服务端有意丢弃 network，单加网络字段不能落盘 | 增加小于 1KiB 的有界诊断结构；保留原报告总大小与回执契约 |
| 协商中意外关闭保留原有限截止；已连接关闭沿用 3 秒恢复并校验所属连接 | 避免关闭时取消唯一截止后无限等待，也避免旧关闭回调误伤新连接 | 协商期关闭可能等到原截止才恢复，不做无限即时重试 |

## 独立 review 与验证

设计 preflight 通过前，补齐协商期意外关闭、offer epoch 与 watchdog 所属关系、无效时钟和共享白名单要求。实现提交 `5b81a9e`；延迟 answer 回归先在旧码复现 11 秒时错误 dc-stuck，最终关联离线测试 426/426 通过。

任务 review 发现延期重置阶段起点，会少报实际等待时间；`957654c` 保留阶段起点并增加 30 秒累计阶段年龄断言，22/22 定向测试通过，独立复核通过。最终跨组件 review 发现旧失败快照可跨退休/新尝试残留；`3cafc64` 修正并验证原故障报告不变、当前状态恢复 inactive，61/61 定向测试通过，独立复核批准部署。未因小修复重复整个测试集。无剩余 Critical/Important/Minor finding；这不替代运行验收。

额外页面慢加载源码审计未发现迟到 core 导致永久禁用、重复启动或旧鉴权状态残留。5 秒失败提示允许后续成功安装清理失败 UI；此前单样本超过启动性能目标的事实保留。资源时间和 shell-relative mark 是不同口径，不相加或据此推断所有公网失败原因。

## 安全部署

以实际主目录基线 `f0571d6` 冻结差异，隔离构建和 manifest 校验通过后 apply 9 个源码/测试路径及既有文档合并。主目录 HEAD、index、其他源文件、四个未部署 watcher 文件和 quick URL 缺失状态保留。原修改没有被混入本次提交。

每次 apply/restart 前均确认 Host 在线、Viewer=0、relayViewer=0。仅通过既有 helper 重启 Signal，3.371 秒恢复；Signal PID15383，启动 22:58:48；Host PID89291、启动 22:06:28，未重启且自动重连。cloudflared84671 与 watcher897 身份未变。新 build 保留 `067dfc41e8374b4e` 与 `a6e8b15122bde656` 旧资源；源码、manifest 和所有列出的资源逐个哈希核对通过。凭据只从本机配置读取并向用户回报，不进入文档。

## 运行结果

采样时间约 23:00:19.002–23:05:19.004（浏览器 time origin 映射，非光学同步）。

正式入口、正常鉴权及一次明确 Start、一次性维护准入的 300 秒被动测试：PASS，实际 300.081 秒、301 样本、无缺样/迟样/失败观测/身份变更，最大无画面推进间隔 916.7ms。输入门禁为就绪并非原生输入执行证据。采样 baseline 已为 PC2/generation2；启动存在一次 connect_error 和恢复，不能仅据采样 PASS 宣称首连无重试。

supervisor 总耗时 345.723 秒，包含启动和退出；worker exit0，无截止超时、干预或发送清理信号。7 个已登记 worker 自然退出，完整进程树退出仍未证明。未触发额外 Host native sample。结束后 health 正常、Host 在线、Viewer=0、relayViewer=0。

该结果只证明本窗口被动画面连续性。真实输入 ACK、Host 输入阶段、应用后新帧、真实可见效果以及三小时连续会话保持 NOT RUN/未验收；不能用 RTT 或控制门禁代替。共享桌面的 native 隔离 probe 尚未实现，不绕过 runner 的 fail-closed 限制。早前 Host 空闲长停顿和活动抓屏/调度停顿也不能因一次短测通过而注销。

关联：[设计](../specs/2026-10-17-startup-datachannel-watchdog-design.md)、[计划](../plans/2026-10-17-startup-datachannel-watchdog-plan.md)、[完整晚间诊断](2026-10-17-evening-connectivity-followup.md)。

## 本轮延迟证据

下表是重叠应用窗口快照的 last 值范围，不是整段 P95，也不是单向传输耗时。

| 指标 | 本轮范围 | 边界 |
|---|---|---|
| Candidate RTT | 30–510ms | 301 个快照，样本年龄约111–141ms；包含往返与端点调度 |
| Jitter buffer | 20.7–218.9ms | 300 个可用快照；不能与不同窗口其他阶段直接相加 |
| 浏览器解码 | 0.465–1.608ms | 300 个可用快照；dropped counter 始终0 |
| Host 抓屏最近一次完成 | 21.544–53.110ms | 报告时最近完成调用；track lifetime 最大360.669ms可包含采样前 |
| Host 正在抓屏年龄 | 4.396–126.916ms | 抓屏墙钟包含原生等待与调度，非纯CPU |
| Host event loop | latest0.127–53.687ms；滚动60秒窗口P95为2.149–6.844ms | 53份报告互相重叠，不能相加当独立采样；首窗含采样前 |
| 实际输入ACK/Host输入队列与执行/应用后帧/真实可见效果 | null / NOT RUN | 本次没有原生业务输入，不能由RTT和帧率补填 |

画面回调9→5491，decoded11→5794；relay/UDP/H.264、1152×720保持。Host报告边界23:00:23.032–23:05:16.030，292.998秒墙钟内进程CPU新增87.972秒，平均约一个核30.02%，不是瞬时CPU峰值。53份资源报告均available/status ok，但年龄948–4984ms，memoryPressure仍unknown；全机swap有波动，不能据此说内存压力已消除或单独归因Host。

## 启动阶段仍有信令重试

日志只读取 preflight 至 supervisor 结束的固定字节片段，Host289849字节、Signal9678字节，前后inode/device一致。观察器23:00:05.774记录一次 connect_error，类别unknown；统计另有一次engine close、reconnect_attempt/reconnect/socket connect，没有观察到此前已建立socket的disconnect。Signal只收到一次offer；Host23:00:14.987收到、15.699发answer、17.455完成ICE、18.048连接。采样于19.003左右开始。

sampler为看到的不同PeerConnection分配递增序号，PC2证明采样前曾观察到另一peer，不能当任意初始标签。源码中 connect_error 后恢复、对未健康peer进行signal-reconnected刷新可解释此序列；早期事件环已丢772条，具体refresh reason未保留，因此这是有依据的调用路径推断。当前证据不支持再改watchdog截止；也不能确定信令错误来自浏览器、网络、边缘或origin。

没有本次新增watchdog故障报告可供核对；默认诊断目录无晚于preflight的新报告，未读取运行进程完整环境，不能排除另配目录。旧22:09报告记录captured.wallTime22:09:25.165、server receivedAt22:09:27.004，未包含明确uploadedAt字段；它仍是旧代码证据。清理前标记23:05:19.008早于Signal断开19.454，符合主动浏览器退出，不是本轮采样中途断开。

下一步核查5秒信令预算与WebSocket/轮询回退的实际实现，并补固定错误分类与启动事件留存的证据缺口；不凭unknown直接延长超时或更换tunnel。
