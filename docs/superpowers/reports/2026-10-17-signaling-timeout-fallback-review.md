# 信令超时回退：源码审计与方案记录

2026-10-17。运行中3cafc64/build22d13d54ac6b458a；本条发现尚未实施。23:00实测有一次unknown信令错误后恢复，随后5分钟被动连续性通过。unknown不能直接归因超时。

## 确认的代码缺口

实际网页打包的是socket.io/client-dist/socket.io.min.js v4.8.3（build-web-client.js:96–106），不是单独安装的client包。独立审计也核对socket.io-client4.8.3和engine.io-client6.6.6的可读实现。

WebRTC配置WS-first、tryAllTransports和5秒Manager timeout。Engine只在opening时_onError路径转向下一transport；Manager自己的超时直接emit Error('timeout')然后Engine.close，不经过该路径。Manager重试又创建新的Engine、重新选WebSocket，故静默WS可能反复卡住，而明确WS拒绝时可以回退polling。浏览器分发版可读代码2106和4668–4672行具有相同流程。现有测试覆盖明确拒绝/关闭端口，没有覆盖无open/error的静默WS。

Manager截止只覆盖Engine打开，不是namespace认证完成或整段恢复的5秒总上限。不能通过改报告口径把启动性能SLO说成已通过。

## 现场证据边界

本次observer仅把TransportError识别为transport-error，timeout和已知认证拒绝都会降成unknown。source可解释可能原因，但现场没有类别证据。初期事件环还丢772条，PC2具体刷新入口只能依据恢复源码推断。因此修复源码已证实的回退缺口，同时补安全分类；不将其写为已唯一定位此次网络故障。

## 采用的决策与代价

| 决策 | 依据 | 代价 |
|---|---|---|
| 当前WS opening确实Manager timeout后，让下一次既有重试polling-first | 不新增并行socket或子预算取消状态，可修正已证实缺口 | 初始超时加重试可超过5秒，保留每次Engine5秒预算，不声称全流程达标 |
| preference在同一用户会话的自动peer/socket恢复间保留，新用户连接/主动断开/superseded清理 | 避免每次重建又回到已失效WS-first；保留新会话默认约定 | WS之后恢复时当前会话仍polling-first，HTTP开销增加；已有升级策略保留 |
| 固定10字段last-connect-error摘要、既有cooldown自动保存 | 区分timeout/transport/auth且不上传任意error内容；解决当前unknown盲区 | 仅保存最近一条；cooldown/认证/网络可抑制即时送达，不承诺完整事件历史 |

独立preflight已通过；明确显式Start/成功reclaim所属边界、Manager closed/Engine opening事件顺序、age超限null、诊断Promise拒绝隔离和既有存储/裁剪口径。实现/测试/部署记录继续追加。服务当前保持可用，未因此操作Host或tunnel。

[绑定设计](../specs/2026-10-17-signaling-timeout-fallback-design.md)、[执行计划](../plans/2026-10-17-signaling-timeout-fallback-plan.md)。
