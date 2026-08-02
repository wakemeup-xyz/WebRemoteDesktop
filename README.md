# CodeHarness学习助手 - 快速开始

## 项目状态

**已完成组件：**
- ✅ 信令服务器 (Node.js + Express + Socket.io)
- ✅ 浏览器客户端 (登录页 + 视频显示 + 远程控制)
- ✅ Python Host 应用 (Python + aiortc + MSS屏幕捕获)
- ✅ H.264 WebRTC 低延迟视频链路
- ✅ WebRTC DataChannel 输入链路
- ✅ Host 捕获源回退：MSS 瞬时只返回 `0x0` monitor 时，自动回退到 `screeninfo`
- ✅ macOS 防睡眠守护和 quick tunnel 自恢复

## 系统架构

```
┌─────────────┐      Socket.IO 信令       ┌─────────────────┐
│   浏览器     │  ◄──────────────────────► │   信令服务器     │
│  (Viewer)   │                           │  (Node.js:8080) │
└──────┬──────┘                           └────────┬────────┘
       │                                           │
       │       WebRTC 视频 + DataChannel 输入       │
       │  ◄──────────────────────────────────────► │
       │                                           │
┌──────┴───────────────────────────────────────────┴────────┐
│                      Python Host                            │
│            屏幕捕获 + H.264 编码 + Quartz 输入               │
└─────────────────────────────────────────────────────────────┘
```

## 启动项目服务

### 启动前准备

首次运行前，先确认以下依赖和权限已经就绪：

- `signal-server` 依赖已安装：在 `signal-server/` 下执行过 `npm install`
- `python-host` 依赖已安装：按 `python-host/requirements.txt` 准备好 Python 运行环境
- 已配置 `signal-server/.env`
- macOS 已授予 **屏幕录制** 和 **辅助功能** 权限给 Python Host

### 安全前置项

- 复制 `signal-server/.env.example` 为 `signal-server/.env`
- 为 `JWT_SECRET` 设置随机值；正式开源前建议使用 32 位以上随机字符串
- 为 Viewer 登录密码与 Host 进程凭据分别配置：`VIEWER_ACCESS_PASSWORD` 与 `HOST_SHARED_SECRET`
- 非本地开发环境保持 TLS 校验开启，不要设置 `WRD_INSECURE_SKIP_TLS_VERIFY=1`
- trycloudflare / quick tunnel 只提供网络入口，不等于额外认证层

> 当前仓库若准备正式公开发布，仍需先轮换历史上已实际使用过的密码、JWT secret、TURN 凭据和 tunnel 相关凭据。

正式公网入口：`https://link.stockhub.wiki`

- 外部用户应只记这一个固定域名
- `trycloudflare` / safe quick tunnel 仅用于本地调试、临时排障和公网入口兜底验证，不应作为长期正式入口

### 方式一：本地调试/排障启动（safe quick tunnel）

当你需要同时拉起本地服务，并保留一个临时 quick tunnel 做调试或排障时，使用这一种。

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/start-safe-wrd.sh
```

该脚本会按顺序：

1. 启动或复用 `signal-server`
2. 等待 `http://127.0.0.1:8080/health` 正常
3. 通过 LaunchAgent 注册并启动 `python-host`
4. 在 `scripts/run-host-launchctl.sh` 内先等待 `/health` 成功，再预检 `/api/auth/login/host` 认证成功，最后才真正启动 `host.py`
5. 等待 `http://127.0.0.1:8080/api/status` 返回 `hostOnline: true`
6. 启动 safe quick tunnel，并通过 `scripts/wrd_entry_health.py` 校验 `<origin>/health` 返回 2xx 且 JSON `status=ok`，验证通过后才原子写入 `/tmp/wrd-safe-current-url.txt`

补充约定：

