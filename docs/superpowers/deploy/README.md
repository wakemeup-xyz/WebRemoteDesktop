# Web Remote Desktop 部署指南

## 推荐部署方式

- **固定域名**：使用 Cloudflare 命名隧道 + `stockhub.wiki`
- **本地调试**：`cd signal-server && npm start`，再运行 `./scripts/restart-host.sh`

## 固定域名启动

1. 先运行 `./scripts/setup-cloudflare.sh`
2. 确认 `~/.cloudflared/config.yml` 已生成
3. 运行 `./scripts/start-fixed-domain.sh`

## 注意

- 不要再依赖临时 `trycloudflare` 地址作为长期入口
- 外网访问应以 `https://stockhub.wiki` 为准
