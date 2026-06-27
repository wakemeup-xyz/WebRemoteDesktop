# Web Terminal 多会话远程终端设计

## 背景

WebRemoteDesktop 当前通过 `signal-server` 暴露网页、认证接口、Socket.IO 信令和诊断上报，通过 Python Host 提供远程桌面视频与输入控制。页面由 `signal-server/server.js` 直接静态托管 `web-client/`，本地入口是 `http://127.0.0.1:8080`，公网入口可通过 safe quick tunnel 或固定域名映射到同一个服务。

新的独立功能是在当前网页里增加一个可切换的 Terminal tab，让已授权用户可以通过浏览器连接并操作本机 shell。该功能需要支持多个 terminal 会话，同时要能在本机打开的 `http://localhost:5173/` 这类本地开发网页场景下，通过同一套映射入口访问服务端 terminal。

调研结论：

- `xtermjs/xterm.js` / `@xterm/xterm` 是浏览器终端渲染的主流方案，MIT，GitHub stars 超过 20k，npm 当前版本为 `6.0.0`。
- `microsoft/node-pty` / `node-pty` 是 Node.js 里创建伪终端的成熟方案，npm 当前版本为 `1.1.0`，适合与现有 Socket.IO 服务集成。
- WeTTY 也是 `xterm.js + node-pty + express + socket.io` 组合，适合作为参考实现或临时 sidecar，但不适合作为本项目的长期主入口，因为鉴权、审计、UI 状态和 safe tunnel 语义都需要纳入现有系统。
- ttyd / GoTTY 是成熟独立 Web Terminal，但会新增独立安全暴露面，不适合作为默认产品路径。
- WebSSH2 适合“网页 SSH 到另一台机器”，不是本功能首期目标；首期目标是控制当前运行 WebRemoteDesktop 的这台本机。

参考链接：

- https://github.com/xtermjs/xterm.js
- https://www.npmjs.com/package/@xterm/xterm
- https://github.com/microsoft/node-pty
- https://www.npmjs.com/package/node-pty
- https://github.com/butlerx/wetty
- https://github.com/tsl0922/ttyd
- https://github.com/billchurch/webssh2

## 目标

1. 在现有 Viewer 网页中增加 `桌面` / `终端` 两个主 tab，用户不需要离开当前网页。
2. Terminal tab 支持创建、切换、重命名和关闭多个 terminal 会话。
3. 每个 terminal 会话连接服务端本机的一个独立 PTY 进程，默认 shell 为 macOS `/bin/zsh`。
4. 本机 `http://localhost:5173/` 打开的网页也能通过部署映射访问同一 terminal 服务，适配 Vite 开发服务器、反向代理和 Cloudflare tunnel 三类入口。
5. 功能轻量：不引入独立 WeTTY/ttyd 服务，不新增数据库，不改变现有 Python Host 媒体链路。
6. 功能好用：终端自动 fit、支持 resize、断线状态清楚、会话列表可见、错误直接展示。
7. 功能安全：默认关闭，显式启用后仍要求 admin 级权限和审计日志。

## 非目标

1. 首期不实现 SSH 网关，不保存 SSH 密钥，不管理远程主机列表。
2. 首期不实现 terminal 会话跨服务重启恢复；`signal-server` 重启后 PTY 会话全部结束。
3. 首期不录制完整终端输入输出历史；只记录审计事件和错误，不默认记录命令内容，避免泄露密钥。
4. 首期不把 terminal 流量放到 STUN、TURN 或 WebRTC DataChannel；terminal 走 HTTPS/WebSocket。
5. 首期不把 WeTTY、ttyd 或 GoTTY 作为默认依赖。

## 推荐架构

```
Browser Viewer
  ├─ Desktop tab
  │    └─ existing WebRTC video + DataChannel input
  │
  └─ Terminal tab
       ├─ @xterm/xterm
       ├─ @xterm/addon-fit
       └─ Socket.IO terminal events
              │
              ▼
Signal Server (Node.js)
  ├─ existing auth / static files / signaling
  ├─ terminal socket handlers
  ├─ terminal session registry
  ├─ audit logger
  └─ node-pty
        └─ /bin/zsh PTY process on this Mac
```

