# Terminal Direct WSS Fast Path Design

日期：2026-07-11

> 本设计用于取代同日那份“Terminal 继续走 Cloudflare Tunnel”的保守方案。新的目标是：**页面入口继续走 Cloudflare；Terminal 改为浏览器直连 WSS fast path；Cloudflare Tunnel 只保留为 fallback 或未开通直连时的兼容路径。**

## 背景

当前远程 Terminal 的性能瓶颈已经被实测证明确认为公网路径 RTT，而不是 PTY、shell 或前端渲染：

1. 本地 `/terminal` raw socket 样本中，`ping RTT` P50 约 `1.3ms`，`input ack` P50 约 `2.6ms`。
2. 固定域名 `https://link.stockhub.wiki` 的 `/terminal` raw socket 样本中，`ping RTT` P50 约 `414.6ms`，`input ack` / `first output` / `marker output` 都基本贴着这个量级。
3. 当前 named tunnel 与 quick tunnel 的 cloudflared metrics 都显示 edge 长时间落在 `lax*`，`quic_client_smoothed_rtt` 约 `180ms ~ 196ms`。

因此，如果 Terminal 继续绑定当前 Cloudflare Tunnel 路径，应用层再怎么优化，公网 Terminal 也很难从 `400ms+` 降到接近本地。

## 已确认结论

1. **网页入口** 和 **Terminal Socket 入口** 没必要走同一条公网路径。
2. 当前 Terminal 本来就是单独的 Socket.IO namespace：`/terminal`。
3. 当前 Terminal 本来就已经使用 `admin` token 做握手鉴权。
4. 当前 `RuntimeConfig.getSocketBase()` 仍把页面 socket、WebRTC socket、terminal socket 全部绑定到同一个 origin。
5. 要让 Terminal 真正变快，核心不是改 PTY，而是给 Terminal 单独一条更短的公网 path。

## 目标

1. 保持页面入口 `link.stockhub.wiki` 继续走 Cloudflare Tunnel / Cloudflare Access。
2. 为 Terminal 提供单独的 **direct WSS fast path**，例如 `wss://term.link.stockhub.wiki/socket.io/...`。
3. 让浏览器页面仍从 Cloudflare 入口拿到 admin 鉴权，再换取一个短时 terminal socket token。
4. 让 Terminal 直连路径在安全上独立受控：子域、TLS、CORS/Origin allowlist、rate limit、审计、短时 token、可选 IP 白名单。
5. 如果直连前提不满足，Terminal 才允许退回当前 Cloudflare Tunnel 路径，并且必须明确暴露“当前走的是 fallback”。

## 非目标

1. 不把 viewer 或普通页面请求直接暴露到 origin。
2. 不让 Terminal 直接复用长期 `admin` token 作为公网直连接入凭证。
3. 不在本轮改动 shared session、replay、presence、active presenter 语义。
4. 不在本轮把 Terminal 改成 SSH、WebRTC DataChannel 或其它协议。

## 前提条件

直连 WSS fast path 只有在以下条件成立时才可上线：

1. origin 具备稳定公网入站能力，或有可控的公网 reverse proxy / L4-L7 入口。
2. Terminal 子域有独立 TLS 证书，例如 `term.link.stockhub.wiki`。
3. 反向代理或公网入口能单独把 Terminal 子域路由到本地 `signal-server`，且最好只暴露 terminal 相关 path。
4. 不处于无法端口映射的网络环境，例如 CGNAT 且没有公网转发能力。

如果以上条件不满足，就不能把 direct WSS 当成默认可交付方案。

## 方案比较

### 方案 A：继续全部走 Cloudflare Tunnel

优点：

1. 暴露面最小
2. 不需要新的公网入口
3. 运维最简单

缺点：

1. 现有 edge 分配下，Terminal RTT 被 Tunnel 路径锁死
2. 即使页面打开正常，Terminal 依旧会维持明显卡顿

结论：安全保守，但不是低延迟方案。

### 方案 B：Terminal 完全改成 direct WSS，不保留 Tunnel fallback

