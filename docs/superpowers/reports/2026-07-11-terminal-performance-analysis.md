# WebRemoteDesktop Terminal 远程连接与交互性能分析报告

日期：2026-07-11
仓库：`/Users/macstudio1/AI/Claude/WebRemoteDesktop`

## 1. 结论摘要

这次排查的结论很明确：

1. Terminal 本地链路本身不慢。
   `signal-server -> node-pty -> PTY echo -> terminal socket` 在本机 `127.0.0.1:8080` 路径下已经是毫秒级，性能不是当前主瓶颈。
2. 远程 Terminal 的主要瓶颈是公网 WebSocket RTT，不是 PTY、不是真正的 shell 执行，也不是 xterm 渲染。
   固定域名 `https://link.stockhub.wiki` 的 `/terminal` namespace 实测 RTT P50 约 `414.6ms`，输入 ack / 首个输出 / marker 输出都基本贴着这个量级。
3. 当前 terminal 延迟埋点“有基础，但不够准，也不够闭环”。
   已经有 `terminal:ping` / `terminal:pong` / `terminal:input_ack`、前端状态栏 P50 展示、diagnostic 上送和较完整测试，但 `inputAck` 的定义存在时钟语义问题，服务端缺少结构化聚合指标，很多配置项只是声明了并未真正执行。
4. 远程可用性现在还有两个独立问题，会干扰“用户觉得 terminal 慢/坏了”的判断：
   - 当前 quick tunnel 地址 `/tmp/wrd-safe-current-url.txt` 返回 `HTTP 404`，不是可交付入口。
   - 固定域名下 `/api/auth/verify` 会被统一 `auth` 限流打到 `429`，会让 Viewer/Terminal 页面流程出现假性异常，即使 `/socket.io` 和 `/terminal` 本身仍可能是好的。
5. 这次 `400ms+` 不是抽象意义上的“Cloudflare 慢”，而是当前 tunnel 边缘实际挂在了美国西岸。
   named tunnel metrics 显示当前 4 条 HA 连接都在 `lax*`，`quic_client_smoothed_rtt` 约 `180ms ~ 196ms`；quick tunnel 也长期落在 `lax*`。这会让亚洲客户端先到本地/香港边缘，再被 Cloudflare 骨干转去洛杉矶拿 tunnel 连接，最终把 terminal app-level RTT 推到 `~400ms`。

一句话归纳：**Terminal 代码链路本身是快的；远程慢主要是公网 RTT；当前埋点已经能证明“不是 PTY 慢”，但还不足以稳定解释所有远程异常。**

## 2. 本次取证范围

本次分析覆盖三层：

1. 代码与设计真相
   - `web-client/js/terminal.js`
   - `web-client/js/diagnostic.js`
   - `signal-server/websocket/terminal.js`
   - `signal-server/lib/terminal/session-manager.js`
   - `signal-server/lib/terminal/audit.js`
   - `signal-server/server.js`
   - 设计文档与需求文档中的 Terminal / latency 相关章节
2. 运行时真相
   - `./scripts/status-safe-wrd.sh`
   - `curl http://127.0.0.1:8080/health`
   - `curl http://127.0.0.1:8080/api/status`
   - 本地 browser 样本
   - 本地 raw socket.io 样本
   - 固定域名 raw socket.io 样本
   - quick tunnel / fixed-domain HTTP 验证
3. 测试与回归保障
   - `signal-server/websocket/terminal.test.js`
   - `signal-server/test/terminal-bootstrap.test.js`
   - `signal-server/test/terminal-session-manager.test.js`
   - `web-client/js/terminal.test.js`
4. Tunnel / edge 运行指标
   - `http://127.0.0.1:20244/metrics`（named tunnel metrics）
   - `http://127.0.0.1:20242/metrics`（quick tunnel metrics）

## 3. 当前运行状态

执行 `./scripts/status-safe-wrd.sh` 时，本地状态为：

- `signal-server`: running
- `host`: running
- `safe tunnel supervisor`: running
- `safe quick tunnel`: running
- `http://127.0.0.1:8080/health`: 正常
- `http://127.0.0.1:8080/api/status`: `hostOnline: true`

这说明本次分析期间，本地 WRD 服务链路是活的。

## 4. Terminal 当前链路结构

### 4.1 数据路径

Terminal 当前不走 WebRTC，也不走 TURN / STUN / DataChannel。

它的链路是：

`Browser xterm.js -> Socket.IO /terminal namespace -> signal-server -> node-pty -> 本机 shell`

这点和桌面媒体链路是完全分开的。

### 4.2 已有性能相关埋点

