# Safe Startup Runbook

本手册用于在 **不影响** `/Users/macstudio1/AI/Claude/StockHub` 的前提下，启动、查看、停止当前仓库 `WebRemoteDesktop` 的完整本地服务链路。

## 启动方式总览

当前仓库推荐按下面优先级选择启动方式：

1. **正式公网入口**：`./scripts/start-fixed-domain.sh`
2. **本地调试/排障 + 临时 quick tunnel**：`./scripts/start-safe-wrd.sh`
3. **手动本地启动**：`signal-server` + `./scripts/restart-host.sh`

区别如下：

- `start-fixed-domain.sh`：适合已经配置好 Cloudflare 命名隧道，需要长期固定域名；正式用户入口应始终使用 `https://link.stockhub.wiki`
- `start-safe-wrd.sh`：适合需要本地服务 + trycloudflare 临时公网地址做调试或排障，且不想影响其他仓库进程；若 tunnel 已在运行，后续重启本地服务会复用它，地址默认不变
- 手动本地启动：适合只做本机调试，不需要公网地址；但仍会通过 LaunchAgent 托管 Host

入口口径：

- 正式公网入口：`https://link.stockhub.wiki`
- quick tunnel / `trycloudflare`：仅调试、临时排障、或 fixed-domain 不可用时的临时观察链路，不作为正式对外地址
- 手机、Pad 和桌面 Viewer 都应访问 `https://link.stockhub.wiki`；移动端不使用单独的域名、端口或认证入口
- 本机调试入口：`http://127.0.0.1:8080`
- `/tmp/wrd-safe-current-url.txt` 只保存当前临时 quick tunnel 地址，不能覆盖固定域名这一正式入口
- named tunnel：只允许 `~/.cloudflared/config.yml` 中的 `credentials-file`；不得用 `--token` 或 `TUNNEL_TOKEN` 启动正式入口
- quick tunnel（trycloudflare）必须与 named tunnel 配置隔离：`scripts/run-safe-quicktunnel.sh` 使用 `--config /dev/null`，并清除 `TUNNEL_TOKEN` / credentials 相关环境变量，避免默认加载 `~/.cloudflared/config.yml` 导致边缘 404

Host 启动语义：

- `./scripts/restart-host.sh` 和 `./scripts/start-safe-wrd.sh` 都会安装并启用 `com.webremotedesktop.host` LaunchAgent
- LaunchAgent 先运行 `scripts/run-host-launchctl.sh`
- wrapper 会先等待 `signal-server /health` 成功，再预检 `HOST_SHARED_SECRET` 对 `/api/auth/login/host` 的认证成功，最后才 `exec python-host/host.py`
- 因此前置条件未满足时，常驻的是 shell wrapper，不会再反复拉起 `host.py` 和 `overlay_window.py`

Tunnel 操作语义：

- 默认不要重启 `trycloudflare` / `scripts/run-safe-quicktunnel.sh` / 对应 `cloudflared` 进程
- 若只是重启本地 `signal-server` 或 `python-host`，必须优先复用现有 tunnel
- 当前有效 debug quick tunnel 地址始终以 `/tmp/wrd-safe-current-url.txt` 为准
- `重启服务` 不得被解释为重建 quick tunnel；在 tunnel 仍存活时，重启本地服务不应改变 `/tmp/wrd-safe-current-url.txt`
- 只有在用户明确要求“重建 tunnel / 重建 Cloudflare / 重启 tunnel / 重新生成公网地址”时，才允许重建 quick tunnel；tunnel 失效本身不是授权
- `status-safe-wrd.sh` 发现 cloudflared argv 含 `--token` 时只输出固定安全告警；不得打印 token、停止进程或执行 `launchctl remove`

## 目标

- 只操作当前仓库自己的 `signal-server`、`python-host`、safe quick tunnel
- 不扫描、不清理、不复用 `StockHub` 的服务进程
- 通过独立的 safe PID / URL / LOG 文件管理当前仓库的公网临时入口

## 推荐命令

### 0. 手动本地启动（不走公网）

如果只需要本机访问，不需要 quick tunnel，可使用两个终端分别启动：

```bash
# 终端 1
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server
npm start

# 终端 2
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/restart-host.sh
```

手动启动后可直接访问：

- 本地页面：`http://127.0.0.1:8080`
- 健康检查：`http://127.0.0.1:8080/health`
- Host 状态：`http://127.0.0.1:8080/api/status`

说明：

- 前端页面由 `signal-server` 托管，**不要**额外启动 `web-client` 开发服务器
- 当前仓库唯一正确本地入口是 `http://127.0.0.1:8080`
- **不要把** `http://127.0.0.1:5173` **当作当前仓库正式入口**；`5173` 只在显式配置 `dev.link.stockhub.wiki` 时作为可选开发映射存在
- 重启 Host 时必须使用 `./scripts/restart-host.sh`，不要手工 `kill` 后重启
- `./scripts/restart-host.sh` 的重启动作是重新注册并 kickstart `com.webremotedesktop.host`，这是预期行为