优点：

1. 延迟最优
2. 路径最清晰

缺点：

1. 一旦直连入口不可达，Terminal 完全不可用
2. 对网络前提和部署质量要求最高

结论：适合公网环境稳定、直连基础设施成熟的场景，但对当前仓库的泛化交付不够稳。

### 方案 C：direct WSS fast path + Cloudflare Tunnel fallback（推荐）

优点：

1. 正常情况下 Terminal 走低延迟直连
2. 直连不可用时仍能保底
3. 迁移风险可控，能逐步验证安全与稳定性

缺点：

1. 配置复杂度高于单路径
2. 前端需要显式感知当前走的是 `direct-wss` 还是 `cloudflare-fallback`

结论：推荐。它既解决性能问题，也避免“一刀切改完就断”的风险。

## 推荐设计

### 一、三条入口解耦

推荐把当前入口拆成三类：

1. 页面/API 主入口
   - `https://link.stockhub.wiki`
   - 继续走 Cloudflare Tunnel
   - 继续承载静态页面、viewer auth、diagnostics、普通 API
2. Terminal direct socket 入口
   - `https://term.link.stockhub.wiki`
   - 浏览器从页面发起 WSS 直连
   - 仅用于 terminal socket
3. Terminal fallback 入口
   - 继续使用当前页面入口上的 `/terminal`
   - 只在 direct WSS 不可用时使用

这样可以把“页面可打开”和“Terminal 是否低延迟”彻底分开。

### 二、Terminal 使用独立 socket base，但真相由 bootstrap 下发

当前 `RuntimeConfig.getSocketBase()` 会把所有 socket 都绑到 `getApiBase()`。这在 direct WSS 架构下不够用了，但更关键的是：**terminal 首选 base 不应该只靠前端硬编码**。

推荐把 terminal 连接策略放进现有 admin-only bootstrap：

`GET /api/terminal/bootstrap`

由服务端下发：

1. `preferredSocketBase`
2. `fallbackSocketBase`
3. `preferredTransportMode`
4. `fallbackAllowed`

前端仍可保留本地 override 能力用于调试，例如：

1. `localStorage.wrdTerminalSocketBase`
2. `localStorage.wrdTerminalFallbackSocketBase`

但生产真相以 bootstrap 响应为准。

`web-client/js/terminal.js` 只改用 terminal bootstrap 提供的 socket base，其它 WebRTC / viewer socket 仍保持原来的 base。

### 三、Terminal 使用短时专用 token，而不是长期 admin token

当前 terminal socket 直接拿 `admin` token 握手。这个 token 现在默认有效期约 `2h`，对公网直连暴露面来说过长。

推荐改成二段式：

1. 页面继续通过 `link.stockhub.wiki` 上的 `/api/auth/login/admin` 获取 admin token
2. 页面再用 admin token 调一个新的 admin-only 接口，例如：
   - `POST /api/terminal/socket-token`
3. 服务端签发一个 **terminal 专用短时 token**
   - audience 单独区分，例如 `web-remote-desktop-terminal`
   - TTL 建议 `60s ~ 300s`
   - claims 至少包含：
     - role=`admin`
     - scope=`terminal:socket`
     - browserSessionId
     - 可选 origin / nonce

这样即使 terminal socket token 暴露，它的时间窗和用途也都更窄。

### 四、Terminal direct 子域的安全边界

Terminal 子域直连时，安全不能只靠“有密码”。

推荐最小边界：

1. TLS 必须开启
2. `Socket.IO` / `Engine.IO` 只允许明确 origin allowlist
   - `https://link.stockhub.wiki`
   - 必要时再加本地开发 origin
3. terminal socket namespace 继续要求 token 握手
4. terminal direct 子域增加单独限流
5. 审计日志记录：
   - remote IP
   - origin
   - browserSessionId
   - admin subject
   - transport path
6. 如环境允许，增加可选 IP 白名单或 Cloudflare WAF / L4 ACL

### 五、Reverse proxy / 公网入口策略

