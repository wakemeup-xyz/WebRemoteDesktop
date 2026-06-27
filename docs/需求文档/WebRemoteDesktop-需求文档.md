# Web Remote Desktop 需求文档

## 1. 项目概述

CodeHarness学习助手 是一个基于 WebRTC 的浏览器远程桌面系统。用户通过浏览器访问网页，即可实时查看并操控远程 macOS 主机的桌面。

### 核心特点
- **零客户端安装**：viewer 端只需浏览器
- **低延迟**：基于 WebRTC P2P 传输
- **公网可达**：通过 Cloudflare Tunnel 暴露服务
- **输入同步**：鼠标、键盘实时转发到远程主机

---

## 2. 系统架构

```
+------------------+       Socket.IO       +------------------+
|   Web Client     | <-------------------> |  Signal Server   |
|  (Viewer)        |        (信令)          |   (Node.js)      |
+--------+---------+                       +--------+---------+
         | WebRTC P2P: Video + DataChannel          |
         +----------->+----------------+<-----------+
                     |   Python Host    |
                     | (macOS + aiortc) |
                     +------------------+
```

### 2.1 组件说明

| 组件 | 技术栈 | 职责 |
|------|--------|------|
| web-client | HTML5 + Vanilla JS | 视频播放、输入采集、UI 交互 |
| signal-server | Node.js + Express + Socket.IO | WebRTC 信令、输入兜底转发、静态文件服务、认证 |
| python-host | Python 3 + aiortc + MSS + Quartz | 屏幕捕获、视频编码、输入执行 |

### 2.2 数据流

1. **连接建立**：Viewer 和 Host 通过 Signal Server 交换 SDP offer/answer 和 ICE candidate
2. **视频传输**：Host 捕获屏幕 → aiortc 编码 → WebRTC P2P → Viewer 解码播放
3. **输入传输**：Viewer 采集鼠标/键盘事件 → WebRTC DataChannel → Host 执行 Quartz 输入；Socket.IO 仅作为兜底通道

---

## 3. 功能需求

### 3.1 视频流

- [x] **屏幕捕获**：使用 MSS 库实时捕获 macOS 屏幕
- [x] **视频编码**：aiortc 使用 H.264 VideoToolbox 硬件编码（monkey-patch 替换默认编码器）
- [x] **帧率控制**：默认 30fps，带帧间隔 sleep 控制
- [x] **延迟优化**：浏览器端 `jitterBufferTarget = 0`，编码器 GOP 1 秒、禁用 B 帧
- [x] **Codec 优先级**：Viewer offer 与 Host answer 均优先 H.264，避免回落到 VP8 软件编码
- [x] **WebRTC 统计回传**：Viewer 定时回传 codec / FPS / RTT / jitter buffer / 丢包等指标到 Host 日志
- [x] **网络模式选择**：Viewer 支持本地直连、自动穿透、外网直连、外网中继四种 ICE 策略
- [x] **网络建议浮窗**：右下角浮窗根据当前模式、候选链路和 0 FPS 状态提示适用场景
- [x] **分辨率切换**：支持 540p / 720p / 1080p / 1440p
- [x] **缩放模式**：自适应(contain) / 填充(cover) / 拉伸(fill)
- [x] **状态显示**：顶部状态栏显示 FPS、延迟、分辨率和候选链路类型

### 3.2 鼠标输入

- [x] **移动**：mousemove 事件转发，坐标映射到远程屏幕
- [x] **点击**：mousedown / mouseup / click / dblclick
- [x] **滚轮**：wheel 事件转发（deltaX/deltaY）
- [x] **坐标映射**：基于视频内容区域（去除 object-fit 黑边）
- [x] **多按钮支持**：左键、右键、中键
- [x] **低延迟传输**：鼠标移动优先通过无序、不可重传的 `input-move` WebRTC DataChannel 发送，避免高频移动事件排队

