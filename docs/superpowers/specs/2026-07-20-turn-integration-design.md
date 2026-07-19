# TURN 全链路接入设计（远程桌面 + Terminal 可选传输）

日期：2026-07-20

## Goal

基于本机 TURN 秘密源 `~/.StockHub/turn.json`，把 **远程桌面 WebRTC** 与 **可选 Terminal 传输** 都接入同一套 coturn，并在 Viewer 页面提供 **模式选择 + 一键/分步测试调通**。用户继续只记一个公网入口 `https://link.stockhub.wiki`；TURN 只决定媒体/可选 Terminal 的中继路径，不替代入口。

## Background

### 配置源

本机权威 TURN 配置（示例结构，凭据不入库）：

```json
{
  "turnServer": {
    "host": "144.225.130.238",
    "port": 3478,
    "username": "...",
    "password": "...",
    "realm": "dedione.stockhub.wiki",
    "transport": "udp"
  }
}
```

规范化后映射到现有 env 模型：

| Env | 含义 |
|---|---|
| `TURN_URLS` | 逗号分隔，如 `turn:host:3478?transport=udp`（可含 TCP/TLS 备选） |
| `TURN_USERNAME` | TURN 用户名 |
| `TURN_CREDENTIAL` | TURN 密码/凭证 |
| `STUN_URLS` | 可选覆盖；默认 Google STUN |
| `WRD_TURN_JSON` | 可选，指向 `turn.json` 绝对路径 |

### 现状（代码事实）

| 组件 | 现状 | 缺口 |
|---|---|---|
| `signal-server/lib/config.js` | 读 `TURN_*`，`getTurnStatus()` | 不读 `turn.json`；无 fingerprint/source |
| `GET /api/webrtc-config` | 下发 `iceServers` / `turnConfigured` | 无 Host 侧一致性、无自检结果 |
| Viewer `webrtc.js` | `lan/auto/stun/relay/tunnel`；`relay` 用 `iceTransportPolicy: 'relay'` | 仅“已配置/未配置”；无 Allocate/双边测试 |
| Host `build_ice_servers()` | 读进程 env 的 `TURN_*` | LaunchAgent 启动路径不注入 `.env`/`turn.json`；`strict-stun` 会忽略 TURN |
| Terminal | Socket.IO `/terminal` only | **协议上不能直接挂 coturn**；设计上曾明确不走 STUN/TURN/WebRTC |

### 关键约束

1. 公网入口与媒体路径解耦：入口可达 ≠ TURN/WebRTC 可达。
2. Strict STUN（`auto`/`stun`）**不自动**切 TURN 或 Socket.IO 媒体 tunnel；保持手动优先。
3. TURN 凭据不得进入 git、诊断明文、前端静态资源。
4. Viewer 与 Host **必须**使用同一套 TURN 指纹，否则 `relay` 永远选不出 pair。
5. Terminal 默认传输保持 Socket.IO；“接入 TURN”只能通过 **可选 WebRTC DataChannel** 新增路径，不能假装 Socket.IO 走了 TURN。

## Confirmed Product Decisions

1. **配置双源**：`env` 显式覆盖 > `signal-server/.env` > `WRD_TURN_JSON` / `~/.StockHub/turn.json`。
2. **远程桌面**：`relay` 模式必须真正可用；`auto`/`stun` 不静默切 TURN。
3. **Terminal**：默认 `socketio`；新增可选 `webrtc-turn`（DataChannel over 同一 TURN）；失败不静默回退。
4. **测试**：页面必须支持配置完整性、Allocate、双边一致性、桌面短试、Terminal 短试。
5. **Host 策略**：全局 `WRD_MEDIA_POLICY=strict-stun` 不得再导致 `relay` 会话忽略 TURN；TURN 启用改为 **会话级**。

## Non-Goals

1. 不删除 `tunnel` 媒体兜底，也不把 `tunnel` 改成 TURN。
2. 不在本设计强制落地 Terminal direct WSS（`term.link.stockhub.wiki`）；可与本方案并存。
3. 不引入 coturn REST 短期凭证（可二期）；本阶段静态 username/password 即可。
4. 不自动从 Strict STUN 失败切到 `relay`。
5. 不把 PTY 从 signal-server 搬到 python-host。

## Architecture

```text
 ~/.StockHub/turn.json  (or env / signal-server/.env)
              │
              ▼
     loadTurnConfig()  ──►  fingerprint = sha256(urls|username)  // no password
              │
     ┌────────┴─────────┐
     v                  v
 signal-server      python-host (LaunchAgent env inject)
 /api/webrtc-config   build_ice_servers(session)
 /api/turn-selftest   turnReady capability report
 TerminalGateway*
     │
     v
 Browser Viewer
  ├─ Desktop PC: video + input DC  (modes include relay)
  └─ Terminal:
       ├─ default: Socket.IO /terminal
       └─ optional: WebRTC DC via TerminalGateway + same iceServers
```

`*` TerminalGateway 仅在启用 `webrtc-turn` 时使用。

## Configuration Loading

### Module: `signal-server/lib/turn-config.js`

职责：

