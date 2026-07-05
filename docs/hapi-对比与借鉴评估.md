# WebRemoteDesktop 与 hapi 对比及借鉴评估

更新时间：2026-07-04

## 1. 背景

当前仓库内已包含 `hapi/` 子项目。为了判断 WebRemoteDesktop 后续是否需要吸收其中的架构思路，本报告基于当前仓库代码与文档，对两者的目标、架构差异、可借鉴点、价值和工作量进行评估。

本报告的事实依据优先来自当前代码与本仓库文档，而不是外部介绍材料。

## 2. 项目定位差异

### WebRemoteDesktop

WebRemoteDesktop 的核心目标是：

- 通过浏览器远程查看和控制 macOS 桌面
- 通过 WebRTC 传输视频和输入
- 通过 Node.js 信令服务、Python Host、safe quick tunnel 和 LaunchAgent 维持可访问性
- 在当前 Viewer 页面里继续扩展 Web Terminal、诊断和网络模式能力

当前主链路可概括为：

`Viewer -> signal-server -> Python Host`

其中：

- `signal-server/` 负责静态页面托管、认证、Socket.IO 信令、terminal 和诊断入口
- `python-host/` 负责屏幕捕获、H.264 编码、WebRTC PeerConnection、Quartz 输入执行
- `web-client/` 负责视频播放、输入采集、网络模式控制和诊断上报

### hapi

hapi 的核心目标是：

- 在本机运行 Claude Code、Codex、Gemini、OpenCode 等 agent 会话
- 通过 Web / PWA / Telegram Mini App 远程控制这些 agent 会话
- 通过 Hub 聚合会话、消息、权限审批、终端和文件浏览能力
- 通过 CLI 包装 agent，通过 Hub 做状态同步，通过 Web 做跨设备交互

当前主链路可概括为：

`CLI(agent wrapper) -> hub -> web / pwa / telegram`

其中：

- `hapi/cli/` 负责拉起和包装 agent
- `hapi/hub/` 负责 HTTP API、Socket.IO、SSE、SQLite、RPC、通知
- `hapi/web/` 负责会话列表、聊天、终端、文件浏览和远程控制界面
- `hapi/shared/` 负责共享类型、schema 和协议

## 3. 主要区别

| 维度 | WebRemoteDesktop | hapi |
|------|------------------|------|
| 核心对象 | 远程桌面、视频流、键鼠输入、terminal | agent 会话、消息、权限审批、文件和终端 |
| 主要复杂度 | WebRTC、H.264、输入时序、NAT/TURN/tunnel、macOS Host 生命周期 | 会话模型、跨端同步、权限流、RPC、持久化、移动端交互 |
| 运行时形态 | Node.js + Python + 静态网页 + 脚本 | Bun workspace + CLI + hub + React PWA + SQLite |
| 状态模型 | 更偏连接状态和运行态组件 | 明确的 Session / Message / Machine / Permission / RPC 模型 |
| 持久化 | 以日志和临时诊断为主 | 以 SQLite 持久化会话、消息、机器和用户 |
| 前端形态 | `web-client/` 的远程桌面页面 | `web/` 的多页面 PWA |
| 运维重点 | Host 启动、LaunchAgent、safe quick tunnel、TURN/STUN | runner、auth、namespace、hub、web、push/telegram |

结论：

- WebRemoteDesktop 是实时媒体与系统控制项目
- hapi 是 agent 会话编排与远程协作项目
- 两者都属于“远程控制本机工作流”，但核心问题域并不相同

## 4. 值得借鉴的事项

### 4.1 共享协议层

hapi 把类型、schema、Socket 事件和协议对象集中在 `hapi/shared/`。这对 WebRemoteDesktop 有明确参考价值。

当前 WebRemoteDesktop 也有较多跨端事件：

- WebRTC 信令：`offer`、`answer`、`ice-candidate`
- Viewer/Host 状态：`host-status`、`viewer-status`
- 输入链路：DataChannel 与 Socket.IO 兜底
- Terminal 事件：`terminal:*`
- 诊断事件：`diagnostic`