当前代码里已经存在的 terminal 性能/状态埋点主要有：

1. 前端周期性 RTT 探测
   - `web-client/js/terminal.js`
   - `terminal:ping` / `terminal:pong`
2. 输入 ack
   - 前端发送 `terminal:input`
   - 服务端返回 `terminal:input_ack`
3. 前端状态栏展示
   - `RTT {p50}ms`
   - `输入 {p50}ms`
4. 诊断上送
   - `TerminalPanel.getDiagnosticState()`
   - `web-client/js/diagnostic.js` 把 terminal 状态一起塞进 diagnostic payload
5. Shared session / replay / attach presence
   - `terminal:pool_snapshot`
   - `terminal:presence`
   - `terminal:replay`

## 5. 实测结果

### 5.1 本地 browser 样本：`http://127.0.0.1:8080`

通过真实浏览器进入 Viewer 页，再打开 Terminal tab 做本地样本，TerminalPanel 诊断状态为：

- `transport=websocket`
- `socketState=connected`
- `socketRtt.p50=6ms`
- `inputAck.p50=11ms`

同一页面里做了 8 次命令探针：

- `ackLatencyMs` 约 `7.6ms ~ 15.0ms`
- `firstOutputLatencyMs` 约 `8.1ms ~ 19.0ms`
- `markerLatencyMs` 约 `13.6ms ~ 24.4ms`

这组数据说明：

- 浏览器真实 UI 路径是快的
- xterm 渲染 + 前端事件分发只引入了很小的附加开销

### 5.2 本地 raw socket 样本：`http://127.0.0.1:8080`

为了剥离页面 UI 自身开销，又直接用 `python-socketio` 连 `/terminal` namespace 做了同口径采样。

结果：

| 指标 | P50 | 平均 | 范围 |
|---|---:|---:|---:|
| ping RTT | `1.3ms` | `4.1ms` | `0.9ms ~ 13.3ms` |
| input ack | `2.6ms` | `6.1ms` | `2.0ms ~ 19.1ms` |
| first output | `1.2ms` | `4.8ms` | `1.1ms ~ 17.4ms` |
| marker output | `2.5ms` | `6.0ms` | `2.0ms ~ 19.1ms` |

结论：

- `signal-server + node-pty + shell echo` 本身是毫秒级
- 本地 terminal 没有系统性性能问题
- 少量 10ms~20ms 级抖动属于正常事件循环/调度波动，不是结构性瓶颈

### 5.3 固定域名 raw socket 样本：`https://link.stockhub.wiki`

同样使用 `python-socketio` 直连固定域名 `/terminal` namespace，结果如下：

| 指标 | P50 | 平均 | 范围 |
|---|---:|---:|---:|
| ping RTT | `414.6ms` | `422.2ms` | `413.4ms ~ 456.9ms` |
| input ack | `428.1ms` | `464.0ms` | `414.9ms ~ 647.4ms` |
| first output | `419.9ms` | `460.9ms` | `414.1ms ~ 646.5ms` |
| marker output | `428.1ms` | `463.9ms` | `414.8ms ~ 647.3ms` |

核心现象：

1. 远程 `input ack`、`first output`、`marker output` 都和 `ping RTT` 同量级。
2. 这三者没有再比 RTT 高出一整段固定成本。
3. 偶发会出现 `~530ms` 到 `~647ms` 的长尾尖峰。

根因判断：

- 真正放大的不是 PTY 或 shell 执行，而是公网 WebSocket 传输 RTT。
- 输入事件到服务端、服务端回 ack、PTY echo 回浏览器，这三步都几乎贴着一个 RTT 在走。
- 换句话说，**远程 terminal 现在主要是链路远，不是实现慢。**

### 5.4 本地 vs 固定域名对比

按 raw socket 口径直接对比：

| 指标 | 本地 P50 | 固定域名 P50 | 放大量级 |
|---|---:|---:|---:|
| ping RTT | `1.3ms` | `414.6ms` | `~319x` |
| input ack | `2.6ms` | `428.1ms` | `~165x` |
| first output | `1.2ms` | `419.9ms` | `~350x` |
| marker output | `2.5ms` | `428.1ms` | `~171x` |

因此本次分析可以排除以下怀疑：

- 不是 `node-pty` 太慢
- 不是 shell 回显太慢
- 不是 session manager 共享会话模型本身太慢
- 不是 xterm 本地渲染导致 400ms 级延迟

### 5.5 quick tunnel 当前不可作为远程样本

当前 `/tmp/wrd-safe-current-url.txt` 指向的 quick tunnel 地址返回：

