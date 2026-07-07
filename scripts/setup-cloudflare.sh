#!/bin/bash
# Cloudflare Tunnel 配置脚本

DOMAIN="${DOMAIN:-link.stockhub.wiki}"
TUNNEL_NAME="${TUNNEL_NAME:-wrd-tunnel}"
LOCAL_PORT="${LOCAL_PORT:-8080}"
LOCAL_ORIGIN="${LOCAL_ORIGIN:-http://127.0.0.1:${LOCAL_PORT}}"
DEV_DOMAIN="${DEV_DOMAIN:-dev.link.stockhub.wiki}"
DEV_LOCAL_ORIGIN="${DEV_LOCAL_ORIGIN:-http://127.0.0.1:5173}"
ENABLE_DEV_SUBDOMAIN="${ENABLE_DEV_SUBDOMAIN:-0}"

echo "=== Cloudflare Tunnel Setup ==="
echo "Domain: $DOMAIN"
echo "Local origin: $LOCAL_ORIGIN"
if [ "$ENABLE_DEV_SUBDOMAIN" = "1" ]; then
    echo "Dev domain: https://$DEV_DOMAIN"
    echo "Dev origin: $DEV_LOCAL_ORIGIN"
else
    echo "Dev subdomain: disabled"
fi
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
    service: $LOCAL_ORIGIN
EOF

if [ "$ENABLE_DEV_SUBDOMAIN" = "1" ]; then
cat >> ~/.cloudflared/config.yml << EOF
  - hostname: $DEV_DOMAIN
    service: $DEV_LOCAL_ORIGIN
EOF
fi

cat >> ~/.cloudflared/config.yml << EOF
  - service: http_status:404
EOF

# 配置 DNS
echo "[4/4] Setting up DNS..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN"
if [ "$ENABLE_DEV_SUBDOMAIN" = "1" ]; then
    cloudflared tunnel route dns "$TUNNEL_NAME" "$DEV_DOMAIN"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Primary domain: https://$DOMAIN"
echo "Primary origin: $LOCAL_ORIGIN"
if [ "$ENABLE_DEV_SUBDOMAIN" = "1" ]; then
    echo "Dev domain: https://$DEV_DOMAIN"
    echo "Dev origin: $DEV_LOCAL_ORIGIN"
fi
echo ""
echo "To start the tunnel, run:"
echo "  cloudflared tunnel run $TUNNEL_NAME"
echo ""
echo "Or use the start script:"
echo "  ./scripts/start-wrd.sh tunnel"