1. `./scripts/start-safe-wrd.sh` 会优先**复用**现有 safe quick tunnel，而不是每次重建
2. 因此在 quick tunnel 进程仍然存活时，单纯重启 `signal-server` / `python-host`，公网地址通常**不会变化**
3. 只有在用户明确要求重建/停止 tunnel、或切换网络入口模式时，地址才允许变化
4. `./scripts/start-safe-wrd.sh` 会安装并启用 `com.webremotedesktop.host` LaunchAgent；这是当前仓库的预期产品行为，不是副作用
5. 默认**不要重启** `trycloudflare` / `scripts/run-safe-quicktunnel.sh` / 对应 `cloudflared` 进程；即使现有 tunnel 已失效，也只能报告，不能自行重建
6. `重启服务` 只指重启本地 `signal-server` / Host；在 tunnel 仍存活时，这类操作不应改变 `/tmp/wrd-safe-current-url.txt` 中的当前地址
7. 当 Viewer 是通过 trycloudflare / 其他公网域名进入，且服务端未配置 `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` 时，前端仍会按当前模式先尝试直连 / STUN；若后续失败，再按页面恢复逻辑决定是否切到 `隧道中继`
8. 如果当前 safe URL 已经不可解析或不可访问，agent 只能报告“公网入口不可达”，不得自行调用会重建 tunnel 的脚本

注意：脚本打印出 URL 只表示 `cloudflared` 已返回一个 trycloudflare 地址，**不等于该地址已经对外可访问**。对外提供前还需要额外确认：

1. `./scripts/status-safe-wrd.sh` 中 `safe quick tunnel` 仍为 `running`
2. trycloudflare 子域名已经可以解析
3. `python3 scripts/wrd_entry_health.py --url <safe-url>` 返回 `deliverable=true`
4. 如果 `safe quick tunnel` 进程仍在，但入口检查已失败，说明旧 tunnel 地址可能已经失效；此时只能报告并等待用户明确授权是否重建 tunnel
5. `scripts/run-safe-quicktunnel.sh` 是 safe URL 的唯一 publisher；它只在 `/health` 2xx 且 JSON `status=ok` 后原子写入当前文件和 archive
6. 如果这台机器的系统 DNS 一时解析不到 `*.trycloudflare.com`，脚本会回退到公共 DNS 解析并用 `curl --resolve` 校验；避免把“本机 resolver 异常”误判成 tunnel 本身不可用

补充判断：

1. `DNS 可解析` 仍不等于入口可用；404、410、429、5xx、重定向或错误 JSON 都不是可交付入口
2. `cloudflared` 进程仍在，也不等于这个 trycloudflare 地址仍然有效；状态判断必须以 `status-safe-wrd.sh` 的 canonical health 结果为准
3. trycloudflare 本身没有稳定性保证；如果需要长期稳定地址，应切换到命名隧道和固定域名，而不是继续依赖临时 quick tunnel
4. 如果你看到地址“变了”，以 `/tmp/wrd-safe-current-url.txt` 的最新内容为准；旧链接只要过了 reachability 校验就必须视为失效
5. `status-safe-wrd.sh` 只读检查，不创建、恢复、删除或改写 PID/URL 真相文件；`trycloudflare` 遇到本机 DNS 失败时，canonical checker 会回退到公共 DNS 并保持正确 TLS SNI 做相同内容校验

如果是在短生命周期的自动化 shell 中启动（例如一次性命令执行器），后台 `nohup` 子进程可能会在父 shell 结束后被回收；此时建议在用户自己的常驻终端中重新执行该脚本，或单独保持 `./scripts/run-safe-quicktunnel.sh` 运行。

常用配套命令：

```bash
# 查看当前安全链路状态
./scripts/status-safe-wrd.sh

# 查看当前临时公网地址
cat /tmp/wrd-safe-current-url.txt

# 停止当前仓库安全链路
./scripts/stop-safe-wrd.sh
```

### 方式二：仅启动本地服务

适用于本机调试，不需要公网访问。

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop

# 终端 1：启动信令服务（同时托管前端页面）
cd signal-server
npm start

# 终端 2：启动 Python Host
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/restart-host.sh
```

这条手动本地路径同样会安装并启用 `com.webremotedesktop.host` LaunchAgent。当前设计就是通过 LaunchAgent 托管 Host，而不是用一次性前台进程。

- 前端**不单独运行** `npm run dev`
- **不要把**裸 `5173` **页面当作当前仓库正式入口**；只有在显式配置 `dev.link.stockhub.wiki` 时，`5173` 才作为可选开发映射存在
- `signal-server` 会通过 `express.static()` 直接托管 `web-client/`
- 本地唯一正确入口：`http://127.0.0.1:8080`
- 健康检查：`http://127.0.0.1:8080/health`
- Host 状态：`http://127.0.0.1:8080/api/status`
- 若 `signal-server` 还没准备好，或 `HOST_SHARED_SECRET` 还不能通过 `/api/auth/login/host` 校验，LaunchAgent 只会让 wrapper 常驻等待，不会反复拉起 `host.py` 和浮窗
- 若只重启本地 `signal-server` 或 Host，默认保持当前 tunnel 不动；当前有效公网地址始终以 `/tmp/wrd-safe-current-url.txt` 为准

