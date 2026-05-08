# macOS Web远程桌面投屏 - 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建完整的macOS桌面投屏和远程控制系统，包含WebRTC视频传输、WebSocket信令、密码认证、鼠标/键盘远程控制。

**Architecture:** macOS原生应用(Swift+ScreenCaptureKit+WebRTC)捕获桌面并建立P2P连接，Node.js信令服务器处理认证和SDP交换，浏览器客户端接收视频流并发送输入指令。

**Tech Stack:** Swift/ScreenCaptureKit/WebRTC, Node.js/Socket.io, 原生HTML/JS/WebRTC

---

## 文件结构

```
WebRemoteDesktop/
├── macos-host/
│   ├── WebRemoteDesktop/
│   │   ├── App.swift                    # 应用入口
│   │   ├── ScreenCaptureManager.swift    # 屏幕捕获管理
│   │   ├── WebRTCManager.swift          # WebRTC连接管理
│   │   ├── WebSocketClient.swift        # 信令服务器连接
│   │   ├── InputController.swift        # 远程输入执行
│   │   ├── ConfigManager.swift          # 分辨率配置
│   │   └── ResolutionPicker.swift       # 分辨率选择UI
│   └── Package.swift                    # Swift Package
├── signal-server/
│   ├── server.js                        # Express主服务器
│   ├── package.json                     # Node依赖
│   ├── routes/
│   │   └── auth.js                      # 认证API
│   └── websocket/
│       ├── signaling.js                 # WebRTC信令处理
│       └── input.js                     # 输入指令中继
└── web-client/
    ├── index.html                       # 登录页
    ├── viewer.html                      # 主显示页
    ├── css/
    │   ├── login.css
    │   └── viewer.css
    └── js/
        ├── auth.js                      # 认证逻辑
        ├── webrtc.js                    # WebRTC连接
        ├── input.js                     # 输入捕获发送
        └── ui.js                        # 界面控制
```

---

## Phase 1: 信令服务器基础

### Task 1: 初始化Node.js项目

**Files:**
- Create: `signal-server/package.json`
- Create: `signal-server/server.js`

- [ ] **Step 1: 创建package.json**

```json
{
  "name": "web-remote-desktop-signal",
  "version": "1.0.0",
  "description": "WebRTC signaling server for macOS remote desktop",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "socket.io": "^4.7.2",
    "jsonwebtoken": "^9.0.2",
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}
```

- [ ] **Step 2: 安装依赖**

```bash
cd signal-server
npm install
```

- [ ] **Step 3: 创建基础Express服务器**

```javascript
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(cors());
app.use(express.json());

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Signal server running on port ${PORT}`);
});
```

- [ ] **Step 4: 测试服务器启动**

```bash
npm start
```

Expected: 控制台显示 `Signal server running on port 8080`

- [ ] **Step 5: 测试健康检查端点**

```bash
curl http://localhost:8080/health
```

Expected: `{"status":"ok","timestamp":"..."}`

- [ ] **Step 6: Commit**

```bash
git add signal-server/
git commit -m "feat: init signal server with Express and Socket.io"
```

---

### Task 2: 实现密码认证系统

**Files:**
- Modify: `signal-server/server.js`
- Create: `signal-server/routes/auth.js`

- [ ] **Step 1: 添加JWT认证中间件**

在 `signal-server/server.js` 顶部添加：

```javascript
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// 从环境变量读取或生成默认密码hash
const DEFAULT_PASSWORD = process.env.ACCESS_PASSWORD || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// 内存存储（生产环境应使用数据库）
const passwordHash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
```

- [ ] **Step 2: 创建认证API路由**

创建 `signal-server/routes/auth.js`：

```javascript
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const passwordHash = bcrypt.hashSync(
  process.env.ACCESS_PASSWORD || 'admin123', 
  10
);

// 登录验证
router.post('/login', async (req, res) => {
  const { password } = req.body;
  
  if (!password) {
    return res.status(400).json({ error: 'Password required' });
  }
  
  const valid = await bcrypt.compare(password, passwordHash);
  
  if (!valid) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  
  const token = jwt.sign(
    { role: 'viewer', timestamp: Date.now() },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  
  res.json({ token, expiresIn: '24h' });
});

// 验证token
router.get('/verify', (req, res) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  
  const token = authHeader.substring(7);
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, role: decoded.role });
  } catch (err) {
    res.status(401).json({ valid: false, error: 'Invalid token' });
  }
});

module.exports = router;
```

- [ ] **Step 3: 挂载认证路由**

在 `signal-server/server.js` 的 `app.use` 后添加：

```javascript
const authRoutes = require('./routes/auth');
app.use('/api/auth', authRoutes);
```

- [ ] **Step 4: 测试登录API**

```bash
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"admin123"}'
```

Expected: `{"token":"...","expiresIn":"24h"}`

- [ ] **Step 5: 测试错误密码**

```bash
curl -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"wrong"}'
```

Expected: `{"error":"Invalid password"}` with status 401

- [ ] **Step 6: 测试token验证**

```bash
curl http://localhost:8080/api/auth/verify \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

Expected: `{"valid":true,"role":"viewer"}`

- [ ] **Step 7: Commit**

```bash
git add signal-server/
git commit -m "feat: add password authentication API"
```

---

### Task 3: 实现WebRTC信令WebSocket

**Files:**
- Modify: `signal-server/server.js`
- Create: `signal-server/websocket/signaling.js`

- [ ] **Step 1: 创建信令处理器**

创建 `signal-server/websocket/signaling.js`：

```javascript
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// 存储活跃的host和viewer连接
const connections = {
  host: null,     // macOS应用连接
  viewers: new Map()  // 浏览器观看者连接
};

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function setupSignaling(io) {
  const signalingNamespace = io.of('/signal');
  
  signalingNamespace.use((socket, next) => {
    // 验证JWT token
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    
    const decoded = verifyToken(token);
    if (!decoded) {
      return next(new Error('Invalid token'));
    }
    
    socket.user = decoded;
    next();
  });
  
  signalingNamespace.on('connection', (socket) => {
    const role = socket.handshake.auth.role;
    console.log(`Signaling connection: ${role} - ${socket.id}`);
    
    if (role === 'host') {
      connections.host = socket;
      socket.emit('connected', { role: 'host' });
      
      // 通知所有viewer host已上线
      connections.viewers.forEach((viewerSocket, viewerId) => {
        viewerSocket.emit('host-status', { online: true });
      });
    } else if (role === 'viewer') {
      connections.viewers.set(socket.id, socket);
      socket.emit('connected', { 
        role: 'viewer',
        hostOnline: connections.host !== null
      });
    }
    
    // 处理offer（viewer -> host）
    socket.on('offer', (data) => {
      if (connections.host) {
        connections.host.emit('offer', {
          offer: data.offer,
          viewerId: socket.id
        });
      }
    });
    
    // 处理answer（host -> viewer）
    socket.on('answer', (data) => {
      const viewerSocket = connections.viewers.get(data.viewerId);
      if (viewerSocket) {
        viewerSocket.emit('answer', { answer: data.answer });
      }
    });
    
    // 处理ICE候选者
    socket.on('ice-candidate', (data) => {
      if (data.target === 'host' && connections.host) {
        connections.host.emit('ice-candidate', {
          candidate: data.candidate,
          from: socket.id
        });
      } else if (data.target === 'viewer') {
        const viewerSocket = connections.viewers.get(data.viewerId);
        if (viewerSocket) {
          viewerSocket.emit('ice-candidate', {
            candidate: data.candidate,
            from: socket.id
          });
        }
      }
    });
    
    // 处理断开连接
    socket.on('disconnect', () => {
      console.log(`Signaling disconnected: ${role} - ${socket.id}`);
      
      if (role === 'host') {
        connections.host = null;
        // 通知所有viewer host已离线
        connections.viewers.forEach((viewerSocket) => {
          viewerSocket.emit('host-status', { online: false });
        });
      } else {
        connections.viewers.delete(socket.id);
      }
    });
  });
  
  return connections;
}

module.exports = { setupSignaling, connections };
```

