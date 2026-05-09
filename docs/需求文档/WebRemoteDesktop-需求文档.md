# Web Remote Desktop 需求文档

## 1. 项目概述

Web Remote Desktop 是一个基于 WebRTC 的浏览器远程桌面系统。用户通过浏览器访问网页，即可实时查看并操控远程 macOS 主机的桌面。

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
|  (Viewer)        |      (信令 + 输入)     |   (Node.js)      |
+--------+---------+                       +--------+---------+
         | WebRTC P2P                               |
         +----------->+----------------+<-----------+
                     |   Python Host    |
                     | (macOS + aiortc) |
                     +------------------+
```

### 2.1 组件说明

| 组件 | 技术栈 | 职责 |
|------|--------|------|
| web-client | HTML5 + Vanilla JS | 视频播放、输入采集、UI 交互 |
| signal-server | Node.js + Express + Socket.IO | WebRTC 信令、输入转发、静态文件服务、认证 |
| python-host | Python 3 + aiortc + MSS + Quartz | 屏幕捕获、视频编码、输入执行 |

### 2.2 数据流

1. **连接建立**：Viewer 和 Host 通过 Signal Server 交换 SDP offer/answer 和 ICE candidate
2. **视频传输**：Host 捕获屏幕 → aiortc 编码 → WebRTC P2P → Viewer 解码播放
3. **输入传输**：Viewer 采集鼠标/键盘事件 → Socket.IO → Signal Server 转发 → Host 执行 Quartz 输入

---

## 3. 功能需求

### 3.1 视频流

- [x] **屏幕捕获**：使用 MSS 库实时捕获 macOS 屏幕
- [x] **视频编码**：aiortc 自动编码为 VP8/VP9
- [x] **帧率控制**：默认 15fps，避免编码器过载
- [x] **分辨率切换**：支持 540p / 720p / 1080p / 1440p
- [x] **缩放模式**：自适应(contain) / 填充(cover) / 拉伸(fill)
- [x] **状态显示**：顶部状态栏显示 FPS、延迟、分辨率

### 3.2 鼠标输入

- [x] **移动**：mousemove 事件转发，坐标映射到远程屏幕
- [x] **点击**：mousedown / mouseup / click / dblclick
- [x] **滚轮**：wheel 事件转发（deltaX/deltaY）
- [x] **坐标映射**：基于视频内容区域（去除 object-fit 黑边）
- [x] **多按钮支持**：左键、右键、中键

**约束**：
- 鼠标坐标使用相对比例 (0-1) 传输，Host 根据屏幕分辨率换算为绝对坐标
- 视频内容区域与元素区域可能不一致（object-fit: contain 导致黑边），前端需计算内容区域偏移

### 3.3 键盘输入

- [x] **单键输入**：字母、数字、标点、功能键 F1-F12
- [x] **组合键**：Command/Control/Shift/Alt + 任意键
- [x] **虚拟按钮**：回车、上下左右方向键、复制(Command+C)、粘贴(Command+V)
- [x] **输入记录**：顶部状态栏实时显示发送的按键信息

**关键技术约束**：
- 前端使用 `KeyboardEvent.code`（物理键位）映射到 macOS keyCode
- Web `keyCode`（ASCII 值）与 macOS `keyCode`（USB HID）不兼容，不可直接使用
- modifier 键（Control/Shift/Alt/Command）自己的 keydown **不应携带自己的 modifier flag**
- 虚拟按钮发送组合键时，必须发送完整的 4 步序列：modifier down → char down → char up → modifier up
- 键盘事件必须串行处理，每次事件间隔 ~20ms，确保 Quartz 正确识别时序

### 3.4 控制栏

- [x] **分辨率设置**：弹出模态框选择分辨率
- [x] **暂停/恢复**：暂停视频播放和输入
- [x] **断开连接**：断开 WebRTC 和 Socket.IO 连接
- [x] **缩放切换**：循环切换 contain/cover/fill
- [x] **显示/隐藏控件**：左上角总控按钮隐藏/显示控制栏和虚拟按钮栏

### 3.5 认证

- [x] **密码登录**：bcrypt 哈希比对
- [x] **JWT Token**：签发 24h 有效期的 token
- [x] **Socket.IO 认证**：连接时校验 token 和 role
- [x] **角色区分**：viewer 和 host 使用不同 role 连接

**安全约束**：
- JWT_SECRET 和 ACCESS_PASSWORD 必须通过环境变量配置，禁止硬编码 fallback
- Host 端密码通过 `HOST_PASSWORD` 环境变量读取
- Input relay 仅允许 viewer 角色发送输入事件

---

## 4. 部署需求

### 4.1 环境变量

| 变量 | 所属组件 | 说明 |
|------|---------|------|
| `JWT_SECRET` | signal-server | JWT 签名密钥 |
| `ACCESS_PASSWORD` | signal-server | 登录密码 |
| `HOST_PASSWORD` | python-host | Host 认证密码 |
| `PORT` | signal-server | 服务端口，默认 8080 |

### 4.2 启动顺序

1. 启动 Cloudflare Tunnel（暴露 localhost:8080）
2. 启动 Signal Server：`node server.js`
3. 启动 Python Host：`HOST_PASSWORD=xxx python host.py`
4. 浏览器访问 Cloudflare 地址，输入密码登录

### 4.3 目录结构

```
WebRemoteDesktop/
├── signal-server/       # Node.js 信令服务器
│   ├── server.js
│   ├── routes/auth.js
│   ├── websocket/signaling.js
│   └── .env
├── python-host/         # Python 屏幕捕获 + 输入执行
│   ├── host.py
│   ├── input_handler.py
│   └── requirements.txt
├── web-client/          # 浏览器前端
│   ├── index.html       # 登录页
│   ├── viewer.html      # 控制台
│   ├── css/
│   └── js/
│       ├── auth.js
│       ├── webrtc.js
│       ├── input.js
│       └── ui.js
└── docs/需求文档/
    └── WebRemoteDesktop-需求文档.md
```

---

## 5. 已知限制

- **平台限制**：Host 端仅支持 macOS（依赖 Quartz 和 MSS）
- **编码性能**：软件 VP8 编码 CPU 占用较高，高分辨率下帧率受限
- **辅助功能权限**：Host 需要 macOS 辅助功能权限才能执行输入
- **浏览器限制**：某些系统级快捷键（如 Command+Tab）无法被浏览器捕获

---

## 6. 变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-05-10 | 创建需求文档，汇总当前已实现功能 |