如果继续扩展 terminal、诊断和多模式网络逻辑，建议逐步引入共享协议层，把 payload 结构、事件名和校验规则集中管理。

#### hapi 参考代码

- `hapi/shared/src/schemas.ts`
  - 集中定义 `Session`、`Machine`、`AgentState`、`Todo` 等核心领域 schema
  - 体现了“先有 schema，再由 hub / web / cli 共同消费”的模式
- `hapi/shared/src/socket.ts`
  - 集中定义 Socket payload schema、事件名和 ack 结构
  - 终端相关的 `terminal:open`、`terminal:write`、`terminal:resize`、`terminal:output`、`terminal:exit` 都在这里统一建模
- `hapi/shared/src/types.ts`
  - 对外统一导出共享类型，避免 `hub` 和 `web` 各自维护一套并发生漂移

#### 对当前仓库的映射建议

当前仓库可优先抽出的共享事件包括：

- WebRTC 信令：`offer`、`answer`、`ice-candidate`
- Viewer / Host 状态：`connected`、`host-status`、`viewer-status`
- Terminal：`terminal:create`、`terminal:attach`、`terminal:input`、`terminal:resize`、`terminal:output`、`terminal:exit`
- 诊断：`diagnostic`、自动失败上报、链路摘要
- 配置类接口：`/api/webrtc-config`、terminal 配置读取

当前仓库建议优先梳理的代码位置：

- `signal-server/websocket/signaling.js`
- `signal-server/websocket/terminal.js`
- `signal-server/lib/diagnostic.js`
- `signal-server/routes/auth.js`
- `web-client/js/webrtc.js`
- `web-client/js/input.js`
- `web-client/js/terminal.js`
- `web-client/js/diagnostic.js`

#### 可直接借鉴的做法

- 先把事件名和 payload 结构提取到一个单独目录，例如 `shared/` 或 `signal-server/shared/`
- 先做运行时校验，再逐步补静态类型或测试
- 不需要一开始就照搬 `hapi` 的完整 schema 规模，但“事件统一定义”这一步应尽快做

### 4.2 轻量持久化

hapi 的 hub 会把 session、message、machine 和 user 持久化到 SQLite。WebRemoteDesktop 不适合照搬完整会话模型，但非常适合借鉴“轻量本地持久化”这个思路。

建议优先考虑持久化以下摘要数据：

- 最近 viewer 连接与断开事件
- 最近 Host 在线状态变化
- 最近 ICE 失败、selected candidate pair、链路类别摘要
- 最近 terminal 创建、关闭、重连和错误
- 最近关键诊断事件和错误码

这样可以显著降低“只靠滚动日志回放”的排障成本。

#### hapi 参考代码

- `hapi/hub/src/store/index.ts`
  - 管理 SQLite 初始化、schema 版本、WAL、权限和各类 store 装配
- `hapi/hub/src/store/sessionStore.ts`
  - 管理 session 级持久化入口
- `hapi/hub/src/store/messageStore.ts`
  - 管理消息持久化、分页、排队、调度等操作
- `hapi/hub/src/sync/sessionCache.ts`
  - 持久化记录与运行时 session cache 之间的同步层
- `hapi/hub/src/sync/messageService.ts`
  - 负责消息写入、读取和对外事件发布
- `hapi/hub/src/sync/syncEngine.ts`
  - 作为 hub 核心编排层，把 store、cache、rpc、sse 串起来

#### 对当前仓库的映射建议

WebRemoteDesktop 不需要照搬 `session/message/machine/user` 四大表，但可以参考其“store + runtime cache + publisher”分层，先做轻量表：

- `viewer_connections`
  - 记录 viewer 上线、断开、userAgent、来源 IP、角色
- `host_status_events`
  - 记录 Host 在线/离线切换、重启、认证失败
- `network_diag_events`
  - 记录 ICE 失败、candidate pair、链路类别、FPS / RTT / jitter 摘要
- `terminal_events`
  - 记录 terminal 创建、attach、detach、close、error
- `auth_events`
  - 记录 Viewer 登录成功/失败、terminal admin 授权成功/失败