### 1. 一键安全启动

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/start-safe-wrd.sh
```

该命令会按顺序：

1. 复用或启动当前仓库的 `signal-server/server.js`
2. 等待 `http://127.0.0.1:8080/health` 正常
3. 通过 `launchctl` 复用或启动当前仓库的 `com.webremotedesktop.host`
4. 在 `scripts/run-host-launchctl.sh` 内等待 `/health` 与 `/api/auth/login/host` 预检都通过
5. 等待 `http://127.0.0.1:8080/api/status` 返回 `hostOnline: true`
6. 复用或启动 `scripts/run-safe-quicktunnel.sh`
7. 只有在该 URL 的 `/health` 返回 2xx 且 JSON `status=ok` 后，才原子写入 `/tmp/wrd-safe-current-url.txt` 与 archive 并输出

重启约定：

- 若只是重启 `signal-server` 或 `python-host`，默认**不停止**现有 safe quick tunnel
- 只要 `/tmp/wrd-safe-quicktunnel.pid` 对应进程仍存活，公网地址默认沿用，不需要重新通知一个新地址
- 只有在用户明确要求执行 `./scripts/stop-safe-wrd.sh`、明确要求重建 quick tunnel，或切换到固定域名方案时，外部地址才允许变化
- 若 signal-server 尚未就绪或 Host 凭据校验失败，Host LaunchAgent 会停留在 wrapper 等待阶段，而不是反复失败重启
- 若当前 quick tunnel 仍存活，排障时不要为了“保险”主动重启它；先检查本地 `8080`、`/api/status` 和 URL 文件
- 若当前访问入口是 trycloudflare / 其他公网域名，且 TURN 未配置，Viewer 仍会先按所选网络模式尝试直连 / STUN；是否进入 `隧道中继` 取决于后续连接结果，而不是入口 URL 本身
- 若当前 quick tunnel 进程仍在，但 safe URL 已经不可解析或 `curl -I -L` 失败，只能报告“当前公网入口失效/不可达”；不得自行调用会重建 tunnel 的脚本
- 每次启动或重启本地服务后，都要从本机运行配置读取并回报两项密码：Viewer 网页登录密码 `VIEWER_ACCESS_PASSWORD`，Terminal admin 密码 `WRD_TERMINAL_ADMIN_PASSWORD`

启动成功后，如需做临时公网排障，读取：

```bash
cat /tmp/wrd-safe-current-url.txt
```

该地址是当前仓库自己的临时调试入口，不是正式用户入口。正式用户（包括手机和 Pad）仍应打开 `https://link.stockhub.wiki`。

但要注意：**地址文件里有 URL，不代表公网已经可用**。对外发送前，至少再做下面 3 步校验：

1. `./scripts/status-safe-wrd.sh` 确认 `safe quick tunnel` 为 `running`
2. 确认该 trycloudflare 子域名已经可以解析
3. `python3 scripts/wrd_entry_health.py --url <safe-url>` 返回 `deliverable=true`
4. `scripts/run-safe-quicktunnel.sh` 是唯一 URL publisher，不会在 health 失败时发布 URL；404、429、5xx、重定向和错误 JSON 全部不可交付
5. 若这台机器自己的系统 DNS 解析不到 `*.trycloudflare.com`，脚本会改用公共 DNS 解析并通过 `curl --resolve` 继续做入口校验，避免把 resolver 问题误判成 tunnel 故障

进一步约束：

1. 若 canonical checker 返回 `dns-unresolved`，说明本机和公共 DNS 都不能解析当前地址，只能报告并等待用户明确是否重建 tunnel
2. 若返回 `origin-unreachable`、`http-invalid` 或 `content-invalid`，当前地址同样不可用，只能报告并等待用户明确授权
3. 不要把“quick tunnel 进程仍在”误判成“公网地址仍可访问”；公网可达性的最终依据始终是 `/health` 的 2xx + JSON 内容
4. 对本仓库来说，`HTTP 530` 和 `Could not resolve host` 都按“当前 trycloudflare 入口不可交付”处理；这一步先归类为 tunnel 侧故障，不要误判成 `signal-server` 或 Host 崩了，也不要自动重建 tunnel
5. 如果只有本机默认 resolver 报 `Could not resolve host`，但公共 DNS 能解析且 `curl --resolve` 返回正常 HTTP，这应归类为本机 DNS 问题，不应让 `run-safe-quicktunnel.sh` 退出并清掉当前 tunnel

