# Shared Terminal 安全、生命周期与可观测性加固设计

**日期：** 2026-07-19
**状态：** 已确认，待实施
**代码基线：** 当前工作树的 `signal-server` Terminal 与 `web-client/js/terminal.js`
**关联诊断：** `docs/superpowers/reports/2026-07-11-terminal-performance-analysis.md`

## 1. 目标

本设计解决新建 Web Terminal 在运行环境、PTY 生命周期、资源保护、认证边界和诊断能力上的系统性问题。完成后必须满足：

1. PTY 只继承明确允许的用户环境，不从 Signal Server 环境或个人 shell rc 自动继承 JWT、密码或其他服务密钥。
2. `python3`、shell、cwd 和 PATH 的行为由服务端显式决定，不依赖 `~/.zprofile`、alias 或父进程的偶然环境。
3. PTY spawn 失败、启动超时和正常退出都有稳定状态、错误码、审计事件和前端提示。
4. exited/failed session 不再接受输入，也不会发送虚假的成功 ack。
5. 输入洪泛和异常输出不会无界消耗 Signal Server 内存或事件循环。
6. 共享 session 的关闭、附着、resize、输入权限和客户端身份有明确的服务端真相。
7. Terminal 指标能区分网络 RTT、服务端处理、PTY 启动、附着和输出压力。
8. 现有 shared session、replay、同页重连和 admin 二次授权语义继续兼容。

## 2. 范围与非目标

### 2.1 本次范围

- `signal-server` 的 Terminal config、PTY environment、session manager、Socket.IO handler、admin auth 和 metrics。
- `web-client/js/terminal.js` 的连接传输选择、错误状态、exited session 展示和指标消费。
- Terminal 单元测试、Socket.IO 集成测试、前端测试和本地/固定域名运行时验收。
- README、safe startup runbook 和 Terminal 需求文档的行为同步。

### 2.2 非目标

1. 不实现独立 Terminal 直连 WSS。当前部署没有公网入站能力，现有 `2026-07-11-terminal-direct-wss-design.md` 继续作为历史方向保留。
2. 不改变 Cloudflare Tunnel、quick tunnel 或媒体 WebRTC 的部署方式。
3. 不承诺降低当前 LAX 边缘造成的约 `400ms` 公网 RTT；代码只负责准确测量和展示它。
4. 不引入独立 OS 用户、容器或 macOS sandbox。Terminal admin 仍获得 `macstudio1` 用户权限，`WRD_TERMINAL_CWD` 只是初始目录，不是文件系统访问边界。
5. 不记录原始命令、密码、剪贴板或完整 PTY 输出。现有 `WRD_TERMINAL_RECORD_IO` 保留为兼容配置，但语义收敛为受控 metadata 记录。

## 3. 当前事实基线

当前实现已经具备：

- admin JWT 二次授权和 viewer/admin namespace 隔离；
- shared session、replay buffer、observer presence、active presenter；
- 8 session 硬上限、可配置 idle reap、关闭竞态错误；
- 同钟域的 socket RTT、input ack RTT 和 server processing 指标；
- password-safe optimistic echo、alternate-screen 禁止本地回显；
- 输入脱敏和结构化 Terminal audit。

当前已证实的缺口：

| 编号 | 缺口 | 证据 | 风险 |
|---|---|---|---|
| E-01 | PTY 复制完整 `process.env` | `session-manager.js` 的 `buildTerminalEnv()` | 服务密钥可从 Terminal 读取 |
| E-02 | PATH 没有 Homebrew Python libexec 目录 | live `signal-server` 由 launchd 以系统 PATH 启动 | `env python3` 解析到 `/usr/bin/python3` |
| E-03 | `startupTimeoutMs` 只读配置不执行 | session manager 无 startup timer | spawn 卡死或静默失败 |
| E-04 | PTY exited 后仍可 `pty.write()` | `writeInput()` 只校验 observer | UI 获得虚假成功 ack |
| E-05 | 无输入频率和输出压力控制 | 只有单次 64 KiB 限制 | 事件循环和内存可被拖垮 |
| E-06 | close 未要求调用者附着 | `handleClose()` 直接调用 `closeSession()` | 未附着 admin 可关闭共享 session |
| E-07 | `clientId` 由浏览器声明 | handshake auth 直接读取 clientId | creator/presenter/audit 身份可伪造 |
| E-08 | auth limiter 覆盖整个 `/api/auth` | `server.js` 统一 20/15min | viewer、host、admin、verify 互相消耗额度 |
| E-09 | `WRD_TERMINAL_RECORD_IO` 只记录 metadata | 配置名称与实际行为不一致 | 运维误以为可回放原始 IO |
| E-10 | server 端缺少 attach/spawn/output 聚合指标 | 当前仅有 socket 和 ack 局部指标 | 无法做运维级归因 |