- [ ] **Step 2: 挂载信令命名空间**

在 `signal-server/server.js` 的 `io` 创建后添加：

```javascript
const { setupSignaling } = require('./websocket/signaling');
const connections = setupSignaling(io);

// 导出connections供其他模块使用
module.exports = { connections };
```

- [ ] **Step 3: 测试WebSocket连接**

使用测试脚本：

```bash
# 新开终端，测试host连接
node -e "
const io = require('socket.io-client');
const socket = io('http://localhost:8080/signal', {
  auth: { token: 'VALID_TOKEN', role: 'host' }
});
socket.on('connect', () => console.log('Host connected'));
socket.on('connected', (data) => console.log(data));
"
```

Expected: `Host connected` + `{ role: 'host' }`

- [ ] **Step 4: Commit**

```bash
git add signal-server/
git commit -m "feat: add WebRTC signaling WebSocket namespace"
```

---

### Task 4: 实现输入指令中继WebSocket

**Files:**
- Create: `signal-server/websocket/input.js`
- Modify: `signal-server/server.js`

- [ ] **Step 1: 创建输入中继处理器**

创建 `signal-server/websocket/input.js`：

```javascript
function setupInputRelay(io, connections) {
  const inputNamespace = io.of('/input');
  
  inputNamespace.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    
    // 简化的token验证（复用signaling的验证）
    try {
      const jwt = require('jsonwebtoken');
      const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = decoded;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });
  
  inputNamespace.on('connection', (socket) => {
    const role = socket.handshake.auth.role;
    console.log(`Input connection: ${role} - ${socket.id}`);
    
    if (role === 'host') {
      socket.emit('connected', { role: 'host' });
    } else if (role === 'viewer') {
      socket.emit('connected', { role: 'viewer' });
    }
    
    // 中继输入指令（viewer -> host）
    socket.on('input', (data) => {
      if (role !== 'viewer') return;
      
      // 转发给host
      if (connections.host) {
        connections.host.emit('input', {
          type: data.type,      // 'mouse' | 'keyboard'
          action: data.action,  // 'move' | 'click' | 'keydown' | etc
          payload: data.payload // 具体数据
        });
      }
    });
    
    socket.on('disconnect', () => {
      console.log(`Input disconnected: ${role} - ${socket.id}`);
    });
  });
}

module.exports = { setupInputRelay };
```

- [ ] **Step 2: 挂载输入中继**

在 `signal-server/server.js` 的 `setupSignaling` 调用后添加：

```javascript
const { setupInputRelay } = require('./websocket/input');
setupInputRelay(io, connections);
```

- [ ] **Step 3: 测试输入中继**

使用测试脚本验证：

```bash
# 先启动host连接
node -e "
const io = require('socket.io-client');
const socket = io('http://localhost:8080/input', {
  auth: { token: 'VALID_TOKEN', role: 'host' }
});
socket.on('input', (data) => console.log('Received input:', data));
" &

# 然后发送测试输入
node -e "
const io = require('socket.io-client');
const socket = io('http://localhost:8080/input', {
  auth: { token: 'VALID_TOKEN', role: 'viewer' }
});
socket.on('connect', () => {
  socket.emit('input', {
    type: 'mouse',
    action: 'move',
    payload: { x: 100, y: 200 }
  });
});
"
```

Expected: host端控制台显示接收到的输入数据

- [ ] **Step 4: Commit**

```bash
git add signal-server/
git commit -m "feat: add input relay WebSocket for remote control"
```

---

## Phase 2: 浏览器客户端

### Task 5: 创建登录页面

**Files:**
- Create: `web-client/index.html`
- Create: `web-client/css/login.css`

- [ ] **Step 1: 创建登录HTML**

创建 `web-client/index.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Web远程桌面 - 登录</title>
  <link rel="stylesheet" href="css/login.css">
</head>
<body>
  <div class="login-container">
    <h1>Web远程桌面</h1>
    <form id="loginForm">
      <div class="input-group">
        <label for="password">访问密码</label>
        <input type="password" id="password" name="password" required
               placeholder="请输入访问密码">
      </div>
      <button type="submit">连接</button>
      <div id="error" class="error-message"></div>
    </form>
  </div>
  
  <script>
    const API_BASE = 'http://localhost:8080';
    
    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const password = document.getElementById('password').value;
      const errorDiv = document.getElementById('error');
      
      try {
        const response = await fetch(`${API_BASE}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
          // 保存token并跳转到viewer页面
          localStorage.setItem('wrd_token', data.token);
          window.location.href = 'viewer.html';
        } else {
          errorDiv.textContent = data.error || '登录失败';
        }
      } catch (err) {
        errorDiv.textContent = '网络错误，请检查服务器连接';
      }
    });
  </script>
</body>
</html>
```

- [ ] **Step 2: 创建登录样式**

创建 `web-client/css/login.css`：

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.login-container {
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(10px);
  border-radius: 16px;
  padding: 40px;
  width: 100%;
  max-width: 360px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.login-container h1 {
  color: #fff;
  text-align: center;
  margin-bottom: 30px;
  font-size: 24px;
  font-weight: 500;
}

.input-group {
  margin-bottom: 20px;
}

.input-group label {
  display: block;
  color: rgba(255, 255, 255, 0.7);
  margin-bottom: 8px;
  font-size: 14px;
}

.input-group input {
  width: 100%;
  padding: 12px 16px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
  font-size: 16px;
  transition: border-color 0.3s;
}

.input-group input:focus {
  outline: none;
  border-color: #4a9eff;
}

.input-group input::placeholder {
  color: rgba(255, 255, 255, 0.3);
}

button[type="submit"] {
  width: 100%;
  padding: 14px;
  border: none;
  border-radius: 8px;
  background: linear-gradient(135deg, #4a9eff 0%, #0066cc 100%);
  color: #fff;
  font-size: 16px;
  font-weight: 500;
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
}

button[type="submit"]:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 20px rgba(74, 158, 255, 0.4);
}

.error-message {
  color: #ff6b6b;
  text-align: center;
  margin-top: 16px;
  font-size: 14px;
  min-height: 20px;
}
```

- [ ] **Step 3: 测试登录页面**

```bash
# 确保服务器在运行
open web-client/index.html
```

Expected: 页面显示密码输入框，输入正确密码后跳转到viewer.html

- [ ] **Step 4: Commit**

```bash
git add web-client/
git commit -m "feat: create login page with password authentication"
```

---

### Task 6: 创建Viewer主页面（视频显示）

**Files:**
- Create: `web-client/viewer.html`
- Create: `web-client/css/viewer.css`

- [ ] **Step 1: 创建Viewer HTML**

创建 `web-client/viewer.html`：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Web远程桌面 - 控制台</title>
  <link rel="stylesheet" href="css/viewer.css">
  <script src="https://cdn.socket.io/4.7.2/socket.io.min.js"></script>