**约束**：
- 鼠标坐标使用相对比例 (0-1) 传输，Host 根据屏幕分辨率换算为绝对坐标
- 视频内容区域与元素区域可能不一致（object-fit: contain 导致黑边），前端需计算内容区域偏移
- 鼠标移动事件可丢弃，点击、滚轮、键盘事件不可丢弃

### 3.3 键盘输入

- [x] **单键输入**：字母、数字、标点、功能键 F1-F12
- [x] **组合键**：Command/Control/Shift/Alt + 任意键
- [x] **虚拟按钮**：回车、上下左右方向键、复制(Command+C)、粘贴(Command+V)
- [x] **输入记录**：顶部状态栏实时显示发送的按键信息
- [x] **防重复绑定**：`Input.init()` 通过 `_listenersBound` 标志防止重复注册事件监听器
- [x] **Windows 访问兼容**：Windows 键盘模式下将 Ctrl 映射为 macOS Command，并提供网页按钮切换 Mac / Windows 模式
- [x] **DataChannel 输入**：键盘和点击优先通过可靠有序 `input` WebRTC DataChannel 发送，Socket.IO 仅用于兜底

**关键技术约束**：
- 前端使用 `KeyboardEvent.code`（物理键位）映射到 macOS keyCode
- Web `keyCode`（ASCII 值）与 macOS `keyCode`（USB HID）不兼容，不可直接使用
- modifier 键（Control/Shift/Alt/Command）自己的 keydown / keyup **不应携带自己的 modifier flag**
- 虚拟按钮发送组合键时，必须发送完整的 4 步序列：modifier down → char down → char up → modifier up
- 键盘事件必须串行处理，每次事件间隔 ~20ms，确保 Quartz 正确识别时序
- 单字符映射需同时覆盖 lowercase / uppercase / shifted symbols（如 `a` / `A` / `!`）
- 注意：macOS keycode `0`（字母 `a`）在 Python 中为 falsy 值，判断键是否有效时必须使用显式布尔标志，不能直接用 `if not key_code:`
- 输入链路需记录 `transport` 和端到端发送延迟，便于区分 DataChannel 与 Socket.IO 兜底路径

### 3.4 控制栏

- [x] **分辨率设置**：弹出模态框选择分辨率
- [x] **暂停/恢复**：暂停视频播放和输入
- [x] **断开连接**：断开 WebRTC 和 Socket.IO 连接
- [x] **缩放切换**：循环切换 contain/cover/fill
- [x] **显示/隐藏控件**：左上角总控按钮隐藏/显示控制栏和虚拟按钮栏
- [x] **诊断日志**：弹出模态框显示浏览器控制台捕获的日志，可一键发送到服务端；连接失败时自动附带网络环境和链路摘要上送一份诊断
- [x] **刷新画面**：手动断开并重连 WebRTC，用于画面卡顿时快速恢复
- [x] **全屏控制**：网页端提供全屏按钮，Esc 使用浏览器原生 Fullscreen API 退出
- [x] **自动重连**：WebRTC ICE / PeerConnection 断开或失败后，Viewer 自动重建连接；自动模式在配置 TURN 时可降级到 relay
- [x] **网络模式**：控制栏提供网络模式按钮，切换后自动重连并更新浮窗说明

### 3.5 Host 本机浮动提示

- [x] **连接提示**：Host 本机右下角显示浮动窗口，展示访问者和在线用户数
- [x] **输入提示**：实时显示接收到的键盘指令
- [x] **动效**：连接和输入提示支持淡入淡出
- [x] **降级运行**：可通过 `WRD_DISABLE_OVERLAY=1` 禁用浮动提示

### 3.6 认证

- [x] **密码登录**：Viewer 通过网页登录，服务端使用 bcrypt 校验输入密码
- [x] **JWT Token**：Viewer 登录后签发 24h token；Host 使用独立接口签发 15m host token
- [x] **Socket.IO 认证**：连接时校验 Bearer token，服务端以 JWT 内的角色为准
- [x] **角色区分**：Viewer 与 Host 使用不同认证入口和不同角色令牌
- [x] **WebRTC 配置鉴权**：`/api/webrtc-config` 需要已登录的 Bearer token 才可访问