如果是在短生命周期的自动化执行环境中启动（例如一次性 shell 命令执行器），`nohup` / `disown` 拉起的后台进程可能在父 shell 结束后被回收。此时应改为在用户自己的常驻终端里执行，或单独保持 `./scripts/run-safe-quicktunnel.sh` 持续运行。

建议的最小交付检查：

```bash
./scripts/status-safe-wrd.sh
SAFE_URL=$(cat /tmp/wrd-safe-current-url.txt)
python3 scripts/wrd_entry_health.py --url "$SAFE_URL"
```

### 2. 查看安全链路状态

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/status-safe-wrd.sh
```

会输出：

- safe signal-server PID 状态
- safe host PID 状态
- safe tunnel supervisor PID 状态
- safe quick tunnel PID 状态
- safe URL 文件状态
- 本地 `8080` 健康检查结果
- 本地 `api/status` 返回内容

该命令严格只读：缺失的 PID 文件保持缺失，过期的 URL 不会从 archive/log 恢复，也不会改写 `/tmp/wrd-safe-current-url.txt`。只有运行中的 tunnel supervisor 可以在重新验证成功后发布 safe URL。

### 3. 一键安全停止

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/stop-safe-wrd.sh
```

该命令只会读取并停止这些安全状态文件记录的 PID：

- `/tmp/wrd-safe-signal.pid`
- `/tmp/wrd-safe-host.pid`
- `/tmp/wrd-safe-tunnel-supervisor.pid`
- `/tmp/wrd-safe-quicktunnel.pid`

同时删除：

- `/tmp/wrd-safe-current-url.txt`

执行该命令后，safe quick tunnel 也会被停止；下一次再启动若重新创建 tunnel，trycloudflare 地址可能变化。

### 4. 固定域名启动

如果你已经完成 Cloudflare 命名隧道配置，可以使用：

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/start-fixed-domain.sh
```

#### 只读 preflight 与本地验收（不改 tunnel）

```bash
# Read-only formal connector check
./scripts/fixed-tunnel-preflight.sh

# Build verification; does not restart any service or tunnel
cd signal-server && npm ci && npm run build:web

# Runtime acceptance after the user manually restarts local services
VIEWER_ACCESS_PASSWORD=... python3 scripts/viewer_bootstrap_acceptance.py \
  --origin http://127.0.0.1:8080 --runs 20 --mode both
```

`fixed-tunnel-preflight.sh` 只报告 ownership / credentials-file / protocol / 近期 timeout-reconnect 分类与 health，不会 kill、restart 或 rotate 任何 `cloudflared`。修复 token/multiple-owner 发现，或变更正在运行的正式 connector，必须另行获得用户明确授权。本地重启与 quick-tunnel 复用规则不变：`重启服务` 只重启 `signal-server` / Host，不得重建 tunnel。

前提条件：

- 已执行过 `scripts/setup-cloudflare.sh`
- 本机存在 `~/.cloudflared/config.yml`
- 已创建 `wrd-tunnel` 命名隧道

如本地服务不是默认 `8080`，可在执行前覆盖：

```bash
LOCAL_PORT=9000 ./scripts/setup-cloudflare.sh
LOCAL_PORT=9000 ./scripts/start-fixed-domain.sh
```

如需同时生成可选开发子域配置，可在执行 `setup-cloudflare.sh` 时显式开启：

```bash
ENABLE_DEV_SUBDOMAIN=1 \
DEV_DOMAIN=dev.link.stockhub.wiki \
DEV_LOCAL_ORIGIN=http://127.0.0.1:5173 \
./scripts/setup-cloudflare.sh
```

固定域名契约：

- 正式入口：`https://link.stockhub.wiki -> 127.0.0.1:8080`
- 可选开发入口：`https://dev.link.stockhub.wiki -> 127.0.0.1:5173`
- `dev.link.stockhub.wiki` 必须单独受 Cloudflare Access 保护
- `5173` 不是正式入口，也不是 startup-blocking 依赖

启动成功后，固定正式入口默认为：`https://link.stockhub.wiki`。手机和 Pad 的访问也统一使用该地址。

### 4.1 开发子域影响边界

- 重启 `5173`：只影响 `dev.link.stockhub.wiki`
- 重启 `8080`：影响 `link.stockhub.wiki`，也会影响 `dev.link.stockhub.wiki` 通过 Vite proxy 访问 `/api`、`/socket.io` 的能力
- 重启 named tunnel / `cloudflared tunnel run`：`link.stockhub.wiki` 与 `dev.link.stockhub.wiki` 同时受影响
- 修改 Cloudflare Access：只影响 `dev.link.stockhub.wiki` 的边缘准入，不会直接重启本地 `8080` / `5173`

### 4.2 Formal tunnel hardening