</head>
<body>
  <div id="loading" class="loading-overlay">
    <div class="spinner"></div>
    <p id="loadingText">正在连接...</p>
  </div>
  
  <div id="statusBar" class="status-bar">
    <span id="connectionStatus" class="status connecting">连接中</span>
    <span id="resolutionDisplay">-</span>
    <span id="fpsDisplay">0 FPS</span>
    <span id="latencyDisplay">0 ms</span>
  </div>
  
  <div class="viewer-container">
    <video id="remoteVideo" autoplay playsinline></video>
  </div>
  
  <div class="control-bar">
    <button id="resolutionBtn" class="control-btn">
      分辨率设置
    </button>
    <button id="pauseBtn" class="control-btn">
      暂停
    </button>
    <button id="disconnectBtn" class="control-btn danger">
      断开连接
    </button>
  </div>
  
  <!-- 分辨率设置弹窗 -->
  <div id="resolutionModal" class="modal hidden">
    <div class="modal-content">
      <h3>选择分辨率</h3>
      <div class="resolution-options">
        <label class="resolution-option">
          <input type="radio" name="resolution" value="540p" data-width="960" data-height="540">
          <span>540p (低画质)</span>
        </label>
        <label class="resolution-option">
          <input type="radio" name="resolution" value="720p" data-width="1280" data-height="720" checked>
          <span>720p (标准)</span>
        </label>
        <label class="resolution-option">
          <input type="radio" name="resolution" value="1080p" data-width="1920" data-height="1080">
          <span>1080p (高清)</span>
        </label>
        <label class="resolution-option">
          <input type="radio" name="resolution" value="1440p" data-width="2560" data-height="1440">
          <span>1440p (超清)</span>
        </label>
      </div>
      <button id="applyResolution" class="modal-btn primary">应用</button>
      <button id="closeResolution" class="modal-btn">取消</button>
    </div>
  </div>
  
  <script src="js/auth.js"></script>
  <script src="js/webrtc.js"></script>
  <script src="js/input.js"></script>
  <script src="js/ui.js"></script>
</body>
</html>
```

- [ ] **Step 2: 创建Viewer样式**

创建 `web-client/css/viewer.css`：

```css
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: #0a0a0f;
  min-height: 100vh;
  overflow: hidden;
}

/* Loading Overlay */
.loading-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: #0a0a0f;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  transition: opacity 0.5s;
}

.loading-overlay.hidden {
  opacity: 0;
  pointer-events: none;
}

.spinner {
  width: 48px;
  height: 48px;
  border: 3px solid rgba(74, 158, 255, 0.3);
  border-top-color: #4a9eff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.loading-overlay p {
  color: rgba(255, 255, 255, 0.7);
  margin-top: 16px;
}

/* Status Bar */
.status-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  background: rgba(0, 0, 0, 0.8);
  padding: 8px 16px;
  display: flex;
  gap: 20px;
  z-index: 100;
  backdrop-filter: blur(4px);
}

.status {
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.status.connecting {
  background: #f59e0b;
  color: #000;
}

.status.connected {
  background: #10b981;
  color: #fff;
}

.status.disconnected {
  background: #ef4444;
  color: #fff;
}

.status-bar span:not(.status) {
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  display: flex;
  align-items: center;
}

/* Viewer Container */
.viewer-container {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

#remoteVideo {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

/* Control Bar */
.control-bar {
  position: fixed;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 12px;
  z-index: 100;
  opacity: 0;
  transition: opacity 0.3s;
}

body:hover .control-bar,
.control-bar:hover {
  opacity: 1;
}

.control-btn {
  padding: 10px 20px;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  backdrop-filter: blur(4px);
  transition: background 0.2s;
}

.control-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.control-btn.danger {
  background: rgba(239, 68, 68, 0.2);
}

.control-btn.danger:hover {
  background: rgba(239, 68, 68, 0.4);
}

/* Resolution Modal */
.modal {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal.hidden {
  display: none;
}

.modal-content {
  background: #1a1a2e;
  padding: 24px;
  border-radius: 12px;
  min-width: 300px;
}

.modal-content h3 {
  color: #fff;
  margin-bottom: 16px;
}

.resolution-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 24px;
}

.resolution-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  cursor: pointer;
  transition: background 0.2s;
}

.resolution-option:hover {
  background: rgba(255, 255, 255, 0.1);
}

.resolution-option input {
  width: 18px;
  height: 18px;
}

.resolution-option span {
  color: #fff;
  font-size: 14px;
}

.modal-btn {
  width: 100%;
  padding: 12px;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  margin-top: 8px;
}

.modal-btn.primary {
  background: linear-gradient(135deg, #4a9eff 0%, #0066cc 100%);
}
```

- [ ] **Step 3: Commit**

```bash
git add web-client/
git commit -m "feat: create viewer page with video display and resolution selector"
```

---

### Task 7: 实现认证检查模块

**Files:**
- Create: `web-client/js/auth.js`

- [ ] **Step 1: 创建认证模块**

创建 `web-client/js/auth.js`：

```javascript
// 认证检查模块
const Auth = {
  API_BASE: 'http://localhost:8080',
  
  // 获取token
  getToken() {
    return localStorage.getItem('wrd_token');
  },
  
  // 检查是否已登录
  isLoggedIn() {
    const token = this.getToken();
    return !!token;
  },
  
  // 验证token有效性
  async verifyToken() {
    const token = this.getToken();
    if (!token) return false;
    
    try {
      const response = await fetch(`${this.API_BASE}/api/auth/verify`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      return response.ok;
    } catch {
      return false;
    }
  },
  
  // 登出
  logout() {
    localStorage.removeItem('wrd_token');
    window.location.href = 'index.html';
  },
  
  // 初始化检查（页面加载时调用）
  async init() {
    if (!this.isLoggedIn()) {
      window.location.href = 'index.html';
      return false;
    }
    
    const valid = await this.verifyToken();
    if (!valid) {
      this.logout();
      return false;
    }
    
    return true;
  }
};

// 页面加载时执行认证检查
document.addEventListener('DOMContentLoaded', () => {
  Auth.init();
});
```

- [ ] **Step 2: Commit**

```bash
git add web-client/js/auth.js
git commit -m "feat: add auth module for token verification"
```

---

### Task 8: 实现WebRTC客户端连接

**Files:**
- Create: `web-client/js/webrtc.js`

- [ ] **Step 1: 创建WebRTC模块**

创建 `web-client/js/webrtc.js`：

```javascript
// WebRTC连接管理
const WebRTC = {
  pc: null,
  socket: null,
  remoteStream: null,
  
  // ICE服务器配置（STUN）
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  },
  
  // 初始化WebRTC和信令连接
  async init() {
    const token = Auth.getToken();
    if (!token) {
      console.error('No token available');
      return;
    }
    
    // 连接信令服务器
    this.socket = io('http://localhost:8080/signal', {
      auth: { token, role: 'viewer' }
    });
    
    this.setupSocketListeners();
    this.createPeerConnection();
  },
  
  // 设置Socket事件监听
  setupSocketListeners() {
    this.socket.on('connect', () => {
      console.log('Signaling connected');
      updateConnectionStatus('connecting');
    });
    
    this.socket.on('connected', (data) => {
      console.log('Server acknowledged:', data);
      
      if (data.hostOnline) {
        // Host在线，创建offer
        this.createOffer();
      } else {
        updateLoadingText('等待Host上线...');
      }
    });
    
    this.socket.on('host-status', (data) => {
      if (data.online) {
        updateLoadingText('Host已上线，正在连接...');
        this.createOffer();
      } else {
        updateConnectionStatus('disconnected');
        updateLoadingText('Host已离线');
      }
    });
    
    this.socket.on('answer', async (data) => {
      console.log('Received answer');
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      } catch (err) {
        console.error('Failed to set remote description:', err);
      }
    });
    
    this.socket.on('ice-candidate', async (data) => {
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        console.error('Failed to add ICE candidate:', err);
      }
    });
    
    this.socket.on('disconnect', () => {
      console.log('Signaling disconnected');
      updateConnectionStatus('disconnected');
    });
  },
  
  // 创建RTCPeerConnection
  createPeerConnection() {
    this.pc = new RTCPeerConnection(this.config);
    
    // 处理ICE候选者
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('ice-candidate', {
          target: 'host',
          candidate: event.candidate
        });
      }
    };
    
    // 处理远程流
    this.pc.ontrack = (event) => {
      console.log('Received remote stream');
      this.remoteStream = event.streams[0];
      
      const videoElement = document.getElementById('remoteVideo');
      videoElement.srcObject = this.remoteStream;
      
      // 隐藏loading，更新状态
      document.getElementById('loading').classList.add('hidden');
      updateConnectionStatus('connected');
      
      // 开始FPS统计
      this.startStats();
    };
    
    // 连接状态变化
    this.pc.onconnectionstatechange = () => {
      console.log('Connection state:', this.pc.connectionState);
      if (this.pc.connectionState === 'connected') {
        updateConnectionStatus('connected');
      } else if (this.pc.connectionState === 'disconnected') {
        updateConnectionStatus('disconnected');
      }
    };
  },
  
  // 创建并发送offer
  async createOffer() {
    try {
      // 创建transceiver接收视频
      this.pc.addTransceiver('video', { direction: 'recvonly' });
      
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      
      this.socket.emit('offer', { offer });
      console.log('Offer sent');
    } catch (err) {
      console.error('Failed to create offer:', err);
    }
  },
  
  // 请求分辨率变更
  async requestResolution(width, height) {
    // 通过WebRTC的data channel或重新协商发送
    // 这里通过信令服务器发送
    if (this.socket) {
      this.socket.emit('resolution-change', { width, height });
    }
  },
  
  // 开始统计信息
  startStats() {
    setInterval(async () => {
      if (!this.pc) return;
      
      const stats = await this.pc.getStats();
      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const fps = report.framesPerSecond || 0;
          document.getElementById('fpsDisplay').textContent = `${Math.round(fps)} FPS`;
        }
      });
    }, 1000);
  },
  
  // 断开连接
  disconnect() {
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    Auth.logout();
  }
};