- `HTTP/2 404`

而 `status-safe-wrd.sh` 给出的 reachability 仍然是 `ok`。

这意味着：

1. 当前 quick tunnel 地址不是可交付的 WRD 页面入口
2. 它不能作为本轮 terminal 远程性能样本
3. 当前 safe reachability 判断存在误判，只验证了“有 HTTP 响应”，没有验证“响应的是正确应用入口”

### 5.6 Cloudflare tunnel 当前实际挂在洛杉矶边缘

这次补查了 tunnel 自身的 metrics，证据非常直接。

#### named tunnel（固定域名）

本机 `127.0.0.1:20244/metrics` 返回：

- `cloudflared_tunnel_ha_connections 4`
- `cloudflared_tunnel_server_locations{connection_id="0",edge_location="lax01"} 1`
- `cloudflared_tunnel_server_locations{connection_id="1",edge_location="lax07"} 1`
- `cloudflared_tunnel_server_locations{connection_id="2",edge_location="lax09"} 1`
- `cloudflared_tunnel_server_locations{connection_id="3",edge_location="lax01"} 1`
- `quic_client_smoothed_rtt{conn_index="0"} 183`
- `quic_client_smoothed_rtt{conn_index="1"} 192`
- `quic_client_smoothed_rtt{conn_index="2"} 196`
- `quic_client_smoothed_rtt{conn_index="3"} 183`

这说明固定域名不是挂在华东/华南/香港近边缘，而是当前 tunnel 出口实打实连到了美国西岸的 `lax*`。

#### quick tunnel（临时地址）

本机 `127.0.0.1:20242/metrics` 与 `/tmp/wrd-safe-quicktunnel.log` 也显示：

- 当前 quick tunnel edge location = `lax09`
- 历史多次在 `lax05/lax07/lax08/lax09/lax11` 之间漂移

因此 quick tunnel 和 fixed-domain tunnel 两条公网路径，现在都存在“边缘落到美国西岸”的问题。

#### 这为什么会把 terminal RTT 放大到 `~400ms`

当前更接近下面这条路：

`同城浏览器 -> 本地/HKG Cloudflare client edge -> Cloudflare backbone -> LAX tunnel edge -> origin`

返回时再走一遍：

`origin -> LAX tunnel edge -> Cloudflare backbone -> 本地/HKG client edge -> 浏览器`

而 named tunnel 当前自己对 LAX 的 QUIC RTT 已经在 `~183ms ~ 196ms`。
terminal 的 `ping` / `input_ack` / `output marker` 又是 app-level 往返消息，所以最终落在 `~414ms` 非常合理，不是一个反常值。

## 6. 根因结论

### 6.1 Terminal 本地实现不是瓶颈

证据：

- 本地 raw socket RTT P50 `1.3ms`
- 本地 raw socket input ack P50 `2.6ms`
- 本地 raw socket first output P50 `1.2ms`
- 本地 raw socket marker output P50 `2.5ms`

这说明 terminal 服务端主链路是健康的。

### 6.2 远程 terminal 慢的第一根因是公网 WebSocket RTT

证据：

- 固定域名 ping RTT P50 `414.6ms`
- input ack / first output / marker output P50 都在 `~420ms`
- 本地链路与远程链路之间是两个数量级
- named tunnel 当前 4 条 HA 连接都在 `lax*`
- named tunnel 的 QUIC smoothed RTT 本身就有 `180ms ~ 196ms`

如果 shell / PTY 是瓶颈，那么：

- 远程 ack 或 output 应该比 RTT 明显再多一截
- 本地链路也应该能看出同类放大

现在都没有看到。

更具体地说，问题不是“浏览器和服务端不在同城”，而是：

1. 浏览器访问 `link.stockhub.wiki` 时，客户端 edge 可以在香港/近点
2. 但 origin 对应的 tunnel 连接当前落在洛杉矶 `lax*`
3. 请求需要在 Cloudflare 骨干里跨太平洋绕到 LAX 才能拿到 tunnel
4. terminal 又是交互式一来一回，所以 RTT 会非常敏感

### 6.3 页面 UI 增加的是小开销，不是主因

证据：

- 本地 browser 样本仍在 `10ms` 级
- 相比固定域名 `400ms+`，UI 开销可以忽略

### 6.4 当前远程“可用性异常”会和“性能差”混在一起

这点是系统性问题：

1. quick tunnel 当前给出 `404`
2. 固定域名下 `/api/auth/verify` 被统一 `/api/auth` 限流打到 `429`

第二点的代码原因也明确：

