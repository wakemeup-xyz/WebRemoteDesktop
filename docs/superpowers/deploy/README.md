# Web Remote Desktop 部署指南

## 前置要求

- macOS 系统 (Host 运行环境)
- 域名: stockhub.wiki (已配置 Cloudflare DNS)
- Cloudflare 账号
- Node.js 14+
- Python 3.11+
- Nginx (可选)

## 快速部署

### 1. 配置 Cloudflare Tunnel (推荐)

```bash
./scripts/setup-cloudflare.sh
```

按照提示完成 Cloudflare 认证。

### 2. 配置 SSL 证书 (使用 Cloudflare Origin Certificate)

1. 登录 Cloudflare Dashboard
2. 选择域名 stockhub.wiki
3. SSL/TLS → Origin Server → Create Certificate
4. 保存证书到 `/opt/nginx/ssl/cloudflare-origin.pem`
5. 保存私钥到 `/opt/nginx/ssl/cloudflare-origin.key`

### 3. 配置文件检查

所有配置文件已自动修改为生产环境配置：

| 文件 | 修改内容 |
|-----|---------|
| `web-client/js/auth.js` | API_BASE: https://stockhub.wiki |
| `web-client/js/webrtc.js` | Socket.io: https://stockhub.wiki |
| `signal-server/server.js` | CORS: https://stockhub.wiki |
| `python-host/host.py` | SERVER_URL: https://stockhub.wiki |

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

### 启用 Cloudflare Access (可选增强)

1. Cloudflare Dashboard → Zero Trust → Access
2. Create Application
3. 选择 stockhub.wiki
4. 配置身份验证 (邮箱验证码/OTP)

## 故障排查

| 问题 | 解决方案 |
|------|---------|
| WebSocket 连接失败 | 检查 CORS 配置和域名是否一致 |
| SSL 证书错误 | 检查证书路径和权限 |
| 无法访问 | 检查 Cloudflare Tunnel 状态: `cloudflared tunnel list` |
| WebRTC 黑屏 | 检查 Python Host 是否运行并授权屏幕录制 |
| 信令服务器无法启动 | 检查端口 8080 是否被占用 |

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

## 网络架构

```
用户浏览器 → Cloudflare (SSL/CDN) → Cloudflare Tunnel → 本地 8080
                                          ↓
                                    Python Host (WebRTC)
```

## 安全要点

1. **WebRTC 媒体流**在建立后 P2P 直连，不经过 Cloudflare
2. **信令通道**通过 Cloudflare 代理，已加密
3. **Python Host** 需要屏幕录制权限，首次运行需在系统偏好设置中授权

## 更新配置

如需更改域名或其他配置，修改以下文件后重启服务：

```bash
# 1. 修改配置文件
vi web-client/js/auth.js
vi web-client/js/webrtc.js
vi signal-server/server.js
vi python-host/host.py

# 2. 重启服务
pkill -f "node.*server.js"
./scripts/start-wrd.sh tunnel
```