### 方式三：固定域名启动

适用于已经配置好 Cloudflare 命名隧道，并希望使用固定域名访问。

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/start-fixed-domain.sh
```

使用前提：

- 已完成 `scripts/setup-cloudflare.sh`
- 本机存在 `~/.cloudflared/config.yml`
- `config.yml` 中为 named tunnel 配置了 `credentials-file`；正式启动不接受 `--token` 参数或 `TUNNEL_TOKEN` 作为凭据来源
- `wrd-tunnel` 命名隧道已配置完成
- debug quick tunnel（trycloudflare）由 `scripts/run-safe-quicktunnel.sh` 启动时会隔离 named config：默认 `--config /dev/null` 并清除 tunnel token/credentials 环境变量；不得把 named tunnel 凭据注入 quick tunnel

`./scripts/status-safe-wrd.sh` 若发现现有 `cloudflared` argv 含 `--token`，只输出固定安全告警，不显示 token，也不会停止或重启 tunnel。凭据迁移和 tunnel 重启必须由用户单独授权。

如本地服务不是 `8080`，可在执行前覆盖：

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
- `5173` 不是当前仓库正式入口，也不是 fixed-domain 启动的 startup-blocking 依赖

脚本成功后，固定域名正式入口默认为：`https://link.stockhub.wiki`

### 启动成功后的访问方式

- 本地访问：`http://127.0.0.1:8080`
- 安全脚本临时公网访问：`cat /tmp/wrd-safe-current-url.txt`
- 旧版普通 quick tunnel 地址：`cat /tmp/wrd-current-url.txt`
- 固定域名正式访问：`https://link.stockhub.wiki`
- 固定域名开发访问（仅在显式配置且通过 Cloudflare Access 后可用）：`https://dev.link.stockhub.wiki`

### 启动后快速自检

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/status
```

期望结果：

- `/health` 返回 `status: ok`
- `/api/status` 返回 `hostOnline: true`

如需确认 LaunchAgent 守门逻辑是否生效，可看 `/tmp/wrd-host-launch.log` 中是否出现以下顺序日志：

- `=== LaunchAgent starting host ===`
- `Signal server healthy: ...`
- `Host auth preflight succeeded: ...`

### 防睡眠服务

远程桌面依赖实时屏幕采集，Mac 不能进入系统睡眠或显示睡眠。首次部署时安装：

```bash
./scripts/install-awake-keeper.sh
```

它会安装 `com.webremotedesktop.awake` LaunchAgent，运行：

```
/usr/bin/caffeinate -dims
```

用于防止系统睡眠、显示睡眠和磁盘睡眠。

### 本地访问

本机调试可访问：

```text
http://127.0.0.1:8080
```

公网访问使用 `/tmp/wrd-current-url.txt` 中的 Cloudflare 地址。

如果使用的是安全脚本 `./scripts/start-safe-wrd.sh` 或 `./scripts/run-safe-quicktunnel.sh`，则应优先读取 `/tmp/wrd-safe-current-url.txt`。

### 前端启动说明

- 前端不单独运行 `npm run dev`
- 当前仓库页面只从 `http://127.0.0.1:8080` 打开
- **不要把** `http://127.0.0.1:5173` **当作当前仓库正式入口**；`5173` 只在显式配置 `dev.link.stockhub.wiki` 时作为可选开发映射存在
- 前端页面由 `signal-server` 通过 `express.static()` 提供
- 若看到“等待 Host 上线”，先检查 `signal-server` 和 `python-host` 是否都已启动
- 页面登录流程保持不变：打开网页 → 输入 Viewer 密码 → 点击“开始学习助手”
- Viewer 登录密码来自 `VIEWER_ACCESS_PASSWORD`（兼容回退到 `ACCESS_PASSWORD`）
- Host 使用独立凭据 `HOST_SHARED_SECRET`（兼容回退到 `HOST_PASSWORD` / `ACCESS_PASSWORD`）
- 连接成功后显示远程 macOS 桌面