本小节覆盖正式命名隧道（`wrd-tunnel` / `https://link.stockhub.wiki`）的升级、只读探测、有界自动 watch，以及**仅 formal connector** 的手动重启。设计见 `docs/superpowers/specs/2026-08-11-formal-tunnel-hardening-design.md`。

#### 操作脚本

| 目的 | 命令 | 副作用 |
|------|------|--------|
| 升级 `cloudflared`（≥ 2026.7.3）并只 bounce 正式 connector | `./scripts/upgrade-cloudflared.sh` | 可能 `brew upgrade cloudflared`；成功后调用 formal-only restart；失败时**不**动现有 connector |
| 只读边缘/源站/正式入口分类探测 | `./scripts/probe-fixed-edge.sh` 然后 `cat /tmp/wrd-fixed-edge-probe.json` | 只读；不 kill / restart / rotate 任何 tunnel |
| 手动重启正式命名隧道 | `./scripts/restart-fixed-domain-tunnel.sh` | 仅 stop/start formal connector + wait deliverable；多 owner 时拒绝；不动 signal / host / quick tunnel |
| 安装有界 formal watcher LaunchAgent | `./scripts/install-fixed-watch.sh` | 安装并 kickstart `com.webremotedesktop.fixed-watch` |
| 只读 preflight（ownership / credentials / protocol / timeout 分类 / health） | `./scripts/fixed-tunnel-preflight.sh` | **只读**；不 kill / pkill / `launchctl remove` / restart |

#### Watch 语义（默认）

`scripts/watch-fixed-domain.sh`（由 `com.webremotedesktop.fixed-watch` 常驻运行）只在 **origin 健康且 formal 持续不健康** 时考虑重启 formal connector：

| 参数 | 默认 | 含义 |
|------|------|------|
| 探测间隔 | 60s | 每 tick 检查 origin + formal health |
| 失败阈值 | **180s** | formal 连续失败满 180s 才进入 restart 候选 |
| 冷却 | 300s | 两次 restart 之间最短间隔 |
| 预算 | **2 / 3600s**（每小时最多 2 次） | 窗口内超预算 → `budget-exhausted`，只 notify 不 restart |
| origin-down | — | origin 不健康时 **不** restart formal（状态 `origin-down`） |
| 多 owner | — | 多个 formal owner 时 skip restart，只 notify |

状态与日志：

- 决策状态：`/tmp/wrd-fixed-watch-state.json`
- 应用日志：`/tmp/wrd-fixed-watch.log`
- LaunchAgent 日志：`/tmp/wrd-fixed-watch-launch.log`
- 告警：macOS notification + 上述 log

#### 「重启服务」≠ formal tunnel restart

- **`重启服务`** 只表示重启本地 `signal-server` / Host（例如 `restart-host.sh`、复用 safe 链路时重启 8080 侧）。
- **不得**把「重启服务」解释为重建 quick tunnel，也**不得**解释为重启 formal named tunnel。
- 允许自动重启 formal connector 的**唯一**自动化路径是已安装的 formal watcher（`com.webremotedesktop.fixed-watch` → `watch-fixed-domain.sh` → `restart-fixed-domain-tunnel.sh`）。除此之外，formal restart 必须由操作者显式执行 `./scripts/restart-fixed-domain-tunnel.sh` 或 `./scripts/upgrade-cloudflared.sh`（升级路径内嵌一次 formal bounce）。
- `./scripts/start-fixed-domain.sh` 仍是“本地服务 + formal 启动”的宽路径；connector-only 恢复优先用 `restart-fixed-domain-tunnel.sh`，不要默认走全量 start。

#### Preflight 保持只读

- `fixed-tunnel-preflight.sh` 与 `probe-fixed-edge.sh` 都是诊断工具：报告 ownership、credentials-file、协议、timeout-heavy、origin/formal/edge 分类与 health。
- 它们**不会** kill、pkill、`launchctl remove`、restart 或 rotate 任何 `cloudflared`。
- 修复 token / multiple-owner、升级 binary、重启 formal connector，都必须走上面的显式脚本，并单独获得操作授权（agent 不得在未授权时 live 执行 brew upgrade / install LaunchAgent / formal restart）。

## 关键文件

### Safe 状态文件

- `signal-server PID`: `/tmp/wrd-safe-signal.pid`
- `host PID`: `/tmp/wrd-safe-host.pid`
- `tunnel supervisor PID`: `/tmp/wrd-safe-tunnel-supervisor.pid`
- `quick tunnel PID`: `/tmp/wrd-safe-quicktunnel.pid`
- `safe URL`: `/tmp/wrd-safe-current-url.txt`

### Safe 日志文件