terminal 流量路径：

| 场景 | 页面入口 | terminal 通道 | 说明 |
|------|----------|---------------|------|
| 本机正式入口 | `http://127.0.0.1:8080` | same-origin Socket.IO | 最简单，推荐调试路径 |
| safe quick tunnel | `/tmp/wrd-safe-current-url.txt` | Cloudflare tunnel WebSocket | 允许，但必须 admin-only |
| 固定域名 | `https://stockhub.wiki` | Cloudflare tunnel WebSocket | 长期公网入口 |
| 本地开发网页 | `http://localhost:5173/` | 显式配置 `WRD_API_BASE=http://127.0.0.1:8080` 或 Vite proxy | 支持开发预览和映射打开 |

## 为什么不直接用 WeTTY / ttyd

WeTTY 和 ttyd 都能快速把 shell 暴露到网页，但它们更适合作为独立服务。当前项目已有认证、状态栏、诊断、safe tunnel 和固定域名入口。如果直接暴露 WeTTY/ttyd，会出现四个问题：

1. 鉴权割裂：需要再维护一套密码、cookie 或反向代理鉴权。
2. 审计割裂：连接、断开、异常不能天然进入现有日志体系。
3. UI 割裂：无法自然放进 Viewer 的 tab、状态栏和连接诊断。
4. 暴露面变大：多一个独立端口和服务，公网映射时更容易误配。

因此长期方案采用内嵌 `xterm.js + node-pty`。WeTTY 可以作为实现参考；ttyd 可以作为应急调试工具，但不能成为默认产品方案。

## 前端设计

### 页面结构

`web-client/viewer.html` 增加主区域 tab：

- `桌面`：现有远程桌面视图，保持默认打开。
- `终端`：新的 terminal workspace。

Terminal workspace 包含：

1. 顶部会话栏：显示 `Terminal 1`、`Terminal 2`、`+`、关闭按钮。
2. 连接状态：`未启用`、`未授权`、`连接中`、`已连接`、`已断开`、`已退出`、`错误`。
3. terminal 容器：xterm 渲染区。
4. 轻量工具按钮：新建、重命名、关闭、清屏、复制选中内容、粘贴。

首期不做复杂分屏。多 terminal 通过 tab 切换即可，避免 UI 过重。

### 前端模块

新增文件：

- `web-client/js/terminal.js`
  - 管理 terminal socket 连接。
  - 管理多个 terminal session 的前端状态。
  - 封装 xterm 创建、fit、resize、输入输出事件。
  - 负责错误提示和断线清理。

- `web-client/css/terminal.css`
  - 终端 tab、会话栏、状态、xterm 容器样式。
  - 保持和现有 `viewer.css` 一致的暗色控制台风格。

可选新增：

- `web-client/js/runtime-config.js`
  - 解决 `localhost:5173` 开发入口下 API base 不等于当前 origin 的问题。
  - 读取 `window.__WRD_API_BASE__`、`localStorage.wrdApiBase` 或默认 `window.location.origin`。

### API base 规则

当前 `web-client/js/auth.js` 写死 `API_BASE = window.location.origin`。为了支持 `http://localhost:5173/`，需要抽成统一配置：

```js
const RuntimeConfig = {
  getApiBase() {
    return window.__WRD_API_BASE__
      || localStorage.getItem('wrdApiBase')
      || window.location.origin;
  }
};
```

规则：

1. 正式入口 `8080`、safe URL、固定域名：默认 same-origin。
2. Vite 开发入口 `5173`：
   - 推荐方式 A：Vite proxy `/api` 和 `/socket.io` 到 `http://127.0.0.1:8080`，前端仍 same-origin。
   - 推荐方式 B：设置 `window.__WRD_API_BASE__ = 'http://127.0.0.1:8080'`。
   - 临时方式 C：在浏览器控制台设置 `localStorage.wrdApiBase='http://127.0.0.1:8080'`。
