# Terminal Cloudflare Tunnel Latency and Reachability Design

日期：2026-07-11

## 背景

当前 Web Terminal 的公网访问链路是：

`Browser xterm.js -> Socket.IO /terminal -> signal-server -> node-pty -> shell`

本地链路已经被证明是毫秒级，远程链路的主要问题是公网 RTT，而不是 PTY、shell 回显或 xterm 渲染。最新运行取证已经确认：

1. 本地 `/terminal` raw socket 样本中，`ping RTT` P50 约 `1.3ms`，`input ack` P50 约 `2.6ms`。
2. 固定域名 `https://link.stockhub.wiki` 的 `/terminal` raw socket 样本中，`ping RTT` P50 约 `414.6ms`，`input ack` / `first output` / `marker output` 都贴近这一量级。
3. 当前 Cloudflare Tunnel metrics 显示 named tunnel 和 quick tunnel 都长期连到 `lax*` 边缘，`quic_client_smoothed_rtt` 约 `180ms ~ 196ms`。
4. 当前用户感知中还混有两个独立假故障：
   - quick tunnel 地址可返回 `HTTP 404`，但 safe reachability 仍可能显示 `ok`
   - `/api/auth/verify` 被全局 `/api/auth` 限流打到 `429`

因此，这个问题不能再被描述成“terminal 慢”，而应拆成三件事：

1. 终端延迟指标真相不够完整
2. 公网入口与鉴权路径存在假故障污染
3. Cloudflare Tunnel 约束下缺少系统性的边缘与 RTT 可观测能力

## 已确认约束

1. **Terminal 必须继续走 Cloudflare Tunnel。** 不能把“不要走 Tunnel”作为方案，也不能把绕过 Tunnel 作为默认修复路径。
2. 共享终端语义保持不变：当前 shared session、reattach、replay、presence、active presenter 契约不改。
3. 不把 quick tunnel / named tunnel 的生命周期与本地 Host / signal-server 重启混在一起。
4. 不引入“本地 optimistic echo 伪装更快”的交互补丁。对于 shell、全屏 TUI、方向键和控制序列，这种做法会制造新的错误认知。
5. 新增的诊断与摘要接口必须继续遵守最小暴露原则；不能把 cloudflared 原始 metrics 或本机细节直接公开给 viewer。

## 目标

1. 给 terminal 建立可解释、可验证、无时钟歧义的延迟模型。
2. 把“公网 RTT 慢”和“应用逻辑慢”分开呈现，避免再误判 PTY 或 xterm。
3. 把 Cloudflare Tunnel 的 edge location、smoothed RTT、metrics 可达性纳入 WRD 自身的 admin 诊断面。
4. 消除 `/api/auth/verify` 限流和 quick tunnel 误判对 terminal 可用性判断的干扰。
5. 在“Terminal 继续走 Cloudflare Tunnel”的前提下，提供可复现实验路径，评估是否还能通过 cloudflared 侧配置获得更低 RTT。

## 非目标

1. 不改 terminal 为 WebRTC、TURN、SSH、Tailscale 或其它公网上行方案。
2. 不把 quick tunnel 作为正式长期入口。
3. 不自动承诺“通过代码修改就一定把公网 terminal RTT 降到本地量级”。
4. 不在本轮改变终端权限模型，不把 viewer 升格到 admin 终端访问。

## 方案比较

### 方案 A：只修观测与误判

内容：

1. 修正 terminal 前端延迟语义
2. 增加 admin 侧 terminal/tunnel 摘要
3. 拆分 `/api/auth/verify` 限流
4. 修正 quick tunnel reachability 判断

优点：

1. 能最快把“慢”和“坏”分离
2. 风险低，几乎不触碰终端核心链路
3. 对当前系统最有解释力

缺点：

1. 不能直接降低 tunnel RTT
2. 只能把瓶颈解释清楚，不能保证改善公网手感