当前仓库最适合接入这些摘要写入的位置：

- `signal-server/lib/diagnostic.js`
- `signal-server/websocket/signaling.js`
- `signal-server/websocket/terminal.js`
- `signal-server/routes/auth.js`
- `signal-server/server.js`

#### 可直接借鉴的做法

- 只存摘要，不存视频原始流，不存高频鼠标移动原始事件
- 先把关键事件写到 SQLite，再决定是否补管理页或历史接口
- 若暂时不想引入数据库，也应先按 `store` 边界设计写接口，避免业务代码直接散写文件

### 4.3 统一诊断入口

hapi 有明显的 `doctor`、runner 状态和统一配置入口。WebRemoteDesktop 当前已有：

- `scripts/status-safe-wrd.sh`
- `README.md`
- `docs/runbook-safe-startup.md`
- `back-debug.log` / `front-debug.log`
- 运行时状态接口 `/health` 和 `/api/status`

但这些入口仍较分散。引入统一的诊断/状态入口，性价比很高。

建议统一输出：

- `signal-server` 健康状态
- Host 是否在线
- LaunchAgent 状态
- 当前 safe URL
- TURN/STUN 配置是否完整
- terminal 是否启用
- 最近错误摘要
- 当前 viewer/relay-viewer 数量

#### hapi 参考代码

- `hapi/web/src/api/client.ts`
  - 所有前端 API 调用都从统一 client 发出
- `hapi/hub/src/web/routes/auth.ts`
  - 展示了认证路由如何单独收口
- `hapi/hub/src/web/routes/events.ts`
  - 负责统一 SSE 订阅入口
- `hapi/hub/src/sse/sseManager.ts`
  - 负责 SSE 订阅管理、heartbeat、广播与可见性配合
- `hapi/hub/src/sync/eventPublisher.ts`
  - 统一对外发布事件
- `hapi/web/src/hooks/useSSE.ts`
  - 前端统一接收状态更新和断线重连

#### 对当前仓库的映射建议

当前仓库里可被统一到一个诊断入口的事实来源包括：

- `scripts/status-safe-wrd.sh`
- `README.md`
- `docs/runbook-safe-startup.md`
- `/health`
- `/api/status`
- `/api/webrtc-config`
- `back-debug.log`
- `front-debug.log`
- `diag-logs/`

如果做成统一入口，建议拆成两层：

- 后端接口层：
  - 返回当前本机状态、配置状态、最近错误、最近诊断摘要
- 脚本/CLI 层：
  - 把 LaunchAgent、safe URL、tunnel、Host 在线、terminal 配置等一起汇总输出

当前仓库的主要落点会是：

- `signal-server/server.js`
- `signal-server/lib/config.js`
- `signal-server/lib/diagnostic.js`
- `scripts/status-safe-wrd.sh`
- `scripts/restart-host.sh`
- `scripts/start-safe-wrd.sh`

#### 可直接借鉴的做法

- 后端对外提供统一 JSON 诊断接口
- 脚本只负责系统层事实，HTTP 接口负责服务内事实
- 页面端如果需要实时看状态，可以仿照 `hapi/web/src/hooks/useSSE.ts` 做一个轻量状态订阅钩子或原生 SSE 客户端

### 4.4 REST / SSE / Socket.IO 分层

hapi 把“动作调用”和“实时更新”做了更清晰的分层：

- REST 负责动作和查询
- SSE 负责状态推送
- Socket.IO 负责 CLI / Hub 的实时双向通道

WebRemoteDesktop 当前大部分实时与状态逻辑仍集中在 Socket.IO。后续如果要增强 terminal、历史诊断和多会话状态，建议逐步分层：

- REST：配置读取、状态快照、诊断历史、terminal 会话列表
- SSE：状态广播、错误通知、terminal 生命周期事件
- Socket.IO：保留 WebRTC 信令和 terminal 实时 I/O

#### hapi 参考代码

- REST 查询/动作：
  - `hapi/hub/src/web/routes/auth.ts`
  - `hapi/hub/src/web/routes/sessions.ts`
  - `hapi/hub/src/web/routes/machines.ts`
  - `hapi/hub/src/web/routes/push.ts`