- `signal-server/server.js:64` 对整个 `/api/auth` 挂了 `rateLimit({ windowMs: 15*60*1000, max: 20 })`
- `signal-server/routes/auth.js` 里的 `/verify`、`/login`、`/login/admin` 全都走同一套路由

结果是：

- 用户多次刷新页面、自动验证 token、重复授权后，远程页面可能先被 `429` 破坏
- 用户体感会变成“terminal 连不上/卡住”，但根因并不是 terminal 传输本身

## 7. 埋点完善度评估

### 7.1 已经做得比较好的部分

1. **Terminal RTT 已有独立探针**
   - `terminal:ping` / `terminal:pong`
   - 能直接把“公网 RTT 慢”与“本地 PTY 慢”拆开
2. **输入链路已有 ack**
   - `signal-server/websocket/terminal.js` 会在写入 PTY 后回 `terminal:input_ack`
3. **共享会话可观测性基础已经有**
   - `pool_snapshot`
   - `presence`
   - `replay`
   - `activePresenter`
4. **前端已有操作体验补偿**
   - optimistic local echo
   - alternate screen 检测
5. **测试覆盖不错**
   - 本轮跑了 46 个 terminal 相关测试，全部通过

### 7.2 明确不足的部分

#### A. `inputAck` 指标定义不准

当前前端记录 `inputAck` 的方式是：

- 服务端回 `serverReceivedAt`
- 前端用 `serverReceivedAt - clientSentAt`

代码位置：

- `signal-server/websocket/terminal.js:262-290`
- `web-client/js/terminal.js:494-508`

问题：

1. 这不是完整 RTT
2. 这依赖客户端和服务端的墙钟基本同步
3. 一旦客户端和服务端不在同一台机器、或系统时钟有偏移，数值就会偏

更准确的定义应该分成两类：

1. **真实输入 RTT**：`clientAckNow - clientSentAt`
2. **服务端处理时间**：`serverSentAt - serverReceivedAt`

当前实现把这两件事混在了一起。

#### B. 服务端没有 terminal 性能聚合视图

当前 terminal 服务端的可观测性主要停留在：

- `terminal_socket_connected`
- `terminal_socket_disconnected`
- `terminal_session_created`
- `terminal_session_closed`
- 每个输出 chunk 一条 `terminal_output`

代码位置：

- `signal-server/websocket/terminal.js`
- `signal-server/lib/terminal/audit.js`
- `signal-server/lib/terminal/session-manager.js`

缺的关键指标包括：

- 每会话/每客户端的 RTT P50/P95
- 输入 ack P50/P95
- 会话 attach 耗时
- PTY spawn 耗时
- 每秒输出字节数
- resize 频率
- disconnect / connect_error 分类统计
- 当前 socket 是 websocket 还是 fallback 到 polling 的聚合统计

也就是说，现在“能局部看”，但还做不到“系统性看”。

#### C. `WRD_TERMINAL_RECORD_IO` 基本没有真正落地

搜索结果表明：

- `recordIo` 被读入配置
- 但实际只在 `terminal_output` 审计里带了一个 `ioRecording: config.recordIo`

并没有真正的 I/O 记录、抽样、持久化或聚合逻辑。

这意味着：

- 配置名表达的能力大于实际实现
- 目前不能依赖它做真实的 terminal I/O 回溯

#### D. `WRD_TERMINAL_IDLE_TIMEOUT_MS` / `WRD_TERMINAL_STARTUP_TIMEOUT_MS` 目前只声明，未形成运行时约束

从代码搜索结果看：

- 这两个变量在 `config` 和 tests 里存在
- 但 session manager 并没有真正执行 idle 回收或 startup timeout 逻辑

这属于典型的“配置存在，但行为没闭环”。

#### E. `terminal_output` 审计过于高频，但信息密度低

当前输出日志会在每个输出 chunk 记一条：

- 没有字节数
- 没有 chunk 长度
- 没有 session backlog
- 没有输出速率

结果是：

- 真出问题时日志很多
- 但仍然很难直接判断是“输出大”“网络慢”“客户端收不动”还是“PTY 自身阻塞”

#### F. quick tunnel 可用性校验不足

本轮已经看到：

- `status-safe-wrd.sh` 认为 quick tunnel `ok`
- 但实际 root 返回 `404`

这会直接污染“远程 terminal 慢/坏”的判断前提。

## 8. 当前结论对应的优先级建议

### P0：必须先做

1. **修正 terminal 输入延迟指标语义**
   - 前端显示：
     - `socketRtt`
     - `inputAckRtt`
     - `serverProcessingMs`
   - 不要再把 `serverReceivedAt - clientSentAt` 当成唯一“输入延迟”