## 4. 方案选择

### 4.1 方案 A：继续在现有文件中逐点修补

改动少，但 environment、lifecycle、flow-control 和 metrics 会继续散落在 `session-manager.js`、Socket handler 和页面中，规则容易漂移。拒绝。

### 4.2 方案 B：按深模块建立 Terminal 内部边界

保留现有 Socket.IO 事件和 shared session 对外协议，新增四个内部模块：

1. `TerminalEnvironment`：构造白名单环境和确定性 PATH。
2. `TerminalLifecycle`：定义 PTY process state、错误码和状态转换。
3. `TerminalFlowControl`：输入 token bucket、输出队列上限和慢 observer 处理。
4. `TerminalMetrics`：记录 bounded counters、latency samples 和输出压力摘要。

`session-manager.js` 只负责 session pool 和这些模块的组合；Socket handler 只负责认证、协议映射和事件发送；页面只消费稳定的 snapshot/error/metrics contract。采用此方案。

### 4.3 方案 C：切换为独立 Terminal 服务或直连 WSS

需要新的公网入站、反向代理和部署边界，不能解决当前服务环境泄露和 PTY 生命周期问题。拒绝。

## 5. 总体架构

```text
admin login
    |
    v
Terminal socket auth -> TerminalSocketIdentity
    |
    v
TerminalSessionManager
    |-- TerminalEnvironment -> node-pty
    |-- TerminalLifecycle  -> starting/running/exited/failed/closed
    |-- TerminalFlowControl -> input bucket + observer output queue
    |-- TerminalMetrics -> bounded counters/samples
    |
    +--> pool snapshot / replay / presence / stable errors
    |
    v
TerminalPanel -> xterm, reconnect, status, metrics
```

### 5.1 Canonical truth sources

| 行为 | 唯一真相源 |
|---|---|
| Terminal 配置和边界 | `signal-server/lib/terminal/config.js` |
| PTY 环境 | `signal-server/lib/terminal/environment.js` |
| process 状态和合法状态转换 | `signal-server/lib/terminal/lifecycle.js` |
| session/observer/presenter | `signal-server/lib/terminal/session-manager.js` |
| 输入/输出压力 | `signal-server/lib/terminal/flow-control.js` |
| Terminal 聚合指标 | `signal-server/lib/terminal/metrics.js` |
| Socket 身份和事件到内部调用的映射 | `signal-server/websocket/terminal.js` |
| 浏览器 session/tab/reconnect UI 状态 | `web-client/js/terminal.js` |

兼容事件名只在 Socket adapter 中保留；内部模块不认识 legacy alias。

## 6. 配置与环境契约

### 6.1 规范化配置

`loadTerminalConfig()` 输出已经校验过的值：

```js
{
  enabled: boolean,
  adminPassword: string,
  shell: '/bin/zsh' | '/bin/bash',
  cwd: string,
  pathEntries: string[], // parsed from WRD_TERMINAL_PATH_EXTRA
  maxSessions: integer,
  softWarnSessionCount: integer,
  replayBufferBytes: integer,
  idleTimeoutMs: integer,
  startupTimeoutMs: integer,
  inputRate: { bytesPerSecond: integer, burstBytes: integer },
  maxObserverQueueBytes: integer,
  allowPolling: false,
  auditLog: string,
  recordIoMetadata: boolean,
}
```

非法数值、负数、非整数和超过安全上限的值在服务启动时抛出明确配置错误；不使用 `NaN` 继续运行。

非空 cwd 必须是已经存在的绝对目录。`WRD_TERMINAL_PATH_EXTRA` 只接受以冒号分隔的绝对目录；不存在、相对或重复项被拒绝，不静默修正。

### 6.2 PTY 白名单环境

PTY 使用受控 interactive shell，不读取个人 `~/.zprofile`、`~/.zshrc`、`~/.bash_profile` 或 `~/.bashrc`。固定启动参数为：

- zsh：`/bin/zsh -f -i`
- bash：`/bin/bash --noprofile --norc -i`

这会移除个人 alias、function 和个人 rc 中自动导出的 token。需要的工具必须通过明确 PATH 或后续单独审查的 repo-owned safe rc 提供。本设计不创建可注入任意命令的 rc 配置项。

PTY 只接收以下环境类别：