- SSE：
  - `hapi/hub/src/web/routes/events.ts`
  - `hapi/hub/src/sse/sseManager.ts`
  - `hapi/hub/src/sync/eventPublisher.ts`
  - `hapi/web/src/hooks/useSSE.ts`
- Socket.IO / RPC：
  - `hapi/hub/src/socket/rpcRegistry.ts`
  - `hapi/hub/src/sync/rpcGateway.ts`
  - `hapi/shared/src/socket.ts`
- 前端统一调用层：
  - `hapi/web/src/api/client.ts`

#### 对当前仓库的映射建议

建议对 WebRemoteDesktop 采用增量式分层，而不是全面重写：

- REST：
  - `/health`
  - `/api/status`
  - `/api/webrtc-config`
  - 后续可增加 `/api/diagnostics/summary`
  - 后续可增加 `/api/terminal/sessions`
- SSE：
  - 后续可增加 viewer/host/terminal/diagnostic 摘要广播
- Socket.IO：
  - 继续保留 `offer` / `answer` / `ice-candidate`
  - 保留 terminal 的实时 I/O

当前仓库对应位置：

- `signal-server/server.js`
- `signal-server/routes/auth.js`
- `signal-server/websocket/signaling.js`
- `signal-server/websocket/terminal.js`
- `web-client/js/auth.js`
- `web-client/js/runtime-config.js`
- `web-client/js/terminal.js`

#### 可直接借鉴的做法

- 先把“状态读取”和“实时 I/O”拆开
- 先加 SSE 看板类订阅，再决定是否给所有页面都接入
- 不要把 WebRTC 媒体链路强行改造成 SSE/REST 模式；这里只需要分离状态和控制面

### 4.5 machine / session 抽象

hapi 明确建模了 machine 和 session。WebRemoteDesktop 当前更像单 Host、单主链路运行模型。

如果未来目标包括以下场景，这一抽象会有价值：

- 多台 Mac Host
- 多 viewer 同时接入
- 多 terminal 会话与更清晰的权限域
- 更明确的连接审计和恢复逻辑

如果近期仍以单机单 Host 为主，这件事不应提前过度设计。

#### hapi 参考代码

- `hapi/hub/src/sync/syncEngine.ts`
  - hub 核心编排，统一暴露 session / machine 访问入口
- `hapi/hub/src/sync/sessionCache.ts`
  - 维护运行时 session cache
- `hapi/hub/src/sync/machineCache.ts`
  - 维护运行时 machine cache 与在线状态
- `hapi/hub/src/store/sessionStore.ts`
  - session 持久化入口
- `hapi/hub/src/web/routes/machines.ts`
  - 机器列表、spawn、目录能力相关接口
- `hapi/web/src/components/NewSession/index.tsx`
  - 前端如何基于 machine 和 session 概念组织“在哪台机器、哪个目录、开什么会话”
- `hapi/web/src/routes/sessions/files.tsx`
  - 说明 session 上下文如何被文件浏览等功能复用

#### 对当前仓库的映射建议

如果未来真的要扩到多 Host / 多 viewer / 多 terminal，可考虑先定义最小模型：

- `host_instance`
  - 当前 Mac Host 的身份、在线状态、能力
- `viewer_session`
  - 某个浏览器访问周期内的 viewer 会话
- `terminal_session`
  - 某个 PTY 会话
- `network_session`
  - 某次 WebRTC 连接尝试及其链路诊断摘要

当前仓库最可能被这类抽象影响的文件：

- `signal-server/websocket/signaling.js`
- `signal-server/websocket/terminal.js`
- `signal-server/server.js`
- `python-host/host.py`
- `web-client/js/ui.js`
- `web-client/js/terminal.js`

#### 可直接借鉴的做法

- 先做只读建模，再决定是否改数据库和前端
- 先在诊断和审计层面使用 session id / host id / viewer id
- 不要在单 Host 阶段把 `hapi` 的完整 machine/session 体系生搬硬套进来