结论：必要，但单独做还不够。

### 方案 B：只做 Tunnel 优化实验

内容：

1. 固化 cloudflared metrics 采样
2. 受控比较不同 cloudflared 版本、QUIC/HTTP2、重连后 edge 分布
3. 以 edge location 与 smoothed RTT 评估优化空间

优点：

1. 唯一可能真实降低公网 RTT 的方向
2. 能给“为什么同城却 400ms+”提供更直接的网络证据

缺点：

1. 如果 Cloudflare 仍把 tunnel 挂在 `lax*`，应用代码层面无法逆转
2. 不解决 `/verify 429` 与 quick tunnel 假阳性

结论：必要，但必须建立在观测真相先被修正之后。

### 方案 C：完整方案（推荐）

内容：

1. 修正 terminal 延迟指标与文案
2. 增加 admin 级 terminal/tunnel 摘要与结构化诊断
3. 拆分 `/verify` 与登录路径的限流
4. 把 quick tunnel reachability 从“任意 HTTP 响应”提升为“WRD 页面/健康入口可交付”
5. 增加 cloudflared 受控实验脚本或文档流程

优点：

1. 既修“真相”，也修“假故障”，还能给“还能不能优化”留下工程化落点
2. 与当前仓库已有 admin summary、diagnostic、safe tunnel 脚本风格兼容
3. 不违背“Terminal 必须继续走 Cloudflare Tunnel”的硬约束

缺点：

1. 范围比点修更大
2. 需要同时覆盖 Node 服务、前端和 shell 脚本测试

结论：推荐。

## 推荐设计

### 一、建立统一的 terminal 延迟语义

当前 `web-client/js/terminal.js` 的 `inputAck` 是用：

`serverReceivedAt - clientSentAt`

这个值依赖浏览器与服务端时钟接近，语义上不是 RTT，也不是纯服务端处理时间，属于容易误导的混合指标。

本次设计将 terminal 相关指标统一定义为：

1. `socketRttMs`
   - 来源：`terminal:ping` 发出到 `terminal:pong` 收到
   - 计算：**只用浏览器本地时钟**
   - 含义：公网 terminal socket 往返时间
2. `inputAckRttMs`
   - 来源：`terminal:input` 发出到 `terminal:input_ack` 收到
   - 计算：**只用浏览器本地时钟**
   - 含义：输入包送达服务端并收到 ack 的往返时间
3. `serverAckProcessingMs`
   - 来源：`terminal:input_ack.serverSentAt - terminal:input_ack.serverReceivedAt`
   - 计算：只在服务端时钟域内完成
   - 含义：服务端从收到输入到回 ack 的处理耗时
4. `firstOutputRttMs`
   - 来源：带 marker 的探针输入发出到第一个对应输出片段收到
   - 计算：**只用浏览器本地时钟**
   - 含义：用户看到 shell 开始响应的实际往返时间
5. `tunnelEdgeRttMs`
   - 来源：本机 cloudflared metrics 的 `quic_client_smoothed_rtt`
   - 含义：origin 到 Cloudflare edge 的 tunnel 侧 RTT
6. `edgeLocation`
   - 来源：本机 cloudflared metrics 的 `cloudflared_tunnel_server_locations`
   - 含义：当前 tunnel 实际挂在哪个 edge

前端状态展示必须避免再把 `inputAck` 叫成模糊的“输入延迟”。推荐展示为：

1. `公网 RTT`
2. `输入往返`
3. `服务端处理`

这样可以直接区分：

1. 浏览器到公网入口慢
2. 服务端处理慢
3. shell 首次响应慢

### 二、把 tunnel 真相纳入 admin 诊断面

当前仓库已经有：

1. `/api/admin/connection-summary`
2. `/api/admin/connection-attempts`
3. `/api/terminal/bootstrap`

但还缺少 terminal 与 cloudflared 的统一 admin 摘要。