- `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `COLORTERM`, `LANG`, `LC_*`；
- 由 `TerminalEnvironment` 构造的 `PATH`；
- 明确允许的终端工具变量，不复制任意 `WRD_*`、`JWT_*`、`*_PASSWORD`、`*_SECRET`、`*_TOKEN`、proxy credential 或 API key。

PATH 顺序固定为：

1. Node 可执行文件所在目录；
2. `${HOME}/.homebrew/bin`、`${HOME}/.homebrew/sbin`；
3. `${HOME}/.homebrew/opt/python@3.11/libexec/bin`；
4. `${HOME}/.local/bin`、`${HOME}/.bun/bin`；
5. 原始环境中的 `/usr/local/bin`、`/usr/bin`、`/bin`、`/usr/sbin`、`/sbin`；
6. 其他 PATH 项仅在通过 allowlist 校验后保留。

不依赖 zsh alias。验收同时执行 `command -v python3` 和 `/usr/bin/env python3`。

该边界只防止自动环境泄露，不构成对恶意 Terminal admin 的秘密隔离。因为 PTY 与 Signal Server 使用同一 OS 用户，admin 仍可能读取该用户可读的 `.env` 或其他文件。若产品需要对 Terminal admin 隐藏服务密钥，必须另立 spec，把 PTY 放到独立 OS 用户或 sandbox 中，并重新设计工作目录权限。

## 7. PTY 生命周期契约

### 7.1 process 状态

session snapshot 新增 `processStatus`，取值为：

`starting`、`running`、`exited`、`failed`、`closed`。

现有 `status` 继续表示 observer presence：`attached` 或 `detached`，避免把进程生命周期和附着状态混在一个字段里。

### 7.2 状态转换

```text
create -> starting
starting + first pty data -> running
starting + pty onExit -> failed
starting + startup timeout -> failed
running + pty onExit -> exited
starting/running/exited/failed + explicit close -> closed and removed from pool
```

### 7.3 错误码

- `terminal_config_invalid`
- `terminal_shell_not_allowed`
- `terminal_cwd_invalid`
- `pty_spawn_failed`
- `pty_starting`
- `pty_startup_timeout`
- `pty_exited`
- `terminal_session_not_found`
- `terminal_session_not_attached`
- `terminal_input_rate_limited`
- `terminal_output_backpressure`
- `terminal_session_limit`

`starting` 状态只允许 attach、detach、close；input 返回 `pty_starting`，不会写入 PTY。`exited`/`failed` 状态只允许 replay、attach、detach、close；input 返回 `pty_exited`。

### 7.4 spawn/timeout 行为

- `ptyFactory()` 同步抛错时，不加入 session pool，Socket 返回 `pty_spawn_failed`，写 audit。
- 成功 spawn 后立即创建 `starting` session，并启动一次性 timer。
- 首个 `onData` 将 processStatus 置为 `running`，清理 timer，并记录 `pty_ready_ms`。
- timer 到期前无首个输出，kill PTY、置 `failed`，发 `terminal:exit` 和 `terminal:error`，保留 session 供用户关闭和审计。
- `onExit` 只处理一次；重复 exit 不得重复广播或重复 kill。

## 8. Session 权限与身份

### 8.1 服务端身份

Socket 的内部 `clientId` 固定使用 `socket.id`；浏览器声明的 `clientId` 只作为长度受限的 `clientLabel`，不用于授权、active presenter 或 close 权限。

创建请求增加 `requestId`，服务端只向创建者回显该 requestId，用于前端确认“这是本浏览器发起的创建”，不再依赖伪造的 clientId。

### 8.2 操作权限

- create：已通过 admin namespace 认证；
- attach/detach/input：调用 socket 必须是该 session 的 observer；
- resize/set active presenter：必须是 observer，且 resize 只由 active presenter执行；
- close：必须是 observer；idle reaper 和服务 shutdown 使用内部 system reason 绕过 observer 检查；
- stale session 的所有操作返回稳定 `terminal_session_not_found` 或 `terminal_session_not_attached`。

## 9. 流控与资源保护

### 9.1 输入 token bucket

每个 observer 一个输入 bucket，默认：

- `bytesPerSecond = 64 * 1024`
- `burstBytes = 128 * 1024`
- 单条消息仍限制 64 KiB

超限只拒绝当前消息，不断开 session；返回 `terminal_input_rate_limited`，记录 bytes、窗口和 observer id，不记录 data。

### 9.2 输出分发

每个 observer 有 bounded output queue，默认 `maxObserverQueueBytes = 512 KiB`。队列达到上限时：

1. 停止向该 observer 继续排队；
2. 发送一次 `terminal:warning`，code 为 `terminal_output_backpressure`；
3. audit 记录 session、observer、queuedBytes、droppedChunks；
4. 将该 observer detach，PTY 和其他 observer 继续运行；
5. 该 observer 下次 attach 通过 replay 恢复最近的 bounded 输出。

不得为了保护慢 observer 杀掉共享 PTY 或阻塞其他 observer。

### 9.3 Replay

现有 replay buffer 继续按 session 限制总字节数；输出压力控制不扩大 replay 上限。snapshot 只暴露容量和 sequence，不暴露 shell 内容。

## 10. 认证与传输

### 10.1 route-specific rate limit

- viewer login：每 IP 独立 limiter；
- host login：每 IP 独立 limiter；
- admin login：更严格的每 IP + 全局 limiter；
- verify：不与 login 共用 bucket。

限流返回稳定 `429`，不写入密码或 token。

### 10.2 Terminal transport

增加 `WRD_TERMINAL_ALLOW_POLLING`，默认 `0`。默认只使用 WebSocket；显式开启 polling 时，前端状态展示 `transport=polling`，metrics 单独计数，不把 polling 样本混入 websocket 样本。

### 10.3 token 兼容

本次不引入独立 Terminal token 服务；继续使用 admin JWT，保留 2h 过期语义。后续若部署边界允许 direct WSS，再单独设计短 token，不在本计划内混入。

## 11. 可观测性

新增 bounded `TerminalMetrics`，只记录计数和数值，不记录命令内容：

- `auth_success`, `auth_rejected`, `socket_connected`, `socket_disconnected`；
- `session_created`, `session_attach`, `session_detach`, `session_closed`；
- `pty_spawn_failed`, `pty_startup_timeout`, `pty_exited`；
- `input_accepted`, `input_rate_limited`, `input_rejected`；
- `output_bytes`, `output_chunks`, `output_backpressure`；
- attach latency、PTY ready latency、server input processing latency 的 p50/p95。

新增 admin-only `GET /api/admin/terminal/metrics`。响应只包含 bounded counters、sample summaries 和当前 pool capacity。`WRD_TERMINAL_RECORD_IO=1` 只开启上述 metadata，不记录 raw IO；需求文档和 runbook 必须同步这一语义。

## 12. 前端行为

- 连接失败、`pty_starting`、`pty_exited`、`pty_spawn_failed`、rate limit 和 backpressure 显示稳定中文状态。
- exited/failed session 保留 tab 和 replay，但输入控件禁用；关闭后从 pool 删除。
- 同页 Socket.IO 重连继续按 fresh pool snapshot 选择 live session，再 attach；不直接信任过期 localStorage id。
- `terminal:session_created` 的 requestId 只由发起者匹配；其他浏览器不抢夺 active tab。
- duplicate legacy event 由 Socket adapter 去重，内部状态只处理一次。

## 13. 测试与验收

### 13.1 单元测试

- environment：密钥不在 PTY env；Homebrew Python path 顺序；非法 PATH 项过滤。
- config：NaN、负数、超上限和不允许 shell/cwd 都失败。
- lifecycle：spawn error、first data ready、startup timeout、重复 exit、exited input rejection。
- identity/permission：伪造 clientLabel 不改变 socket identity；未附着 close 被拒绝。
- flow-control：单条超限、bucket 耗尽、慢 observer detach、其他 observer 继续收到输出。
- metrics：计数有界、样本 p50/p95 正确、raw data 不进入事件。

### 13.2 集成测试

- admin/viewer namespace 隔离；
- create/attach/detach/close 的 requestId 和 presence；
- exited session 的稳定错误；
- auth route-specific limiter；
- `/api/admin/terminal/metrics` 只允许 admin。

### 13.3 运行时验收

本地 Signal Server 已由用户启动后执行：

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server
node --test
cd ..
node --test web-client/js/terminal.test.js web-client/js/terminal-echo-controller.test.js
```

Terminal 内执行：

```bash
printf 'SHELL=%s\nPATH=%s\n' "$SHELL" "$PATH"
command -v python3
/usr/bin/env python3 -c 'import sys; print(sys.executable)'
env | sed 's/=.*//' | sort
```

验收必须证明：服务密钥不存在、Python 为 Homebrew 3.11、exited session 不 ack、输入限流可见、metrics 可读、现有 tunnel URL 未被改变。

## 14. 发布与回滚

实现按 plan 中的 commit boundary 分批落地。每批先跑聚焦测试，再跑 Signal Server 全量测试。任何一批失败只回滚该批代码，不执行 `stop-safe-wrd.sh`，不重建 quick tunnel。服务重启由用户明确授权后使用既有本地 restart 流程，并核对 PID、health 和 URL 文件。
