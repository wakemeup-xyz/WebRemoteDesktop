#!/bin/bash
# Web Remote Desktop 启动脚本 - 固定域名版本
# 需要先配置命名隧道和 DNS 记录
# 使用方法：
#   1. 登录 Cloudflare Dashboard: https://dash.cloudflare.com
#   2. 进入 Zero Trust → Tunnels
#   3. 找到隧道 wrd-tunnel (ID: 104d2ca6-7efe-4f7e-a0f3-8567aa1d4b94)
#   4. 添加 Public Hostname: stockhub.wiki → http://localhost:8080
#   5. 更新 DNS: stockhub.wiki CNAME 指向 104d2ca6-7efe-4f7e-a0f3-8567aa1d4b94.cfargotunnel.com

DOMAIN="${DOMAIN:-stockhub.wiki}"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}=== Web Remote Desktop 启动器 (固定域名) ===${NC}"
echo ""

# 1. 检查并启动信令服务器
echo -e "${YELLOW}[1/3] 检查信令服务器...${NC}"
if ! curl -s http://localhost:8080/health > /dev/null 2>&1; then
    echo "   启动信令服务器..."
    cd "$PROJECT_DIR/signal-server"
    nohup npm start > /tmp/signal.log 2>&1 &
    sleep 2
    if curl -s http://localhost:8080/health > /dev/null 2>&1; then
        echo -e "   ${GREEN}✓ 信令服务器已启动${NC}"
    else
        echo -e "   ${RED}✗ 信令服务器启动失败${NC}"
        exit 1
    fi
else
    echo -e "   ${GREEN}✓ 信令服务器已在运行${NC}"
fi

# 2. 检查域名配置并启动命名隧道
echo -e "${YELLOW}[2/3] 启动 Cloudflare 命名隧道...${NC}"
echo "   域名: $DOMAIN"

# 检查隧道是否已在运行
if pgrep -f "cloudflared tunnel run" > /dev/null; then
    echo -e "   ${GREEN}✓ 隧道已在运行${NC}"
else
    # 启动命名隧道（使用 token）
    TOKEN="eyJhIjoiZTI4Mjk3ZTlkMWMwZjllZjA4Njk4NGNmNDg4ODU2NDAiLCJ0IjoiMTA0ZDJjYTYtN2VmZS00ZjdlLWEwZjMtODU2N2FhMWQ0Yjk0IiwicyI6Ik9HWmhZVEV5TXpRdFptSXhZeTAwWW1ZM0xXRXhNRGd0WlRZMk5XSmhOakl4TldOaiJ9"
    cloudflared tunnel run --token "$TOKEN" > /tmp/tunnel.log 2>&1 &
    sleep 5

    if pgrep -f "cloudflared tunnel run" > /dev/null; then
        echo -e "   ${GREEN}✓ 隧道已启动${NC}"
    else
        echo -e "   ${RED}✗ 隧道启动失败${NC}"
        tail -20 /tmp/tunnel.log
        exit 1
    fi
fi

# 3. 重启 Python Host
echo -e "${YELLOW}[3/3] 重启 Python Host...${NC}"
pkill -f "python.*host.py" 2>/dev/null
sleep 1

cd "$PROJECT_DIR/python-host"
nohup python3 host.py > /tmp/host.log 2>&1 &
sleep 2

if pgrep -f "python.*host.py" > /dev/null; then
    echo -e "   ${GREEN}✓ Python Host 已启动${NC}"
else
    echo -e "   ${RED}✗ Python Host 启动失败${NC}"
    tail -20 /tmp/host.log
    exit 1
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}部署完成！${NC}"
echo ""
echo -e "访问地址: ${YELLOW}https://$DOMAIN${NC}"
echo "密码: admin123"
echo ""
echo -e "注意：确保域名 $DOMAIN 已正确配置 DNS 和隧道路由"
echo -e "${GREEN}========================================${NC}"