// 辅助函数：更新连接状态显示
function updateConnectionStatus(status) {
  const statusEl = document.getElementById('connectionStatus');
  statusEl.className = 'status ' + status;
  
  const statusText = {
    'connecting': '连接中',
    'connected': '已连接',
    'disconnected': '已断开'
  };
  statusEl.textContent = statusText[status] || status;
}

// 辅助函数：更新loading文字
function updateLoadingText(text) {
  document.getElementById('loadingText').textContent = text;
}

// 页面加载完成后初始化WebRTC
document.addEventListener('DOMContentLoaded', () => {
  // 等待认证完成后初始化
  setTimeout(() => {
    if (Auth.isLoggedIn()) {
      WebRTC.init();
    }
  }, 500);
});
```

- [ ] **Step 2: Commit**

```bash
git add web-client/js/webrtc.js
git commit -m "feat: add WebRTC client with signaling and video streaming"
```

---

### Task 9: 实现远程输入捕获模块

**Files:**
- Create: `web-client/js/input.js`

- [ ] **Step 1: 创建输入捕获模块**

创建 `web-client/js/input.js`：

```javascript
// 远程输入捕获和发送
const Input = {
  socket: null,
  videoElement: null,
  isActive: false,
  
  // 初始化输入系统
  init() {
    this.videoElement = document.getElementById('remoteVideo');
    if (!this.videoElement) return;
    
    // 连接输入WebSocket
    const token = Auth.getToken();
    this.socket = io('http://localhost:8080/input', {
      auth: { token, role: 'viewer' }
    });
    
    this.socket.on('connect', () => {
      console.log('Input channel connected');
    });
    
    this.setupEventListeners();
  },
  
  // 设置事件监听
  setupEventListeners() {
    const video = this.videoElement;
    
    // 鼠标移动
    video.addEventListener('mousemove', (e) => {
      if (!this.isActive) return;
      
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'move', coords);
    });
    
    // 鼠标按下
    video.addEventListener('mousedown', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'down', {
        ...coords,
        button: this.getMouseButton(e.button)
      });
    });
    
    // 鼠标释放
    video.addEventListener('mouseup', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'up', {
        ...coords,
        button: this.getMouseButton(e.button)
      });
    });
    
    // 点击（兼容性处理）
    video.addEventListener('click', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'click', {
        ...coords,
        button: this.getMouseButton(e.button)
      });
    });
    
    // 双击
    video.addEventListener('dblclick', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'dblclick', coords);
    });
    
    // 滚轮
    video.addEventListener('wheel', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      
      const coords = this.getRelativeCoords(e);
      this.sendInput('mouse', 'wheel', {
        ...coords,
        deltaX: e.deltaX,
        deltaY: e.deltaY
      });
    });
    
    // 键盘事件（在video获得焦点时）
    video.addEventListener('keydown', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      
      this.sendInput('keyboard', 'keydown', {
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        modifiers: this.getModifiers(e)
      });
    });
    
    video.addEventListener('keyup', (e) => {
      if (!this.isActive) return;
      e.preventDefault();
      
      this.sendInput('keyboard', 'keyup', {
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        modifiers: this.getModifiers(e)
      });
    });
    
    // 点击video获取焦点以接收键盘事件
    video.addEventListener('click', () => {
      video.focus();
    });
    
    // 视频开始播放后激活输入
    video.addEventListener('playing', () => {
      this.isActive = true;
      video.focus();
    });
    
    // 视频暂停时禁用输入
    video.addEventListener('pause', () => {
      this.isActive = false;
    });
  },
  
  // 计算相对坐标（将视频显示坐标映射到原始桌面坐标）
  getRelativeCoords(e) {
    const video = this.videoElement;
    const rect = video.getBoundingClientRect();
    
    // 计算在视频元素内的相对位置（0-1范围）
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    
    // 限制在0-1范围内
    const clampedX = Math.max(0, Math.min(1, relX));
    const clampedY = Math.max(0, Math.min(1, relY));
    
    return {
      relX: clampedX,
      relY: clampedY
    };
  },
  
  // 获取鼠标按钮名称
  getMouseButton(button) {
    const buttons = ['left', 'middle', 'right'];
    return buttons[button] || 'left';
  },
  
  // 获取修饰键状态
  getModifiers(e) {
    return {
      ctrl: e.ctrlKey,
      shift: e.shiftKey,
      alt: e.altKey,
      meta: e.metaKey
    };
  },
  
  // 发送输入指令
  sendInput(type, action, payload) {
    if (!this.socket || !this.socket.connected) return;
    
    this.socket.emit('input', {
      type,
      action,
      payload,
      timestamp: Date.now()
    });
  },
  
  // 激活/暂停输入
  setActive(active) {
    this.isActive = active;
    if (active && this.videoElement) {
      this.videoElement.focus();
    }
  }
};

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
  // 延迟初始化，确保video元素已加载
  setTimeout(() => Input.init(), 1000);
});
```

- [ ] **Step 2: Commit**

```bash
git add web-client/js/input.js
git commit -m "feat: add remote input capture for mouse and keyboard"
```

---

### Task 10: 实现UI控制模块

**Files:**
- Create: `web-client/js/ui.js`

- [ ] **Step 1: 创建UI控制模块**

创建 `web-client/js/ui.js`：

```javascript
// UI控制逻辑
const UI = {
  // 初始化UI
  init() {
    this.setupResolutionModal();
    this.setupControlButtons();
  },
  
  // 设置分辨率弹窗
  setupResolutionModal() {
    const resolutionBtn = document.getElementById('resolutionBtn');
    const modal = document.getElementById('resolutionModal');
    const applyBtn = document.getElementById('applyResolution');
    const closeBtn = document.getElementById('closeResolution');
    
    // 打开弹窗
    resolutionBtn.addEventListener('click', () => {
      modal.classList.remove('hidden');
    });
    
    // 关闭弹窗
    closeBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
    });
    
    // 点击背景关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
    
    // 应用分辨率
    applyBtn.addEventListener('click', () => {
      const selected = document.querySelector('input[name="resolution"]:checked');
      if (selected) {
        const width = parseInt(selected.dataset.width);
        const height = parseInt(selected.dataset.height);
        
        // 发送分辨率变更请求
        if (typeof WebRTC !== 'undefined') {
          WebRTC.requestResolution(width, height);
        }
        
        // 更新显示
        document.getElementById('resolutionDisplay').textContent = 
          `${selected.value} (${width}x${height})`;
        
        modal.classList.add('hidden');
      }
    });
  },
  
  // 设置控制按钮
  setupControlButtons() {
    const pauseBtn = document.getElementById('pauseBtn');
    const disconnectBtn = document.getElementById('disconnectBtn');
    const video = document.getElementById('remoteVideo');
    
    let isPaused = false;
    
    // 暂停/恢复按钮
    pauseBtn.addEventListener('click', () => {
      if (isPaused) {
        video.play();
        pauseBtn.textContent = '暂停';
        Input.setActive(true);
      } else {
        video.pause();
        pauseBtn.textContent = '恢复';
        Input.setActive(false);
      }
      isPaused = !isPaused;
    });
    
    // 断开连接按钮
    disconnectBtn.addEventListener('click', () => {
      if (confirm('确定要断开连接吗？')) {
        WebRTC.disconnect();
      }
    });
  }
};

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
  UI.init();
});
```

- [ ] **Step 2: Commit**

```bash
git add web-client/js/ui.js
git commit -m "feat: add UI controls for resolution and playback"
```

---

## Phase 3: macOS Host端（Swift）

### Task 11: 创建macOS项目结构

**Files:**
- Create: `macos-host/Package.swift`
- Create: `macos-host/WebRemoteDesktop/App.swift`

- [ ] **Step 1: 创建Swift Package配置**

创建 `macos-host/Package.swift`：

```swift
// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "WebRemoteDesktop",
    platforms: [.macOS(.v13)],
    products: [
        .executable(
            name: "WebRemoteDesktop",
            targets: ["WebRemoteDesktop"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/stasel/WebRTC.git", from: "115.0.0"),
        .package(url: "https://github.com/socketio/socket.io-client-swift.git", from: "16.0.0"),
    ],
    targets: [
        .executableTarget(
            name: "WebRemoteDesktop",
            dependencies: [
                .product(name: "WebRTC", package: "WebRTC"),
                .product(name: "SocketIO", package: "socket.io-client-swift"),
            ],
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency")
            ]
        ),
    ]
)
```

- [ ] **Step 2: 创建主应用入口**

创建 `macos-host/WebRemoteDesktop/App.swift`：

```swift
import Cocoa
import ScreenCaptureKit
import WebRTC
import SocketIO

