# 页面 Terminal（Tunnel 浏览器交互）完整评测方案

**日期：** 2026-08-01  
**状态：** 可执行评测基线（验收门禁文档）  
**范围：** Viewer 页面 Terminal tab，经 **Cloudflare Tunnel** 公网入口的浏览器交互可用性与性能  
**非范围：** 远程桌面视频画质、桌面 DataChannel 输入、Host 屏幕采集本身（仅作为 Terminal 切换时的隔离副作用检查）

---

## 0. 一句话结论口径

本评测要回答的唯一主问题：

> **在 tunnel 网络条件下，浏览器打开 Viewer → 授权 Terminal → 创建/附着会话 → 键入/粘贴/多行提交/resize/共享观察，是否“可交互、正确、稳定、可观测”，且应用层不得把公网 RTT 再放大到不可用。**

- **通过（PASS）**：所有 **P0 硬门禁** 全部满足，且 **性能门禁** 达到「可用」档或以上。  
- **有条件通过（CONDITIONAL PASS）**：P0 全部满足，性能落在「降级可用」档，且所有降级原因可解释为 **公网 RTT / edge 位置**，应用层开销门禁仍通过。  
- **不通过（FAIL）**：任一 P0 失败，或应用层开销门禁失败，或交互正确性失败，或入口不可交付。

> 历史取证提醒（见 `docs/superpowers/reports/2026-07-11-terminal-performance-analysis.md`）：本地 terminal 是毫秒级；固定域名曾出现 `~400ms` app-level RTT，主因是 tunnel 挂在 `lax*` 边缘，不是 PTY/xterm。本方案必须把 **网络 RTT** 与 **应用开销** 拆开判分，禁止把“远端慢”笼统判成“terminal 实现坏了”，也禁止用“网络本来就慢”掩盖应用层放大。

---

## 1. 被测对象与真实数据路径

### 1.1 被测产品面

| 项 | 说明 |
|----|------|
| 页面入口 | Viewer（`viewer.html`）内 **终端** tab |
| 授权 | Viewer 登录后，Terminal **admin 二次授权** |
| 会话模型 | **共享 PTY session pool**（多浏览器可 attach 同一 shell） |
| 默认传输 | **HTTPS + Socket.IO WebSocket**（`/terminal` namespace） |
| 可选传输 | `webrtc-turn`（DataChannel + TURN，`node-datachannel`）；须显式选择，失败必须明确报错，不得静默回退 |
| 服务端 | `signal-server` + `node-pty` 本机 shell（默认 `/bin/zsh`） |
| 前端 | `@xterm/xterm` + fit + composer + echo controller |

### 1.2 Tunnel 路径（主评测路径）

```
公网浏览器
  → Cloudflare edge（client edge）
  → Cloudflare backbone
  → tunnel edge（named / quick）
  → cloudflared(origin)
  → signal-server:8080
  → Socket.IO /terminal
  → node-pty → shell
  ← 同路径返回 xterm 输出 / input_ack / pong
```

**硬约束（与产品设计一致）：**

1. Terminal **默认继续走 Cloudflare Tunnel 的 WebSocket 路径**，不以“绕过 Tunnel”作为通过条件。  
2. 桌面媒体链路（WebRTC/STUN/TURN）与 Terminal 链路 **解耦**；切到 Terminal 可触发桌面媒体暂停，但不得销毁 Terminal 授权、Socket、PTY。  
3. 评测默认 **不重建 tunnel**；入口地址以既有契约为准：
   - 正式入口：`https://link.stockhub.wiki`
   - debug quick tunnel：`/tmp/wrd-safe-current-url.txt`（仅辅助；不可交付时只能报告，不得自动重建）

### 1.3 关键实现与文档真相源

| 类别 | 路径 |
|------|------|
| 前端面板 | `web-client/js/terminal.js` |
| 回显策略 | `web-client/js/terminal-echo-controller.js` |
| 多行 composer | `web-client/js/terminal-composer.js` |
| 服务端事件 | `signal-server/websocket/terminal.js` |
| 会话/流控 | `signal-server/lib/terminal/session-manager.js`、`flow-control.js` |
| 指标 | `signal-server/lib/terminal/metrics.js` |
| 可选 WebRTC | `signal-server/lib/terminal/webrtc-gateway.js` |
| 运行探针 | `scripts/terminal-runtime-probe.js`、`scripts/terminal-runtime-check.sh` |
| 需求 | `docs/需求文档/WebRemoteDesktop-需求文档.md` §3.7 |
| 延迟语义 | `docs/superpowers/specs/2026-07-11-terminal-cloudflare-tunnel-latency-design.md` |
| 历史性能 | `docs/superpowers/reports/2026-07-11-terminal-performance-analysis.md` |