1. `loadTurnFromEnv(env)`
2. `loadTurnFromJsonFile(path)` — 解析 `turnServer` 对象
3. `normalizeTurnUrls({ host, port, transport, extraUrls })` → `urls[]`
4. `mergeTurnConfig({ env, jsonPath })` — env 优先
5. `getTurnFingerprint({ urls, username })` — 稳定哈希，**不含 password**
6. 启动日志：`turnConfigured` / `turnSource` / `urls` / `fingerprint`，永不打印 credential

`turn.json` → URL 规则：

```text
turn:{host}:{port}?transport={udp|tcp}
```

若 json 仅含 `udp`，默认至少生成 UDP URL；可选在配置或探测后追加：

```text
turn:{host}:{port}?transport=tcp
turns:{host}:5349?transport=tcp   # 仅当运维确认 TLS 已开
```

### Host 注入

`scripts/run-host-launchctl.sh`（及统一 env 助手）必须：

1. 加载与 signal-server 同一套 TURN 解析结果（可复用小脚本或从 `signal-server/.env` + `WRD_TURN_JSON` 读取）
2. `export TURN_URLS TURN_USERNAME TURN_CREDENTIAL STUN_URLS`
3. Host 启动日志打印 `turnReady` + fingerprint（无密码）

### Session-scoped TURN on Host

替换“全局 strict 则忽略全部 TURN”的行为：

| 会话意图 | Host ICE |
|---|---|
| Viewer `lan` / `stun` / strict auto 直连尝试 | 可不含 TURN（Strict STUN） |
| Viewer `relay` 或 offer 标记 `iceMode=relay` / `allowTurn=true` | **必须**含 TURN，且建议 `iceTransportPolicy` 侧行为与 relay 一致 |
| Viewer `tunnel` | 不建 WebRTC 媒体 PC |

实现要点：

1. offer / 信令附带 `networkMode` 或 `iceMode`
2. Host 在 `on_offer` 重建 PC 时按该字段调用 `build_ice_servers(mode)`
3. Host 向 signaling 上报 `turnReady` + `turnFingerprint` 供 Viewer 对比

## Desktop Media Path

### Mode semantics（对齐代码，修正文案）

| Mode | ICE | TURN | 自动切其他模式 |
|---|---|---|---|
| `lan` | 无 STUN/TURN | 否 | 否 |
| `auto` | STUN；若已配置可把 TURN 放进 iceServers 作候选，但 **失败不自动改写为 relay/tunnel** | 候选可选 | 否 |
| `stun` | 仅 STUN | 否 | 否 |
| `relay` | `iceTransportPolicy: 'relay'` | 必须 | 否；失败只建议 tunnel |
| `tunnel` | 非 WebRTC | 否 | 否 |

UI 文案必须与上表一致：删除“有 TURN 时自动兜底”类误导描述，改为“失败时提示手动切换外网中继”。

### Relay success criteria

同时满足：

1. `turnConfigured === true`
2. Host `turnReady === true` 且 fingerprint 与 Viewer 一致
3. selected candidate type = `relay`
4. FPS > 0 且输入可用（DataChannel 或既有输入路径）

### Failure taxonomy

| Code | Meaning | Next action |
|---|---|---|
| `turn-config-missing` | 无 TURN URL | 配置 turn.json / env |
| `turn-config-partial` | 缺 username/credential | 补全 |
| `turn-host-not-ready` | Host 未装载 TURN | 修 LaunchAgent env / 重启 Host |
| `turn-fingerprint-mismatch` | 双边 URL/用户名不一致 | 统一配置源 |
| `turn-allocate-failed` | 无 relay candidate | 查 3478/防火墙/凭据/realm |
| `turn-pair-not-selected` | 有 candidate 无 selected | 超时/策略/双边 |
| `relay-media-zero-fps` | pair 有但无画面 | 捕获/编码，非 TURN |

## Terminal Path

### Why not “just plug TURN”

TURN 只服务 WebRTC ICE。当前 Terminal 是：

```text
Browser --Socket.IO /terminal--> signal-server --node-pty--> shell
```

要“接入 TURN”必须新增可选传输：

```text
Browser --WebRTC DataChannel (via TURN)--> TerminalGateway --SessionManager--> PTY
```

### Terminal transport enum

```text
terminalTransport:
  - socketio          # 默认：页面同源 Socket.IO（含 CF 入口）
  - webrtc-turn       # 新增：DC + 与桌面同一 iceServers
  # socketio-direct   # 既有 direct-wss 设计，本方案不阻塞、不实现
```

规则：

1. 默认 `socketio`，行为与现网一致。
2. 选 `webrtc-turn` 前必须 `turnConfigured` 且自检至少通过 Allocate。
3. `webrtc-turn` 失败：**明确失败**，不静默退回 socketio（用户可手动切回）。
4. 与桌面 `networkMode` 独立：桌面 `relay`、Terminal 仍可 `socketio`。

### TerminalGateway (signal-server)

推荐内嵌于 signal-server（Phase 2）；若 Node 原生 WebRTC（如 `wrtc`）在 macOS 不可用，再拆独立 sidecar。

职责：

