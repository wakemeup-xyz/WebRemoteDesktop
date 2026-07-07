# `dev.link.stockhub.wiki` 开发子域与 Cloudflare Access 设计

日期：2026-07-08

## 背景

当前仓库已经有一条稳定正式入口：

- `link.stockhub.wiki -> 127.0.0.1:8080`

这条入口由 Cloudflare 命名隧道承载，本地 `signal-server` 直接托管 `web-client/`，因此正式运行时唯一正确入口仍然是 `8080` 对应页面。

用户现在希望增加一条开发时入口：

- `dev.link.stockhub.wiki -> http://127.0.0.1:5173`

目标不是替换正式入口，而是在不破坏主站的前提下，把本机某个 Vite 开发页通过固定子域暴露出来，并且这条开发入口单独受 Cloudflare Access 保护。

## 已确认约束

1. 正式入口继续保持 `https://link.stockhub.wiki`。
2. 新入口接受使用子域名 `https://dev.link.stockhub.wiki`。
3. 该入口是开发用途，不是长期对外正式产品入口。
4. `dev` 子域需要单独的 Cloudflare Access 保护。
5. 用户选择的是“完整开发入口”模式，不只是静态页面曝光，还要考虑 `/api`、`/socket.io`、HMR 和开发交互。
6. 当前仓库只原生管理 `8080` 主服务，不原生拥有一个独立的 `5173` 应用代码库；因此 `5173` 侧配置必须以“对接契约”方式定义，而不是假设它已经在本仓库内实现。
7. `dev.link.stockhub.wiki` 是多级子域；部署时必须把该 hostname 的证书前置条件一起检查，不应只看 tunnel 和 DNS。

## 目标

1. 在同一个 Cloudflare 命名隧道下增加 `dev.link.stockhub.wiki`。
2. 让 `dev` 子域只在开发需要时映射到本机 `5173`。
3. 用单独的 Cloudflare Access 应用保护 `dev` 子域。
4. 让 `dev` 页面通过 same-origin 方式访问当前 `8080` 后端能力，避免额外放宽默认 CORS。
5. 保证 `5173` 的重启不会影响正式入口 `link.stockhub.wiki`。
6. 保证主站 `8080` 和 tunnel 生命周期的解释边界清晰，不把 dev 入口和正式入口混成一个运维对象。

## 非目标

1. 不把 `5173` 变成当前仓库新的正式本地入口。
2. 不让 `dev` 子域替代 `link.stockhub.wiki`。
3. 不在本阶段自动化创建 Cloudflare Access 应用或策略；默认只把配置要求和验证步骤写入仓库文档。
4. 不在本阶段隔离出一套独立 dev backend；本阶段默认复用当前 `8080` 后端能力。
5. 不把 quick tunnel 重新引入为 dev 长期入口。

## 方案比较

### 方案 A：同一命名隧道 + 独立 `dev` 子域 + 独立 Access + Vite 反向代理

拓扑：

- `link.stockhub.wiki -> 127.0.0.1:8080`
- `dev.link.stockhub.wiki -> 127.0.0.1:5173`
- `5173` 本地将 `/api` 与 `/socket.io` 代理到 `127.0.0.1:8080`

优点：

1. 正式入口与开发入口是两个清晰域名，用户和运维认知成本最低。
2. `5173` 页面保持 same-origin 调用，不需要默认扩大后端 CORS 面。
3. `5173` 重启只影响 `dev` 子域，不影响主站。
4. 继续使用同一个 named tunnel，Cloudflare 侧改动最小。
5. Cloudflare Access 可以只套在 `dev` 子域，不改变主站策略。

缺点：

1. `dev` 页面虽然单独鉴权，但默认仍复用 `8080` 后端，因此没有运行时隔离。
2. 需要 `5173` 对应开发应用自己正确配置 Vite proxy 和 HMR。

结论：推荐。它在安全、复杂度和可维护性之间最平衡。

### 方案 B：把 `5173` 挂到 `link.stockhub.wiki` 的某个 path

例如：

- `link.stockhub.wiki/dev/* -> 127.0.0.1:5173`

优点：

1. 只保留一个主域名。

缺点：

1. Path 级路由要处理 Vite 资源路径、HMR、history fallback、`/__vite_ping` 和 websocket，复杂度高。
2. 主站和 dev 页共享同一 host，更容易发生缓存、cookie、路径基准和误操作混淆。
3. 很难把 Cloudflare Access 只精确套在 dev path 上而不引入额外策略复杂度。

结论：不推荐。比子域方案更脆弱，且更容易污染正式入口。

### 方案 C：单独新建第二条 tunnel 或继续用 quick tunnel 暴露 `5173`

优点：

1. 理论上可以把 dev 与主站进一步拆开。

缺点：

