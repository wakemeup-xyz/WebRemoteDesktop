# Web Remote Desktop 公网部署实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Web Remote Desktop 部署到公网，通过域名 stockhub.wiki 访问，使用 Cloudflare Tunnel + Nginx 原生部署。

**架构:** Cloudflare (SSL/CDN) → Cloudflare Tunnel → 本地 Nginx (反向代理) → 信令服务器 + Python Host。WebRTC 媒体流 P2P 直连。

**Tech Stack:** Node.js, Python, Nginx, Cloudflared Tunnel

---

## 文件变更清单

| 文件路径 | 操作 | 说明 |
|---------|------|------|
| `web-client/js/auth.js` | 修改 | API 基础 URL 改为域名 |
| `web-client/js/webrtc.js` | 修改 | Socket.io 连接改为域名 |
| `signal-server/server.js` | 修改 | CORS 配置添加域名 |
| `python-host/host.py` | 修改 | 服务器 URL 改为域名 |
| `signal-server/.env` | 创建 | 环境变量配置 |
| `scripts/start-wrd.sh` | 创建 | 服务启动脚本 |
| `scripts/setup-cloudflare.sh` | 创建 | Cloudflare Tunnel 配置脚本 |
| `docs/superpowers/deploy/nginx.conf` | 创建 | Nginx 配置文件模板 |
| `docs/superpowers/deploy/README.md` | 创建 | 部署说明文档 |

---

## Task 1: 修改前端 API 地址

**Files:**
- Modify: `web-client/js/auth.js:3`

- [ ] **Step 1: 修改 API_BASE 为域名**

```javascript
// 修改前
API_BASE: 'http://localhost:8080',

// 修改后  
API_BASE: 'https://stockhub.wiki',
```

- [ ] **Step 2: 提交变更**

```bash
git add web-client/js/auth.js
git commit -m "config: update API base URL for production"
```

---

## Task 2: 修改前端 WebSocket 连接地址

**Files:**
- Modify: `web-client/js/webrtc.js:21`

- [ ] **Step 1: 修改 Socket.io 连接 URL**

```javascript
// 修改前
this.socket = io('http://localhost:8080', {

// 修改后
this.socket = io('https://stockhub.wiki', {
```

- [ ] **Step 2: 提交变更**

```bash
git add web-client/js/webrtc.js
git commit -m "config: update WebSocket URL for production"
```

---

## Task 3: 修改后端 CORS 配置

**Files:**
- Modify: `signal-server/server.js:23-28`

- [ ] **Step 1: 更新 CORS 允许的域名**

```javascript
// 修改前
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

// 修改后
const io = new Server(server, {
  cors: {
    origin: ['https://stockhub.wiki', 'https://*.stockhub.wiki'],
    methods: ['GET', 'POST'],
    credentials: true
  },
});
```

- [ ] **Step 2: 提交变更**

```bash
git add signal-server/server.js
git commit -m "config: update CORS for production domain"
```

---

## Task 4: 修改 Python Host 服务器地址

**Files:**
- Modify: `python-host/host.py:25`

- [ ] **Step 1: 更新 SERVER_URL**

```python
# 修改前
SERVER_URL = "http://localhost:8080"

# 修改后
SERVER_URL = "https://stockhub.wiki"
```

- [ ] **Step 2: 提交变更**

```bash
git add python-host/host.py
git commit -m "config: update server URL for production"
```

---

## Task 5: 创建环境变量配置文件

**Files:**
- Create: `signal-server/.env`

- [ ] **Step 1: 创建 .env 文件**

```bash
cat > signal-server/.env << 'EOF'
# Server configuration
PORT=8080
NODE_ENV=production

# JWT Secret (change this in production!)
JWT_SECRET=your-secret-key-change-this-in-production

# CORS settings
CORS_ORIGIN=https://stockhub.wiki
EOF
```

- [ ] **Step 2: 提交文件**

```bash
git add signal-server/.env
git commit -m "config: add production environment variables"
```

---

## Task 6: 创建 Nginx 配置模板

**Files:**
- Create: `docs/superpowers/deploy/nginx.conf`

- [ ] **Step 1: 创建 Nginx 配置目录**

```bash
mkdir -p docs/superpowers/deploy
```

- [ ] **Step 2: 创建 Nginx 配置文件**