3. 跨 origin 时必须配置 `CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173`。
4. Socket.IO 连接也必须使用同一个 API base，而不是默认当前页面 origin。

## 后端设计

### 依赖

新增依赖：

```json
{
  "node-pty": "^1.1.0"
}
```

如果 macOS 或 CI 出现 native build 成本，可以评估 `@homebridge/node-pty-prebuilt-multiarch`。默认先用 upstream `node-pty`，避免锁进 fork。

### 后端模块

新增文件：

- `signal-server/lib/terminal/config.js`
  - 读取 terminal 功能开关、shell、cwd、session 上限、超时。

- `signal-server/lib/terminal/session-manager.js`
  - 管理 PTY 创建、输入、resize、输出订阅、退出和清理。
  - 不直接依赖 Socket.IO，便于单测。

- `signal-server/lib/terminal/audit.js`
  - 输出结构化审计日志。
  - 默认写 console，后续可接文件持久化。

- `signal-server/websocket/terminal.js`
  - 注册 Socket.IO terminal 事件。
  - 做 token 校验、权限校验、参数校验和事件路由。

修改文件：

- `signal-server/server.js`
  - 引入 `setupTerminal(io)`。

- `signal-server/lib/config.js`
  - 增加 terminal 配置读取。

- `signal-server/routes/auth.js`
  - 增加 admin 登录或 terminal 二次授权。

### 配置项

新增 `.env` 配置：

```bash
# Web terminal is off by default.
WRD_ENABLE_TERMINAL=0

# Separate admin password for terminal access.
WRD_TERMINAL_ADMIN_PASSWORD=

# Shell and cwd.
WRD_TERMINAL_SHELL=/bin/zsh
WRD_TERMINAL_CWD=/Users/macstudio1/AI/Claude/WebRemoteDesktop

# Limits.
WRD_TERMINAL_MAX_SESSIONS=4
WRD_TERMINAL_MAX_SESSIONS_PER_USER=4
WRD_TERMINAL_IDLE_TIMEOUT_MS=900000
WRD_TERMINAL_STARTUP_TIMEOUT_MS=10000

# Logging.
WRD_TERMINAL_AUDIT_LOG=1
WRD_TERMINAL_RECORD_IO=0
```

默认 `WRD_ENABLE_TERMINAL=0`。如果未设置 `WRD_TERMINAL_ADMIN_PASSWORD`，即使开启 `WRD_ENABLE_TERMINAL=1` 也不能创建 terminal，会返回明确错误：

```json
{
  "error": "terminal_admin_password_required"
}
```

### 角色与权限

现有系统只有 `viewer` 和 `host`。Terminal 需要更高权限，不能复用普通 viewer 密码。

推荐首期新增 admin token：

- `/api/auth/login/admin`
  - 输入 `WRD_TERMINAL_ADMIN_PASSWORD`。
  - 返回 JWT：`role=admin`，`scope=["viewer","terminal"]`，过期时间 2 小时。

权限规则：

| 角色 | 桌面观看 | 桌面输入 | terminal |
|------|----------|----------|----------|
| viewer | 允许 | 允许 | 禁止 |
| host | 不适用 | 不适用 | 禁止 |
| admin | 允许 | 允许 | 允许 |

兼容策略：

1. 现有 viewer 登录不变。
2. Terminal tab 对 viewer 可见但显示“需要管理员授权”，不创建 socket。
3. 用户输入 terminal admin password 后，前端把 admin JWT 存入 `sessionStorage`，不写入 `localStorage`。
4. Socket.IO `terminal:*` 事件只接受 admin token。

## Socket.IO 事件协议

所有事件走现有 Socket.IO 连接或独立 `/terminal` namespace 都可以。推荐首期使用独立 namespace `/terminal`，避免与 WebRTC 信令事件混在一起。

连接认证：