---

## 2. 评测目标与成功定义

### 2.1 目标

1. **可进入**：经 tunnel 公网入口可交付登录页 / Viewer / Terminal bootstrap。  
2. **可授权**：admin 二次授权稳定，viewer 密码不能越权。  
3. **可交互**：键入、回车、控制序列、粘贴、多行 composer、resize、清屏均正确。  
4. **可共享**：多浏览器 attach 同一 session，输入即时作用于同一 shell；断开浏览器不销毁 PTY。  
5. **可恢复（当前产品语义）**：浏览器断线后可重新授权/附着；**不把“自动恢复原 PTY 上下文”当作已交付能力**（需求中仍为 `[ ]`），但必须验证“PTY 仍在、可 re-attach、replay 可用”。  
6. **可度量**：同钟 RTT / inputAck / serverProcess 可读取，诊断不泄露密钥与原始 IO。  
7. **性能可用**：在 tunnel 条件下满足下文严格性能门禁；应用层不得成为主瓶颈。

### 2.2 非目标（本轮不作为 FAIL 理由）

1. 把公网 RTT 压到本地毫秒级（Cloudflare edge 位置可能无法由应用代码保证）。  
2. 自动重建 quick tunnel / 切换 named tunnel 生命周期。  
3. 把 Terminal 改造成 WebRTC 默认路径。  
4. 完整 shell 不受 `WRD_TERMINAL_CWD` 限制（需求仍为后续项）。  
5. 浏览器断网后 **自动** 重连到原 Terminal 且无人工 re-attach（需求仍为 `[ ]`）。

---

## 3. 环境矩阵与前置条件

### 3.1 必须具备

| 检查项 | 通过条件 | 命令/来源 |
|--------|----------|-----------|
| Terminal 功能开启 | `WRD_ENABLE_TERMINAL=1` 且配置了 `WRD_TERMINAL_ADMIN_PASSWORD` | `signal-server/.env`（不把密码写入评测报告正文） |
| 本地健康 | `GET /health` → 2xx 且 JSON `status=ok` | `curl -fsS http://127.0.0.1:8080/health` |
| 本地状态 | `GET /api/status` 可用 | `curl -fsS http://127.0.0.1:8080/api/status` |
| 正式 tunnel 入口可交付 | `https://link.stockhub.wiki/health` 2xx + `status=ok` | `python3 scripts/wrd_entry_health.py --url https://link.stockhub.wiki` 期望 `deliverable=true` |
| 浏览器 | 最新稳定版 Chrome 或 Edge（主路径）；Safari 作为兼容抽检 | 真实 UI 评测必须用真实浏览器，不得只靠 raw socket |
| 时钟与取证 | 浏览器 Performance/本地 pending 时钟；服务端只报告 server 域处理时延 | 禁止混用浏览器与服务器 wall clock 算 RTT |

### 3.2 评测入口分层（强制）

| 层 | 入口 | 角色 | 是否计入最终 PASS |
|----|------|------|-------------------|
| L0 本地基线 | `http://127.0.0.1:8080` | 证明应用链路健康 | **必须 PASS**（否则整体 FAIL，不论 tunnel） |
| L1 正式 tunnel | `https://link.stockhub.wiki` | **主评测路径** | **必须达到可用档或以上** |
| L2 debug tunnel | `/tmp/wrd-safe-current-url.txt` | 辅助；仅在可交付时采样 | 不替代 L1；若不可交付只记 BLOCKED，不擅自重建 |

### 3.3 禁止事项

1. 评测过程中自动执行 `stop-safe-wrd.sh` / 重建 quick tunnel / 重启 named tunnel（除非用户书面授权且本轮明确包含“入口恢复实验”）。  
2. 把 `http://127.0.0.1:5173` 当作正式入口。  
3. 用 optimistic local echo 伪装“更快”来通过手感主观分。  
4. 在报告中写入 Viewer/Terminal 明文密码、JWT、TURN 凭据、命令原文中的密钥。  
5. 仅用单元测试代替 tunnel 真机评测。

---

## 4. 指标定义（唯一口径）

所有延迟指标必须可复现，且 **单时钟域**：