- `safe quick tunnel log`: `/tmp/wrd-safe-quicktunnel.log`
- `safe tunnel supervisor log`: `/tmp/wrd-safe-tunnel-supervisor.log`
- `signal-server log`: `/tmp/signal-server.log`
- `host runtime log`: `back-debug.log`（Python `RotatingFileHandler`）
- `host LaunchAgent wrapper log`: `/tmp/wrd-host-launch.log`（每次 wrapper 启动前原地保留最近 1 MiB）

### 运行时日志语义

- 结构化运行日志默认始终开启，Viewer 诊断摘要、Terminal 审计事件、Host 摘要事件都会进入实时日志
- `WRD_ENABLE_DIAG_PERSIST=1` 只控制 Viewer 诊断 bundle 是否额外写入系统临时目录，不影响运行日志输出
- `WRD_TERMINAL_AUDIT_LOG=/path/to/file.jsonl` 只是在统一运行日志之外再复制一份 Terminal 审计 JSONL
- `WRD_TERMINAL_RECORD_IO=0` 是保守默认值，表示不记录完整 Terminal 输入输出内容
- `WRD_HOST_VERBOSE_DIAGNOSTICS=1` 仅用于显式排障；默认 Host 只记诊断摘要，不刷整段 `[VIEWER]` 日志
- `WRD_LOG_MAX_BYTES` / `WRD_LOG_BACKUP_COUNT` 控制 Host、Signal structured file sink 和 Terminal audit file，默认 10 MiB / 3 个备份
- Host/Signal 默认不记录 key、code、文本、坐标或完整 input payload；只保留 action、transport、字节数、input ID hash 和本机耗时
- Terminal `socketRtt` / `inputAckRtt` 只使用浏览器本地 pending 时钟；`serverProcessMs` 独立计算。password-safe echo 只有确认远端 shell 回显后才开启，Enter/控制键/alternate-screen/重连会立即关闭
- shared Terminal 默认硬上限 8 个 session；`WRD_TERMINAL_IDLE_TIMEOUT_MS>0` 时回收超时且无人附着的 session
- Terminal 运行环境由服务端 allowlist 构造，zsh/bash 使用 no-rc interactive 参数；`PATH` 包含 Homebrew Python 3.11 libexec 目录，`WRD_TERMINAL_PATH_EXTRA` 只能配置已存在绝对目录。环境中不得出现 JWT、password、proxy credential、API key 或 token
- Terminal 默认 WebSocket-only；`WRD_TERMINAL_ALLOW_POLLING=1` 才允许 polling。`WRD_TERMINAL_RECORD_IO=1` 仅为 metadata 记录，不提供原始 IO 回放
- PTY `starting/exited/failed` 状态拒绝输入并不发送成功 ack；输入默认 64 KiB 单消息上限和每 observer token bucket，慢 observer 超过 512 KiB 队列会被单独 detach，下一次 attach 通过 replay 恢复
- admin-only `GET /api/admin/terminal/metrics` 返回 bounded counters、p50/p95、transport 分桶和 pool 容量；不得把命令、密码或完整 PTY 输出写入日志
- 可运行只读检查：`bash scripts/terminal-runtime-check.sh`。它只读取本地 health/status、`/tmp/wrd-safe-current-url.txt` 和可选 metrics/env probe；设置 `WRD_TERMINAL_PROBE_TOKEN` 时会创建并关闭一个临时 Terminal，验证 `command -v python3`、`/usr/bin/env python3`、敏感环境键和 exited-input 无 ack，并确认 safe URL 前后不变；不会调用 `stop-safe-wrd.sh`、重启脚本、`cloudflared` 或 `launchctl remove`

## 排障顺序

### 场景 1：启动后打不开网页

按下面顺序检查：

1. `./scripts/status-safe-wrd.sh`
2. 先确认自己访问的是 `http://127.0.0.1:8080`、`https://link.stockhub.wiki`，或已配置好的 `https://dev.link.stockhub.wiki`，而不是裸 `5173`
3. `curl http://127.0.0.1:8080/health`
4. `curl http://127.0.0.1:8080/api/status`
5. `cat /tmp/wrd-safe-current-url.txt`
6. `tail -100 /tmp/wrd-safe-quicktunnel.log`

判断方法：

