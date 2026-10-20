# turn-long-20261017b：Signal / heartbeat / tunnel 日志只读分析

**结论：本轮首先发生客户端当前 Engine 的 `transport-close`，随后 Socket 断开、租约清空、输入门关闭；媒体当时仍在进展。没有复现此前已归类的 Viewer `ping-timeout`。现有证据不能确定是谁首先关闭 WebSocket，也不能将其归因于 Cloudflare、Host 或 helper 清理。**

本轮计划 10,800 秒，实际媒体观察 131.952546 秒、132 样本；三小时连续性未达到。supervisor 耗时 167.110 秒包含启动与退出，不能当作媒体覆盖。以下仅使用既有本地证据；没有网络、浏览器、probe、测试、服务/tunnel/native 输入操作，没有源码或 Git index 变更。

## 首次断连与清理的先后

时间均为 2026-10-17；UTC 与 CST（UTC+08:00）并列。客户端 epoch 由既有 anchors 换算，两种锚点差 1 ms；表中毫秒不表示跨进程因果精度。

| UTC | CST | 已有证据 |
|---|---|---|
| 07:18:52.242 | 15:18:52.242 | Signal 创建并 flush 第 5 个 ping |
| 07:18:52.634 | 15:18:52.634 | 客户端收到 ping、创建 pong |
| 07:18:53.001 | 15:18:53.001 | Signal 收到第 5 个 pong；该次 flush→pong 759 ms |
| 07:19:00.048 | 15:19:00.048 | 倒数第二样本：Socket connected、PC connected、租约 epoch 1、effective input gate=true |
| 07:19:00.366 | 15:19:00.366 | 客户端最后 packetCreate/flush；记录包类型为 unknown，不能当作 pong |
| 07:19:00.626 | 15:19:00.626 | **首断连**：当前 Engine close，reason=`transport-close` |
| 07:19:00.644 | 15:19:00.644 | Socket disconnect 与 Manager close，均为 `transport-close` |
| 07:19:00.752 | 15:19:00.752 | 最后帧回调，晚于首次 Engine close 约 125.6 ms |
| 07:19:01.052 | 15:19:01.052 | 最后样本：Socket=false、leaseEpoch=0、effective input gate=false；PC仍connected、media仍active |
| 07:19:01.069 | 15:19:01.069 | Python 检测到失败 |
| 07:19:01.080 | 15:19:01.080 | observer preclose，随后停止监听 |
| 约07:19:01.141 | 约15:19:01.141 | helper 开始 browser.close；819 ms后完成 |
| 07:19:01.540 | 15:19:01.540 | Signal `viewer-heartbeat-close`：engine / transport-close |
| 07:19:01.550 | 15:19:01.550 | Signal Viewer disconnected，原始 reason 分类 transport close |
| 07:19:01.589 | 15:19:01.589 | Signal 进入 Viewer reconnect grace |

同一浏览器时钟内，首断连比 preclose 早 **454 ms**，所以此次首断连不是 browser.close 造成。反过来，**Signal 关闭记录晚于 browser.close 开始约399 ms**，且晚于客户端首断连约914 ms：它可能是原始关闭的传播，也可能受随后清理影响；没有底层关闭元数据，不能选定其中一个解释。

最后一秒 framesDecoded 1914→1926、帧回调1878→1890；PC/attempt/path身份及generation保持，只有Socket、leaseEpoch、effective input gate变化。summary的 identityChangeObservations=1来自leaseEpoch归零，不代表PC或attempt换代。startupSummary.controlState=ACTIVE没有独立时间戳，也不能覆盖末样本inputAllowed=false。

## Signal 有界日志与 heartbeat

- 只读 `/tmp/signal-server.log` 的 **[1863167, 1866153)**；2,986 bytes、71行。preflight、supervisor end与当前文件的device/inode一致；没有借用重启前日志。切片 SHA-256 `2265c2068daf449a5416b929ad5f4b1d9d94fc0d6b30e51ce7ee016ba9774607`。原始日志不复制到报告。
- 其中唯一 `viewer-heartbeat-close`：wall=07:19:01.540Z、连接观测duration=137,830 ms、current=true、proof=true、engine/websocket、reason=transport-close。
- 观测到 **5 pingCreated / 5 pingInFlush / 5 pongReceived**；五次flush→pong间隔分别为 **843, 1369, 855, 1298, 759 ms**。关闭时距最后ping创建/flush 9,298 ms，距最后收到pong 8,539 ms。没有这五次观测ping未获pong的证据。
- 关闭快照：transport state=closed、writable=true、bufferLength=0。Node最近记录60点，last48 ms、max106 ms、P95记录值30 ms、missed0、末值年龄887 ms；这是有界心跳诊断，不能扩展为整个会话的完整事件循环分布。
- heartbeat coverage明确为 **partial**，ringDropped=0，未触发flush扫描上限/值无效/计数裁剪。不能把partial写成完整覆盖，也不能用客户端pongCreated替代服务端pongReceived；本轮二者都有独立记录。
- 切片包含Viewer的transport-close与reconnect grace，没有Host disconnected事件。Host有界媒体分析另见 `/tmp/wrd-turn-long-b-media-analysis.md`：最后Host样本PC仍connected，current loop lag约0.42 ms，未见Host断连。最大视频无进展783.3 ms未触发5秒阈值，不能将本轮归为此前Host秒级stall。