| 指标 | 定义 | 时钟 | 含义 |
|------|------|------|------|
| `socketRttMs` | `terminal:ping` 发出 → `terminal:pong` 收到 | **仅浏览器本地** | 公网 terminal socket 往返 |
| `inputAckRttMs` | `terminal:input` 发出 → `terminal:input_ack` 收到 | **仅浏览器本地** | 输入送达并 ack 的往返 |
| `serverProcessMs` | `input_ack.serverSentAt - input_ack.serverReceivedAt` | **仅服务端** | 服务端处理输入到回 ack |
| `firstOutputRttMs` | 带 marker 的探针输入发出 → 首个对应输出片段 | **仅浏览器本地** | 用户看到 shell 开始响应 |
| `markerOutputRttMs` | 探针输入发出 → 完整 marker 行回显 | **仅浏览器本地** | 端到端命令可见完成 |
| `appOverheadAckMs` | `inputAckRttMs - socketRttMs`（同窗口样本配对或用 P50 差） | 派生 | 相对纯 RTT 的应用附加 |
| `appOverheadFirstOutMs` | `firstOutputRttMs - socketRttMs` | 派生 | 首输出相对 RTT 附加 |
| `tunnelEdgeRttMs` | cloudflared `quic_client_smoothed_rtt` | origin 本机 metrics | origin→edge |
| `edgeLocation` | `cloudflared_tunnel_server_locations` | origin 本机 metrics | 当前 edge |
| `transport` | `websocket` / `polling` / `webrtc-turn` | 运行时 | 默认必须为 `websocket`（除非显式测可选路径） |

**采样要求（严格）：**

1. 每个入口层至少 **30** 个有效 `ping` 样本，**30** 个有效 input/marker 样本。  
2. 报告 **min / P50 / P95 / max / sampleCount**；禁止只报平均值。  
3. 丢弃明确异常样本（页面后台、tab throttle、devtools 断点、系统睡眠）前必须记录剔除原因与数量；剔除率 **>10%** 则该轮次无效，须重测。  
4. 前端状态栏展示与 `TerminalPanel.getDiagnosticState()` 必须与上述语义一致：`RTT`=`socketRtt`，`输入`=`inputAckRtt`，`服务端`=`serverProcessMs`。

---

## 5. 性能门禁（严格）

### 5.1 L0 本地基线（硬门禁，失败则整体 FAIL）

| 指标 | P50 上限 | P95 上限 | 说明 |
|------|----------|----------|------|
| `socketRttMs`（浏览器） | **≤ 25 ms** | **≤ 60 ms** | UI 路径 |
| `inputAckRttMs` | **≤ 40 ms** | **≤ 80 ms** | |
| `firstOutputRttMs`（`printf` marker） | **≤ 50 ms** | **≤ 100 ms** | |
| `serverProcessMs` | **≤ 10 ms** | **≤ 30 ms** | 与入口无关 |
| raw socket（可选对照） | ping P50 **≤ 5 ms** | **≤ 20 ms** | 剥离 UI |

本地基线失败 ⇒ **应用链路不健康**，tunnel 结果一律无效。

### 5.2 L1 正式 tunnel：网络分档 + 应用开销硬门禁

#### 5.2.1 网络分档（解释“手感”，不单独决定应用好坏）

以浏览器 `socketRttMs` **P50** 分档：

| 档位 | `socketRttMs` P50 | 交互体验预期 | 最终结论可否 |
|------|-------------------|--------------|--------------|
| A 优秀 | ≤ 120 ms | 接近本地可打字 | 可 PASS |
| B 可用 | ≤ 250 ms | 可交互 shell，可感知延迟 | 可 PASS |
| C 降级可用 | ≤ 400 ms | 可操作但吃力；长输出滚动明显 | 最多 CONDITIONAL PASS |
| D 不可用 | \> 400 ms | 连续输入严重拖影/误判 | **性能 FAIL**（除非本轮明确声明“仅取证网络，不验收产品可用性”） |

> 严格策略：产品验收默认要求 **至少 B 档** 才能给 PASS。C 档仅允许 CONDITIONAL PASS，且必须附 edge/RTT 证据证明瓶颈在 tunnel edge 而非应用。D 档性能不通过。

#### 5.2.2 应用开销硬门禁（与 RTT 解耦，**全部必须满足**）

这些门禁用于证明“慢的是网，不是实现”：

| 指标 | P50 上限 | P95 上限 | 失败含义 |
|------|----------|----------|----------|
| `serverProcessMs` | **≤ 15 ms** | **≤ 40 ms** | 服务端处理过慢 |
| `appOverheadAckMs` = P50(inputAck)−P50(socketRtt) | **≤ 40 ms** | — | 输入路径相对 RTT 放大过多 |
| `appOverheadFirstOutMs` = P50(firstOut)−P50(socketRtt) | **≤ 80 ms** | — | 首输出路径放大过多 |
| `inputAckRttMs` P95 / P50 | **≤ 2.0** | — | 长尾失控 |
| `socketRttMs` P95 / P50 | **≤ 1.8** | — | 链路抖动过大（可 CONDITIONAL，若伴随丢包/重连则 FAIL） |
| 连续 5 分钟空闲后首次 `ping` | ≤ 当时窗口 P95×1.5 | — | 假死/唤醒异常 |