### 3.7 Web Terminal

- [ ] **Terminal tab**：在现有 Viewer 页面中增加 Terminal tab，用户无需离开当前网页
- [ ] **二次授权**：Viewer 登录后，Terminal 需要单独的 admin 二次授权
- [ ] **浏览器会话级授权**：同一浏览器会话内，多个 Terminal tab 共享一次 admin 授权
- [ ] **完整 shell**：Terminal 直接连接本机完整 shell，不限制在项目目录
- [ ] **多会话**：支持同时打开多个 Terminal，会话之间互不干扰
- [ ] **断网重连**：浏览器断网后自动重连到原来的 Terminal，会话和上下文保留
- [ ] **手动关闭才销毁**：Terminal 会话默认一直保留，直到用户手动关闭或服务重启
- [ ] **软提示**：不设硬上限，但当会话数量较多时给出明显性能提示
- [ ] **开发映射**：本机 `http://localhost:5173/` 打开的网页也要能通过映射访问同一套 Terminal 服务
- [ ] **审计日志**：记录 admin 登录、Terminal 创建、断开、重连、关闭和错误
- [ ] **独立实现**：优先使用 `@xterm/xterm` + `node-pty` + Socket.IO 的内嵌方案，不默认引入 WeTTY / ttyd 独立服务

**Terminal 安全约束**：
- Terminal 默认关闭，必须显式开启
- Terminal 使用独立 admin 密码，不复用普通 Viewer 密码
- admin 授权只保存在浏览器 session 内，不默认写入持久 localStorage
- Terminal 不走 STUN / TURN / WebRTC DataChannel，只走 HTTPS / WebSocket
- 不默认记录完整命令和输出内容，避免泄露密钥
- 如果 shell 启动失败、权限不足或资源压力过高，必须明确报错或提示，不允许静默降级

**安全约束**：
- `JWT_SECRET` 必须通过环境变量配置，禁止提交示例占位值或继续依赖仓库内泄露旧值
- Viewer 登录密码读取 `VIEWER_ACCESS_PASSWORD`，兼容回退到 `ACCESS_PASSWORD`
- Host 独立凭据读取 `HOST_SHARED_SECRET`，兼容回退到 `HOST_PASSWORD` / `ACCESS_PASSWORD`
- Input relay 与 diagnostic relay 仅允许 viewer 派生角色发送
- Host 端默认开启 TLS 校验；仅本地开发场景可通过 `WRD_INSECURE_SKIP_TLS_VERIFY=1` 放宽 localhost 校验
- 诊断日志默认不落仓库；若开启 `WRD_ENABLE_DIAG_PERSIST=1`，仅写入系统临时目录并使用脱敏后的内容

---

## 4. 部署需求

### 4.1 环境变量