### Web Terminal

- Viewer 仍然是默认入口，Terminal 需要在 Viewer 登录后再做一次 admin 二次授权
- Terminal 是所有完成 admin 二次授权用户共用的 shared shell session pool
- 多个浏览器可同时附着到同一个共享会话；任一浏览器输入都会立即作用到同一个 shell
- 关闭当前 Terminal 标签页或整个 Viewer 页面，只会让该浏览器断开附着，不会 kill 底层 PTY；会话会持续到显式关闭或服务重启
- Viewer 的 `断开连接` 按钮和网络模式切换只影响远程桌面 / WebRTC 路径，不会关闭共享 Terminal 会话
- 切换到 Terminal、页面进入后台或手动暂停会停止远程桌面 capture、编码和视频 payload；信令、ICE、DataChannel、Terminal Socket 和共享 PTY 保持连接
- 返回桌面或页面重新可见时只清除对应自动原因；手动暂停会继续生效，直到用户再次点击恢复。暂停和恢复期间的预期 0 FPS 不触发质量降档、ICE restart 或自动重连
- `scripts/restart-host.sh` 或 signal-server 重启在 tunnel 仍存活时通常会保留当前公网地址，但共享 Terminal 会话保存在内存中，因此会在服务重启时结束
- Terminal **默认**只走浏览器会话内的 Socket.IO / HTTPS 通道，不依赖 STUN / TURN / WebRTC 媒体链路；可选 `webrtc-turn`（DataChannel + 同一 TURN）见 TURN 接入设计 Phase 2，须显式选择且失败不得静默回退
- Terminal 的 `socketRtt` 和 `inputAckRtt` 只使用浏览器本地 pending 时间；服务端 `serverProcessMs` 单独显示，不能跨机器相减 wall clock
- password-safe echo 默认不可信：首批普通输入只作为隐藏 probe，只有远端 shell 确实回显后才对后续字符启用；Enter、控制键、alternate-screen、断线和重连都会清零，因此密码提示不会在浏览器显示输入字符
- shared Terminal 默认最多 `8` 个 PTY session，达到上限后拒绝新建但不影响现有会话；可通过 `WRD_TERMINAL_MAX_SESSIONS` 调整。每会话 replay 默认 256 KiB，配置 `WRD_TERMINAL_IDLE_TIMEOUT_MS` 后会自动回收超时且无人附着的会话
- Terminal PTY 只继承 allowlist 环境，shell 使用 `/bin/zsh -f -i` 或 `/bin/bash --noprofile --norc -i`；`PATH` 由服务端固定注入 Homebrew Python 3.11 libexec 路径，不读取个人 shell rc。`WRD_TERMINAL_PATH_EXTRA` 只接受已存在的绝对目录，重复或空项会拒绝启动
- Terminal 进程状态分为 `starting/running/exited/failed/closed`；starting、exited、failed 不接受输入，也不会发送成功 ack。输出按 observer 独立限流，慢 observer 会单独 detach，PTY 和其他 observer 继续运行并可通过 replay 恢复
- `WRD_TERMINAL_RECORD_IO=1` 只记录 metadata（字节数、chunk 数、延迟和状态），不记录原始命令、密码或完整输出。管理员可读取 `GET /api/admin/terminal/metrics`，该接口只返回有界计数、p50/p95 摘要和 pool 容量
- Terminal transport 默认只用 WebSocket；只有显式设置 `WRD_TERMINAL_ALLOW_POLLING=1` 才启用 polling fallback。polling 与 websocket latency 样本分开统计
- 公网入口的 Cloudflare/边缘 RTT 不由 Terminal 代码消除；runtime checker 只读验证本地 health、Terminal metrics、Python 路径、环境键和 exited-input；设置 `WRD_TERMINAL_PROBE_TOKEN` 时会创建并关闭一个临时 Terminal，并确认 safe URL 没有变化，不会重启或重建 tunnel
- `http://localhost:5173/` 仅用于前端开发映射和 API 代理；对外暴露时应走 `https://dev.link.stockhub.wiki` 并单独受 Cloudflare Access 保护，不是当前仓库的正式入口
- 连接失败会直接报错，并把前端诊断日志发送到后端，便于排查


## 项目记忆