```nginx
server {
    listen 443 ssl http2;
    server_name stockhub.wiki;

    # SSL 证书 (Cloudflare Origin Certificate)
    ssl_certificate /opt/nginx/ssl/cloudflare-origin.pem;
    ssl_certificate_key /opt/nginx/ssl/cloudflare-origin.key;

    # SSL 配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    # 安全头
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # 静态文件 (可选：Nginx 直接服务静态文件，不经过 Node.js)
    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # API 和 WebSocket
    location /api/ {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Socket.io WebSocket
    location /socket.io/ {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}

# HTTP 重定向到 HTTPS (如果直接暴露 Nginx，通过 CF 时不需要)
server {
    listen 80;
    server_name stockhub.wiki;
    return 301 https://$server_name$request_uri;
}
```

- [ ] **Step 3: 提交文件**

```bash
git add docs/superpowers/deploy/nginx.conf
git commit -m "deploy: add nginx configuration template"
```

---

## Task 7: 创建服务启动脚本

**Files:**
- Create: `scripts/start-wrd.sh`

- [ ] **Step 1: 创建 scripts 目录**

```bash
mkdir -p scripts
```

- [ ] **Step 2: 创建启动脚本**

```bash
cat > scripts/start-wrd.sh << 'EOF'
#!/bin/bash
set -e

# Web Remote Desktop 服务启动脚本
# 用法: ./start-wrd.sh [tunnel|local]

MODE=${1:-local}
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="/var/log/wrd"

# 创建日志目录
sudo mkdir -p "$LOG_DIR"

echo "=== Starting Web Remote Desktop ==="
echo "Mode: $MODE"
echo "Project: $PROJECT_DIR"
echo ""

# 1. 启动信令服务器
echo "[1/3] Starting signal server..."
cd "$PROJECT_DIR/signal-server"
nohup npm start > "$LOG_DIR/signal.log" 2>&1 &
echo "Signal server PID: $!"

# 等待信令服务器启动
sleep 2

# 2. 启动 Nginx (如果使用本地模式)
if [ "$MODE" == "local" ]; then
    echo "[2/3] Starting Nginx..."
    if [ -f "$PROJECT_DIR/docs/superpowers/deploy/nginx.conf" ]; then
        sudo nginx -c "$PROJECT_DIR/docs/superpowers/deploy/nginx.conf" 2>/dev/null || \
        sudo nginx -s reload 2>/dev/null || \
        echo "Nginx already running or config error"
    fi
fi

# 3. 启动 Cloudflare Tunnel (如果启用)
if [ "$MODE" == "tunnel" ]; then
    echo "[2/3] Starting Cloudflare Tunnel..."
    if command -v cloudflared &> /dev/null; then
        nohup cloudflared tunnel run wrd-tunnel > "$LOG_DIR/tunnel.log" 2>&1 &
        echo "Cloudflare tunnel PID: $!"
    else
        echo "Warning: cloudflared not installed"
    fi
fi

echo "[3/3] Setup complete"
echo ""
echo "Services:"
echo "  - Signal Server: http://localhost:8080"
echo "  - Nginx: https://localhost (if enabled)"
echo ""
echo "Logs: $LOG_DIR"
echo ""
echo "To start Python Host, run:"
echo "  cd $PROJECT_DIR/python-host && python3 host.py"
EOF

chmod +x scripts/start-wrd.sh
```

- [ ] **Step 3: 提交文件**

```bash
git add scripts/start-wrd.sh
git commit -m "deploy: add service startup script"
```

---

## Task 8: 创建 Cloudflare Tunnel 配置脚本

**Files:**
- Create: `scripts/setup-cloudflare.sh`

- [ ] **Step 1: 创建 Cloudflare 配置脚本**

```bash
cat > scripts/setup-cloudflare.sh << 'EOF'
#!/bin/bash
# Cloudflare Tunnel 配置脚本

DOMAIN="stockhub.wiki"
TUNNEL_NAME="wrd-tunnel"

echo "=== Cloudflare Tunnel Setup ==="
echo "Domain: $DOMAIN"
echo ""

# 检查 cloudflared
if ! command -v cloudflared &> /dev/null; then
    echo "Installing cloudflared..."
    brew install cloudflared
fi

# 登录 Cloudflare
echo "[1/4] Logging in to Cloudflare..."
cloudflared tunnel login

# 创建隧道
echo "[2/4] Creating tunnel: $TUNNEL_NAME"
cloudflared tunnel create "$TUNNEL_NAME"

# 获取 Tunnel ID
TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
echo "Tunnel ID: $TUNNEL_ID"

# 创建配置文件
echo "[3/4] Creating config file..."
mkdir -p ~/.cloudflared

cat > ~/.cloudflared/config.yml << EOF
tunnel: $TUNNEL_ID
credentials-file: ~/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $DOMAIN
    service: http://localhost:8080
  - service: http_status:404
EOF

# 配置 DNS
echo "[4/4] Setting up DNS..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "To start the tunnel, run:"
echo "  cloudflared tunnel run $TUNNEL_NAME"
echo ""
echo "Or use the start script:"
echo "  ./scripts/start-wrd.sh tunnel"
EOF

chmod +x scripts/setup-cloudflare.sh
```