推荐新增一条 **admin-only** 摘要接口，例如：

`GET /api/admin/terminal-summary`

返回内容只暴露必要摘要，不直接透传完整 Prometheus metrics：

1. terminal pool 摘要
   - enabled
   - session count
   - attached observer count
   - active presenter
2. terminal latency 摘要
   - `socketRttMs`
   - `inputAckRttMs`
   - `serverAckProcessingMs`
   - `firstOutputRttMs`
   - 最近窗口的 P50/P95
3. tunnel 摘要
   - named tunnel metrics 是否可达
   - quick tunnel metrics 是否可达
   - edge locations
   - smoothed RTT 列表与聚合值
   - 最后采样时间
4. 入口判定
   - local
   - fixed-domain
   - quick-tunnel
   - unknown

实现上不要求 signal-server 直接公开 cloudflared 原始 metrics。推荐增加一个本地 metrics 解析器，只读取本机 `127.0.0.1` 的 metrics 端点，然后转成结构化摘要。

### 三、把 `/verify` 从密码登录限流中拆出来

当前 `signal-server/server.js` 对整个 `/api/auth` 套用了同一条限流：

1. `/login`
2. `/login/admin`
3. `/login/host`
4. `/verify`

这会把频繁的 token 校验与密码爆破防护混成同一个桶，结果是普通 Viewer/Terminal 页面流程也可能触发 `429`。

推荐改成分层限流：

1. `authPasswordLoginLimiter`
   - 只用于 `/login`、`/login/viewer`、`/login/admin`
   - 保持较严格阈值，承担密码爆破防护
2. `authHostLoginLimiter`
   - 单独作用于 `/login/host`
   - 避免被 viewer/admin 流量干扰
3. `authVerifyLimiter`
   - 单独作用于 `/verify`
   - 阈值显著高于密码登录
   - 仍保留限流，不把 `/verify` 变成完全无限制端点

这样做的安全边界是清晰的：

1. 密码登录仍是强限流入口
2. token verify 仍有限流，但不会因为普通页面刷新或多 tab 而异常伤害可用性

### 四、把 quick tunnel 可达性从“有 HTTP 响应”提升为“WRD 可交付”

当前 `scripts/lib-safe-wrd.sh` 的 `wrd_safe_url_reachability_state()` 只要：

`curl -I -L "$url"` 返回成功

就视为 `reachable`。这会把 `HTTP 404` 之类“有响应但不能交付 WRD 页面”的状态误报成 `ok`。

推荐把 quick tunnel 验证升级成应用级判断，至少满足下面之一：

1. `GET <base>/health` 返回 `200` 且 JSON 中 `status=ok`
2. `GET <base>/api/status` 返回 `200`
3. `GET <base>/` 返回 `200` 且能匹配 WRD 页面指纹

其中：

1. safe 启动脚本发布 URL 前，应验证 **健康端点 + 页面入口**
2. `status-safe-wrd.sh` 应输出更细状态：
   - `ok`
   - `dns-unresolved`
   - `origin-unreachable`
   - `health-failed`
   - `entry-invalid`

这样终端/公网问题才能正确归因：

1. tunnel 进程还活着，但入口页已失效
2. origin 服务活着，但公网入口映射错了
3. 只是本机 resolver 异常

### 五、定义 Tunnel 优化实验的受控边界

在“Terminal 继续走 Cloudflare Tunnel”的约束下，真正可能改善公网 RTT 的，只剩 cloudflared 与 edge 分配侧。

因此需要一套明确的实验流程，而不是直接宣称“优化好了”：

1. 固定实验输入
   - 同一用户地理位置
   - 同一公网入口
   - 同一 terminal 探针脚本
2. 每轮记录：
   - `socketRttMs` P50/P95
   - `inputAckRttMs` P50/P95
   - `firstOutputRttMs` P50/P95
   - edge locations
   - smoothed RTT
   - cloudflared 版本
   - transport（QUIC / HTTP2）