- `docs/project-memory.md`：迁移自 Claude memory 的长期项目约定
- `docs/claude-memory-index.md`：Claude memory 索引与映射说明
- `docs/runbook-safe-startup.md`：安全启动 / 状态 / 停止运行手册

## 目录结构

```
WebRemoteDesktop/
├── launchd/               # macOS LaunchAgent 配置
├── scripts/               # 启动和运维脚本
│   ├── start-with-tunnel.sh
│   ├── run-quicktunnel.sh
│   ├── install-awake-keeper.sh
│   ├── run-awake-keeper.sh
│   └── run-host-launchctl.sh
├── signal-server/          # Node.js 信令服务器 ✅
│   ├── server.js          # 主服务器
│   ├── routes/auth.js     # 登录验证
│   └── websocket/         # WebSocket 处理
├── web-client/             # 浏览器客户端 ✅
│   ├── index.html         # 登录页
│   ├── viewer.html        # 视频控制台
│   ├── css/               # 样式文件
│   └── js/                # 前端逻辑
└── python-host/            # Python Host 应用 ✅
    ├── host.py            # 主程序
    ├── input_handler.py   # 输入处理
    ├── h264_videotoolbox_encoder.py
    ├── overlay_window.py  # Host 本机浮动提示
    └── requirements.txt   # Python依赖
```

## 测试清单