### 4.6 PWA / 通知 / Telegram

hapi 在“外出审批”和“跨设备查看状态”方面更完整。WebRemoteDesktop 也可以借鉴其中的移动端产品形态，但这不是当前最紧迫的工程问题。

适合借鉴的方向包括：

- PWA 安装和移动端布局优化
- Host 掉线提醒
- terminal admin 二次授权提醒
- strict STUN 失败后自动通知

不适合当前直接引入的部分包括完整 Telegram 绑定、会话聊天模型和 agent 权限审批体系。

#### hapi 参考代码

- Web Push：
  - `hapi/hub/src/web/routes/push.ts`
  - `hapi/hub/src/store/pushStore.ts`
  - `hapi/hub/src/push/pushService.ts`
- 通知聚合：
  - `hapi/hub/src/notifications/notificationHub.ts`
  - `hapi/hub/src/notifications/eventParsing.ts`
  - `hapi/hub/src/notifications/notificationTypes.ts`
- 页面可见性：
  - `hapi/hub/src/visibility/visibilityTracker.ts`
  - `hapi/hub/src/sse/sseManager.ts`
- 前端消费层：
  - `hapi/web/src/hooks/useSSE.ts`

#### 对当前仓库的映射建议

WebRemoteDesktop 如果借鉴这一块，建议先做最小版本：

- Host 掉线通知
- terminal admin 授权过期或失败通知
- strict STUN 失败通知
- safe URL 不可达提醒

当前仓库最适合接这些事件的地方：

- `signal-server/lib/diagnostic.js`
- `signal-server/websocket/signaling.js`
- `signal-server/websocket/terminal.js`
- `web-client/js/diagnostic.js`
- `web-client/js/ui.js`

#### 可直接借鉴的做法

- 先做 Web Push 或页面内提醒，不必先上 Telegram
- 可以借鉴 `visibilityTracker` 思路，避免页面不可见时仍做无意义高频推送
- 这部分是产品增强项，不应优先于诊断和协议治理

## 5. 每个事项的价值与工作量评估

| 事项 | 价值 | 工作量 | 评估 |
|------|------|--------|------|
| 统一 `doctor` / `status` / `auth` / 运行态诊断入口 | 高 | 低到中 | 性价比最高，建议最先做 |
| 引入共享协议层，统一 `signal-server` / `web-client` / terminal / diagnostic 事件 | 高 | 中 | 强烈建议尽快做 |
| 引入 SQLite 级别的轻量诊断与会话摘要持久化 | 高 | 中 | 很值得做 |
| 对状态类接口做 REST / SSE / Socket.IO 分层 | 中高 | 中到高 | 值得做，但应分步推进 |
| 引入 machine / session 抽象 | 中高 | 高 | 有长期价值，短期不宜优先 |
| 引入 PWA / push / Telegram 这类移动提醒能力 | 中 | 中 | 产品增强项，不是当前主矛盾 |
| 全面迁移到 `hapi` 风格的 Bun monorepo / 单 binary / 全栈重构 | 低 | 很高 | 当前不建议 |

## 6. 具体判断

### 6.1 统一诊断入口

价值：

- 直接降低排障时间
- 能把现有脚本、日志、HTTP 状态和 tunnel 状态收拢到一个入口
- 对当前运维习惯最贴近

工作量：

- 低到中
- 可从脚本和状态汇总开始，不必先改底层架构

建议：

- 作为第一优先级事项推进

### 6.2 共享协议层

价值：

- 降低前后端事件漂移
- 提高 terminal、诊断、状态事件的可维护性
- 便于后续补测试和做 schema 校验

工作量：

- 中
- 需要梳理现有事件名、字段和角色边界

建议：

- 作为第一阶段的核心工程治理动作

### 6.3 轻量持久化

价值：

- 解决“问题发生后无法回看”的排障缺口
- 对 network mode、ICE、terminal 这类时序问题尤其有用

工作量：

- 中
- 若只记录摘要事件，不记录视频和高频输入原始流，复杂度可控

建议：

- 放在共享协议层之后推进，效果最好

### 6.4 分层改造