1. quick tunnel 不稳定，不适合作为长期开发入口。
2. 新建第二条 tunnel 会增加账户侧对象、脚本和运维分裂。
3. 当前主站已具备 named tunnel，复用该 tunnel 增加第二 hostname 更直接。

结论：不推荐作为第一阶段方案。

## 推荐设计

### 一、边缘拓扑

在当前 `wrd-tunnel` 的 `config.yml` 中增加第二条 ingress：

```yaml
ingress:
  - hostname: link.stockhub.wiki
    service: http://127.0.0.1:8080
  - hostname: dev.link.stockhub.wiki
    service: http://127.0.0.1:5173
  - service: http_status:404
```

Cloudflare DNS 上分别把：

1. `link.stockhub.wiki`
2. `dev.link.stockhub.wiki`

都 route 到同一个 named tunnel。

补充前置条件：

1. `link.stockhub.wiki` 沿用现有证书策略。
2. `dev.link.stockhub.wiki` 作为多级子域，部署前必须确认 Cloudflare 侧该 hostname 的证书已就绪；否则即使 tunnel 和 DNS 路由存在，TLS 仍可能异常。

### 二、Access 边界

`dev.link.stockhub.wiki` 单独创建一个 Cloudflare Access Self-hosted Application：

1. Application domain：`dev.link.stockhub.wiki`
2. Policy：默认 deny-all
3. Allow：只允许指定邮箱、邮箱域、IdP group 或指定账号
4. Session duration：建议短于主站，例如 `8h`
5. 不与主站 `link.stockhub.wiki` 复用 Access policy

这样做的含义是：

1. 未通过 Access 的用户，连 `5173` 页都进不来。
2. Access 是开发入口的第一层边界。
3. Viewer 密码和 Terminal admin 密码仍然保留，形成第二层应用内鉴权。

### 三、`5173` 开发页对接契约

`5173` 对应应用必须满足以下对接契约：

1. 页面从 `https://dev.link.stockhub.wiki` 打开时，静态资源路径正常。
2. `/api` 代理到 `http://127.0.0.1:8080`
3. `/socket.io` 代理到 `http://127.0.0.1:8080`，并开启 websocket 透传
4. HMR client 使用公网 host：
   - host: `dev.link.stockhub.wiki`
   - protocol: `wss`
   - clientPort: `443`

参考 Vite 配置：

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

关键点是：浏览器只看见 `dev.link.stockhub.wiki` 这个 origin，真正与 `8080` 的交互由本机 `5173` dev server 做反向代理。这样默认不用把 `signal-server` 的 `CORS_ORIGIN` 放大到整个 dev 域。

### 四、本仓库脚本边界

本仓库只应管理以下事实：

1. named tunnel 是否生成包含主域和 dev 子域的 `config.yml`
2. DNS route 是否覆盖两个 hostname
3. fixed-domain 启动脚本是否仍然只把 `8080` 主服务当作强依赖
4. 部署文档是否写清楚 `5173` 是可选开发入口，不是主服务

本仓库不应把 `5173` 视为正式运行必要条件。原因是：

1. 当前主站仍是 `8080`
2. `5173` 可能属于另一个开发应用或另一个仓库
3. 如果把 `5173` 检查写成 fixed-domain 启动硬依赖，会让主站部署被开发页拖垮

因此推荐行为是：

1. `setup-cloudflare.sh` 支持可选写入 `dev` ingress
2. `start-fixed-domain.sh` 继续只强校验 `8080/health`
3. 如需校验 `5173`，通过单独的验证步骤或辅助脚本完成，而不是阻塞主入口启动

## 安全评估

### 一、Access 能解决什么

Access 可以解决：

1. 未授权公网用户无法直接打开 `dev.link.stockhub.wiki`
2. 搜索引擎、误分享链接、撞库式访问不能直接看到开发页
3. 即使 `5173` 页面本身没有独立登录页，Cloudflare 边缘也先挡住未授权请求

### 二、Access 不能解决什么

Access 不能解决：

1. `5173` 页面代码如果本身危险，授权用户仍能执行它
2. `5173` 通过 proxy 调到 `8080` 后，仍然可能影响当前共享后端
3. Host、signal-server、Terminal 仍运行在同一台机器，同一 dev 用户拿到入口后仍可影响共享运行态

所以本阶段的安全结论是：

1. `dev` 子域实现的是“入口隔离”，不是“运行时隔离”
2. 只要 `dev` 仍复用 `8080`，就必须接受它对当前主服务有共享 blast radius

### 三、主要风险与缓解

#### 风险 1：dev 页面误伤正式后端

表现：

- `5173` 页面调用 `/api`、`/socket.io` 时进入同一个 `8080`

缓解：

1. 只允许可信开发者进入 Access
2. 默认 deny-all，只做显式 allowlist
3. 文档中明确这不是隔离 dev 环境
4. 如果后续需要强隔离，再拆分 dev backend 端口或独立 Host/runtime