#### 5.2.3 交互吞吐硬门禁（tunnel 下）

| 场景 | 通过条件 |
|------|----------|
| 连续键入 40 个可打印字符（约 5~8 字符/秒） | 最终 buffer **零丢失、零乱序、零重复**；最终行与期望完全一致 |
| 粘贴 2 KiB 文本一次 | 一次提交成功；`input_ack` 成功；输出完整；无 session 崩溃 |
| 粘贴 32 KiB 文本一次 | 若 ≤ 64 KiB 单消息上限：成功或明确 `rate_limited`/尺寸拒绝且 **可恢复**；不得挂死 socket |
| 持续 `yes` / 大输出 10s 后 Ctrl+C | 输出可停止；session 仍 `running`；后续 `echo ok` 正常 |
| 多行 composer 提交 20 行 | bracketed paste 开启时一次粘贴语义正确；草稿在 ack 后清空 |

#### 5.2.4 连接建立时延（tunnel）

| 步骤 | 上限 |
|------|------|
| 打开 tunnel URL → 登录页可交互 | **≤ 5 s**（P95，冷缓存可 ≤ 8 s） |
| Viewer 登录成功 → 进入 `viewer.html` | **≤ 3 s** |
| Terminal admin 授权成功 → `/terminal` socket `connected` | **≤ 3 s** |
| `create_session` → `session_created` 且 `processStatus=running` | **≤ `WRD_TERMINAL_STARTUP_TIMEOUT_MS`（默认 10s）**，P50 **≤ 2 s** |
| 首次可键入（xterm 聚焦可输入） | create 后 **≤ 1 s** 额外 |

### 5.3 L2 quick tunnel

仅在 `wrd_entry_health.py` 判定 `deliverable=true` 时采样。性能门禁与 L1 相同，但 **不得** 因 L2 失败否定 L1；L2 不可交付记 `BLOCKED`。

### 5.4 可选 `webrtc-turn` 路径（若环境已配置 TURN）

| 项 | 通过条件 |
|----|----------|
| capability | 前端收到明确 `available=true/false` 与 reason |
| 失败可见性 | 不可用时 UI **明确报错**，不得显示“已连接 webrtc”却无数据 |
| 成功时 | 输入/输出正确；诊断 `transport=webrtc-turn`；延迟样本与 websocket **分桶** |
| 回退 | 不得静默回退到 websocket 并伪装 webrtc 成功 |

未配置 TURN 时本项记 `SKIP`，不阻断主路径 PASS。

---

## 6. 交互正确性门禁（P0，全部硬通过）

下列任一项失败 ⇒ **整体 FAIL**，与 RTT 无关。

### 6.1 入口与鉴权

| ID | 用例 | 通过标准 |
|----|------|----------|
| A1 | tunnel 入口可交付 | `/health` 2xx + `status=ok`；登录页可打开；非 404/410/5xx/错误页 |
| A2 | Viewer 密码登录 | 正确密码进入 Viewer；错误密码拒绝；不泄露内部错误栈 |
| A3 | Terminal 未授权可见性 | Terminal tab 可见但提示需管理员授权；**不能**创建 session |
| A4 | admin 二次授权 | 正确 admin 密码后可 bootstrap/connect；错误密码拒绝 |
| A5 | 权限隔离 | 仅 viewer token 调用 terminal 事件必须拒绝；host token 不得创建 terminal |
| A6 | 授权存储 | admin token 不写入持久 `localStorage`（允许 sessionStorage/内存）；刷新策略符合当前实现且可复测 |
| A7 | `/api/auth/verify` | 正常页面刷新/多 tab **不得** 被密码登录限流打成持续性 `429` 导致 Terminal 不可用 |

### 6.2 会话生命周期

| ID | 用例 | 通过标准 |
|----|------|----------|
| S1 | 创建会话 | `create_session` → `running`；xterm 出现 shell 提示符 |
| S2 | 多会话 | 可创建 ≥2 session；tab 切换状态正确；输入进入当前 active session |
| S3 | 关闭会话 | 显式 close 后 PTY 销毁；迟到 input/resize 返回稳定 `terminal_session_not_found`；**signal-server 不崩** |
| S4 | 浏览器断开不销毁 | 关闭 tab/刷新/断 socket 后，另一浏览器仍可 attach 原 session（共享语义） |
| S5 | exit 后禁输入 | shell `exit` 后 `processStatus=exited`；再 input 被拒绝且 **无成功 ack** |
| S6 | 软/硬上限 | 超 soft warn 有提示；达 hard max（默认 8）拒绝新建且不影响已有 session |
| S7 | replay | 新 observer attach 收到 replay；内容为近期输出前缀/窗口，不要求无限历史 |
| S8 | presence | 多 observer 时 presence/pool_snapshot 反映附着人数变化 |