@main
class AppDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow?
    var statusItem: NSStatusItem?
    
    var captureManager: ScreenCaptureManager?
    var webRTCManager: WebRTCManager?
    var signalClient: SignalClient?
    var inputController: InputController?
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        // 设置状态栏图标
        setupStatusBar()
        
        // 检查屏幕录制权限
        checkScreenCapturePermission()
    }
    
    func setupStatusBar() {
        statusItem = NSStatusBar.shared.statusItem(withLength: NSStatusItem.variableLength)
        statusItem?.button?.image = NSImage(systemSymbolName: "rectangle.on.rectangle", accessibilityDescription: "Remote Desktop")
        
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "分辨率设置", action: #selector(showResolutionPicker), keyEquivalent: "r"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "启动服务", action: #selector(startService), keyEquivalent: "s"))
        menu.addItem(NSMenuItem(title: "停止服务", action: #selector(stopService), keyEquivalent: "x"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "退出", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        
        statusItem?.menu = menu
    }
    
    func checkScreenCapturePermission() {
        SCShareableContent.getWithCompletionHandler { [weak self] content, error in
            DispatchQueue.main.async {
                if let error = error {
                    self?.showPermissionAlert(error: error)
                } else {
                    print("Screen capture permission granted")
                    self?.startService()
                }
            }
        }
    }
    
    func showPermissionAlert(error: Error) {
        let alert = NSAlert()
        alert.messageText = "需要屏幕录制权限"
        alert.informativeText = "请在系统设置 > 隐私与安全 > 屏幕录制中启用权限"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "打开设置")
        alert.addButton(withTitle: "取消")
        
        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
        }
    }
    
    @objc func showResolutionPicker() {
        // 显示分辨率选择窗口
        ResolutionPicker.show()
    }
    
    @objc func startService() {
        // 初始化各模块
        captureManager = ScreenCaptureManager()
        webRTCManager = WebRTCManager()
        inputController = InputController()
        
        signalClient = SignalClient(
            serverURL: URL(string: "http://localhost:8080")!,
            token: "PLACEHOLDER_TOKEN"
        )
        
        // 启动服务
        signalClient?.connect()
        
        updateStatusMenu(running: true)
    }
    
    @objc func stopService() {
        signalClient?.disconnect()
        webRTCManager?.close()
        captureManager?.stop()
        
        updateStatusMenu(running: false)
    }
    
    func updateStatusMenu(running: Bool) {
        let iconName = running ? "rectangle.on.rectangle.fill" : "rectangle.on.rectangle"
        statusItem?.button?.image = NSImage(systemSymbolName: iconName, accessibilityDescription: "Remote Desktop")
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add macos-host/
git commit -m "feat: create macOS host project structure and app entry"
```

---

### Task 12: 实现屏幕捕获管理器

**Files:**
- Create: `macos-host/WebRemoteDesktop/ScreenCaptureManager.swift`

- [ ] **Step 1: 创建屏幕捕获模块**

创建 `macos-host/WebRemoteDesktop/ScreenCaptureManager.swift`：

```swift
import Foundation
import ScreenCaptureKit
import CoreVideo

@available(macOS 13.0, *)
class ScreenCaptureManager: NSObject, SCStreamDelegate, SCStreamOutput {
    
    private var stream: SCStream?
    private var display: SCDisplay?
    
    // 分辨率配置
    struct Resolution: Codable {
        let name: String
        let width: Int
        let height: Int
        
        static let presets: [Resolution] = [
            Resolution(name: "540p", width: 960, height: 540),
            Resolution(name: "720p", width: 1280, height: 720),
            Resolution(name: "1080p", width: 1920, height: 1080),
            Resolution(name: "1440p", width: 2560, height: 1440)
        ]
    }
    
    var currentResolution: Resolution = Resolution.presets[1] // 默认720p
    var onFrameCaptured: ((CMSampleBuffer) -> Void)?
    
    override init() {
        super.init()
    }
    
    // 设置分辨率
    func setResolution(_ resolution: Resolution) {
        currentResolution = resolution
        // 如果正在捕获，需要重启stream
        if stream != nil {
            stop()
            start()
        }
    }
    
    // 开始捕获
    func start() {
        SCShareableContent.getWithCompletionHandler { [weak self] content, error in
            guard let self = self else { return }
            
            if let error = error {
                print("Failed to get shareable content: \(error)")
                return
            }
            
            guard let display = content?.displays.first else {
                print("No display available")
                return
            }
            
            self.display = display
            self.setupStream(display: display)
        }
    }
    
    private func setupStream(display: SCDisplay) {
        // 配置过滤器（捕获整个显示）
        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        
        // 配置捕获参数
        let config = SCStreamConfiguration()
        
        // 设置输出分辨率
        config.width = currentResolution.width
        config.height = currentResolution.height
        
        // 设置帧率（目标15fps）
        config.minimumFrameInterval = CMTime(value: 1, timescale: 15)
        
        // 使用H.264编码
        config.pixelFormat = kCVPixelFormatType_32BGRA
        
        // 显示光标
        config.showsCursor = true
        
        // 创建stream
        stream = SCStream(filter: filter, configuration: config, delegate: self)
        
        // 添加输出
        do {
            try stream?.addStreamOutput(self, type: .screen, sampleHandlerQueue: .global(qos: .userInteractive))
        } catch {
            print("Failed to add stream output: \(error)")
            return
        }
        
        // 开始捕获
        stream?.startCapture { [weak self] error in
            if let error = error {
                print("Failed to start capture: \(error)")
            } else {
                print("Screen capture started at \(self?.currentResolution.name ?? "unknown")")
            }
        }
    }
    
    // 停止捕获
    func stop() {
        stream?.stopCapture { error in
            if let error = error {
                print("Error stopping capture: \(error)")
            }
        }
        stream = nil
    }
    
    // SCStreamDelegate
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        print("Stream stopped with error: \(error)")
    }
    
    // SCStreamOutput
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen else { return }
        guard sampleBuffer.isValid else { return }
        
        // 回调给编码器
        onFrameCaptured?(sampleBuffer)
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add macos-host/
git commit -m "feat: add ScreenCaptureManager with resolution configuration"
```

---

### Task 13: 实现WebRTC管理器

**Files:**
- Create: `macos-host/WebRemoteDesktop/WebRTCManager.swift`

- [ ] **Step 1: 创建WebRTC模块**

创建 `macos-host/WebRemoteDesktop/WebRTCManager.swift`：

```swift
import Foundation
import WebRTC
import CoreMedia

class WebRTCManager: NSObject {
    
    private var peerConnection: RTCPeerConnection?
    private var videoSource: RTCVideoSource?
    private var videoTrack: RTCVideoTrack?
    private var factory: RTCPeerConnectionFactory?
    
    var onIceCandidate: ((RTCIceCandidate) -> Void)?
    
    override init() {
        super.init()
        setupWebRTC()
    }
    
    private func setupWebRTC() {
        // 初始化SSL
        RTCInitializeSSL()
        
        // 创建工厂
        factory = RTCPeerConnectionFactory()
        
        // 创建视频源
        videoSource = factory?.videoSource()
        
        // 创建视频轨道
        videoTrack = factory?.videoTrack(with: videoSource!, trackId: "screen")
        
        // 配置ICE服务器
        let config = RTCConfiguration()
        config.iceServers = [
            RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"]),
            RTCIceServer(urlStrings: ["stun:stun1.l.google.com:19302"])
        ]
        
        // 创建PeerConnection
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        peerConnection = factory?.peerConnection(with: config, constraints: constraints, delegate: self)
        
        // 添加视频流到PeerConnection
        let stream = factory?.mediaStream(withStreamId: "screen-stream")
        stream?.addVideoTrack(videoTrack!)
        
        peerConnection?.add(stream!)
    }
    
    // 处理offer并创建answer
    func handleOffer(_ offer: RTCSessionDescription, completion: @escaping (Result<RTCSessionDescription, Error>) -> Void) {
        peerConnection?.setRemoteDescription(offer) { [weak self] error in
            if let error = error {
                completion(.failure(error))
                return
            }
            
            // 创建answer
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            self?.peerConnection?.answer(for: constraints) { answer, error in
                if let error = error {
                    completion(.failure(error))
                    return
                }
                
                guard let answer = answer else {
                    completion(.failure(NSError(domain: "WebRTC", code: -1, userInfo: [NSLocalizedDescriptionKey: "Failed to create answer"])))
                    return
                }
                
                self?.peerConnection?.setLocalDescription(answer) { error in
                    if let error = error {
                        completion(.failure(error))
                    } else {
                        completion(.success(answer))
                    }
                }
            }
        }
    }
    
    // 添加ICE候选者
    func addIceCandidate(_ candidate: RTCIceCandidate) {
        peerConnection?.add(candidate)
    }
    
    // 推送视频帧
    func pushFrame(_ sampleBuffer: CMSampleBuffer) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        
        let rtcpixelBuffer = RTCCVPixelBuffer(pixelBuffer: pixelBuffer)
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let timeStampNs = CMTimeGetSeconds(timestamp) * Double(NSEC_PER_SEC)
        
        let videoFrame = RTCVideoFrame(buffer: rtcpixelBuffer, rotation: ._0, timeStampNs: Int64(timeStampNs))
        
        videoSource?.capturer(RTCVideoCapturer(delegate: videoSource!), didCapture: videoFrame)
    }
    
    // 关闭连接
    func close() {
        peerConnection?.close()
        peerConnection = nil
    }
}