#### 风险 2：为了 dev 映射而放宽全局 CORS

表现：

- 直接把 `CORS_ORIGIN` 扩大到多个开发域，增加接口暴露面

缓解：

1. 推荐 same-origin Vite proxy
2. 本阶段不把扩大 CORS 作为默认方案
3. 只有外部应用无法使用 proxy 时，才把 runtime API base + CORS 作为备选

#### 风险 3：主站被 dev 入口可用性绑架

表现：

- `5173` 没启动导致脚本误判 fixed-domain 整体不可用

缓解：

1. `start-fixed-domain.sh` 只校验 `8080`
2. dev 子域健康检查单独执行
3. 文档中明确主站与 dev 子域的启动依赖不同

#### 风险 4：Access 策略与主站策略混用

表现：

- 把 `link.stockhub.wiki` 和 `dev.link.stockhub.wiki` 套同一个宽松策略

缓解：

1. 单独创建 dev Access app
2. 单独的 allow policy
3. 单独记录 session duration 和规则

## 重启与可用性影响评估

### 重启 `5173`

影响：

1. `dev.link.stockhub.wiki` 页面暂时不可用
2. 现有 HMR websocket 断开并重连
3. `link.stockhub.wiki` 不受影响
4. Cloudflare Access 不受影响

结论：这是低风险、局部影响。

### 重启 `8080`

影响：

1. `link.stockhub.wiki` 直接受影响
2. `dev.link.stockhub.wiki` 页面壳体可能还在，但其 `/api` 和 `/socket.io` 代理请求会失败
3. Terminal / Viewer / auth 等共享能力一并受影响

结论：这是共享后端重启，影响主站与 dev 两侧。

### 重启 `cloudflared` / named tunnel

影响：

1. `link.stockhub.wiki` 和 `dev.link.stockhub.wiki` 同时受影响
2. 本地 `8080` 与 `5173` 进程本身不一定挂，但公网入口消失

结论：这是共享边缘层重启，两个域名共同受影响。

### 修改 Cloudflare Access 规则

影响：

1. 只影响 `dev.link.stockhub.wiki` 的边缘准入
2. 不需要本地重启 `5173`
3. 不需要本地重启 `8080`

结论：Access 是边缘鉴权层，与本地应用生命周期解耦。

## 实现策略

### 第一阶段

1. 本仓库脚本支持为 named tunnel 写入可选 `dev` ingress
2. 部署文档补齐 `dev` 子域、Access 与 Vite proxy/HMR 对接契约
3. 增加验证步骤，确认：
   - main hostname 正常
   - dev hostname 解析正常
   - Access 生效
   - Vite HMR 在公网子域下可用

### 第二阶段（未来可选）

如果后续确认 dev 与正式主站需要运行时隔离，再考虑：

1. `dev` 子域代理到独立 dev backend，而不是共享 `8080`
2. dev Host / dev signal-server / dev Terminal 拆成单独进程或单独机器
3. 再进一步自动化 Cloudflare Access 配置

## 验证清单

### 边缘验证

1. `cloudflared tunnel route dns` 中能看到两个 hostname
2. `~/.cloudflared/config.yml` 包含两个 ingress
3. `curl -I https://link.stockhub.wiki` 返回正常
4. 未登录 Access 时访问 `https://dev.link.stockhub.wiki` 被要求鉴权
5. Access 登录后能打开 `dev` 页面
6. `dev.link.stockhub.wiki` 不出现 hostname 证书错误

### 功能验证

1. `dev` 页面能加载静态资源
2. `dev` 页面访问 `/api` 成功
3. `dev` 页面连接 `/socket.io` 成功
4. HMR 修改后浏览器能收到更新

### 边界验证

1. 停掉 `5173` 后，`link.stockhub.wiki` 仍可用
2. 停掉 `8080` 后，主站不可用，dev 页代理能力也失败
3. Access policy 改动不会要求本地服务重启

## 回滚策略

如需回滚，本阶段只需要：

1. 从 `config.yml` 删除 `dev.link.stockhub.wiki` ingress
2. 删除 `dev.link.stockhub.wiki` DNS route
3. 删除或停用对应 Access app
4. 保留 `link.stockhub.wiki -> 8080` 原有路径不变

这个回滚不会影响当前主站结构。

## 技术合理性结论

推荐方案在当前仓库约束下是合理的，原因有四点：

1. 它不改变主站真相源。正式入口仍是 `link.stockhub.wiki -> 8080`。
2. 它把 dev 暴露能力收敛到同一 named tunnel，避免再引入一套并行公网入口。
3. 它默认采用 same-origin proxy，避免为了开发入口扩大后端 CORS 面。
4. 它明确承认当前阶段只有入口隔离，没有运行时隔离，因此不会在安全上做虚假承诺。

这也是本阶段最小、最稳、最容易验证的设计。