### 6.3 输入 / 输出 / 回显

| ID | 用例 | 通过标准 |
|----|------|----------|
| I1 | 基本回车 | `echo WRD_MARK_<nonce>` 输出恰好一次且内容正确 |
| I2 | 快速连续输入 | 40 字符无丢字、无乱序 |
| I3 | 控制键 | `Ctrl+C` 中断前台；`Ctrl+L`/清屏按钮行为符合 UI 承诺 |
| I4 | 方向键/编辑 | 在 zsh 行编辑中 Left/Right/Backspace 行为正确（至少基础 readline） |
| I5 | 密码安全回显 | 首批普通输入先作 hidden probe；确认远端 echo 前不错误本地回显密码式输入；Enter/控制键/断线重置 confidence |
| I6 | alternate screen | 进入 `vim`/`less` 等后本地 optimistic echo 策略不破坏 TUI；退出后 shell 可用 |
| I7 | Unicode | 中文、emoji（单测 + 真机各一组）往返正确，不截断半字符到错误状态（允许字体缺字，不允许协议损坏） |
| I8 | 大输出 | `python3 -c 'print("x"*100000)'` 完整到达或在流控下最终完整；session 不退出 |
| I9 | 输入限速 | 超过 token bucket 时出现明确 `terminal_input_rate_limited`（或等价 UI），恢复后可继续 |

### 6.4 Composer（多行）

| ID | 用例 | 通过标准 |
|----|------|----------|
| C1 | Shift+Enter | 仅本地换行，**不**向 PTY 发送 |
| C2 | Enter 提交 | 发送后待 `input_ack` 再清草稿；失败保留草稿 |
| C3 | bracketed paste on | 负载为 `CSI 200~ ... CSI 201~\r` 语义；多行一次执行符合 zsh/readline 预期 |
| C4 | bracketed paste off | 仍提交原始内容+`\r`；UI 不虚假承诺 |
| C5 | 空草稿 Enter | 发送 `\r` |
| C6 | 禁用态 | 未授权/未连接/未附着时不可提交 |
| C7 | 草稿隔离 | 多 session 切换草稿互不串；关闭 session 丢弃对应草稿；**不**持久化到 localStorage |

### 6.5 Resize / Fit / UI

| ID | 用例 | 通过标准 |
|----|------|----------|
| U1 | 窗口 resize | 触发 fit + `terminal:resize`；`stty size` 与 cols/rows 一致（允许 1 行内误差需记录，默认要求完全一致） |
| U2 | tab 切换 | 桌面 ↔ 终端切换不丢 Terminal 授权；回到终端仍可输入 |
| U3 | 媒体暂停隔离 | 切 Terminal 后桌面媒体可暂停；Terminal socket/PTY/admin **不受影响** |
| U4 | 状态栏 | 显示连接状态 + RTT/输入/服务端（有样本时）；文案不把 serverProcess 叫成 RTT |
| U5 | 错误可见 | 创建失败、未启用、未授权、背压 detach 均有明确中文/稳定错误，不静默 |

### 6.6 流控 / 背压 / 多观察者

| ID | 用例 | 通过标准 |
|----|------|----------|
| F1 | 慢 observer | 制造慢消费 observer 时，仅该 observer 因 backpressure detach；其他 observer 与 PTY 继续 |
| F2 | 快 observer 不受害 | F1 期间另一浏览器持续 `echo` 正常 |
| F3 | 单消息上限 | \>64 KiB 单 input 被拒绝；连接仍在 |
| F4 | active presenter（若启用） | 切换 presenter 语义符合当前实现；无双写混乱（以代码契约为准，需在报告写明观察结果） |

### 6.7 安全与环境确定性