- 如果打开的是裸 `5173` 页面：这是错误入口；正式入口应切回 `8080` / `link.stockhub.wiki`，开发映射应改走 `dev.link.stockhub.wiki`
- 如果 `health` 不通：优先看 `signal-server`
- 如果 `health` 通但 `hostOnline` 为 `false`：优先看 `back-debug.log`
- 如果 `/tmp/wrd-host-launch.log` 只有 `Signal server healthy: ...` 但没有 `Host auth preflight succeeded: ...`：优先检查 `HOST_SHARED_SECRET`
- 如果本地都通但公网不通：优先看 safe quick tunnel 日志
- 如果本地都通、DNS 也能解析，但 `curl -I -L` 返回 `HTTP 530`：按“公网入口失效”处理，报告原因并等待用户明确是否重建 tunnel，不要先重启本地 `signal-server` 或 Host
- 如果本地都通、DNS 直接不解析：这同样不是 origin 故障，优先按 quick tunnel 地址失效处理，但不得自动重建 tunnel
- 如果只是本地服务异常，但 `/tmp/wrd-safe-current-url.txt` 仍指向现有 tunnel：只修本地服务，不得重建 tunnel
- 如果 URL 文件里已经有 trycloudflare 地址，但状态脚本显示 `safe quick tunnel: stale`：说明地址文件已经写出，但实际公网进程没有存活，不能把这个链接当作有效入口
- 如果 PID 文件 stale 但发现同仓库 live 进程，状态只显示 `discovered; pid file unchanged`，不会调和 PID 文件

补充排查：

- 如果本地 `health` 正常，但浏览器页面显示“等待 Host 上线”，说明 `signal-server` 正常、`python-host` 尚未成功回连
- 如果 `restart-host.sh` 执行后很快退出，先看 `/tmp/wrd-host-launch.log` 的预检，再看 `back-debug.log` 的 Host runtime
- 如果 fixed domain 不可用，先确认本地 `8080` 正常，再检查 `~/.cloudflared/config.yml` 和隧道配置
- Web Terminal 走的是 Viewer 内部的 Socket.IO 二次授权，不会重启 quick tunnel，也不会占用 WebRTC 媒体链路

### 场景 1b：网页可打开，但远程桌面媒体连接失败

网页入口、登录、Socket.IO 信令和诊断上报可以通过 quick tunnel 正常工作，但这不代表 WebRTC 媒体路径可达。`auto` / `stun` 模式默认遵守 Strict STUN：

- 先尝试 WebRTC direct ICE，允许 `host` / `srflx` / `prflx`
- 媒体链路恶化时自动降载：720p/20fps → 540p/15fps → 480p/12fps → 360p/8fps
- 降载仍失败时主动尝试一次 ICE restart（自动恢复有界；这不是唯一后续手段）
- 自动恢复预算耗尽后明确失败并自动上传诊断
- 不自动切 TURN，不自动走 Cloudflare/Socket.IO 媒体 tunnel
- **普通 WebRTC 失败只走上述有界自动恢复，不会自动启动 500 轮端口搜索**

#### 手动 STUN 端口搜索（可选）

当自动恢复耗尽、或用户希望主动尝试换一组系统分配的 UDP 端口时，可在控制栏点击「搜索端口」（仅 `auto` / `stun`、信令已连且 Host 在线）：

1. **唯一触发**：只有用户手动点击该按钮才会启动最多 **500** 轮全量 PeerConnection 重建；自动失败处理不得启动
2. **成功条件**：本轮出现 selected pair，且连续 3 个 1 秒采样都有解码视频；成功后保留当前连接
3. **UI**：状态区只显示数字端口与轮次（如 `端口搜索 27/500 · Viewer UDP … · Host UDP …`），不显示 IP；未拿到候选时显示「分配中」
4. **可停止**：再次点击变为「停止搜索」；切换网络模式、断开、登出或普通「刷新画面」会取消搜索
5. **策略不变**：500 轮耗尽后不自动切 TURN / Socket.IO 媒体 tunnel，也不覆盖 Strict STUN 自动恢复预算
6. **端口限制**：浏览器无选择本地 ICE UDP 端口的 API；Host `aiortc`/`aioice` 绑定端口 `0`，由 OS 分配。本功能不保证唯一端口、不保证可被路由器单端口转发命中

排查顺序：

1. 查看 Host 日志里的 `VIEWER_STATS`、`WRD_MEDIA_PROFILE`、`WRD_STUN_FAILURE`
2. 如果出现 `WRD_MEDIA_PROFILE`，说明 Viewer 已检测到弱链路并尝试降载
3. 如果最终出现 `strict-stun-exhausted`，优先判断公司网 UDP/NAT、家庭路由器 NAT、IPv6、防火墙，而不是重启 quick tunnel；需要时可再尝试手动「搜索端口」（最多 500 轮）
4. **若需要跨网稳定投屏**：检查 TURN 是否双边就绪（见下节），再**手动**切换「外网中继」；不要假设 `auto` 会自动切 TURN
5. quick tunnel 的 `curl -I -L` 只能证明网页入口可达，不能证明媒体直连或 TURN 可达
6. 如果 `back-debug.log` 出现 `No usable monitor reported by MSS`，按 Host 捕获源异常处理；这不是 Cloudflare 入口故障，也不是 TURN 故障
7. 当前 Host 在 `MSS` 只返回 `0x0` monitor 时会自动回退到 `screeninfo`；如果刚修复完或刚更新代码，优先执行本地 `restart-local` 让新 Host 进程生效