| 变量 | 所属组件 | 说明 |
|------|---------|------|
| `JWT_SECRET` | signal-server | JWT 签名密钥 |
| `VIEWER_ACCESS_PASSWORD` | signal-server | Viewer 网页登录密码 |
| `HOST_SHARED_SECRET` | signal-server / python-host | Host 登录 `/api/auth/login/host` 使用的共享密钥 |
| `ACCESS_PASSWORD` | signal-server / python-host | 兼容回退密码，仅用于兼容旧配置，不建议继续作为正式开源配置 |
| `HOST_PASSWORD` | signal-server / python-host | Host 凭据兼容回退项，仅用于旧环境迁移 |
| `PORT` | signal-server | 服务端口，默认 8080 |
| `SERVER_URL` | python-host | Host 连接 Signal Server 的地址，默认 `http://127.0.0.1:8080` |
| `WRD_DISABLE_OVERLAY` | python-host | 设置为 `1` 时禁用 Host 本机浮动提示 |
| `WRD_INSECURE_SKIP_TLS_VERIFY` | python-host | 仅本地开发时允许放宽 localhost 的 TLS 校验 |
| `WRD_ENABLE_DIAG_PERSIST` | signal-server | 设置为 `1` 时把脱敏后的诊断日志写入系统临时目录 |
| `STUN_URLS` | signal-server / python-host | 逗号分隔的 STUN URL，默认使用 Google STUN |
| `TURN_URLS` | signal-server / python-host | 逗号分隔的 TURN/TURNS URL，用于外网中继 |
| `TURN_USERNAME` | signal-server / python-host | TURN 用户名 |
| `TURN_CREDENTIAL` | signal-server / python-host | TURN 密码/凭证 |
| `WRD_ENABLE_TERMINAL` | signal-server | 是否启用网页 Terminal，默认 `0` |
| `WRD_TERMINAL_ADMIN_PASSWORD` | signal-server | Terminal 二次授权密码 |
| `WRD_TERMINAL_SHELL` | signal-server | 默认 shell，推荐 `/bin/zsh` |
| `WRD_TERMINAL_CWD` | signal-server | Terminal 默认工作目录 |
| `WRD_TERMINAL_SOFT_WARN_SESSION_COUNT` | signal-server | 会话数软提示阈值，默认 `4` |
| `WRD_TERMINAL_IDLE_TIMEOUT_MS` | signal-server | 会话空闲超时，默认 `0` 表示不自动销毁 |
| `WRD_TERMINAL_STARTUP_TIMEOUT_MS` | signal-server | PTY 启动超时 |
| `WRD_TERMINAL_AUDIT_LOG` | signal-server | 是否记录 Terminal 审计日志 |
| `WRD_TERMINAL_RECORD_IO` | signal-server | 是否记录完整输入输出，默认 `0` |

### 4.2 启动顺序

1. 启动防睡眠服务：`scripts/install-awake-keeper.sh`（一次性安装）或 `scripts/run-awake-keeper.sh`
2. 启动 Signal Server：`node server.js`
3. 启动 Cloudflare Tunnel（暴露 `127.0.0.1:8080`）
4. 启动 Python Host：`python host.py`（使用 `HOST_SHARED_SECRET`，兼容回退到 `HOST_PASSWORD` / `ACCESS_PASSWORD`）
5. 浏览器访问页面，输入 Viewer 密码登录

默认推荐使用：

```bash
./scripts/start-safe-wrd.sh
```

该脚本只会复用或启动当前仓库自己的 `signal-server`、Host LaunchAgent、safe quick tunnel。

其中 Host 的启动语义为：

1. `scripts/start-safe-wrd.sh` 与 `scripts/restart-host.sh` 都会安装并启用 `com.webremotedesktop.host` LaunchAgent
2. LaunchAgent 先运行 `scripts/run-host-launchctl.sh`
3. wrapper 先等待 `signal-server /health` 成功
4. wrapper 再预检 `HOST_SHARED_SECRET` 对 `/api/auth/login/host` 的认证成功
5. 只有上述前置条件都满足，才真正启动 `python-host/host.py`

因此在 signal-server 未就绪或 Host 凭据不正确时，不会再反复拉起 `host.py` 与本机浮窗，只会停留在 wrapper 等待阶段。

若只需要本机访问、不需要公网入口，再改用：

```bash
./scripts/restart-host.sh
```

这条路径同样会重新注册并 kickstart `com.webremotedesktop.host` LaunchAgent；这是当前产品设计的一部分，而不是异常副作用。

停止该安全链路时，使用：`./scripts/stop-safe-wrd.sh`。它只会停止安全启动脚本记录过的 PID，不会清理其他项目进程。
查看该安全链路状态时，使用：`./scripts/status-safe-wrd.sh`。它只读取安全 PID / URL 文件，并检查本地 `8080` 健康状态。

当前 safe quick tunnel 地址会写入：