| ID | 用例 | 通过标准 |
|----|------|----------|
| X1 | 环境探针 | `scripts/terminal-runtime-probe.js` 在 **本地与 tunnel** 均通过：Python 路径含期望 fragment；exit 后禁输入 |
| X2 | 禁止继承密钥 | PTY env **不得**出现 `JWT_SECRET`、`WRD_TERMINAL_ADMIN_PASSWORD`、`VIEWER_ACCESS_PASSWORD`、`HOST_SHARED_SECRET`、代理/API key 等（与 probe 黑名单一致） |
| X3 | metrics 脱敏 | `/api/admin/terminal/metrics` 无 raw/command/output/secret 字段 |
| X4 | 审计 | admin 登录、create/attach/close/reject 有结构化审计；默认不记录完整 IO |
| X5 | 诊断上报 | “发送日志到服务端”若启用，payload 含 terminal 摘要但不含命令原文/密码 |

### 6.8 与桌面模式共存（副作用）

| ID | 用例 | 通过标准 |
|----|------|----------|
| D1 | 先连桌面再开 Terminal | Terminal 可用；桌面暂停语义符合产品（自动 pause reason 不覆盖 manual-pause） |
| D2 | Terminal 使用中点桌面断开 | 只断浏览器桌面侧；**不**销毁共享 PTY |
| D3 | 网络模式切换（若 UI 有） | 不销毁 Terminal 共享会话 |

---

## 7. 稳定性 / 长跑 / 故障注入（P0/P1）

### 7.1 P0 稳定性

| ID | 场景 | 通过标准 |
|----|------|----------|
| R1 | 连续操作 15 分钟 | 每分钟 20 次 marker echo；成功率 **100%**；无 socket 非预期断开；无 session 意外 exit |
| R2 | 人工断网 10s 再恢复 | UI 显示断开；恢复后可重新连接/附着；已有共享 PTY 仍在（若仍实现为共享且服务未重启） |
| R3 | 刷新页面 | 重新登录/授权后可 attach；replay 可见；无服务端泄漏 session 句柄导致无法创建 |
| R4 | 双浏览器并发输入 | 同一 session 交错输入不崩溃；输出为同一 shell 字符流（可能交错，属共享语义） |

### 7.2 P1（记录但不单独否决 PASS，除非引发 P0）

| ID | 场景 | 期望 |
|----|------|------|
| R5 | 30 分钟空闲后再输入 | 仍可用或明确超时回收（若 `IDLE_TIMEOUT` 配置） |
| R6 | signal-server 重启 | 所有 PTY 结束（设计如此）；UI 明确错误；**不得**表现为“假在线” |
| R7 | cloudflared 边缘切换/抖动 | 允许短中断；恢复后可继续；需记录 edge 变化 |

---

## 8. 评测执行流程（按顺序，不可跳步）

### Phase 0 — 冻结环境快照

1. 记录时间、机器、浏览器版本、OS。  
2. `./scripts/status-safe-wrd.sh` 输出归档（脱敏）。  
3. 记录入口：
   - local `http://127.0.0.1:8080`
   - fixed `https://link.stockhub.wiki`
   - safe URL 文件是否存在（值可 hash，报告可写“present/absent”）
4. `python3 scripts/wrd_entry_health.py --url <fixed>` → 必须 `deliverable=true`。  
5. 确认 `WRD_ENABLE_TERMINAL=1`（不打印密码）。  
6. 可选：抓取本机 cloudflared metrics 的 edge 与 `quic_client_smoothed_rtt`。

**门禁：** Phase 0 失败则停止，结论 `BLOCKED`（环境不可测），不是产品 PASS。

### Phase 1 — 自动化/半自动预检

```bash
# 本地只读预检（不改 tunnel）
WRD_RUNTIME_BASE_URL=http://127.0.0.1:8080 \
WRD_TERMINAL_PROBE_TOKEN=<admin-jwt> \
WRD_TERMINAL_METRICS_TOKEN=<admin-jwt> \
./scripts/terminal-runtime-check.sh
```

建议补充（评测脚本可临时编写，不强制合入）：

1. 对 L1 入口重复 probe（同一 `terminal-runtime-probe.js`，`baseUrl=https://link.stockhub.wiki`）。  
2. 采集 30× ping / 30× marker 的 raw 或 browser 诊断快照。

**门禁：** L0 check 失败 ⇒ FAIL。

### Phase 2 — L0 本地浏览器交互全量

按第 6 章用例表执行 A/S/I/C/U/F/X/D 全套（本地入口）。  
记录诊断 JSON：`TerminalPanel.getDiagnosticState()`。

**门禁：** 任一 P0 失败 ⇒ FAIL；性能必须满足 §5.1。

### Phase 3 — L1 Tunnel 浏览器交互全量（核心）

