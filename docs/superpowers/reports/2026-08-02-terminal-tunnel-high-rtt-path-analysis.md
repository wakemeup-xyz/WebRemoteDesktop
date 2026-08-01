# Terminal Tunnel 高 RTT 根因与路径决策分析

**日期：** 2026-08-02  
**范围：** Cloudflare Tunnel 上页面 Terminal（Socket.IO）延迟；named tunnel edge；本机出口 colo；TURN DataChannel 备选路径  
**关联：** `docs/superpowers/plans/2026-08-01-page-terminal-tunnel-browser-evaluation-plan.md`  
**评测证据：** `artifacts/terminal-tunnel-eval/2026-08-01/`

---

## 1. 结论摘要

| 问题 | 结论 |
|------|------|
| 应用层是否仍把 RTT 串行放大？ | **已修复**（windowed output flow-control，commit `7902492`） |
| named tunnel 重启能否离开 `lax*`？ | **不能**。用户授权重启后 edge 仍全是 `lax*`，origin→edge QUIC RTT 仍 ~190ms |
| 客户端为何常进 SJC/LAX colo？ | `loc=CN` 但 anycast 入口在美西/港波动；与 ISP/跨境路径有关，**不是 Terminal 代码 bug** |
| 高 RTT 时切 webrtc-turn 能否保证 B 档？ | **不保证**。当前 TURN 主机在 **Los Angeles**（TCP:3478 ~515ms），与 CF tunnel 同属美西底盘 |
| 产品正确策略 | 默认保持 Socket.IO；**高 RTT 时手动推荐**尝试 TURN；**禁止自动切换/静默回退**；分桶展示延迟 |

一句话：**交互正确性与应用开销已过关；网络 B 档被「Origin/TURN 都落美西」的物理路径卡住，不是再改 PTY/xterm 能消掉的。**

---

## 2. 真实拓扑（架构正确性）

```
[Browser, loc=CN]
    │  HTTPS/WSS anycast (colo 常见 HKG 或 SJC/LAX)
    ▼
[Cloudflare network]
    │  backbone → tunnel edge
    ▼
[cloudflared named: wrd-tunnel]  ← 实测 edge 固定 lax*
    │  ~185–200ms QUIC RTT origin↔edge
    ▼
[signal-server :8080]
    ├─ /terminal Socket.IO  → node-pty → shell     ← 默认路径
    └─ TerminalWebRtcGateway (node-datachannel)
           ↕ TURN relay (iceTransportPolicy=relay)
    [TURN 144.225.130.238:3478]  ← 地理：Los Angeles, US
```

桌面媒体链路与 Terminal **解耦**；本分析只动 Terminal 传输选择语义，不改 desktop mode 矩阵。

### 2.1 进程与 metrics 端口（本机实测）

| 进程 | 角色 | metrics |
|------|------|---------|
| `cloudflared … config.yml run wrd-tunnel` | **正式 named tunnel**（`link.stockhub.wiki`） | `127.0.0.1:20242` |
| `cloudflared … --config /dev/null --url http://127.0.0.1:8080` | debug quick tunnel | `127.0.0.1:20244` |
| `cloudflared tunnel run --token …` | **另一套 token 隧道**（非 WRD credentials-file 契约；status 会告警） | 另有监听；**不要当作 wrd-tunnel** |

正式入口只应认 **credentials-file + wrd-tunnel**。token 进程是安全与排障噪声源，但未在本轮擅自杀掉（可能服务其他系统）。

---

## 3. Named tunnel edge 实验（已授权执行）

### 3.1 操作

- **只**重启 named `wrd-tunnel`（`launchctl` label `com.webremotedesktop.fixed-domain`）
- **未**重建 quick tunnel，**未**改 `/tmp/wrd-safe-current-url.txt`
- **未**使用会杀 signal-server/host 的完整 `start-fixed-domain.sh` 一键脚本（避免扩大爆炸半径）

### 3.2 结果

| 时刻 | edge locations | origin→edge smoothed RTT | L1 socketRtt P50 |
|------|----------------|--------------------------|------------------|
| 重启前 | lax01/05/07/08/10/11 | ~185–213ms | ~468–638ms |
| 重启后 | **仍全部 lax\*** | ~185–197ms | **更差** ~830ms（抖动） |

`https://link.stockhub.wiki/health` 在重启后仍 `deliverable=true`。

**推断：** Cloudflare 将本 origin 的 tunnel 控制连接稳定锚在美西 PoP；进程级 reconnect **不能**把 edge 迁到 HKG/NRT/SIN。要换 edge 需要 **出口 IP/区域/中转架构** 级变更，不是 `cloudflared` 重启彩票。

---

## 4. 本机出口与客户端 colo

### 4.1 观测