```bash
/tmp/wrd-safe-current-url.txt
```

由于 trycloudflare quick tunnel 没有稳定性保证，`scripts/run-safe-quicktunnel.sh` 会在检测到 `Unauthorized: Tunnel not found` 时重建 quick tunnel 并更新当前安全地址文件。
同时，脚本现在要求：拿到 trycloudflare URL 后，必须先通过本机 `curl -I -L` reachability 校验，才允许把该地址写入 `/tmp/wrd-safe-current-url.txt`。

需要特别说明：地址文件中已经写出 trycloudflare URL，只能说明 `cloudflared` 已拿到一个临时地址，**不能直接视为公网可用**。对外提供前仍应检查：

1. tunnel 进程仍然存活
2. trycloudflare 子域名已经可以解析
3. 该 URL 能返回 HTTP 响应
4. 若 `curl -I -L` 返回 `Could not resolve host` 或 `HTTP 530`，都按“当前 quick tunnel 入口不可交付”处理，不应误判成 `signal-server` 或 Host 的本地故障

若本机同时运行 `/Users/macstudio1/AI/Claude/StockHub`，推荐优先使用 `scripts/run-safe-quicktunnel.sh`。该脚本只写入 `/tmp/wrd-safe-quicktunnel.pid`、`/tmp/wrd-safe-quicktunnel.log`、`/tmp/wrd-safe-current-url.txt`，不会清理其他项目的进程；当 quick tunnel 过期时，也会自动重建并刷新安全地址文件。

若在短生命周期自动化 shell 中执行 safe quick tunnel，后台子进程可能在父 shell 结束后被回收；此时应改为在用户自己的常驻终端中执行，或改用固定域名隧道。

### 4.3 目录结构

```
WebRemoteDesktop/
├── launchd/              # macOS LaunchAgent 配置
│   └── com.webremotedesktop.awake.plist
├── scripts/              # 启动和运维脚本
│   ├── install-awake-keeper.sh
│   ├── run-awake-keeper.sh
│   ├── run-host-launchctl.sh
│   └── run-quicktunnel.sh
├── signal-server/       # Node.js 信令服务器
│   ├── server.js
│   ├── routes/auth.js
│   ├── websocket/signaling.js
│   └── .env
├── python-host/         # Python 屏幕捕获 + 输入执行
│   ├── host.py
│   ├── input_handler.py
│   ├── h264_videotoolbox_encoder.py  # H.264 硬件编码器 (monkey-patch)
│   └── requirements.txt
├── web-client/          # 浏览器前端
│   ├── index.html       # 登录页
│   ├── viewer.html      # 控制台
│   ├── css/
│   └── js/
│       ├── auth.js
│       ├── webrtc.js
│       ├── input.js
│       ├── ui.js
│       └── diagnostic.js      # 日志捕获 + 诊断模态框
└── docs/需求文档/
    └── WebRemoteDesktop-需求文档.md
```

---

## 5. 已知限制