1. **使用公网浏览器路径**打开 `https://link.stockhub.wiki`（不要用本机 hosts 作弊绕过 tunnel）。  
2. 完整走：登录 → Terminal 授权 → 创建 session → 全套交互用例（可对高成本用例做子集，但 **A/S/I1-I5/C1-C3/U1-U3/X1-X3/R1-R3** 不可省略）。  
3. 性能采样 §4/§5.2。  
4. 双浏览器共享 attach（可用两个配置文件/两个设备；至少两个独立 context）。  
5. 切桌面 tab 验证媒体暂停不影响 Terminal。  
6. 页面“发送日志到服务端”一次，归档 `diag-logs/` 中对应文件（确认无密钥）。

**门禁：**  
- 交互 P0 全过  
- 应用开销硬门禁全过  
- 网络分档 ≥ B → PASS；= C 且应用开销过 → CONDITIONAL；= D → 性能 FAIL

### Phase 4 — 长跑与故障

执行 R1–R4；记录断开/重连次数、错误码、是否出现假在线。

### Phase 5 — 证据包与裁决

产出报告（见 §10），给出 PASS / CONDITIONAL PASS / FAIL / BLOCKED。

---

## 9. 手工操作剧本（Tunnel 主路径最短可复现）

> 以下为评审员逐步操作；每步记录截图或诊断字段。

1. 打开 `https://link.stockhub.wiki`  
2. 输入 Viewer 密码登录  
3. 进入 Viewer，确认可看到 **桌面 / 终端** tab  
4. 打开 **终端**，输入 Terminal admin 密码完成二次授权  
5. 确认状态变为已连接；transport=websocket  
6. 新建 Terminal session，等待 prompt  
7. 输入：
   ```bash
   printf 'WRD_OK_%s\n' "tunnel-$(date +%s)"
   ```
   确认输出一次且正确  
8. 连续快速输入一行英文句子 + Enter，确认无丢字  
9. Composer：Shift+Enter 两行，再 Enter 提交；确认行为符合 bracketed paste 状态  
10. 改变浏览器窗口大小，执行 `stty size`，与 UI cols/rows 对照  
11. 第二浏览器同样授权并 attach 同一 session；在 A 输入 `echo from-A`，B 可见；B 输入 `echo from-B`，A 可见  
12. 关闭 B 页面；A 仍可用；session 仍在  
13. 在 A 执行 `exit`；确认 exited；再输入被拒绝  
14. 切回桌面 tab 再回终端；授权与历史 session 列表语义符合当前实现  
15. 读取状态栏 RTT/输入/服务端，导出诊断

---

## 10. 证据包格式（必须归档）

建议目录：

```text
artifacts/terminal-tunnel-eval/YYYY-MM-DD/
  env-snapshot.md
  phase0-status.txt
  entry-health-fixed.json
  l0-local/
    diagnostic.json
    latency-samples.json
    screenshots/
  l1-tunnel/
    diagnostic.json
    latency-samples.json
    edge-metrics-snippet.txt
    screenshots/
    dual-browser-notes.md
  probes/
    terminal-runtime-check-local.log
    terminal-runtime-probe-tunnel.json
  verdict.md
```

`verdict.md` 最小字段：

```markdown
# Verdict
- Result: PASS | CONDITIONAL PASS | FAIL | BLOCKED
- Network tier (L1): A|B|C|D
- socketRtt P50/P95:
- inputAck P50/P95:
- serverProcess P50/P95:
- appOverheadAck / appOverheadFirstOut:
- P0 failed IDs: []
- edgeLocation / tunnelEdgeRtt:
- Notes:
```

**禁止**把密码、token、完整命令中的秘密写入证据包明文；必要时只保留 hash/inputId。

---

## 11. 最终裁决规则（总表）

| 条件 | 结果 |
|------|------|
| Phase 0 入口/环境不可测 | **BLOCKED** |
| L0 任一 P0 或 §5.1 失败 | **FAIL** |
| L1 任一交互 P0 失败 | **FAIL** |
| L1 应用开销硬门禁失败 | **FAIL**（即使 RTT 很高也不能开脱） |
| L1 网络 D 档（socketRtt P50 > 400ms） | **FAIL**（可用性不达标） |
| L1 网络 C 档 + 应用开销通过 + 交互 P0 全过 | **CONDITIONAL PASS** |
| L1 网络 A/B 档 + 应用开销通过 + 交互 P0 全过 + R1 长跑通过 | **PASS** |
| 仅单元测试绿、无 L1 真机证据 | **不得判 PASS** |

### 11.1 “Tunnel 浏览器交互是否可用”的严格定义

同时满足：

1. 经正式 tunnel 入口可登录、可二次授权、可建立 websocket terminal；  
2. 键入/回车/基础编辑/中断/多行提交/resize 正确且无状态机卡死；  
3. 共享会话语义正确（断浏览器不毁 PTY；可 re-attach）；  
4. 性能至少 B 档，或 C 档且应用开销门禁通过（后者只能 CONDITIONAL）；  
5. 安全探针与 metrics 脱敏通过；  
6. 15 分钟连续 marker 成功率 100%。