```js
io('/terminal', {
  auth: {
    token: adminJwt,
    clientId: browserSessionId
  }
});
```

### client -> server

`terminal:create`

```json
{
  "clientSessionId": "term-local-1",
  "cols": 120,
  "rows": 32,
  "cwd": "/Users/macstudio1/AI/Claude/WebRemoteDesktop",
  "title": "WebRemoteDesktop"
}
```

`terminal:input`

```json
{
  "sessionId": "term_abc123",
  "data": "ls -la\r"
}
```

`terminal:resize`

```json
{
  "sessionId": "term_abc123",
  "cols": 140,
  "rows": 40
}
```

`terminal:close`

```json
{
  "sessionId": "term_abc123",
  "reason": "user-close"
}
```

`terminal:list`

```json
{}
```

### server -> client

`terminal:created`

```json
{
  "sessionId": "term_abc123",
  "title": "Terminal 1",
  "cwd": "/Users/macstudio1/AI/Claude/WebRemoteDesktop",
  "shell": "/bin/zsh"
}
```

`terminal:output`

```json
{
  "sessionId": "term_abc123",
  "data": "..."
}
```

`terminal:exit`

```json
{
  "sessionId": "term_abc123",
  "exitCode": 0,
  "signal": null
}
```

`terminal:error`

```json
{
  "sessionId": "term_abc123",
  "error": "max_sessions_reached",
  "message": "Terminal session limit reached"
}
```

`terminal:snapshot`

```json
{
  "sessions": [
    {
      "sessionId": "term_abc123",
      "title": "Terminal 1",
      "createdAt": "2026-06-27T12:00:00.000Z",
      "lastActiveAt": "2026-06-27T12:01:00.000Z",
      "status": "running"
    }
  ]
}
```

## 多 terminal 会话模型

服务端 session 字段：

```js
{
  id,
  ownerSub,
  socketId,
  title,
  cwd,
  shell,
  cols,
  rows,
  ptyProcess,
  createdAt,
  lastActiveAt,
  status
}
```

规则：

1. 每个 session 对应一个 PTY 子进程。
2. 默认最多 4 个总 session，每个 admin 最多 4 个。
3. session 和创建它的 socket 绑定；socket disconnect 后进入 30 秒 grace period。
4. grace period 内同一 admin 重新连接，可以选择 reattach。
5. grace period 超时后 kill PTY。
6. 用户显式关闭 tab 时立即 kill PTY。
7. `signal-server` 进程退出时不做恢复，PTY 跟随进程结束。

首期可以不实现完整 reattach，只要 disconnect 后明确提示“连接断开，terminal 已关闭”也可接受。但推荐保留 30 秒 grace period，体验更好，复杂度仍可控。

## 安全设计

Terminal 是远程 shell，安全等级高于远程桌面。必须按默认禁用、显式启用、管理员授权处理。

### 强制安全规则

1. `WRD_ENABLE_TERMINAL` 默认是 `0`。
2. 未设置 admin password 时不能创建 terminal。
3. 普通 viewer token 不能调用任何 `terminal:*` 事件。
4. admin token 只存 `sessionStorage`。
5. 所有 terminal 事件校验 JWT、role、session ownership。
6. 输入大小限制：单条 input 最大 64 KB。
7. 输出限速：server 对 `terminal:output` 做背压保护，避免浏览器卡死。
8. resize 限制：`cols` 10-300，`rows` 5-100。
9. cwd 必须落在允许目录内，默认只允许 `WRD_TERMINAL_CWD`。
10. shell 必须来自允许列表，默认只允许 `/bin/zsh` 和 `/bin/bash`。

### 审计日志

默认记录：

- admin 登录成功/失败。
- terminal socket 连接/断开。
- session 创建/关闭/退出。
- cwd、shell、cols、rows。
- 来源 IP、user-agent、token subject。
- 错误码和异常堆栈摘要。

默认不记录：

- 完整输入内容。
- 完整输出内容。
- 环境变量。
- 粘贴内容。

