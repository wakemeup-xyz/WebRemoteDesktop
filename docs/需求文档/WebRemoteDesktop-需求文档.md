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
- [x] **诊断日志**：弹出模态框显示浏览器控制台捕获的日志，可一键发送到服务端
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

- [x] **密码登录**：bcrypt 哈希比对
- [x] **JWT Token**：签发 24h 有效期的 token
- [x] **Socket.IO 认证**：连接时校验 token 和 role
- [x] **角色区分**：viewer 和 host 使用不同 role 连接

**安全约束**：
- JWT_SECRET 和 ACCESS_PASSWORD 必须通过环境变量配置，禁止硬编码 fallback
- Host 端密码优先从 `HOST_PASSWORD` 环境变量读取，若未设置则使用代码中的默认密码（开发/测试场景）
- Input relay 仅允许 viewer 角色发送输入事件
- Diagnostic relay 仅允许 viewer 角色发送日志

---

## 4. 部署需求

### 4.1 环境变量

| 变量 | 所属组件 | 说明 |
|------|---------|------|
| `JWT_SECRET` | signal-server | JWT 签名密钥 |
| `ACCESS_PASSWORD` | signal-server | 登录密码 |
| `HOST_PASSWORD` | python-host | Host 认证密码 |
| `PORT` | signal-server | 服务端口，默认 8080 |
| `SERVER_URL` | python-host | Host 连接 Signal Server 的地址，默认 `http://127.0.0.1:8080` |
| `WRD_DISABLE_OVERLAY` | python-host | 设置为 `1` 时禁用 Host 本机浮动提示 |
| `STUN_URLS` | signal-server / python-host | 逗号分隔的 STUN URL，默认使用 Google STUN |
| `TURN_URLS` | signal-server / python-host | 逗号分隔的 TURN/TURNS URL，用于外网中继 |
| `TURN_USERNAME` | signal-server / python-host | TURN 用户名 |
| `TURN_CREDENTIAL` | signal-server / python-host | TURN 密码/凭证 |

### 4.2 启动顺序

1. 启动防睡眠服务：`scripts/install-awake-keeper.sh`（一次性安装）或 `scripts/run-awake-keeper.sh`
2. 启动 Signal Server：`node server.js`
3. 启动 Cloudflare Tunnel（暴露 `127.0.0.1:8080`）
4. 启动 Python Host：`python host.py`（密码优先读取 `HOST_PASSWORD` 环境变量，否则使用默认密码）
5. 浏览器访问 Cloudflare 地址，输入密码登录

推荐使用：

```bash
./scripts/start-with-tunnel.sh
```

当前 quick tunnel 地址会写入：

```bash
/tmp/wrd-current-url.txt
```

由于 trycloudflare quick tunnel 没有稳定性保证，`scripts/run-quicktunnel.sh` 会在检测到 `Unauthorized: Tunnel not found` 时重启 quick tunnel 并更新当前地址文件。

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
- **Cloudflare Tunnel**：trycloudflare 临时域名会过期，需读取 `/tmp/wrd-current-url.txt` 获取最新地址；生产应切换命名隧道和固定域名
- **系统睡眠**：远程桌面依赖实时屏幕采集，Host 必须通过 `caffeinate -dims` 防止系统/显示/磁盘睡眠；手动睡眠、断电、合盖仍可能强制中断

---

## 6. 变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-05-10 | 创建需求文档，汇总当前已实现功能 |
| 2026-05-10 | 修复键盘 `is_modifier` NameError 导致大量按键失效；新增诊断日志对话框和刷新画面按钮；优化视频延迟（jitterBufferTarget=0、GOP 1s）；HOST_PASSWORD 支持默认值 fallback；更新 Cloudflare Tunnel URL |
| 2026-05-11 | 项目网页名称更新为 CodeHarness学习助手；新增 Host 本机浮动提示、全屏按钮、Windows 键盘兼容、WebRTC 自动重连；输入链路改为 WebRTC DataChannel 优先（可靠 `input` + 不可靠 `input-move`），Socket.IO 兜底；新增 Viewer WebRTC stats 回传；新增防睡眠 LaunchAgent（`caffeinate -dims`）；新增 quick tunnel 自恢复并将当前访问地址写入 `/tmp/wrd-current-url.txt` |
| 2026-05-11 | 新增 WebRTC 网络模式选择和右下角网络建议浮窗；Signal Server 提供 `/api/webrtc-config`；Host 与 Viewer 均支持 `STUN_URLS` / `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL`；自动模式可在 TURN 已配置时从直连降级到中继 |