- [x] 信令服务器启动成功 (http://localhost:8080/health)
- [x] 浏览器能打开登录页
- [x] Viewer 密码验证通过（使用当前环境变量配置值）
- [x] Python Host 启动成功
- [x] Host 连接到信令服务器
- [x] 浏览器点击“开始学习助手”后建立 WebRTC 连接
- [x] 浏览器显示桌面画面
- [x] H.264 视频编码优先
- [x] 远程鼠标操作响应
- [x] 远程键盘输入响应
- [ ] Windows 访问模式 Ctrl → macOS Command 已有 UI 和归一化代码，但发送 payload 仍需按键盘专项审计整改并重新验收
- [x] WebRTC DataChannel 输入优先，Socket.IO 兜底
- [x] 分辨率切换正常
- [x] 防睡眠 LaunchAgent 运行

## 故障排查

### 显示"等待Host上线..."
1. 检查 Python Host 是否已启动: `ps aux | grep host.py`
2. 检查 Host 日志: `cat /tmp/host.log`
3. 检查服务器日志: `cat /tmp/signal-server.log`
4. 确保浏览器和 Host 都连接到同一个服务器端口 8080

### 当前公网地址打不开

1. 区分地址文件：safe 脚本看 `cat /tmp/wrd-safe-current-url.txt`，旧脚本看 `cat /tmp/wrd-current-url.txt`
2. 检查状态：`./scripts/status-safe-wrd.sh`
3. 先确认自己打开的是 `8080`、`link.stockhub.wiki`，或已配置好的 `dev.link.stockhub.wiki`，而不是裸 `5173`
4. 检查 tunnel 日志：`tail -100 /tmp/wrd-safe-quicktunnel.log` 或 `tail -100 /tmp/cloudflared-wrd.log`
5. 如果看到 `Unauthorized: Tunnel not found`，说明 trycloudflare 临时地址过期，脚本会自动重启并更新地址文件
6. 如果日志已打印 trycloudflare 地址，但域名仍无法解析或状态脚本显示 `safe quick tunnel: stale`，说明公网入口实际上尚未可用；常见原因是 DNS 传播延迟，或后台进程在短生命周期 shell 退出后被回收
7. 生产环境应使用 Cloudflare 命名隧道和固定域名

### 安全 Quick Tunnel（不影响 StockHub）

1. 先确认本仓库源站正常：`curl http://127.0.0.1:8080/health`
2. 启动独立 quick tunnel：`./scripts/run-safe-quicktunnel.sh`
3. 查看当前安全地址：`cat /tmp/wrd-safe-current-url.txt`
4. 查看独立日志：`tail -100 /tmp/wrd-safe-quicktunnel.log`
5. 该脚本只使用本仓库独立的 PID / URL / LOG 文件，不会 `pkill` 其他项目进程
6. 若日志出现 `Unauthorized: Tunnel not found`，脚本会自动拉起新的 safe quick tunnel 并刷新地址文件

### 一键安全启动（推荐）

1. 启动本仓库完整链路：`./scripts/start-safe-wrd.sh`
2. 它会只复用或启动本仓库的 `signal-server`、`python-host`、safe quick tunnel
3. 不会停止 `/Users/macstudio1/AI/Claude/StockHub` 的服务
4. 若 safe quick tunnel 已在运行，重启本地服务时会继续复用它，因此公网地址默认保持不变
5. 每次启动或重启本地服务后，都要从运行配置回报 `VIEWER_ACCESS_PASSWORD` 和 `WRD_TERMINAL_ADMIN_PASSWORD`
6. 成功后可从 `/tmp/wrd-safe-current-url.txt` 读取公网地址
7. 读取到地址后，仍应继续执行 `./scripts/status-safe-wrd.sh` 和一次外部可达性校验，再把链接发给使用者

### 一键安全停止

1. 停止本仓库安全启动链路：`./scripts/stop-safe-wrd.sh`
2. 该脚本只读取 `/tmp/wrd-safe-*.pid` 并停止这些 PID，不会扫描或清理其他项目进程
3. 执行后会删除 `/tmp/wrd-safe-current-url.txt`

### 一键安全状态

1. 查看本仓库安全链路状态：`./scripts/status-safe-wrd.sh`
2. 它会只读取 `/tmp/wrd-safe-*.pid`、`/tmp/wrd-safe-current-url.txt`，并检查公网 `/health`、本地 `http://127.0.0.1:8080/health` 与 `/api/status`
3. 它可以发现与 PID 文件不一致的活进程并报告，但不会调和 PID 文件，也不会从 archive/log 恢复 URL

### WebRTC 连接失败
1. 检查浏览器控制台是否有 JavaScript 错误
2. 在网页控制栏切换网络模式：本地同网优先“本地直连”，普通外网用“自动穿透”或“外网直连”；TURN / 隧道中继作为用户手动模式使用
3. 如果网页一直 `0 FPS` 且链路为 `-` / `unknown`，说明 ICE 没有选出媒体路径；Strict STUN 默认不会自动切 TURN 或媒体 tunnel
4. TURN 环境变量：`TURN_URLS`、`TURN_USERNAME`、`TURN_CREDENTIAL`；STUN 可通过 `STUN_URLS` 覆盖
5. 如果 Host 日志出现 `No usable monitor reported by MSS`，说明这次失败是 Host 屏幕枚举异常，不是公网入口异常；当前 Host 会优先用 `MSS`，若只拿到 `0x0` monitor 再回退到 `screeninfo`
6. 2026-07-09 已验证：`https://link.stockhub.wiki` 下手动切到 `隧道中继` 可以真实出画，Viewer 状态会显示 `已连接 / 链路 tunnel / Tunnel relay stream`

### Strict STUN 自适应优化

`auto` / `stun` 模式会在直连媒体链路恶化时先自动降载：720p/20fps → 540p/15fps → 480p/12fps → 360p/8fps。触发信号包括连续 0 FPS、RTT/Jitter 异常和丢包突增。若降载后仍未恢复，Viewer 会主动尝试一次 ICE restart。

该优化不会自动切 TURN，也不会自动走 Cloudflare/Socket.IO 媒体 tunnel。恢复预算耗尽后页面会明确显示 Strict STUN 失败，并自动发送诊断日志。用户仍可手动切换到 TURN 或 tunnel 对应模式。

家庭路由器“虚拟服务器/端口转发”只有在 Host 侧 WebRTC UDP 端口范围可控时才有稳定意义。当前 aiortc/aioice 默认随机绑定本地 UDP 端口，`RTCConfiguration` 不提供标准端口范围字段，因此不能只填一个端口就保证 Strict STUN 可达。后续如引入 `WRD_ICE_UDP_PORT_RANGE`，才适合配合路由器转发固定 UDP 范围。

### TURN 配置示例

如果你希望手动 `外网中继` 模式真正可用，需要同时配置 TURN。**Viewer（signal-server）与 Host（python-host）必须使用同一套 TURN**，否则选不出 `relay` candidate pair。

权威设计与分阶段实施：

- 设计：`docs/superpowers/specs/2026-07-20-turn-integration-design.md`
- 计划：`docs/superpowers/plans/2026-07-20-turn-integration-plan.md`

#### 配置源优先级

1. 进程环境变量 `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL`（完整三项时合成 id=`env` 并默认选中）
2. `signal-server/.env`（dotenv）
3. `WRD_TURN_JSON` 指向的 JSON，或默认本机 `~/.StockHub/turn.json`（若文件存在）
4. 可选 `WRD_TURN_SERVER_ID` / 文件 `defaultTurnServerId` 指定默认节点；否则**优先阿里云**（remark/realm/id 含 aliyun/阿里云）

本机 JSON 支持多节点（**不要提交到 git**）：

```json
{
  "turnServers": [
    {
      "host": "cn.turn.example",
      "port": 3478,
      "username": "your-user",
      "password": "your-password",
      "realm": "aliyun.example",
      "transport": "udp",
      "remark": "阿里云节点"
    },
    {
      "host": "os.turn.example",
      "port": 3478,
      "username": "your-user",
      "password": "your-password",
      "realm": "overseas.example",
      "transport": "udp",
      "remark": "海外节点"
    }
  ]
}
```

兼容旧单节点：

```json
{
  "turnServer": {
    "host": "your.turn.host",
    "port": 3478,
    "username": "your-user",
    "password": "your-password",
    "realm": "example.realm",
    "transport": "udp"
  }
}
```

也可直接写在 `signal-server/.env`：

```env
STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_URLS=turn:your.turn.host:3478?transport=udp
TURN_USERNAME=你的用户名
TURN_CREDENTIAL=你的凭证
# 可选：显式指定 JSON 路径 / 默认节点
# WRD_TURN_JSON=/Users/you/.StockHub/turn.json
# WRD_TURN_SERVER_ID=aliyun
```

配置要点：

1. `TURN_URLS`、`TURN_USERNAME`、`TURN_CREDENTIAL` 三项必须同时存在，否则 TURN 不生效（`turnMisconfigured`）；完整 env 会覆盖为默认 `env` 节点
2. **Host 与 signal-server 必须能读同一 `turn.json` 目录**（Host 按 offer.`turnServerId` 会话级选节点）；仅改 signal-server 不够。用 `scripts/restart-host.sh` 重启 Host
3. Viewer 网络面板可切换 **TURN 节点**（`wrdTurnServerId`）；「应用并重连」后 offer 携带 `turnServerId`，signaling 白名单转发
4. `relay` 会话必须在 Host 侧 **会话级** 允许 TURN；全局 `strict-stun` 不得再导致外网中继模式被静默忽略
5. `auto` / `stun` 模式：保持 Strict STUN，失败时先降载和 ICE restart / 可选手动端口搜索，恢复耗尽后明确失败，**不自动**切 TURN 或 tunnel
6. `relay` 模式：`iceTransportPolicy: 'relay'`；配置不完整时页面明确提示，建议手动改用隧道中继
7. 当前入口是否是 trycloudflare / 外网域名，不再作为自动强制切到 `隧道中继` 的条件
8. 常见来源：自建 coturn，或 metered.ca / Twilio / Cloudflare Calls 等；公司网常拦 UDP，可追加 `?transport=tcp` / `turns:` 备选并先做自检
9. Terminal **默认**仍走 Socket.IO，不依赖 TURN；可选 `webrtc-turn` DataChannel 为后续 Phase（见设计文档），失败时不得静默假装已接通

设计文档：`docs/superpowers/specs/2026-08-02-multi-turn-server-selection-design.md`

验证方式：

- 打开页面网络模式面板，确认显示 `TURN 已配置`、节点下拉（默认阿里云）与 fingerprint / Host ready
- 先在网页登录，再使用带 Bearer Token 的请求访问 `/api/webrtc-config`，确认 `turnConfigured` 为 `true`，`turnServers` 列表无 password
- `GET /api/webrtc-config?turnServerId=overseas` 应切换 `selectedTurnServerId` 与 `iceServers`
- 选「外网中继」重连；stats 显示链路 `relay` / TURN 中继，且 FPS > 0
- Host 日志中应出现 TURN 已配置类日志，以及 `Using custom H.264 encoder` / `VIEWER_STATS`
- 接入自检 UI 后：点「测试 TURN」，配置完整性 + Allocate + 双边 fingerprint 应 PASS

### 操作画面延迟高

1. 检查 Host 日志：`tail -f /tmp/host-debug.log`
2. 关注 `VIEWER_STATS`：`codec=video/H264`、`fps`、`rtt`、`jitter_buffer`
3. 关注输入日志：应显示 `transport=datachannel`
4. 如果输入回落到 `transport=socket`，说明 DataChannel 未建立或页面未刷新

### 前端诊断日志调试

1. 让用户在网页诊断面板点击“发送日志到服务端”
2. `web-client/js/diagnostic.js` 会收集最近控制台日志和延迟统计
3. 前端优先通过 Socket.IO `diagnostic` 事件发送；若 signaling/socket 不可用，再退化为带 Bearer 的 HTTP `POST /api/diagnostics`
4. 运行时结构化日志默认始终开启；Viewer 诊断、Terminal 审计和 Host 摘要事件都会进入实时服务端日志
5. 默认不会把诊断 bundle 持久化到仓库目录；仅在设置 `WRD_ENABLE_DIAG_PERSIST=1` 时写入系统临时目录下的 `wrd-diag/`
6. Terminal 审计事件默认进入统一运行日志；仅在设置 `WRD_TERMINAL_AUDIT_LOG=/path/to/file.jsonl` 时额外写一份独立 JSONL 审计文件
7. `WRD_TERMINAL_RECORD_IO=0` 表示默认不记录完整 Terminal 输入输出原文；只有显式打开时才允许记录详细 IO
8. Host 处理浏览器诊断时默认只输出摘要事件；只有设置 `WRD_HOST_VERBOSE_DIAGNOSTICS=1` 才会额外打印逐行 Viewer 日志
9. Host 和 Signal file sink 共用 `WRD_LOG_MAX_BYTES` / `WRD_LOG_BACKUP_COUNT`，默认单文件 10 MiB、保留 3 个备份；Terminal audit file 使用相同轮转边界
10. 默认输入日志只记录 action、transport、payload byte count、input ID hash 和本机执行时间，不记录 key、code、文本、坐标或完整 payload
11. `host_event_loop_lag` 以 20ms/100ms 分级并附带媒体档位、连接状态、计数和有界资源摘要；普通告警按 5 秒聚合，避免日志放大阻塞
12. 排查问题时，优先看实时服务端日志；若已开启 bundle 持久化，再读取临时目录中的最新诊断文件

### Mac 待机后服务不可用

1. 检查防睡眠：`pmset -g assertions`
2. 应看到 `PreventSystemSleep`、`PreventUserIdleDisplaySleep`、`PreventDiskIdle`
3. 检查守护进程：`launchctl print gui/$(id -u)/com.webremotedesktop.awake`

## 已知限制

1. **屏幕录制权限**: Python Host 需要屏幕录制权限，首次运行需要在系统设置中授权
2. **辅助功能权限**: Python Host 需要辅助功能权限才能执行远程输入
3. **临时 tunnel**: trycloudflare 地址在 quick tunnel 存活期间通常保持不变，但在进程退出、过期重建或显式停 tunnel 后会变化；safe 模式读取 `/tmp/wrd-safe-current-url.txt`
4. **系统睡眠**: 已通过 `caffeinate -dims` 防止主动睡眠；手动睡眠、合盖、断电仍可能中断

## 下一步优化

1. 切换 Cloudflare 命名隧道和固定域名
2. 增加端到端输入延迟可视化
3. 支持音频传输
4. 支持多 viewer 观看 / 单 viewer 控制


## 远程桌面可靠性闭环（2026-07-20）

自动化已闭合（详见 `docs/superpowers/reports/2026-07-20-remote-desktop-reliability-closure-evidence.md`）：

- Host 控制租约 transition 失败/超时/非法 ack **fail-closed**：保持 `REVOKING`，同 epoch 1s/2s/4s 有界重试后广播 `reset-blocked`；仅 reset-only `applied` 进入 `FREE`。
- 手动 STUN 端口搜索仅当前 **ACTIVE controller** 可启动；只读调用严格无副作用。
- 媒体暂停停止桌面输入、MSS capture、WebRTC encode/payload、tunnel JPEG/relay；保留信令、ICE/DataChannel 与 Terminal。
- tunnel 源分辨率可自适应（960/640/480），Viewer 外层 viewport 与指针几何保持稳定。
- 本闭环不引入 TURN/VPS/原生 Viewer/固定 UDP 端口；不重启 Cloudflare tunnel。

真实双 Viewer / 普通 Chrome / 公网 tunnel 运行验收见 Task 9 证据表（运行时待补）。