- [ ] **Step 2: 提交文件**

```bash
git add scripts/setup-cloudflare.sh
git commit -m "deploy: add cloudflare tunnel setup script"
```

---

## Task 9: 创建部署说明文档

**Files:**
- Create: `docs/superpowers/deploy/README.md`

- [ ] **Step 1: 创建部署文档**

```markdown
# Web Remote Desktop 部署指南

## 前置要求

- macOS 系统 (Host 运行环境)
- 域名: stockhub.wiki (已配置 Cloudflare DNS)
- Cloudflare 账号
- Node.js 14+
- Python 3.11+
- Nginx

## 快速部署

### 1. 配置 Cloudflare Tunnel (推荐)

```bash
./scripts/setup-cloudflare.sh
```

### 2. 配置 SSL 证书

1. 登录 Cloudflare Dashboard
2. 选择域名 stockhub.wiki
3. SSL/TLS → Origin Server → Create Certificate
4. 保存证书到 `/opt/nginx/ssl/cloudflare-origin.pem`
5. 保存私钥到 `/opt/nginx/ssl/cloudflare-origin.key`

### 3. 修改配置文件

所有配置文件已自动修改，检查确认:
- `web-client/js/auth.js` - API_BASE
- `web-client/js/webrtc.js` - Socket.io URL
- `signal-server/server.js` - CORS origin
- `python-host/host.py` - SERVER_URL

### 4. 启动服务

```bash
# 使用 Cloudflare Tunnel (推荐)
./scripts/start-wrd.sh tunnel

# 或使用本地 Nginx
./scripts/start-wrd.sh local
```

### 5. 启动 Python Host

```bash
cd python-host
python3 host.py
```

## 安全配置

### 修改默认密码

编辑 `signal-server/routes/auth.js`:
```javascript
const VALID_PASSWORD = 'your-new-password';
```

### 启用 Cloudflare Access (可选)

1. Cloudflare Dashboard → Access
2. Create Application
3. 选择 stockhub.wiki
4. 配置身份验证 (邮箱验证码)

## 故障排查

| 问题 | 解决方案 |
|------|---------|
| WebSocket 连接失败 | 检查 CORS 配置和域名 |
| SSL 证书错误 | 检查证书路径和权限 |
| 无法访问 | 检查 Cloudflare Tunnel 状态 |
| WebRTC 黑屏 | 检查 Python Host 是否运行 |

## 服务管理

```bash
# 查看日志
tail -f /var/log/wrd/signal.log
tail -f /var/log/wrd/tunnel.log

# 停止服务
pkill -f "node.*server.js"
pkill -f "cloudflared"
pkill -f "python.*host.py"

# 重启服务
./scripts/start-wrd.sh tunnel
```
```

- [ ] **Step 2: 提交文件**

```bash
git add docs/superpowers/deploy/README.md
git commit -m "docs: add deployment guide"
```

---

## Task 10: 创建 Git 部署标签

- [ ] **Step 1: 创建版本标签**

```bash
git tag -a v1.0.0-deploy -m "Production deployment for stockhub.wiki"
```

- [ ] **Step 2: 推送标签到远程**

```bash
git push origin v1.0.0-deploy
```

---

## 部署后验证清单

- [ ] 访问 https://stockhub.wiki 显示登录页面
- [ ] 使用密码登录成功
- [ ] 启动 Python Host
- [ ] 浏览器端显示 "Host已上线"
- [ ] 点击 "开始远程桌面" 连接成功
- [ ] 屏幕画面正常显示
- [ ] 画面随鼠标移动更新

---

**总结:** 完成所有配置修改和脚本创建后，运行 `./scripts/setup-cloudflare.sh` 配置隧道，然后运行 `./scripts/start-wrd.sh tunnel` 启动服务即可。