1. 鉴权：短时 terminal token / 既有 admin token 策略（与 Terminal 设计一致，禁止裸露长期 secret）
2. 建短生命周期 PeerConnection，iceServers 来自同一 `loadTurnConfig()`
3. DataChannel `terminal` 与 SessionManager 双向桥接
4. 复用 rate limit、审计、session 生命周期

最小 DC 帧：

```json
{ "t": "in", "sid": "...", "data": "..." }
{ "t": "out", "sid": "...", "data": "..." }
{ "t": "resize", "cols": 120, "rows": 40 }
{ "t": "ping" }
{ "t": "pong", "ts": 0 }
```

成功判据：DC open + ping RTT + 一行 marker 输出成功；强制 relay 时 stats 为 relay。

## Selection + Self-Test UX

在现有网络模式面板扩展为 **网络与 TURN 控制台**（不新开独立站点）。

### Blocks

1. **桌面网络模式**（现有 radio）+ TURN 状态行（source / fingerprint 短码 / Host ready）
2. **Terminal 传输**（socketio / webrtc-turn）
3. **测试结果列表**（分步 PASS/FAIL + 耗时 + 建议）
4. 按钮：`测试 TURN`、`测试 Terminal 传输`、`应用并重连`

### Test pipeline

| Step | Name | How | Pass |
|---|---|---|---|
| A | Config integrity | `/api/webrtc-config` + Host capability | configured && !misconfigured && hostTurnReady |
| B | Browser Allocate | 临时 `RTCPeerConnection({iceTransportPolicy:'relay'})` 收齐 gathering | `relayCandidates >= 1` |
| C | Server probe（可选） | `POST /api/turn-selftest` | allocate ok |
| D | Fingerprint match | Viewer vs Host | equal |
| E | Desktop short relay | 10–15s 试连或读当前 stats | selected=relay && fps>0 |
| F | Terminal DC short | 短会话 ping + marker | open && echo ok |

前端模块建议：

- `web-client/js/turn-selftest.js` — 纯测试逻辑，无 UI
- `WebRTC` / `ui.js` — 面板投影与按钮
- 诊断 snapshot 增加 `turnSelfTest`（无密码、可含 fingerprint）

### API surface

| API | Auth | Purpose |
|---|---|---|
| `GET /api/webrtc-config` | access token | 扩展 `turnSource`, `turnFingerprint`, `hostTurnReady`, `turnUrls`（已配置时） |
| `GET /api/turn-status` | access token | 轻量轮询 |
| `POST /api/turn-selftest` | access token + rate limit | 服务端 Allocate 探针 |
| Host capability via signaling | host auth | `turnReady`, `turnFingerprint` |
| `POST /api/terminal/webrtc-session` | terminal admin | Phase 2 会话 |

## Security

1. `turn.json` / `.env` 文件权限建议 `600`；路径可配置，默认 `~/.StockHub/turn.json`。
2. 所有含 credential 的下发仅对已登录 Viewer；日志与 `diag-logs` 脱敏。
3. `POST /api/turn-selftest` 限流，防止刷 Allocate。
4. 正式公开发布前轮换 TURN 静态账号（与 SECURITY.md 一致）。
5. TerminalGateway 不得扩大 origin 暴露面；仅复用既有 signal-server 入口。

## Phased Delivery

### Phase 0 — Desktop config path（必做，先通）

- 加载 `turn.json` / 统一 env
- Host LaunchAgent 注入 `TURN_*`
- 会话级允许 `relay` 使用 TURN
- 验收：配置完整 + 手动外网中继出画

### Phase 1 — Select + test（产品化）

- 浏览器 Allocate 自检
- 面板结果 / Host fingerprint
- 可选服务端 selftest
- 文案与需求文档对齐

### Phase 2 — Terminal webrtc-turn（满足“Terminal 也接入 TURN”）

- TerminalGateway + 前端传输选择
- 失败明确提示
- 测试步骤 F

### Phase 3 — Docs / ops harden

- README、runbook、需求文档、`.env.example`
- 运维检查清单（3478 UDP/TCP、中继端口段）

## Compatibility

1. 未配置 TURN 时行为与现网一致：`relay` 不可用提示、Strict STUN、手动 tunnel。
2. 既有 `wrdNetworkMode` localStorage 键保持。
3. 手动 STUN 端口搜索仍仅 `auto`/`stun`，且耗尽不自动 TURN。
4. Terminal 默认路径零回归。

## Acceptance Summary

- [ ] `turn.json` 或 env 可使 `turnConfigured=true`，source/fingerprint 可见
- [ ] Host 与 Viewer fingerprint 一致，`relay` 出画且链路显示 TURN 中继
- [ ] 「测试 TURN」可复现 Allocate 与一致性结论
- [ ] Terminal 默认 Socket.IO 不变；可选 `webrtc-turn` 可测可连可失败明示
- [ ] 凭据不出现在 git、诊断与控制台明文

## Open Follow-ups（非本阶段阻塞）

1. coturn REST 短期凭证
2. Terminal direct-wss 与 webrtc-turn 的延迟对比面板
3. `auto` 是否产品级允许“二次手动一键应用 relay”以外的半自动策略