3. 仅允许以下实验变量变化：
   - cloudflared 版本
   - protocol / transport 配置
   - tunnel 重连后的 edge 分布观察

评估原则：

1. 如果 edge 仍稳定落在 `lax*`，应用侧不应宣称“已修复 terminal 慢”
2. 只有当 edge location 或 tunnel smoothed RTT 出现稳定改善时，才认为公网 terminal 体验有真实改善

### 六、安全边界

新增能力必须满足以下安全要求：

1. `terminal-summary` 仅对 `admin` 暴露
2. 不透传原始 cloudflared metrics 文本，不暴露 token、credentials-file 路径或本机命令行
3. `/verify` 虽然单独限流，但不取消鉴权校验
4. quick tunnel 状态脚本仍遵守现有原则：未获明确授权，不自动重建 tunnel

## 影响面

### Truth Source

1. terminal 延迟语义真相：`web-client/js/terminal.js` 与 terminal socket ack/pong payload
2. tunnel 边缘真相：本机 cloudflared metrics 摘要
3. quick tunnel 可达性真相：`scripts/lib-safe-wrd.sh` 的应用级 reachability 判定

### Backend

1. `signal-server/server.js`
2. 新增 terminal/tunnel summary 逻辑
3. `/api/auth` 限流拆分

### Frontend

1. `web-client/js/terminal.js` 的指标语义和状态文案
2. 如有 admin 诊断 UI，可消费新的 terminal/tunnel 摘要

### Runtime / Ops

1. `scripts/lib-safe-wrd.sh`
2. `scripts/run-safe-quicktunnel.sh`
3. `scripts/status-safe-wrd.sh`
4. Cloudflare metrics 观察流程

### Docs

1. `README.md`
2. `docs/runbook-safe-startup.md`
3. `docs/superpowers/reports/2026-07-11-terminal-performance-analysis.md`

## 兼容性说明

1. 终端共享池、`terminal:replay`、`terminal:presence`、`/api/terminal/bootstrap` 继续保留。
2. `terminal:ping` / `terminal:pong` 与 `terminal:input_ack` 仍保留现有 payload 字段，但前端使用方式会修正。
3. 新增 admin summary 是增量接口，不替换现有 `/api/admin/connection-summary`。
4. safe tunnel 不改变“默认不自动重建”的运行边界。

## 验证标准

以下结果同时成立时，才算该设计真正落地：

1. 本地 terminal 与公网 terminal 的指标语义一致，且都不依赖浏览器与服务端跨机器时钟同步。
2. admin 可以在 WRD 自身接口中看到 terminal RTT、server processing、edge location 与 tunnel smoothed RTT。
3. 正常页面打开与 terminal 使用过程中，不再因为 `/api/auth/verify` 共享限流而出现常态化 `429`。
4. quick tunnel 入口若只返回 `404` 或非 WRD 页面，不再被 safe status 误报成 `ok`。
5. 至少完成一轮 cloudflared 受控实验，并能清楚说明“RTT 是否改善，以及改善是否来自 edge/transport 变化”。

## 技术结论

这次修复的核心不是“让 terminal 不走 Cloudflare Tunnel”，而是：

1. 把 terminal 真正慢在哪里说清楚
2. 把与 terminal 混杂的假故障剥离干净
3. 在保留 Cloudflare Tunnel 前提下，给仍可能存在的优化空间建立受控试验与验收标准

这在技术上是合理的，因为当前证据已经足够证明：

1. PTY 不是瓶颈
2. 公网 RTT 是瓶颈
3. 但用户对“terminal 慢/坏了”的感知还被 `/verify 429` 与 quick tunnel 误判放大了

所以正确的系统性修复，不是改 transport 边界，而是先修真相、再修误判、最后只对仍有机会改善的 tunnel 参数做实验。