如果临时排障需要记录 IO，必须显式设置：

```bash
WRD_TERMINAL_RECORD_IO=1
```

启用后日志必须标记 `ioRecording=true`，并且文档提示可能包含密钥、token 和隐私内容。

## 部署映射与 `localhost:5173`

`localhost:5173` 通常是 Vite 或其他开发服务，不是当前仓库正式入口。为了让这个页面也能打开 terminal，有两种推荐方案。

### 方案 A：Vite proxy

开发服务器代理：

```js
export default {
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/socket.io': {
        target: 'http://127.0.0.1:8080',
        ws: true
      }
    }
  }
};
```

优点：

- 页面继续使用 same-origin。
- Cookie、CORS、Socket.IO 路径最简单。
- 最适合本机开发。

缺点：

- 只适合开发环境，不是正式部署形态。

### 方案 B：Runtime API base

页面启动前注入：

```html
<script>
  window.__WRD_API_BASE__ = 'http://127.0.0.1:8080';
</script>
```

或开发时临时设置：

```js
localStorage.setItem('wrdApiBase', 'http://127.0.0.1:8080');
```

同时 `.env` 配置：

```bash
CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
```

优点：

- 不依赖 Vite proxy。
- 适合把同一套静态页面部署到其他入口。

缺点：

- 需要清楚处理跨 origin。
- 更容易因 CORS 或 mixed content 配错。

推荐：首期同时支持两者，默认文档推荐方案 A，方案 B 用于部署映射和特殊入口。

## 与现有远程桌面链路的关系

1. Terminal 不使用 STUN、TURN、WebRTC 媒体或 DataChannel。
2. Terminal 可以经过 Cloudflare tunnel 的 WebSocket，因为它是控制面流量，不是媒体流量。
3. Terminal 不改变 Strict STUN 媒体策略；桌面视频是否直连，与 terminal 是否可用无关。
4. 如果 safe quick tunnel 失效，terminal 和网页会一起不可达；这时仍按现有 runbook 只修 tunnel，不重启 terminal 独立服务。
5. 重启本地 `signal-server` 会终止 terminal PTY session；如果 tunnel 未重启，公网 URL 不应变化。

## 错误处理

| 错误码 | 触发条件 | 用户提示 |
|--------|----------|----------|
| `terminal_disabled` | `WRD_ENABLE_TERMINAL!=1` | 终端功能未启用 |
| `terminal_admin_password_required` | 未配置 admin password | 服务端未配置终端管理员密码 |
| `terminal_unauthorized` | token 缺失、过期或非 admin | 需要管理员授权 |
| `max_sessions_reached` | 超过总 session 上限 | 终端数量已达上限 |
| `max_sessions_per_user_reached` | 超过用户上限 | 当前浏览器终端数量已达上限 |
| `invalid_terminal_size` | cols/rows 越界 | 终端尺寸无效 |
| `invalid_cwd` | cwd 不在允许目录 | 终端目录不允许访问 |
| `shell_not_allowed` | shell 不在允许列表 | 服务端不允许该 shell |
| `pty_spawn_failed` | node-pty spawn 失败 | 启动终端失败，查看服务端日志 |
| `pty_exited` | PTY 已退出 | 终端进程已退出 |
| `terminal_backpressure` | 输出过快 | 输出过快，已暂停刷新 |

错误必须同时：

1. 在 UI 明确显示。
2. 发出 `terminal:error`。
3. 写入 audit log。

## 测试策略

### 后端单测

新增：

- `signal-server/test/terminal-config.test.js`
  - 默认 disabled。
  - enabled 但缺 admin password 时拒绝。
  - session limits 和 timeout 解析正确。

- `signal-server/test/terminal-session-manager.test.js`
  - 使用 fake PTY adapter，不启动真实 shell。
  - 创建 session 成功。
  - 输入转发到 PTY。
  - resize 调用 PTY resize。
  - close 会 kill PTY。
  - session 上限生效。

