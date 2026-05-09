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
