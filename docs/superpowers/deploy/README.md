# Web Remote Desktop 部署指南

## 推荐部署方式

- **固定域名正式入口**：`https://link.stockhub.wiki -> 127.0.0.1:8080`
- **可选开发子域**：`https://dev.link.stockhub.wiki -> 127.0.0.1:5173`
- **本地调试**：`cd signal-server && npm start`，再运行 `./scripts/restart-host.sh`

正式入口边界：

- `127.0.0.1:8080` 是当前仓库唯一正式入口
- `127.0.0.1:8080` 是 fixed-domain 路径唯一 startup-blocking 依赖
- `5173` 只作为可选开发映射，不替代正式入口

## 固定域名启动

1. 先运行 `./scripts/setup-cloudflare.sh`
2. 确认 `~/.cloudflared/config.yml` 已生成
3. 运行 `./scripts/start-fixed-domain.sh`

## `dev.link.stockhub.wiki` 配置

### 1. 生成双 hostname tunnel 配置

```bash
cd /Users/macstudio1/AI/Claude/WebRemoteDesktop
ENABLE_DEV_SUBDOMAIN=1 \
DEV_DOMAIN=dev.link.stockhub.wiki \
DEV_LOCAL_ORIGIN=http://127.0.0.1:5173 \
./scripts/setup-cloudflare.sh
```

预期边缘形态：

- `link.stockhub.wiki -> http://127.0.0.1:8080`
- `dev.link.stockhub.wiki -> http://127.0.0.1:5173`

### 2. Cloudflare Access 单独保护 `dev`

在 Cloudflare Zero Trust 中为 `dev.link.stockhub.wiki` 单独创建一个 Self-hosted Application：

- Application domain：`dev.link.stockhub.wiki`
- Policy model：deny-by-default
- Allowlist：仅允许指定邮箱、账号或 IdP group
- 不与 `link.stockhub.wiki` 复用同一套 Cloudflare Access policy

这层 Cloudflare Access 只负责 `dev` 子域边缘准入，不替代当前应用内的 Viewer 密码和 Terminal admin 密码。

### 3. 证书前置条件

`dev.link.stockhub.wiki` 是多级子域。启用前必须确认 Cloudflare 对该 hostname 的证书前置条件已经满足，否则即使 tunnel 和 DNS 配好了，浏览器仍可能出现证书错误。

### 4. Vite proxy / HMR 契约

`5173` 对应的开发应用必须满足以下契约，才能通过 `https://dev.link.stockhub.wiki` 正常工作：

- `/api -> http://127.0.0.1:8080`
- `/socket.io -> http://127.0.0.1:8080`，并启用 `ws`
- HMR host：`dev.link.stockhub.wiki`
- HMR protocol：`wss`
- HMR client port：`443`

示例：

```js
export default {
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/socket.io': {
        target: 'http://127.0.0.1:8080',
        ws: true,
      },
    },
    hmr: {
      host: 'dev.link.stockhub.wiki',
      protocol: 'wss',
      clientPort: 443,
    },
  },
};
```

`5173` 通过 same-origin 代理访问 `8080`，因此当前阶段不需要把 `5173` 升级成正式后端入口。更强的运行时隔离仍是后续工作。

## 运维验证清单

```bash
cloudflared tunnel info wrd-tunnel
curl -I https://link.stockhub.wiki
curl -I https://dev.link.stockhub.wiki
```

主站验证：

- `https://link.stockhub.wiki` 继续按原路径可访问，不应被 `dev` 的 Cloudflare Access 策略误保护

`dev` 子域验证：

- 未登录 Access 时，`curl -I https://dev.link.stockhub.wiki` 的预期是 challenge / redirect，而不是直接 `200`
- `dev.link.stockhub.wiki` 在登录前出现 Cloudflare Access challenge
- Access 登录后没有证书错误
- 登录后静态资源能正常加载
- 手工检查 `/api` 代理、`/socket.io` websocket、以及 HMR 是否正常

## 回滚清单

1. 从 named tunnel 配置中删除 `dev.link.stockhub.wiki -> 127.0.0.1:5173` ingress
2. 删除 `dev.link.stockhub.wiki` 对应的 DNS hostname / tunnel route
3. 删除或停用 `dev.link.stockhub.wiki` 对应的 Cloudflare Access Self-hosted Application
4. 保留 `link.stockhub.wiki -> 127.0.0.1:8080`

## 注意

- 不要再依赖临时 `trycloudflare` 地址作为长期入口
- 正式外网访问应以 `https://link.stockhub.wiki` 为准
- `https://dev.link.stockhub.wiki` 只用于可选开发入口，不替代正式入口
