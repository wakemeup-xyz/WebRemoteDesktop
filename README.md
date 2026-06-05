# CodeHarness学习助手 - 快速开始

## 项目状态

**已完成组件：**
- ✅ 信令服务器 (Node.js + Express + Socket.io)
- ✅ 浏览器客户端 (登录页 + 视频显示 + 远程控制)
- ✅ Python Host 应用 (Python + aiortc + MSS屏幕捕获)
- ✅ H.264 WebRTC 低延迟视频链路
- ✅ WebRTC DataChannel 输入链路
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

### 方式一：仅启动本地服务

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

- 前端**不单独运行** `npm run dev`
- **不要打开**其他项目的 `5173` 页面；那个通常是别的 Vite 应用，不是当前远程桌面
- `signal-server` 会通过 `express.static()` 直接托管 `web-client/`
- 本地唯一正确入口：`http://127.0.0.1:8080`
- 健康检查：`http://127.0.0.1:8080/health`
- Host 状态：`http://127.0.0.1:8080/api/status`

### 方式二：一键安全启动本地 + 公网临时地址

适用于需要 trycloudflare 临时公网入口，并且希望**只操作当前仓库服务**的场景。推荐优先使用。

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/start-safe-wrd.sh
```

该脚本会按顺序：

1. 启动或复用 `signal-server`
2. 等待 `http://127.0.0.1:8080/health` 正常
3. 启动或复用 `python-host`
4. 等待 `http://127.0.0.1:8080/api/status` 返回 `hostOnline: true`
5. 启动 safe quick tunnel，并把公网地址写入 `/tmp/wrd-safe-current-url.txt`

注意：脚本打印出 URL 只表示 `cloudflared` 已返回一个 trycloudflare 地址，**不等于该地址已经对外可访问**。对外提供前还需要额外确认：

1. `./scripts/status-safe-wrd.sh` 中 `safe quick tunnel` 仍为 `running`
2. trycloudflare 子域名已经可以解析
3. `curl -I -L <safe-url>` 能拿到 HTTP 响应

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

### 方式三：固定域名启动

适用于已经配置好 Cloudflare 命名隧道，并希望使用固定域名访问。

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
./scripts/start-fixed-domain.sh
```

使用前提：

- 已完成 `scripts/setup-cloudflare.sh`
- 本机存在 `~/.cloudflared/config.yml`
- `wrd-tunnel` 命名隧道已配置完成

脚本成功后，固定域名入口默认为：`https://stockhub.wiki`

### 启动成功后的访问方式

- 本地访问：`http://127.0.0.1:8080`
- 安全脚本临时公网访问：`cat /tmp/wrd-safe-current-url.txt`
- 旧版普通 quick tunnel 地址：`cat /tmp/wrd-current-url.txt`
- 固定域名访问：`https://stockhub.wiki`

### 启动后快速自检

```bash
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/status
```

期望结果：

- `/health` 返回 `status: ok`
- `/api/status` 返回 `hostOnline: true`

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
- **不要把** `http://127.0.0.1:5173` **当作当前仓库入口**；它很可能是本机其他项目的 Vite 页面
- 前端页面由 `signal-server` 通过 `express.static()` 提供
- 若看到“等待 Host 上线”，先检查 `signal-server` 和 `python-host` 是否都已启动
- 页面登录流程保持不变：打开网页 → 输入 Viewer 密码 → 点击“开始学习助手”
- Viewer 登录密码来自 `VIEWER_ACCESS_PASSWORD`（兼容回退到 `ACCESS_PASSWORD`）
- Host 使用独立凭据 `HOST_SHARED_SECRET`（兼容回退到 `HOST_PASSWORD` / `ACCESS_PASSWORD`）
- 连接成功后显示远程 macOS 桌面


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
- [x] Windows 访问模式支持 Ctrl → macOS Command
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
3. 先确认自己打开的不是 `5173`，而是 `8080` 或 safe URL
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
4. 成功后可从 `/tmp/wrd-safe-current-url.txt` 读取公网地址
5. 读取到地址后，仍应继续执行 `./scripts/status-safe-wrd.sh` 和一次外部可达性校验，再把链接发给使用者

### 一键安全停止

1. 停止本仓库安全启动链路：`./scripts/stop-safe-wrd.sh`
2. 该脚本只读取 `/tmp/wrd-safe-*.pid` 并停止这些 PID，不会扫描或清理其他项目进程
3. 执行后会删除 `/tmp/wrd-safe-current-url.txt`