#### 已连接但黑屏

网页已打开、信令已通、ICE 已 connected，但画面仍黑或周期性 0 FPS。这不是 Cloudflare 入口故障，也不要把「已连接」当成已经出画。

1. 先看 `WRD_SESSION_PRESENTATION` 是否 1280x720（relay 默认 cap）。若仍是 `1728x1080` / 进程旧 1080p，说明本次会话 size 未绑定。
2. 再看 `WRD_KEYFRAME emitted=`。`emitted=true` 才表示编码器产出了 IDR；`emitted=false` / `pending` 表示关键帧没真正发出，不要把 `requested=true` 当成已恢复。
3. Viewer 状态应是「正在出画」直到第一帧真正画出；未出画不得显示「已连接」。出画后又连续 ≥1s 0 FPS 应为「画面卡顿」。
4. 不要重建 tunnel；Host 用 `./scripts/restart-host.sh`。

设计：`docs/superpowers/specs/2026-08-29-relay-paint-continuity-design.md`

家庭路由器端口转发只有在 Host 侧 WebRTC UDP 端口范围可控时才有稳定意义。当前 aiortc/aioice 默认随机绑定本地 UDP 端口（系统分配，绑定 `0`），手动搜索端口也只是反复重建连接以换取新的系统端口，因此不要把 TP-LINK “虚拟服务器”里配置单个端口当作已解决 Strict STUN 可达性问题。

#### TURN / 外网中继排查（手动）

设计与实施计划：

- `docs/superpowers/specs/2026-07-20-turn-integration-design.md`
- `docs/superpowers/plans/2026-07-20-turn-integration-plan.md`
- 多节点切换：`docs/superpowers/specs/2026-08-02-multi-turn-server-selection-design.md`

检查顺序：

1. 配置源：`TURN_*` 环境变量，或 `signal-server/.env`，或 `WRD_TURN_JSON` / `~/.StockHub/turn.json`（支持 `turnServers[]`；默认优先阿里云；`WRD_TURN_SERVER_ID` 可覆盖）
2. 登录后访问 `/api/webrtc-config`：`turnConfigured=true`；核对 `turnServers` / `selectedTurnServerId` / `turnFingerprint` / `hostTurnReady`（列表字段不得含 password）
3. Host 必须能读同一 `turn.json` 目录（`scripts/restart-host.sh`）；日志应出现 multi-turn ids 与 default；会话 offer 的 `turnServerId` 会刷新 Host capability
4. 页面网络面板选择 TURN 节点后「应用并重连」；`relay` 成功时链路为 TURN 中继且 FPS > 0，Viewer/Host fingerprint 对应当前节点
5. 失败分类优先：配置缺失/不完整、Host 未就绪、节点 unknown、fingerprint 不一致、Allocate 失败（3478/防火墙/凭据）、有 candidate 无 selected、pair 有但 0 FPS（捕获/编码）
6. Terminal **默认**仍走 Socket.IO，与 TURN 无关；可选 `webrtc-turn` 见设计 Phase 2，失败不得静默回退

### 场景：画面糊 / 秒级卡顿但 RTT 只有 ~100ms

Quality Lock（默认）：

1. 分辨率设置里 **「自动调整分辨率」默认关闭**——系统不得自动 720p→480p/360p
2. 状态栏区分 `RTT` 与 `缓冲`：缓冲尖峰多来自 0fps/关键帧空窗，不是单纯网络差
3. 短时卡顿应优先关键帧恢复（日志 `WRD_KEYFRAME` / `request-keyframe`），而不是 survival 分辨率
4. Host 日志：`WRD_MEDIA_PROFILE size locked` 表示忽略了 Viewer 请求的更小 size；`WRD_ENCODER_RATE ... encoderReopen=false` 表示同分辨率热更新码率
5. 若仍糊：检查是否手动打开了自动分辨率；或用户手选分辨率过低；TURN 是否选了海外节点

相关设计：`docs/superpowers/specs/2026-08-02-quality-lock-low-latency-design.md`

### 场景 2：Cloudflare 地址失效

如果日志出现 `Unauthorized: Tunnel not found`，说明当前 quick tunnel 很可能已经在 Cloudflare 侧失效。Agent 只能报告该结论；除非用户明确要求重建 tunnel，否则不得自动重建或刷新：

- `/tmp/wrd-safe-current-url.txt`

手动确认：

```bash
cat /tmp/wrd-safe-current-url.txt
tail -100 /tmp/wrd-safe-quicktunnel.log
```

如果日志中已经打印出 `Your quick Tunnel has been created`，但从外部仍无法访问，再继续区分两类情况：

- 进程还活着，但域名暂时无法解析：优先等待几秒到几十秒，并重复 DNS / `curl` 验证
- 进程已经退出：报告状态，等待用户明确是否在常驻终端执行 `./scripts/run-safe-quicktunnel.sh`