- `signal-server/test/terminal-auth.test.js`
  - viewer token 被拒。
  - admin token 被允许。
  - 过期/无效 token 被拒。

### 前端单测

新增：

- `web-client/js/terminal.test.js`
  - 多 session 状态创建/切换/关闭。
  - terminal disabled 状态不连接 socket。
  - socket error 显示到状态区。
  - resize 事件节流。

### 手工验证

1. `WRD_ENABLE_TERMINAL=0`，登录 viewer，Terminal tab 显示未启用，不能创建 session。
2. `WRD_ENABLE_TERMINAL=1` 但不设置 admin password，服务端启动后 terminal 创建返回明确错误。
3. 设置 admin password，登录 admin 后创建 4 个 terminal，能独立运行 `pwd`、`ls`。
4. 创建第 5 个 terminal 返回 `max_sessions_reached`。
5. 切换到 `http://127.0.0.1:8080`，terminal 可用。
6. 切换到 safe quick tunnel URL，terminal 可用，公网 URL 不因 terminal 操作变化。
7. 使用 `localhost:5173` + Vite proxy，terminal 可用。
8. 使用 `localhost:5173` + `WRD_API_BASE`，terminal 可用。
9. 关闭浏览器 tab，30 秒后 PTY 被清理。
10. 重启 `signal-server`，terminal 结束，safe tunnel 不重启。

## 实施分期

### Phase 1：最小可用

1. 新增配置和 admin 登录。
2. 新增 `/terminal` Socket.IO namespace。
3. 新增 `node-pty` session manager。
4. 前端新增 Terminal tab，支持单个 terminal。
5. 完成基本审计日志和错误提示。

### Phase 2：多 terminal

1. 前端会话栏支持新建、切换、关闭、重命名。
2. 后端 session 上限、per-user 上限和 idle timeout。
3. 断线清理和 30 秒 grace period。

### Phase 3：部署映射和开发入口

1. 抽出 RuntimeConfig。
2. `Auth`、WebRTC、Terminal 统一使用 API base。
3. 支持 `localhost:5173` 的 Vite proxy 与 API base 两种模式。
4. 文档补充启动和 CORS 配置。

推荐把 Phase 1 和 Phase 2 合并成一个实现计划，因为多 terminal 是核心需求；Phase 3 可以同计划实现，但测试独立验收。

## 验收标准

1. 默认配置下 terminal 不可用，UI 给出明确未启用状态。
2. 配置 `WRD_ENABLE_TERMINAL=1` 和 `WRD_TERMINAL_ADMIN_PASSWORD` 后，admin 能进入 Terminal tab。
3. 同一浏览器可以创建至少 4 个 terminal，并在它们之间切换。
4. 每个 terminal 有独立 PTY，当前目录、进程状态和输出互不串扰。
5. 普通 viewer 不能创建或操作 terminal。
6. 关闭 terminal tab 会结束对应 PTY。
7. 浏览器断开后 PTY 会在约定时间内清理。
8. `http://127.0.0.1:8080`、safe quick tunnel URL、固定域名入口都使用同一套 terminal 逻辑。
9. `http://localhost:5173/` 通过 Vite proxy 或 Runtime API base 能连接 `8080` terminal 服务。
10. terminal 操作不会重启 Cloudflare tunnel，不会改变 `/tmp/wrd-safe-current-url.txt`。
11. 审计日志能看到 admin 登录、terminal 创建、关闭、退出和错误。
12. 单测覆盖配置、权限、session manager 和前端状态机。

## 结论

最合适的技术方案是把 Web Terminal 做成现有 Viewer 的一等功能：前端用 `@xterm/xterm`，后端用 `node-pty`，通过独立 Socket.IO namespace 连接，默认禁用并由 admin 二次授权开启。这个方案比直接部署 WeTTY/ttyd 更轻、更容易纳入现有 UI、认证、日志和 tunnel 语义，也能自然支持多个 terminal 和 `localhost:5173` 开发映射入口。