2. **拆分 `/api/auth` 限流策略**
   - `/login`、`/login/admin` 保持严格限流
   - `/verify` 单独放宽，或直接不走同一个 20/15m 限流器
   - 否则远程 Viewer / Terminal 会被假性打坏
3. **把 quick tunnel 入口校验从“任意 HTTP 响应”升级到“正确 WRD 入口”**
   - 至少区分 `200 登录页`、`viewer.html`、`404`
   - 当前 `404` 被当成 `ok` 是错误结论
4. **把 tunnel edge location 和 cloudflared RTT 纳入诊断**
   - 直接采集 `127.0.0.1:20244/metrics`
   - 至少暴露：
     - 当前 `edge_location`
     - `quic_client_smoothed_rtt`
     - `cloudflared_tunnel_ha_connections`
   - 否则未来又会把“LAX 出口问题”误判成 terminal 代码问题

### P1：应该补齐

1. **增加 terminal 服务端聚合指标/诊断接口**
   - 参考已有 `/api/admin/connection-summary`
   - 新增 terminal summary：
     - 连接数
     - attach/detach 次数
     - websocket / polling 比例
     - RTT / ack P50/P95
     - 输出字节速率
     - spawn 耗时
2. **真正实现或移除以下配置项**
   - `WRD_TERMINAL_IDLE_TIMEOUT_MS`
   - `WRD_TERMINAL_STARTUP_TIMEOUT_MS`
   - `WRD_TERMINAL_RECORD_IO`
3. **把 `terminal_output` 从逐 chunk 日志改成聚合日志**
   - 例如每 5s/10s 汇总：
     - chunk count
     - total bytes
     - active observers
     - recent RTT / ack
4. **验证 cloudflared 出口是否能回到近边缘**
   - named tunnel 当前是 QUIC，多连接全部落在 `lax*`
   - 应做受控实验：
     - 升级 `cloudflared` 到新版本
     - 记录重连后 `edge_location`
     - 对比 QUIC / HTTP2 下 `edge_location` 和 `smoothed_rtt`
   - 如果无论怎么重连都还是 `lax*`，那说明这条网络/运营商到 Cloudflare tunnel 的出口本身就不适合低延迟 terminal

### P2：体验增强

1. 诊断面板中直接展示 terminal：
   - 当前 transport
   - RTT P50/P95
   - input ack RTT P50/P95
   - 当前 active session observerCount
   - 最近 connect_error / disconnect reason
2. 区分“本地入口基线”和“公网入口基线”
   - 用户一眼就能知道是链路远，还是系统慢

## 9. 最终判断

### 9.1 性能结论

当前 Terminal 的实现质量，已经足以支撑本地与近距离网络下的流畅交互。
远程慢的核心不是实现层 bug，而是当前固定域名公网 WebSocket 路径的 RTT 本来就在 `~400ms` 量级。

### 9.2 埋点结论

当前埋点已经能回答：

- terminal 是不是连上了
- 共享会话有没有 attach / replay
- RTT 大概有多高
- 输入有没有收到 ack

但还不能稳定回答：

- 输入慢到底是上行 RTT、下行 RTT、服务端排队还是 PTY 阻塞
- 一个会话最近 10 分钟到底是偶发尖峰还是持续恶化
- 远程用户报“terminal 很卡”时，是公网入口坏了、auth verify 被限流了，还是 terminal namespace 自己真的慢

### 9.3 工程判断

所以当前状态最准确的评价是：

**Terminal 性能问题已经被定位，不在 PTY 栈，而在公网传输；可观测性有基础，但还不够“运维级”。**

## 10. 本次验证命令与结果

已执行并通过：

```bash
node --test signal-server/websocket/terminal.test.js signal-server/test/terminal-bootstrap.test.js signal-server/test/terminal-session-manager.test.js
node --test web-client/js/terminal.test.js
```

运行时验证过：

```bash
./scripts/status-safe-wrd.sh
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/status
curl -I -L https://link.stockhub.wiki
curl -I -L "$(cat /tmp/wrd-safe-current-url.txt)"
curl -i https://link.stockhub.wiki/api/auth/verify -H "Authorization: Bearer <viewer-token>"
```

结果摘要：

- 本地服务正常
- fixed domain 登录页可达
- quick tunnel 当前 root 返回 `404`
- fixed domain 的 `/api/auth/verify` 当前会返回 `429`
- named tunnel 当前 4 条 HA 连接都落在 `lax*`
- named tunnel `quic_client_smoothed_rtt` 约 `183ms ~ 196ms`