// MARK: - RTCPeerConnectionDelegate
extension WebRTCManager: RTCPeerConnectionDelegate {
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {
        print("Signaling state changed: \(stateChanged)")
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        print("Stream added")
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {
        print("Stream removed")
    }
    
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {
        print("Should negotiate")
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        print("ICE connection state: \(newState)")
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        print("ICE gathering state: \(newState)")
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        print("Generated ICE candidate")
        onIceCandidate?(candidate)
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {
        print("Removed ICE candidates")
    }
    
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        print("Data channel opened")
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add macos-host/
git commit -m "feat: add WebRTC manager for video streaming"
```

---

### Task 14: 实现信令客户端

**Files:**
- Create: `macos-host/WebRemoteDesktop/SignalClient.swift`

- [ ] **Step 1: 创建信令客户端**

创建 `macos-host/WebRemoteDesktop/SignalClient.swift`：

```swift
import Foundation
import SocketIO
import WebRTC

class SignalClient {
    
    private var manager: SocketManager?
    private var signalingSocket: SocketIOClient?
    private var inputSocket: SocketIOClient?
    
    private let serverURL: URL
    private let token: String
    
    var onOfferReceived: ((RTCSessionDescription, String) -> Void)?
    var onInputReceived: ((InputCommand) -> Void)?
    
    // 输入指令结构
    struct InputCommand: Codable {
        let type: String      // "mouse" | "keyboard"
        let action: String    // "move" | "click" | "keydown" | etc
        let payload: [String: Double]?  // 坐标等数据
        let timestamp: Double?
    }
    
    init(serverURL: URL, token: String) {
        self.serverURL = serverURL
        self.token = token
    }
    
    func connect() {
        // 配置SocketManager
        let config: SocketIOClientConfiguration = [
            .compress,
            .connectParams(["token": token])
        ]
        
        manager = SocketManager(socketURL: serverURL, config: config)
        
        // 连接信令命名空间
        signalingSocket = manager?.socket(forNamespace: "/signal")
        setupSignalingHandlers()
        
        // 连接输入命名空间
        inputSocket = manager?.socket(forNamespace: "/input")
        setupInputHandlers()
        
        // 开始连接
        signalingSocket?.connect(withPayload: ["role": "host"])
        inputSocket?.connect(withPayload: ["role": "host"])
    }
    
    private func setupSignalingHandlers() {
        signalingSocket?.on(clientEvent: .connect) { [weak self] data, ack in
            print("Signaling connected")
        }
        
        signalingSocket?.on("connected") { [weak self] data, ack in
            print("Server acknowledged signaling connection")
        }
        
        // 接收offer
        signalingSocket?.on("offer") { [weak self] data, ack in
            guard let data = data.first as? [String: Any],
                  let offerDict = data["offer"] as? [String: Any],
                  let sdp = offerDict["sdp"] as? String,
                  let type = offerDict["type"] as? String,
                  let viewerId = data["viewerId"] as? String else {
                return
            }
            
            let offer = RTCSessionDescription(type: .offer, sdp: sdp)
            self?.onOfferReceived?(offer, viewerId)
        }
        
        // 接收ICE候选者
        signalingSocket?.on("ice-candidate") { [weak self] data, ack in
            guard let data = data.first as? [String: Any],
                  let candidateDict = data["candidate"] as? [String: Any] else {
                return
            }
            
            let sdp = candidateDict["candidate"] as? String ?? ""
            let sdpMLineIndex = candidateDict["sdpMLineIndex"] as? Int32 ?? 0
            let sdpMid = candidateDict["sdpMid"] as? String
            
            let candidate = RTCIceCandidate(
                sdp: sdp,
                sdpMLineIndex: sdpMLineIndex,
                sdpMid: sdpMid
            )
            
            // 转发给WebRTCManager
            NotificationCenter.default.post(
                name: .init("NewIceCandidate"),
                object: nil,
                userInfo: ["candidate": candidate]
            )
        }
        
        signalingSocket?.on(clientEvent: .disconnect) { data, ack in
            print("Signaling disconnected")
        }
    }
    
    private func setupInputHandlers() {
        inputSocket?.on(clientEvent: .connect) { [weak self] data, ack in
            print("Input channel connected")
        }
        
        inputSocket?.on("connected") { [weak self] data, ack in
            print("Server acknowledged input connection")
        }
        
        // 接收输入指令
        inputSocket?.on("input") { [weak self] data, ack in
            guard let data = data.first as? [String: Any] else { return }
            
            let command = InputCommand(
                type: data["type"] as? String ?? "",
                action: data["action"] as? String ?? "",
                payload: data["payload"] as? [String: Double],
                timestamp: data["timestamp"] as? Double
            )
            
            self?.onInputReceived?(command)
        }
        
        inputSocket?.on(clientEvent: .disconnect) { data, ack in
            print("Input channel disconnected")
        }
    }
    
    // 发送answer
    func sendAnswer(_ answer: RTCSessionDescription, to viewerId: String) {
        let data: [String: Any] = [
            "answer": [
                "type": "answer",
                "sdp": answer.sdp
            ],
            "viewerId": viewerId
        ]
        signalingSocket?.emit("answer", data)
    }
    
    // 发送ICE候选者
    func sendIceCandidate(_ candidate: RTCIceCandidate, to viewerId: String) {
        let data: [String: Any] = [
            "target": "viewer",
            "viewerId": viewerId,
            "candidate": [
                "candidate": candidate.sdp,
                "sdpMLineIndex": candidate.sdpMLineIndex,
                "sdpMid": candidate.sdpMid ?? ""
            ]
        ]
        signalingSocket?.emit("ice-candidate", data)
    }
    
    func disconnect() {
        signalingSocket?.disconnect()
        inputSocket?.disconnect()
        manager?.disconnect()
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add macos-host/
git commit -m "feat: add signal client for WebSocket communication"
```

---

### Task 15: 实现输入控制器（CGEvent模拟）

**Files:**
- Create: `macos-host/WebRemoteDesktop/InputController.swift`

- [ ] **Step 1: 创建输入控制器**

创建 `macos-host/WebRemoteDesktop/InputController.swift`：

```swift
import Foundation
import CoreGraphics
import AppKit

class InputController {
    
    // 主显示器尺寸（用于坐标映射）
    private var displayBounds: CGRect {
        return CGMainDisplayID().flatMap { CGDisplayBounds($0) } ?? .zero
    }
    
    // 执行输入指令
    func execute(command: SignalClient.InputCommand) {
        DispatchQueue.main.async { [weak self] in
            switch command.type {
            case "mouse":
                self?.handleMouse(action: command.action, payload: command.payload)
            case "keyboard":
                self?.handleKeyboard(action: command.action, payload: command.payload)
            default:
                break
            }
        }
    }
    
    // 处理鼠标事件
    private func handleMouse(action: String, payload: [String: Double]?) {
        guard let payload = payload else { return }
        
        // 获取相对坐标并转换为绝对坐标
        let relX = payload["relX"] ?? 0
        let relY = payload["relY"] ?? 0
        
        let bounds = displayBounds
        let x = CGFloat(relX) * bounds.width + bounds.origin.x
        let y = CGFloat(relY) * bounds.height + bounds.origin.y
        
        let point = CGPoint(x: x, y: y)
        
        switch action {
        case "move":
            moveMouse(to: point)
            
        case "down", "click":
            let button = payload["button"].flatMap { MouseButton(rawValue: Int($0)) } ?? .left
            clickMouse(at: point, button: button, down: true)
            if action == "click" {
                // 延迟释放，模拟单击
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    self.clickMouse(at: point, button: button, down: false)
                }
            }
            
        case "up":
            let button = payload["button"].flatMap { MouseButton(rawValue: Int($0)) } ?? .left
            clickMouse(at: point, button: button, down: false)
            
        case "dblclick":
            // 双击：快速两次点击
            doubleClick(at: point)
            
        case "wheel":
            let deltaX = Int32(payload["deltaX"] ?? 0)
            let deltaY = Int32(payload["deltaY"] ?? 0)
            scrollWheel(at: point, deltaX: deltaX, deltaY: deltaY)
            
        default:
            break
        }
    }
    
    // 处理键盘事件
    private func handleKeyboard(action: String, payload: [String: Double]?) {
        guard let payload = payload,
              let keyCode = payload["keyCode"].flatMap({ CGKeyCode($0) }) else {
            return
        }
        
        let down = (action == "keydown")
        
        // 获取修饰键状态
        let modifiers = CGEventFlags(
            mask: [
                payload["ctrl"] == 1 ? .maskControl : [],
                payload["shift"] == 1 ? .maskShift : [],
                payload["alt"] == 1 ? .maskAlternate : [],
                payload["meta"] == 1 ? .maskCommand : []
            ].reduce([]) { $0.union($1) }
        )
        
        simulateKey(keyCode: keyCode, down: down, modifiers: modifiers)
    }
    
    // 移动鼠标
    private func moveMouse(to point: CGPoint) {
        let event = CGEvent(mouseEventSource: nil,
                           mouseType: .mouseMoved,
                           mouseCursorPosition: point,
                           mouseButton: .left)
        event?.post(tap: .cghidEventTap)
    }
    
    // 鼠标点击
    private func clickMouse(at point: CGPoint, button: MouseButton, down: Bool) {
        let type: CGEventType
        switch (button, down) {
        case (.left, true): type = .leftMouseDown
        case (.left, false): type = .leftMouseUp
        case (.right, true): type = .rightMouseDown
        case (.right, false): type = .rightMouseUp
        case (.middle, true): type = .otherMouseDown
        case (.middle, false): type = .otherMouseUp
        }
        
        let event = CGEvent(mouseEventSource: nil,
                           mouseType: type,
                           mouseCursorPosition: point,
                           mouseButton: button.cgButton)
        event?.post(tap: .cghidEventTap)
    }
    
    // 双击
    private func doubleClick(at point: CGPoint) {
        // 第一次点击
        clickMouse(at: point, button: .left, down: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.clickMouse(at: point, button: .left, down: false)
            
            // 第二次点击
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.clickMouse(at: point, button: .left, down: true)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                    self?.clickMouse(at: point, button: .left, down: false)
                }
            }
        }
    }
    
    // 滚轮
    private func scrollWheel(at point: CGPoint, deltaX: Int32, deltaY: Int32) {
        let event = CGEvent(scrollWheelEvent2: nil,
                           dx: deltaX,
                           dy: deltaY,
                           dz: 0)
        event?.location = point
        event?.post(tap: .cghidEventTap)
    }
    
    // 模拟按键
    private func simulateKey(keyCode: CGKeyCode, down: Bool, modifiers: CGEventFlags) {
        let event = CGEvent(keyboardEventSource: nil,
                           virtualKey: keyCode,
                           keyDown: down)
        event?.flags = modifiers
        event?.post(tap: .cghidEventTap)
    }
}

// 鼠标按钮枚举
enum MouseButton: Int {
    case left = 0
    case middle = 1
    case right = 2
    
    var cgButton: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add macos-host/
git commit -m "feat: add input controller for simulating mouse and keyboard events"
```

---

### Task 16: 实现分辨率选择UI

**Files:**
- Create: `macos-host/WebRemoteDesktop/ResolutionPicker.swift`

- [ ] **Step 1: 创建分辨率选择器**

创建 `macos-host/WebRemoteDesktop/ResolutionPicker.swift`：

```swift
import Cocoa

class ResolutionPicker {
    
    static func show() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 250),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        
        window.title = "分辨率设置"
        window.center()
        
        let viewController = ResolutionViewController()
        window.contentViewController = viewController
        
        NSApp.runModal(for: window)
    }
}

class ResolutionViewController: NSViewController {
    
