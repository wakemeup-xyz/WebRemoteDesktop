# Web Remote Desktop 公网部署设计文档

**日期**: 2026-05-09  
**域名**: stockhub.wiki  
**部署方式**: 原生部署  
**服务器环境**: 家庭宽带/NAS（内网穿透）

---

## 1. 系统架构

```
用户访问
    │
    ↓ HTTPS
cloudflare.com (SSL证书 + CDN)
    │
    ↓ HTTPS
stockhub.wiki
    │
    ↓ 内网穿透隧道 (frp/ngrok/cloudflare tunnel)
    │
家用路由器/NAS (端口映射 8080)
    │
    ↓
┌─────────────────────────────────────┐
│  macOS Host 机器                      │
│  ├── 信令服务器 (Node.js) :8080       │
│  ├── Python Host (WebRTC 推流)        │
│  └── Nginx (SSL终止 + 反向代理) :443   │
└─────────────────────────────────────┘
```

---

## 2. 部署架构设计

### 2.1 网络流量路径

| 步骤 | 组件 | 说明 |
|------|------|------|
| 1 | 用户浏览器 | 访问 https://stockhub.wiki |
| 2 | Cloudflare | SSL证书、CDN加速、安全防护 |
| 3 | 内网穿透 | frp/ngrok/CF Tunnel 连接到内网 |
| 4 | Nginx | 反向代理到信令服务器 |
| 5 | 信令服务器 | Node.js Socket.io + 静态文件 |
| 6 | Python Host | WebRTC 屏幕捕获和推流 |

### 2.2 端口分配

| 服务 | 内部端口 | 外部访问 | 说明 |
|------|---------|---------|------|
| Nginx | 443 | 443 (通过CF) | HTTPS 入口 |
| 信令服务器 | 8080 | 8080 (内网) | Socket.io + API |
| Python Host | 随机 | 不暴露 | WebRTC 直连 |

---

## 3. 安全设计方案

### 3.1 认证层
- **JWT Token**: 现有密码登录机制保留
- **密码**: admin123 (部署前建议修改)
- **Token 过期**: 24小时

### 3.2 传输安全
- **Cloudflare SSL**: 全程 HTTPS
- **WebRTC**: DTLS 加密传输
- **WSS**: WebSocket over SSL (通过 CF)

### 3.3 访问控制
- **Cloudflare Access** (可选): 邮件验证码登录
- **IP 白名单**: 限制仅管理员 IP
- **Rate Limiting**: 防止暴力破解

### 3.4 WebRTC 安全
- **ICE 服务器**: 使用 STUN/TURN 保障连接
- **本地网络优先**: Host 和 Viewer 直连，不经过服务器

---

## 4. 部署步骤

### 4.1 准备工作

```bash
# 1. 安装依赖
brew install nginx
brew install node
pip3 install -r python-host/requirements.txt

# 2. 创建 SSL 目录
sudo mkdir -p /opt/nginx/ssl
```

### 4.2 内网穿透配置

**方案 A: Cloudflare Tunnel (推荐)**
```bash
# 安装 cloudflared
brew install cloudflared

# 登录 Cloudflare
cloudflared tunnel login

# 创建隧道
cloudflared tunnel create wrd-tunnel

# 配置隧道 (config.yml)
cloudflared tunnel route dns wrd-tunnel stockhub.wiki
```

**方案 B: frp (备用)**
```bash
# 需要公网服务器作为中转
# frps.ini (服务器端)
[common]
bind_port = 7000

# frpc.ini (本地)
[common]
server_addr = x.x.x.x
server_port = 7000

[wrd]
type = tcp
local_port = 443
remote_port = 443
```

### 4.3 Nginx 配置

```nginx
server {
    listen 443 ssl http2;
    server_name stockhub.wiki;

    # SSL 证书 (Cloudflare  Origin Certificate)
    ssl_certificate /opt/nginx/ssl/cloudflare-origin.pem;
    ssl_certificate_key /opt/nginx/ssl/cloudflare-origin.key;

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # 静态文件
    location / {
        root /Users/macstudio1/AI/Claude/WebRemoteDesktop/web-client;
        try_files $uri $uri/ /index.html;
    }

    # API 和 WebSocket
    location /api/ {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Socket.io WebSocket
    location /socket.io/ {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

### 4.4 系统服务配置

**创建 LaunchDaemon (macOS)**

```xml
<!-- /Library/LaunchDaemons/com.wrd.signal.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.wrd.signal</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/server.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server</string>
    <key>StandardOutPath</key>
    <string>/var/log/wrd-signal.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/wrd-signal-error.log</string>
</dict>
</plist>
```

---

## 5. 关键配置修改

### 5.1 前端 API 地址

```javascript
// web-client/js/auth.js
const Auth = {
  API_BASE: 'https://stockhub.wiki',  // 改为域名
  ...
}

// web-client/js/webrtc.js
const WebRTC = {
  socket: io('https://stockhub.wiki', {  // 改为域名
    auth: { token, role: 'viewer' }
  }),
  ...
}
```

### 5.2 后端 CORS 配置

```javascript
// signal-server/server.js
const io = new Server(server, {
  cors: {
    origin: ['https://stockhub.wiki', 'https://*.stockhub.wiki'],
    methods: ['GET', 'POST'],
    credentials: true
  },
});
```

### 5.3 Python Host 配置

```python
# python-host/host.py
SERVER_URL = "https://stockhub.wiki"  # 改为域名
```

---

## 6. 启动脚本

```bash
#!/bin/bash
# start-wrd.sh

cd /Users/macstudio1/AI/Claude/WebRemoteDesktop

# 1. 启动信令服务器
cd signal-server
npm start &
SIGNAL_PID=$!

# 2. 启动 Nginx
sudo nginx

# 3. 启动 Cloudflare Tunnel
cloudflared tunnel run wrd-tunnel &
TUNNEL_PID=$!

# 4. 启动 Python Host (按需)
# cd ../python-host
# python3 host.py &
# HOST_PID=$!

echo "Services started. PIDs: Signal=$SIGNAL_PID, Tunnel=$TUNNEL_PID"
```

---

## 7. 安全检查清单

- [ ] 修改默认密码 admin123
- [ ] 启用 Cloudflare "Always Use HTTPS"
- [ ] 启用 Cloudflare "Bot Fight Mode"
- [ ] 配置 Cloudflare Rate Limiting
- [ ] 生成并配置 Origin Certificate
- [ ] 验证 JWT Token 过期时间
- [ ] 测试 WebRTC 连接正常
- [ ] 验证端口未直接暴露
- [ ] 检查防火墙规则

---

## 8. 备选方案

### 方案 A: Cloudflare Access (Zero Trust)
- 在 Cloudflare Dashboard 启用 Access
- 配置邮件域白名单
- 用户先登录 Cloudflare，再访问应用

### 方案 B: Tailscale
- 所有设备加入 Tailscale 网络
- 直接通过 Tailscale IP 访问，无需端口暴露
- 最简单安全，但需要客户端安装

---

## 9. 监控和日志

```bash
# 查看日志
tail -f /var/log/wrd-signal.log
tail -f /usr/local/var/log/nginx/access.log

# Cloudflare 实时日志
cloudflared tunnel tail wrd-tunnel
```

---

**总结**: 使用 Cloudflare Tunnel + Nginx + 原生部署，实现安全的公网访问。WebRTC 视频流在建立连接后 P2P 传输，不经过服务器，保证流畅度。