价值：

- 长期上会让状态读取、历史展示和广播更清晰
- 对 terminal 和诊断页会更友好

工作量：

- 中到高
- 如果一次性重构过大，容易拖慢当前功能推进

建议：

- 只做增量分层，不做一口气重写

### 6.5 machine / session 抽象

价值：

- 对多 Host、多 viewer、多 terminal 更有帮助
- 适合在产品边界扩大时引入

工作量：

- 高
- 会同时影响连接模型、鉴权模型、状态结构和 UI 展示

建议：

- 作为中长期演进方向，不宜先做

### 6.6 PWA / 通知 / Telegram

价值：

- 对移动端使用体验有帮助
- 对外出监控状态、提醒 admin 授权有产品价值

工作量：

- 中

建议：

- 在核心诊断和协议治理稳定后再考虑

### 6.7 全面工程迁移

价值：

- 主要改善工程统一感
- 对当前 WebRTC、Host、tunnel、诊断这些核心问题帮助有限

工作量：

- 很高
- 风险明显高于收益

建议：

- 当前阶段不做

## 7. 建议优先级

建议顺序如下：

1. 统一 `doctor` / `status` / `auth` / 运行态诊断入口
2. 建立共享协议层，统一事件名、payload 和校验
3. 引入轻量持久化，记录诊断摘要和 terminal / viewer 关键事件
4. 对状态类接口做增量式 REST / SSE 分层
5. 仅在确实需要多 Host / 多 terminal / 多 viewer 时，再引入 machine / session 抽象

## 8. hapi 参考代码索引

为了方便后续查阅，这里按主题列出 `hapi` 里最值得对照阅读的代码入口。

### 协议与共享模型

- `hapi/shared/src/schemas.ts`
- `hapi/shared/src/socket.ts`
- `hapi/shared/src/types.ts`

### Hub 核心编排

- `hapi/hub/src/sync/syncEngine.ts`
- `hapi/hub/src/sync/sessionCache.ts`
- `hapi/hub/src/sync/machineCache.ts`
- `hapi/hub/src/sync/messageService.ts`
- `hapi/hub/src/sync/eventPublisher.ts`
- `hapi/hub/src/sync/rpcGateway.ts`

### 持久化

- `hapi/hub/src/store/index.ts`
- `hapi/hub/src/store/sessionStore.ts`
- `hapi/hub/src/store/messageStore.ts`
- `hapi/hub/src/store/pushStore.ts`

### REST / SSE / 订阅

- `hapi/hub/src/web/routes/auth.ts`
- `hapi/hub/src/web/routes/events.ts`
- `hapi/hub/src/web/routes/machines.ts`
- `hapi/hub/src/web/routes/sessions.ts`
- `hapi/hub/src/web/routes/push.ts`
- `hapi/hub/src/sse/sseManager.ts`
- `hapi/hub/src/visibility/visibilityTracker.ts`

### Web 前端

- `hapi/web/src/api/client.ts`
- `hapi/web/src/hooks/useSSE.ts`
- `hapi/web/src/hooks/useTerminalSocket.ts`
- `hapi/web/src/routes/sessions/terminal.tsx`
- `hapi/web/src/routes/sessions/files.tsx`
- `hapi/web/src/components/NewSession/index.tsx`

### 推送与通知

- `hapi/hub/src/push/pushService.ts`
- `hapi/hub/src/notifications/notificationHub.ts`
- `hapi/hub/src/notifications/eventParsing.ts`
- `hapi/hub/src/notifications/notificationTypes.ts`

## 9. 最终结论

对 WebRemoteDesktop 来说，最值得借鉴的不是 hapi 的完整产品形态，而是以下三类工程方法：

- 共享协议层
- 轻量持久化
- 统一诊断入口

这些改动都能直接提升当前仓库在 terminal、诊断、网络模式和排障方面的可维护性，而且不会过早把项目拖进大规模重构。

相反，全面迁移到 hapi 的单 binary、Bun workspace、Hub/CLI/PWA 全家桶风格，当前收益不足，工作量和风险都过高，不应作为近期方向。