### 一键安全状态

1. 查看本仓库安全链路状态：`./scripts/status-safe-wrd.sh`
2. 它会只读取 `/tmp/wrd-safe-*.pid`、`/tmp/wrd-safe-current-url.txt`，并检查 `http://127.0.0.1:8080/health` 与 `http://127.0.0.1:8080/api/status`

### WebRTC 连接失败
1. 检查浏览器控制台是否有 JavaScript 错误
2. 在网页控制栏切换网络模式：本地同网优先“本地直连”，普通外网用“自动穿透”，公司网/校园网/跨运营商用“外网中继”
3. 如果网页一直 `0 FPS` 且链路为 `-` / `unknown`，说明 ICE 没有选出媒体路径，需要配置 TURN
4. TURN 环境变量：`TURN_URLS`、`TURN_USERNAME`、`TURN_CREDENTIAL`；STUN 可通过 `STUN_URLS` 覆盖

### TURN 配置示例

如果你希望 `auto` 在外网下更稳定，或希望 `外网中继` 模式真正可用，需要同时配置 TURN。当前项目支持从 `signal-server/.env` 读取：

```env
STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_URLS=turn:global.relay.metered.ca:80,turn:global.relay.metered.ca:443,turns:global.relay.metered.ca:443
TURN_USERNAME=你的用户名
TURN_CREDENTIAL=你的凭证
```

配置要点：

1. `TURN_URLS`、`TURN_USERNAME`、`TURN_CREDENTIAL` 三项必须同时存在，否则 TURN 不生效
2. `signal-server` 和 `python-host` 都会读取这些环境变量，因此重启后端和 Host 即可生效
3. `auto` 模式：有 TURN 时会在直连失败后自动尝试中继；没有 TURN 时会更快退回 `隧道中继`
4. `relay` 模式：没有 TURN 时并不会真正中继，只会退回 STUN / tunnel 提示
5. 常见来源：自建 coturn，或使用 metered.ca / Twilio / Cloudflare Calls 等 TURN 服务

验证方式：

- 打开页面网络模式面板，确认显示 `TURN 已配置`
- 先在网页登录，再使用带 Bearer Token 的请求访问 `/api/webrtc-config`，确认 `turnConfigured` 为 `true`
- 连接后若 stats 显示链路 `relay`，说明已实际走 TURN 中继
- Host 日志中应出现 `Using custom H.264 encoder` 和 `VIEWER_STATS`

### 操作画面延迟高

1. 检查 Host 日志：`tail -f /tmp/host-debug.log`
2. 关注 `VIEWER_STATS`：`codec=video/H264`、`fps`、`rtt`、`jitter_buffer`
3. 关注输入日志：应显示 `transport=datachannel`
4. 如果输入回落到 `transport=socket`，说明 DataChannel 未建立或页面未刷新

### 前端诊断日志调试

1. 让用户在网页诊断面板点击“发送日志到服务端”
2. `web-client/js/diagnostic.js` 会收集最近控制台日志和延迟统计
3. 前端通过 Socket.IO `diagnostic` 事件发送到 Signal Server，服务端会先做脱敏和截断
4. 默认不会把诊断日志持久化到仓库目录；仅在设置 `WRD_ENABLE_DIAG_PERSIST=1` 时写入系统临时目录下的 `wrd-diag/`
5. 排查问题时，优先看实时服务端日志；若已开启持久化，再读取临时目录中的最新诊断文件

### Mac 待机后服务不可用

1. 检查防睡眠：`pmset -g assertions`
2. 应看到 `PreventSystemSleep`、`PreventUserIdleDisplaySleep`、`PreventDiskIdle`
3. 检查守护进程：`launchctl print gui/$(id -u)/com.webremotedesktop.awake`

## 已知限制

1. **屏幕录制权限**: Python Host 需要屏幕录制权限，首次运行需要在系统设置中授权
2. **辅助功能权限**: Python Host 需要辅助功能权限才能执行远程输入
3. **临时 tunnel**: trycloudflare 地址会过期，需读取 `/tmp/wrd-current-url.txt`
4. **系统睡眠**: 已通过 `caffeinate -dims` 防止主动睡眠；手动睡眠、合盖、断电仍可能中断

## 下一步优化

1. 切换 Cloudflare 命名隧道和固定域名
2. 增加端到端输入延迟可视化
3. 支持音频传输
4. 支持多 viewer 观看 / 单 viewer 控制