## Cloudflare：仅有跨连接背景证据

- 读取已有 `/tmp/wrd-fixed-domain.log`（543,535 bytes）；其最后时间戳是 **06:20:25Z / 14:20:25 CST**，比故障早约59分钟。07:14–07:22Z窗口没有记录。它无法提供本次socket的edge关闭事件，也不能据“没有日志”宣称edge没有故障。
- `/tmp/wrd-fixed-watch.log`带显式+0800时区。故障附近 **15:16:34、15:17:43、15:18:52、15:19:57** 均记录status=healthy、action=none；所选15:14–15:22窗口没有restart/reconnect动作类别。
- watcher是独立健康请求，既不关联本Viewer socket，也不覆盖中间每一刻；其健康结果不能排除单条WebSocket关闭。root另行只读确认tunnel/watcher进程identity未变，仅支持没有观察到进程重启。
- 没有与本会话可关联的edge connection/request trace、close code或TLS/TCP断开方向。**Cloudflare是否触发此次关闭：unknown。** 没有操作tunnel。

## 与此前93秒 ping timeout 的对比

此前93秒结果按既有任务背景归类Viewer ping-timeout；本报告未重新扫描那次原日志。当前客户端与Signal都记录transport-close，末次完整ping/pong交换距关闭约8秒，且客户端事件循环max20 ms、无已观测hidden/offline/freeze。**本轮没有复现同一ping-timeout签名；这不等于此前问题已被修复或不会再次出现。** heartbeat观测增强现在能证实服务端确实收到五个pong，这是本轮新增的有效区分证据。

supervisor记录7个worker身份自然退出、0 signals、无deadline/intervention/sample触发；这与“helper先杀browser导致首次断连”不符。身份覆盖仍以supervisor自身completeProcessTreeExitEstablished字段为准，不能扩展为没有遗漏任何瞬时子进程。客户端断连后约0.45秒便停observer，未观察到reconnect attempt，不能据此认定自动重连失效。

## 下一步最小选择（建议，未实施）

1. **若优先定位关闭原因：先补原始transport关闭元数据，再做一组相同浏览器/媒体模式的本地入口对照。** 当前缺少浏览器WebSocket close code/wasClean、Engine close description固定类别、Signal底层ws close code与独立transport-error时间。仅收固定枚举/数值与匿名对象标签，不记录reason原文、URL、session ID、token或包正文。这样才能区分主动正常关闭、异常EOF和transport error，避免只重复“transport-close”。
2. 本地对照须沿用既有零Viewer/独占proof边界，不能并发占用生产Viewer；同一socket至少覆盖本轮约138秒断开窗口。若本地也出现同签名，会缩小到浏览器/Signal一侧；若本地未复现，仅支持公网路径相关的假设，不能单次证明Cloudflare有错。当前证据不支持直接修改产品超时。
3. **若优先验证用户可恢复：可另做真实人工C5 UI恢复验收，但应把它记为独立恢复验证。** 本次仅证明断连后effective input gate关闭且媒体短时继续，没有人工恢复证据。不得通过丢弃/重签proof、自动绕过admission来制造恢复PASS。

不建议直接加大ping timeout、自动替换proof或重建tunnel。当前最小代码候选只是完善关闭诊断；根因修复要等关闭来源的证据。

## 证据路径

- `/tmp/wrd-owned-turn-probe-private/turn-long-20261017b/preflight.json`
- `/tmp/wrd-owned-turn-probe-private/turn-long-20261017b/supervisor.json`
- `/tmp/wrd-owned-turn-probe-private/turn-long-20261017b/session/lifecycle.json`
- `/tmp/wrd-owned-turn-probe-private/turn-long-20261017b/session/samples.jsonl`
- `/tmp/wrd-owned-turn-probe-private/turn-long-20261017b/session/summary.json`

输出仅此脱敏报告，权限0600；不含raw socket/viewer/session IDs、IP、token或输入内容。