为了避免把整个 `signal-server` 直接暴露在 terminal 子域上，推荐用反向代理只放行 terminal 所需 path。

至少要考虑：

1. `Socket.IO` 握手与升级路径
   - `/socket.io/`
2. 一个最小 health path
   - 例如 `/terminal-health`
3. 其它路径默认 `404`

这意味着：

1. `term.link.stockhub.wiki` 不承载静态页面
2. `term.link.stockhub.wiki` 不承载 viewer 普通 API
3. direct terminal 域只暴露 socket 与最小健康检查

### 六、Fallback 语义必须显式

如果 direct WSS 失败，前端不能静默退回 tunnel 然后假装“一切正常”。

推荐行为：

1. 先尝试 direct WSS
2. 如果失败：
   - 记录失败原因
   - 明确 UI 状态为 `direct-wss failed`
3. 只有在允许 fallback 的配置下，才切到 tunnel terminal
4. 状态栏必须显示当前 transport mode：
   - `direct-wss`
   - `cloudflare-fallback`

这样用户才知道当前为什么又变慢了。

### 七、直连可行性判断

不是每台机器都适合 direct WSS。

推荐增加一个部署能力判断矩阵：

1. 有公网 IP / 反代 / 端口映射
   - 可以启用 direct WSS
2. 无公网入站、CGNAT、仅本地开发
   - 不启用 direct WSS
   - 保留 tunnel-only

仓库层面不应把 direct WSS 视为永远可用的默认事实，而应把它建模为：

`configured + reachable + policy-allowed`

三者同时满足时才启用。

## 安全评估

### 风险

1. 增加了一个新的公网子域
2. 增加了 origin 暴露面
3. 增加了 token 被截获后的使用窗口
4. 增加了反代错误配置导致“整个 signal-server 暴露”的风险

### 对应缓解

1. terminal 子域只走最小 path 暴露
2. socket token 独立 audience + 极短 TTL
3. origin allowlist
4. socket 审计与限流
5. 文档中把 path allowlist 和 `404 default deny` 写成硬要求

## 影响面

### Truth Source

1. terminal socket base 真相：`/api/terminal/bootstrap` 返回的 terminal connection policy
2. terminal token 真相：新的 `terminal socket token` 签发与校验
3. 当前 transport mode 真相：前端 terminal state
4. direct 可用性真相：新的 health/probe 与运行时诊断

### Backend

1. 新增 terminal socket token 签发接口
2. 新增 terminal token 校验逻辑
3. 新增 terminal-health 或最小 summary path
4. 新增 terminal direct 相关审计字段

### Frontend

1. terminal.js 独立 socket base
2. terminal auth 改成“admin token -> terminal socket token”
3. transport mode 显示
4. direct 失败与 fallback 逻辑

### Runtime / Deploy

1. `term.link.stockhub.wiki` 子域
2. TLS 与 reverse proxy path allowlist
3. CORS/Origin allowlist

### Docs

1. README
2. runbook-safe-startup
3. 新的部署/安全说明

## 验证标准

只有下面这些结果同时成立，这个方案才算真的合理：

1. 直连 WSS 启用时，Terminal 公网 RTT 显著低于当前 tunnel path。
2. 页面入口仍然只走原 Cloudflare 主入口，不受 Terminal direct 子域影响。
3. terminal direct 子域没有暴露静态页面和普通 API。
4. terminal socket 只能用短时 terminal token 建立连接，不能直接复用长期 admin token。
5. direct 不可用时，前端能明确显示 fallback，而不是静默退回。

## 技术结论

如果目标是真正降低 Terminal 卡顿，**服务端和网页端直接连接是对的**，前提是这条直连路径具备可控的公网安全与部署条件。

所以最合理的新方向不是“页面和 Terminal 一起脱离 Cloudflare”，而是：

1. 页面继续走 Cloudflare Tunnel / Cloudflare Access
2. Terminal 单独走 direct WSS fast path
3. Tunnel terminal 降级为 fallback，而不是 primary path

这比继续死守 tunnel-only 更符合你现在的性能目标，也比“全量公网裸暴露”更稳。