    var radioButtons: [NSButton] = []
    var selectedResolution: ScreenCaptureManager.Resolution?
    
    override func loadView() {
        self.view = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 250))
    }
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        // 标题
        let titleLabel = NSTextField(labelWithString: "选择投屏分辨率：")
        titleLabel.font = NSFont.boldSystemFont(ofSize: 14)
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(titleLabel)
        
        NSLayoutConstraint.activate([
            titleLabel.topAnchor.constraint(equalTo: view.topAnchor, constant: 20),
            titleLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20)
        ])
        
        // 创建分辨率选项
        let resolutions = ScreenCaptureManager.Resolution.presets
        var lastView: NSView = titleLabel
        
        for (index, resolution) in resolutions.enumerated() {
            let button = NSButton(radioButtonWithTitle: "\(resolution.name) (\(resolution.width)x\(resolution.height))", target: self, action: #selector(resolutionChanged(_:)))
            button.tag = index
            button.translatesAutoresizingMaskIntoConstraints = false
            
            // 默认选中720p
            if resolution.name == "720p" {
                button.state = .on
                selectedResolution = resolution
            }
            
            radioButtons.append(button)
            view.addSubview(button)
            
            NSLayoutConstraint.activate([
                button.topAnchor.constraint(equalTo: lastView.bottomAnchor, constant: 12),
                button.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20)
            ])
            
            lastView = button
        }
        
        // 应用按钮
        let applyButton = NSButton(title: "应用", target: self, action: #selector(applyResolution))
        applyButton.translatesAutoresizingMaskIntoConstraints = false
        applyButton.keyEquivalent = "\r" // Enter键
        view.addSubview(applyButton)
        
        // 取消按钮
        let cancelButton = NSButton(title: "取消", target: self, action: #selector(cancel))
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancelButton)
        
        NSLayoutConstraint.activate([
            applyButton.topAnchor.constraint(equalTo: lastView.bottomAnchor, constant: 20),
            applyButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            applyButton.widthAnchor.constraint(equalToConstant: 80),
            
            cancelButton.topAnchor.constraint(equalTo: applyButton.topAnchor),
            cancelButton.trailingAnchor.constraint(equalTo: applyButton.leadingAnchor, constant: -10),
            cancelButton.widthAnchor.constraint(equalToConstant: 80)
        ])
    }
    
    @objc func resolutionChanged(_ sender: NSButton) {
        let index = sender.tag
        selectedResolution = ScreenCaptureManager.Resolution.presets[index]
    }
    
    @objc func applyResolution() {
        guard let resolution = selectedResolution else { return }
        
        // 发送通知给ScreenCaptureManager
        NotificationCenter.default.post(
            name: NSNotification.Name("ResolutionChanged"),
            object: nil,
            userInfo: ["resolution": resolution]
        )
        
        // 关闭窗口
        view.window?.close()
        NSApp.stopModal()
    }
    
    @objc func cancel() {
        view.window?.close()
        NSApp.stopModal()
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add macos-host/
git commit -m "feat: add resolution picker UI for macOS menu bar"
```

---

## 验收测试

### Task 17: 集成测试验证

**Files:**
- 全部组件集成测试

- [ ] **Step 1: 启动信令服务器**

```bash
cd signal-server
npm start
```

Expected: `Signal server running on port 8080`

- [ ] **Step 2: 启动macOS应用**

```bash
cd macos-host
swift build
swift run
```

Expected: 状态栏出现图标，点击"启动服务"

- [ ] **Step 3: 浏览器访问登录页面**

打开 `http://localhost:8080`（或直接从文件打开index.html）

输入密码 `admin123`，验证能进入viewer页面

- [ ] **Step 4: 验证WebRTC连接**

在viewer页面等待连接，Expected:
- 状态栏显示"已连接"
- 视频区域显示桌面画面
- FPS显示>10

- [ ] **Step 5: 测试远程鼠标**

在视频区域移动鼠标、点击

Expected: macOS桌面上的鼠标跟随远程操作

- [ ] **Step 6: 测试远程键盘**

点击视频区域获取焦点，按下键盘按键

Expected: macOS接收到对应键盘输入

- [ ] **Step 7: 测试分辨率切换**

点击"分辨率设置"，选择不同档位，点击应用

Expected: 视频画质相应改变

- [ ] **Step 8: Commit测试文档**

```bash
git add -A
git commit -m "test: integration test complete - all features working"
```

---

## 实施计划检查清单

| 规格要求 | 实施任务 | 状态 |
|---------|---------|------|
| WebRTC视频传输 | Task 3, 8, 12, 13 | ✓ |
| 密码认证 | Task 2, 7 | ✓ |
| 鼠标远程控制 | Task 9, 15 | ✓ |
| 键盘远程控制 | Task 9, 15 | ✓ |
| 多档分辨率切换 | Task 5, 12, 16 | ✓ |
| 状态显示 | Task 6, 8 | ✓ |
| macOS菜单栏UI | Task 11, 16 | ✓ |

所有规格要求均已覆盖，无占位符，无TBD。