补充说明：

- 现在脚本不会在“只拿到 URL 但还没验通”的阶段更新 `/tmp/wrd-safe-current-url.txt`
- 因此一旦地址文件变化，就意味着旧地址已经不应再继续对外使用；新的当前地址只认这个文件

### 场景 3：状态脚本显示 safe PID 文件缺失，但 8080 仍然正常

这通常表示：

- 当前本地 `signal-server` / `host` 是通过非 safe 脚本启动的
- 或 safe PID 文件被删掉了，但服务进程还在运行

这时不要直接全局清理；先确认当前服务是否是你想保留的，再决定是否用 safe 脚本重新接管。

### 场景 4：URL 已生成，但 trycloudflare 域名一直无法解析

这通常表示：

- Cloudflare quick tunnel 域名传播尚未完成
- 或当前 quick tunnel 进程已经退出，只留下旧的 URL 文件
- 或 tunnel 是在短生命周期自动化 shell 中启动，子进程被回收

按下面顺序处理：

1. `./scripts/status-safe-wrd.sh`
2. `tail -100 /tmp/wrd-safe-quicktunnel.log`
3. 确认本地源站仍正常：`curl http://127.0.0.1:8080/health`
4. 若 `safe quick tunnel` 非 `running`，报告状态，等待用户明确是否重新执行 `./scripts/run-safe-quicktunnel.sh`
5. 若 `safe quick tunnel` 为 `running` 但 DNS 仍长期不解析，改用固定域名方案 `./scripts/start-fixed-domain.sh`
6. 若公共 DNS 已能解析、而只有本机 resolver 长期不解析，应优先修本机 DNS；当前脚本已会在这类情况下保留 tunnel，不再把它误判成不可交付

## Host 空闲锁屏 / 防睡眠巡检

远程 Host 推荐：

1. 已安装 awake：`./scripts/install-awake-keeper.sh`（`caffeinate -ims`，**不含** `-d`，允许熄屏）
2. 系统设置 → 锁定屏幕：**屏幕保护程序启动或显示器关闭后需要密码 = 永不**
3. 巡检：

```bash
./scripts/check-host-lock-policy.sh
echo exit=$?
# 0 = OK；1 = 硬失败（awake 未跑或仍用 -d）；2 = 仅警告（如密码策略需人工确认、电池 sleep 过短）
```

边界：手动锁定、合盖、电池系统睡眠、熄屏后画面发黑不在自动修复范围；不支持远程解锁密码锁屏。

设计：`docs/superpowers/specs/2026-08-11-host-no-idle-lock-allow-display-sleep-design.md`

## 明确边界

以下行为 **禁止默认执行**：

- 停止或重启 `/Users/macstudio1/AI/Claude/StockHub` 的服务
- 使用全局 `pkill` 扫描共享进程名
- 为了处理当前仓库问题，顺手重启 `StockHub` 的 Vite / 后端 / tunnel

当前仓库的安全脚本设计目标就是：**只影响当前仓库自己记录过的服务**。

## Web Terminal 约束

- Terminal 只在 Viewer 里开启，前提是先完成 Viewer 登录，再做 admin 二次授权
- Terminal 是所有 admin 已授权用户共用的 shared shell session pool，而不是单浏览器私有会话
- 多个浏览器可以同时附着到同一个共享 shell；输入是共享的，并会立即作用到同一个 PTY
- 关闭某个 Terminal 标签页或整个 Viewer 页面，只会断开该浏览器，不会 kill 底层 PTY；会话会保留到显式关闭或服务重启
- Viewer 的 `断开连接` 按钮以及网络模式切换只影响远程桌面链路，不会关闭 Terminal 会话
- `signal-server` / Host 重启通常会保留当前 tunnel 地址，但共享 Terminal 会话在内存中维护，因此会随服务重启结束
- Terminal 失败应直接报错并上送诊断日志，不要自动退回媒体 tunnel 或 TURN
- `http://localhost:5173/` 只作为开发映射入口；对外暴露时应走 `https://dev.link.stockhub.wiki` 并单独受 Cloudflare Access 保护，不是当前仓库的正式页面入口


## 控制租约与媒体暂停运维提示（2026-07-20）

- 若 Viewer 显示「Host 输入复位未确认，控制已安全锁定」：表示 reset barrier 仍在 `REVOKING/reset-blocked`。不要反复点请求控制；优先检查 Host 是否在线并完成 reset，或按既有流程重启本地 Host（不重建 tunnel）。
- 暂停桌面媒体不会断开 Terminal；恢复后需等待首帧渲染再写入输入。
- 公网入口仍以 `/tmp/wrd-safe-current-url.txt` 为准；本闭环不授权重建 tunnel。