- **平台限制**：Host 端仅支持 macOS（依赖 Quartz 和 MSS）
- **编码性能**：已切换为 H.264 VideoToolbox 硬件编码，CPU 占用大幅降低
- **辅助功能权限**：Host 需要 macOS 辅助功能权限才能执行输入
- **浏览器限制**：某些系统级快捷键（如 Command+Tab）无法被浏览器捕获
- **视频延迟**：WebRTC 浏览器端 jitter buffer 默认较大，已通过 `jitterBufferTarget = 0` 优化
- **跨网络访问**：Cloudflare Tunnel 只承载网页和信令，WebRTC 媒体默认仍尝试直连；跨 NAT/防火墙环境需要配置 TURN 才能稳定投屏
- **Cloudflare Tunnel**：trycloudflare 临时域名会过期；safe 模式需读取 `/tmp/wrd-safe-current-url.txt` 获取最新地址，旧脚本模式则读取 `/tmp/wrd-current-url.txt`；生产应切换命名隧道和固定域名
- **Terminal 权限**：网页 Terminal 默认关闭；启用后必须使用独立 admin 密码，且同一浏览器会话内的多个 Terminal 共享授权
- **Terminal 会话**：Terminal 默认不设硬上限，但会在会话数较多时提示性能风险；断网后会话保留并自动重连到原 session，直到用户手动关闭或服务重启
- **重启语义**：在 safe quick tunnel 仍存活时，单纯重启 `signal-server` / `python-host` 默认复用现有 tunnel，因此公网地址通常不变；只有显式停 tunnel、tunnel 失效重建或切换入口模式时才变化
- **运维约束**：默认不要主动重启 `trycloudflare` / `scripts/run-safe-quicktunnel.sh` / 对应 `cloudflared` 进程；当前有效公网地址以 `/tmp/wrd-safe-current-url.txt` 为准，只有用户明确要求或 tunnel 已失效时才重建
- **可达性校验**：trycloudflare 地址写入文件后，仍需额外校验进程存活、DNS 解析和 HTTP 可达性，不能仅凭“拿到 URL”就判断公网入口已经成功
- **自动化环境**：在短生命周期自动化 shell 中启动 quick tunnel 时，后台子进程可能被父 shell 退出连带回收；需要常驻终端或固定域名隧道
- **系统睡眠**：远程桌面依赖实时屏幕采集，Host 必须通过 `caffeinate -dims` 防止系统/显示/磁盘睡眠；手动睡眠、断电、合盖仍可能强制中断

---

## 6. 变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-05-10 | 创建需求文档，汇总当前已实现功能 |
| 2026-05-10 | 修复键盘 `is_modifier` NameError 导致大量按键失效；新增诊断日志对话框和刷新画面按钮；优化视频延迟（jitterBufferTarget=0、GOP 1s）；HOST_PASSWORD 支持默认值 fallback；更新 Cloudflare Tunnel URL |
| 2026-05-11 | 项目网页名称更新为 CodeHarness学习助手；新增 Host 本机浮动提示、全屏按钮、Windows 键盘兼容、WebRTC 自动重连；输入链路改为 WebRTC DataChannel 优先（可靠 `input` + 不可靠 `input-move`），Socket.IO 兜底；新增 Viewer WebRTC stats 回传；新增防睡眠 LaunchAgent（`caffeinate -dims`）；新增 quick tunnel 自恢复并将当前访问地址写入 `/tmp/wrd-current-url.txt` |
| 2026-05-11 | 新增 WebRTC 网络模式选择和右下角网络建议浮窗；Signal Server 提供 `/api/webrtc-config`；Host 与 Viewer 均支持 `STUN_URLS` / `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL`；自动模式可在 TURN 已配置时从直连降级到中继，未配置 TURN 时会更快切到隧道中继；外网中继模式仅在 TURN 配置完整时启用 |
| 2026-06-02 | 补充公网启动约束：trycloudflare URL 写入文件不等于公网已可用；safe quick tunnel 交付前需验证进程存活、DNS 解析和 HTTP 可达性；短生命周期自动化 shell 中需避免把临时后台进程误判为常驻服务 |
| 2026-06-06 | 同步开源前安全加固现状：Viewer 与 Host 分离认证、`/api/webrtc-config` 需要 Bearer token、TLS 默认校验开启、诊断日志默认不落仓库，仅在显式开启时写入系统临时目录 |
| 2026-06-06 | 明确 safe quick tunnel 重启语义：仅重启本地服务时默认复用现有 quick tunnel，公网地址通常不变；停止 safe 链路或 tunnel 失效重建时地址才变化 |
| 2026-06-14 | 明确 Host 由 `com.webremotedesktop.host` LaunchAgent 托管；`restart-host.sh` / `start-safe-wrd.sh` 会重新注册 LaunchAgent；`run-host-launchctl.sh` 新增 signal-server health 与 host auth 双重预检，避免 Host 在前置条件未满足时反复失败拉起 |