- 公网 IP：`120.229.11.141`，`cdn-cgi/trace` 报 `loc=CN`
- 访问 `link.stockhub.wiki` 的 colo：**HKG 与 SJC 波动**（同机连续采样两种都出现）
- `cloudflare.com` trace 曾稳定 `colo=LAX`
- 环境存在 `LOCAL_HTTP_PROXY_URL=http://127.0.0.1:1087` 等本地代理变量；评测用 Node/curl **未**设置 `http_proxy` 时仍见高 RTT + 美西/港 colo → **主因不是评测脚本误走代理**，而是跨境 anycast/ISP 路径

### 4.2 路径含义

即使浏览器进 **HKG**，Terminal 默认路径仍要：

`HKG →（骨干）→ LAX tunnel edge → 本机 origin → 原路返回`

因此 app-level RTT 落在 **~400–800ms** 与历史取证一致，**在 edge 迁出美西之前无法稳定进入评测 B 档（≤250ms）**。

---

## 5. TURN DataChannel 产品决策

### 5.1 能力现状

- 服务端 `terminal:webrtc_capability` → `available: true`（`node-datachannel` + TURN 已就绪）
- UI 已有传输下拉：`socketio`（默认）/ `webrtc-turn`
- 既有硬约束：**失败必须可见，禁止静默回退 Socket.IO 并假装在线**

### 5.2 TURN 地理

- 配置来源：`~/.StockHub/turn.json`（host `144.225.130.238:3478`）
- 地理：**Los Angeles, US**（与 tunnel edge 同区）
- 本机 TCP 连接 3478：~**515ms**

因此：**推荐 TURN 是「换一条可对比路径」，不是「承诺达到 B 档」。**  
若未来要真正服务 CN 交互，需要 **亚洲 TURN** 和/或 **亚洲侧 tunnel 出口**，与前端推荐文案分开治理。

### 5.3 已落地的产品行为（代码）

在 `web-client/js/terminal.js`：

1. `classifyTerminalNetworkTier` / `buildTerminalTransportAdvice`：与评测 A/B/C/D 对齐  
2. 当 **Socket.IO** 且 `socketRtt P50 > 250ms` 且 TURN available →  
   - 传输状态提示可 **手动** 切换 TURN  
   - 下拉项标注「高 RTT 可尝试」  
   - **不**自动改 `preferredTransport`  
3. 诊断 `getDiagnosticState()` 增加：`networkTier`、`transportAdvice`、`preferredTransport`、`webrtcAvailable`  
4. 修正 webrtc `ack` 时钟：RTT 仍走 browser pending；仅 `serverProcessMs` 进服务端域  
5. 单测 68 全绿（含「高 RTT 推荐但不自动切换」）

### 5.4 明确非目标

- 不把 webrtc-turn 设为默认（公网入口与鉴权仍依赖 Tunnel/WSS）  
- 不在 TURN 失败时偷偷回 Socket.IO 并显示“已连接 TURN”  
- 不在本轮迁移 TURN 主机或购买亚洲 PoP（需独立运维决策）

---

## 6. 评测门禁对照（当前）

| 门禁 | 状态 |
|------|------|
| L0 本地性能 | PASS |
| L1 交互 P0 | PASS |
| 应用开销 | PASS（windowed flow-control 后 firstOut≈1 RTT） |
| 15 分钟 soak | PASS 298/298 |
| 网络 ≥ B | **FAIL（D）** — 路径地理，非应用回归 |
| 安全探针 | PASS（本地） |
| 不重建 quick tunnel / 不用假 echo | PASS |

整体：**应用与交互可用；严格网络 B 档未过。**

---

## 7. 后续运维选项（需单独授权）

按侵入性排序：

1. **亚洲侧反向出口**：HK/SG VPS 跑 `cloudflared`，私有线路回源自宅（改 edge 地理）  
2. **亚洲 TURN**：把 `turn.json` 迁到近用户区域后复测 webrtc-turn 是否进入 B/C  
3. **清理 token 版 cloudflared**：确认非本仓库依赖后淘汰，减少 status 告警与 metrics 混淆  
4. **接受 D 档公网 Terminal**：文档写明「远程 shell 可用但手感受跨境 RTT 限制」，本地 `127.0.0.1:8080` 仍为低延迟路径

---

## 8. 变更与证据索引

| 项 | 位置 |
|----|------|
| 输出窗口化 | `signal-server/lib/terminal/flow-control.js`（`7902492`） |
| 高 RTT 推荐 | `web-client/js/terminal.js` + `terminal.test.js` |
| Edge 实验日志 | `artifacts/terminal-tunnel-eval/2026-08-01/l1-tunnel/named-tunnel-edge-experiment.txt` |
| 重启后延迟 | `…/latency-samples-after-named-restart.json` |
| 评测 verdict | `artifacts/terminal-tunnel-eval/2026-08-01/verdict.md` |