任一不满足 ⇒ **不可用（FAIL）** 或 **环境阻塞（BLOCKED）**。

---

## 12. 推荐自动化扩展（本方案执行时可做，不阻塞文档生效）

现有资产：

- `scripts/terminal-runtime-check.sh`：本地只读验收  
- `scripts/terminal-runtime-probe.js`：环境/生命周期探针  
- `web-client/js/terminal*.test.js`、`signal-server/test/terminal-*.test.js`：契约单测  

建议评测轮次增加（可后续合入 scripts，本方案不强制已实现）：

1. `terminal-tunnel-latency-bench.js`：对给定 baseUrl 采 30 样本输出 P50/P95 JSON  
2. Playwright 脚本：tunnel URL 登录 + Terminal 授权 + marker echo（密码从本机运行配置读入，不写仓库）  
3. 双 context 共享 attach 断言  

单测 **全部通过** 是发车条件，**不是** tunnel 可用性通过条件。

---

## 13. 用例优先级速查

| 级别 | 必须通过才能谈可用性 |
|------|----------------------|
| **P0** | A1–A7, S1–S5, I1–I5, C1–C3, U1–U3, X1–X3, R1–R3, §5.1, §5.2.2, 网络档 ≥C 的裁决规则 |
| **P1** | S6–S8, I6–I9, C4–C7, U4–U5, F1–F4, D1–D3, R4–R7, webrtc-turn 可选 |
| **P2** | 美观/文案润色、Safari 全量、极端 1MiB 粘贴、长时间 2h+ soak |

**严格验收默认：P0 全过 + P1 失败数 = 0 才给完美 PASS；允许 P1 最多 2 项记缺陷但仍 PASS 的前提是不影响正确性与数据完整性，且写入缺陷列表。**  
更严选项（推荐用于发布门禁）：**P0+P1 全过** 才 PASS。

---

## 14. 与历史问题的回归清单（必测）

来自既有报告/设计，评测时显式勾选：

1. **不得**再把 `serverReceivedAt - clientSentAt` 当 RTT。  
2. **不得**把 quick tunnel 的“任意 HTTP 响应”当成可交付；必须以 health/页面可交付为准。  
3. **不得**因 `/api/auth/verify` 与登录共用过严限流导致 Terminal 假故障。  
4. 远程慢时必须同时给出 `socketRtt`、`inputAck`、`serverProcess`、edge location。  
5. 关闭 session 后的迟到 input 不得打崩服务端。  
6. 慢 observer backpressure 不得误杀共享 PTY。  
7. 切 Terminal 触发的媒体暂停不得误伤 Terminal 授权与 PTY。

---

## 15. 执行检查清单（打印勾选）

### 环境

- [ ] L0 health ok  
- [ ] L1 entry health deliverable  
- [ ] Terminal enabled + admin password configured  
- [ ] 未擅自重建 tunnel  

### L0

- [ ] 交互 P0  
- [ ] §5.1 性能  
- [ ] runtime-check + probe  

### L1 Tunnel

- [ ] 交互 P0  
- [ ] 双浏览器共享  
- [ ] §5.2.2 应用开销  
- [ ] 网络分档记录  
- [ ] 15 分钟长跑  
- [ ] 诊断/ metrics 脱敏  

### 裁决

- [ ] verdict.md 已写  
- [ ] 证据包完整  
- [ ] 结果：PASS / CONDITIONAL PASS / FAIL / BLOCKED  

---

## 16. 参考

- `docs/需求文档/WebRemoteDesktop-需求文档.md` §3.7 Web Terminal  
- `docs/superpowers/specs/2026-06-27-web-terminal-design.md`  
- `docs/superpowers/specs/2026-07-07-shared-web-terminal-design.md`  
- `docs/superpowers/specs/2026-07-11-terminal-cloudflare-tunnel-latency-design.md`  
- `docs/superpowers/specs/2026-07-19-terminal-hardening-design.md`  
- `docs/superpowers/specs/2026-07-19-terminal-multiline-composer-design.md`  
- `docs/superpowers/reports/2026-07-11-terminal-performance-analysis.md`  
- `docs/runbook-safe-startup.md`  
- `scripts/terminal-runtime-check.sh`  
- `scripts/terminal-runtime-probe.js`  

---

## 17. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-08-01 | 初版：面向 tunnel 浏览器交互的完整评测方案与严格通过门禁 |
