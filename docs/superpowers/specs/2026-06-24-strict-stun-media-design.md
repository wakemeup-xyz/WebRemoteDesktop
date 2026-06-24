# Strict STUN 媒体直连与自动诊断日志设计

## 背景

当前 WebRemoteDesktop 的公网入口依赖 Cloudflare Tunnel 暴露网页、认证接口和 Socket.IO 信令。旧策略为了提高可连通性，在公网入口且未配置 TURN 时会直接或最终切换到 `隧道中继`，把视频帧通过 Cloudflare/Socket.IO 转发。

新的产品边界改为：Cloudflare Tunnel 只负责网页入口、认证、信令和诊断上报；默认媒体路径必须优先尝试 WebRTC 直连，允许 `host`、`srflx`、`prflx` 候选。`TURN relay` 与媒体 tunnel 不再作为失败后的自动兜底，但仍可作为显式手动模式供用户切换。连接失败时必须给出明确失败状态和可诊断日志，默认不自动改走媒体 tunnel。

该设计采用“Strict STUN + 家庭侧可达性优化”。它不承诺穿透所有公司网或所有运营商 NAT。RFC 4787 明确指出，地址和端口依赖过滤这类 NAT 场景下，ICE 可能需要 UDP relay 才能连通；本项目在禁用 TURN/relay 的前提下遇到这类网络必须失败并报错。

参考依据：

- [RFC 8445 ICE](https://datatracker.ietf.org/doc/html/rfc8445)：ICE 使用 STUN/TURN 收集候选并执行连通性检查；仅 STUN 可以得到 server-reflexive 候选，TURN 会产生 relayed 候选。
- [RFC 4787 NAT UDP behavior](https://datatracker.ietf.org/doc/html/rfc4787)：地址和端口依赖过滤可能要求 UDP relay；没有 relay 时应视为不可达网络，而不是继续兜底。
- [MDN WebRTC connectivity](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity)：WebRTC 候选类型包括 `host`、`srflx`、`prflx`、`relay`，UDP 通常优先用于媒体。
- [Cloudflare Tunnel docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)：Cloudflare Tunnel 是 origin 到 Cloudflare 的 outbound-only 连接模型；本项目只把它作为 HTTP/Socket.IO 入口，不把它作为媒体路径。

## 目标

1. 入口与媒体解耦：Cloudflare Tunnel 继续承载网页、登录、`/api/webrtc-config`、Socket.IO 信令和诊断上报。
2. 媒体严格直连：视频和 WebRTC DataChannel 默认只允许 direct ICE 候选，禁止 `relay` 候选成为自动恢复路径，禁止 `startTunnelRelay()` 作为默认兜底路径；但用户显式切换到 TURN / tunnel 模式时可以继续使用既有实现。
3. 失败明确可诊断：连不上时显示具体失败类别、建议检查项和连接尝试 ID，并自动把结构化连接日志发到后端。
4. 家庭侧尽量可达：通过家庭网络、路由器、macOS 防火墙、IPv6、UDP 端口策略提升 STUN/P2P 成功率。
5. 保持可测试：通过前端单测、信令服务测试、Host 日志测试和手工网络场景验证，防止旧 tunnel fallback 回归。

## 非目标

1. 不把 TURN / tunnel 当作 Strict STUN 的自动兜底路径。
2. 不保证公司网、校园网、运营商 CGNAT、双重 NAT、UDP 严格封锁场景一定能连通。
3. 首期不修改 `aiortc` / `aioice` 内部 UDP 端口绑定逻辑；固定端口范围和端口映射作为增强方案单独评估。
4. 不把完整 SDP、JWT、密码、键盘输入内容或未脱敏候选端点写入诊断日志。

## 当前冲突点

以下现状需要在实现阶段改掉或改写为 strict policy：

1. `README.md:77` 写明公网入口且无 TURN 时前端会直接切 `隧道中继`。
2. `README.md:339-341` 写明 `auto` / `relay` 缺 TURN 时会退回 `隧道中继`。
3. `web-client/js/webrtc.js:41-66` 暴露 `relay` 与 `tunnel` 模式，并把 tunnel 描述为最终兜底。
4. `web-client/js/webrtc.js:92-94` 的 `shouldForceTunnelForCurrentContext()` 会在公网入口且无 TURN 时强制 tunnel。
5. `web-client/js/webrtc.js:126-140` 在初始化阶段可直接进入 `startTunnelRelay()`。
6. `web-client/js/webrtc.js:1419-1450` 在 `auto` / `stun` 失败后会调用 `startTunnelRelay()`。
7. `python-host/host.py:122-146` 会从环境变量构造 TURN ICE server；strict 模式下即使环境里有 TURN，也必须忽略或报策略告警。
8. `signal-server/websocket/signaling.js:252-300` 已接收诊断日志，但持久化报告还没有保留完整 `network`、连接事件和失败分类。
9. `web-client/js/diagnostic.js:155-220` 已有手动和冷却自动上报，但目前结构化连接事件不足，失败时可能缺少一次连接尝试的完整上下文。

## 总体架构

```
Viewer Browser
  | HTTPS through Cloudflare Tunnel
  | - static page
  | - auth
  | - /api/webrtc-config
  | - Socket.IO signaling
  | - diagnostics upload
  v
Signal Server
  | local auth / signaling / diagnostics relay
  v
Python Host

Media path:
Viewer Browser <====== WebRTC direct ICE only ======> Python Host
allowed candidate types: host, srflx, prflx
forbidden candidate types: relay
forbidden fallback: Socket.IO / Cloudflare media tunnel
```

Signal Server 仍是必要组件，但只交换 SDP、ICE candidate、控制指令元数据和诊断报告。媒体连接失败后，Signal Server 不应发起 `relay-stream-control`，Viewer 不应请求 `tunnel-frame`，Host 不应启动 JPEG/Socket.IO 帧转发。

## 严格 STUN 策略

新增有效策略名：

```json
{
  "mediaPolicy": "strict-stun",
  "allowTurnMedia": false,
  "allowTunnelMedia": false,
  "diagnosticAutoSend": true
}
```

策略规则：

1. `buildPeerConfig()` 只使用 STUN server，不把 TURN server 传给浏览器 `RTCPeerConnection`。
2. Host 端 `build_ice_servers()` 在 strict 模式下只返回 STUN `RTCIceServer`；如果检测到 `TURN_URLS`，记录 `WRD_POLICY_WARNING turn_ignored_strict_stun`。
3. `networkMode=auto` 的语义改为“优先 LAN/host candidate，然后 STUN direct；失败后最多 ICE restart 一次和完整重连一次，之后终止失败”。
4. `networkMode=stun` 的语义改为“只尝试外网 STUN direct；失败后终止失败”。
5. `networkMode=lan` 继续只依赖 host candidate，适合同网段和本机验证。
6. `networkMode=relay` 与 `networkMode=tunnel` 在 strict policy 下不作为默认推荐选项；UI 中可以保留显式切换入口，但必须标记为“手动模式，非自动兜底”。
7. `localStorage` 中已有的 `wrdNetworkMode=tunnel` 或 `relay` 进入页面时不自动改写为 `auto` 或 `stun`，但必须弹出明显提示，说明当前会话处于非 strict 模式。
8. 如果任意本地或远端 candidate 类型为 `relay`，在 `auto` / `stun` 模式下视为 `policy-violation-relay-candidate`；在用户显式选择 `relay` 模式时，仅记录为 `relay-mode-selected`。
9. 如果进入了 `startTunnelRelay()`、收到 tunnel frame、或发送 `relay-stream-control`，在 `auto` / `stun` 模式下视为 `policy-violation-media-tunnel`；在用户显式选择 `tunnel` 模式时，仅允许作为手动模式运行。

## 连接重试与终止

一次连接尝试用 `connectionAttemptId` 标识。每次页面 init、手动刷新、ICE restart 后的完整重连都生成或派生一次 attempt。

推荐状态机：

1. `init`：加载 server config，确定 `mediaPolicy=strict-stun`。
2. `signaling-connected`：Socket.IO 已连接，仅用于信令和诊断。
3. `peer-created`：创建 `RTCPeerConnection`，只含 STUN。
4. `offer-created` / `answer-received`：完成 SDP 交换。
5. `ice-gathering`：收集 local candidate，记录 candidate 类型。
6. `ice-checking`：加入 remote candidate，等待 selected pair。
7. `direct-connected`：selected pair 类型为 `host`、`srflx` 或 `prflx`，且视频开始出帧。
8. `ice-restart-once`：首次 `ice-failed`、`ice-disconnected`、`pc-failed` 时尝试一次 `restartIce()`。
9. `full-reconnect-once`：ICE restart 后仍失败时完整重建一次 PeerConnection。
10. `terminal-failure`：仍无 direct media，停止重试，显示失败分类并自动上报诊断。

终止条件：

1. `iceConnectionState=failed` 且已尝试允许的恢复动作。
2. `connectionState=failed` 且已尝试允许的恢复动作。
3. ICE gathering complete 后没有任何可用 remote candidate。
4. 20 秒内没有 selected candidate pair。
5. selected pair 已建立但 10 秒内 `0 FPS` 或没有第一帧。
6. 出现 `relay` candidate 或 tunnel media 路径。

## 失败分类

Viewer 自动计算 `failureCategory`，Host 和 Signal Server 只记录并展示，不重新猜测。

| 分类 | 判据 | 用户可见解释 |
|------|------|--------------|
| `local-stun-unreachable` | 本地没有 `srflx`，STUN request 没得到候选 | 当前浏览器网络无法访问 STUN/UDP，可能是公司网阻断 UDP |
| `host-stun-unreachable` | Host 没有 `srflx` 或 Host 上报 STUN 失败 | 家庭侧 Host 无法通过 STUN 暴露公网候选，检查 macOS 防火墙、路由器和 ISP |
| `remote-candidate-missing` | Viewer 没收到 Host 的 usable candidate | 信令候选交换不完整或 Host ICE 采集失败 |
| `candidate-check-failed` | 两侧都有 `srflx`/`prflx`，但没有 selected pair | NAT 映射/过滤不兼容，严格 STUN 无法穿透 |
| `company-udp-blocked` | Viewer 端只有 TCP/无 UDP，或 ICE check 全失败且网络类型像企业代理 | 公司/校园网络限制 UDP/WebRTC |
| `media-timeout-after-selected-pair` | selected pair 已建立但持续 0 FPS | ICE 已通但媒体未出帧，检查 Host 编码、浏览器解码、track 状态 |
| `policy-violation-relay-candidate` | 任一 candidate 类型为 `relay` | 当前策略禁止 TURN relay |
| `policy-violation-media-tunnel` | 触发 tunnel relay 或收到 tunnel frame | 当前策略禁止 Cloudflare/Socket.IO 媒体隧道 |

成功分类：

| 分类 | 判据 | 含义 |
|------|------|------|
| `lan-direct` | selected pair 为 `host` | 同网段或本机直连 |
| `stun-direct` | selected pair 为 `srflx` 或 `prflx` | 外网 STUN/P2P 成功 |
| `ipv6-direct` | selected pair 地址族为 IPv6 且不是 relay | IPv6 直连成功 |

## 自动连接日志

### Viewer 端事件缓冲

新增结构化连接事件缓冲，和现有 console 日志并存：

```json
{
  "connectionAttemptId": "wrd-20260624-123456-abcdef",
  "event": "ice-connection-state",
  "at": 1782345678.12,
  "wallTime": 1782345000000,
  "mode": "auto",
  "mediaPolicy": "strict-stun",
  "data": {
    "state": "checking"
  }
}
```

事件名：

1. `session-start`
2. `config-loaded`
3. `policy-normalized-mode`
4. `socket-connected`
5. `peer-created`
6. `offer-created`
7. `answer-received`
8. `candidate-local`
9. `candidate-remote`
10. `ice-gathering-state`
11. `ice-connection-state`
12. `pc-connection-state`
13. `selected-candidate-pair`
14. `first-video-frame`
15. `zero-fps-window`
16. `ice-restart`
17. `full-reconnect`
18. `terminal-failure`
19. `policy-violation`
20. `diagnostic-send`

缓冲规则：

1. 最多保留最近 300 条结构化事件。
2. candidate 事件只保留类型、协议、地址族、端口是否存在、STUN/TURN 来源类别，不默认保留完整公网 IP。
3. 默认不上传完整 SDP、JWT、密码、访问 URL query、键盘内容、鼠标坐标序列。
4. 如果需要临时保留完整候选端点，必须显式设置 `WRD_DIAG_INCLUDE_ENDPOINTS=1`，并在报告里标记 `endpointRedaction=disabled`。

### 自动上报触发

自动上报必须走后端，不依赖用户手动点诊断按钮。

触发时机：

1. 首次 terminal failure。
2. 发现 policy violation。
3. selected pair 建立但 10 秒内无第一帧。
4. ICE restart 和 full reconnect 都失败。
5. 用户点击诊断按钮。
6. 可选：首次 direct 成功时上传一份 compact success snapshot，便于对比失败样本。

限速：

1. 同一个 `connectionAttemptId` 的 terminal failure 必须发送一次，不受普通冷却限制。
2. 非终止类自动上报 15 秒冷却。
3. 单个页面 session 最多自动发送 5 份失败报告，超过后只在 UI 中提示本地日志已保留。
4. 发送失败时写入 `localStorage.wrdPendingDiagnostics`，下一次信令连接成功后补发最近 2 份。

### 上报通道

首选沿用现有 Socket.IO `diagnostic` 事件，因为页面在 Cloudflare Tunnel 入口下通常仍能访问 Signal Server。

增强为双通道：

1. Primary: `WebRTC.socket.emit('diagnostic', payload)`。
2. Fallback: `POST /api/diagnostics`，Bearer token 鉴权，供 Socket.IO 尚未连上或已断开时使用。
3. Last resort: 临时 Socket.IO 连接，保留现有行为。

`POST /api/diagnostics` 和 Socket.IO 使用同一套脱敏、限额、持久化逻辑，避免两套报告格式。

### 诊断 payload

```json
{
  "type": "connection-diagnostic",
  "schemaVersion": 2,
  "trigger": "auto-failure",
  "reason": "candidate-check-failed",
  "connectionAttemptId": "wrd-20260624-123456-abcdef",
  "viewerSocketId": "abc123",
  "offerEpoch": 3,
  "mediaPolicy": "strict-stun",
  "networkMode": "auto",
  "failureCategory": "candidate-check-failed",
  "candidateSummary": {
    "local": { "host": 1, "srflx": 1, "prflx": 0, "relay": 0, "other": 0 },
    "remote": { "host": 1, "srflx": 1, "prflx": 0, "relay": 0, "other": 0 }
  },
  "selectedCandidatePair": null,
  "pc": {
    "connectionState": "failed",
    "iceConnectionState": "failed",
    "iceGatheringState": "complete",
    "signalingState": "stable"
  },
  "events": [],
  "logs": [],
  "latency": null,
  "inputState": {
    "keyboardMode": "mac",
    "pendingKeys": 0,
    "lastReleaseAllReason": null,
    "lastKeyboardResetReason": null,
    "recentInputEvents": []
  },
  "redaction": {
    "sdp": "omitted",
    "tokens": "omitted",
    "keyboardDebug": "omitted",
    "candidateEndpoints": "redacted"
  }
}
```

## 后端日志与持久化

Signal Server：

1. `redactDiagnosticPayload()` 保留 `schemaVersion`、`connectionAttemptId`、`mediaPolicy`、`failureCategory`、`candidateSummary`、`selectedCandidatePair`、`events`、`pc`、`redaction`。
2. `persistDiagnostic()` 报告文件包含完整脱敏后的 `network` 和 `events`，不再只写 logs/latency/input。
3. 持久化目录仍为系统临时目录 `os.tmpdir()/wrd-diag`，默认由 `WRD_ENABLE_DIAG_PERSIST=1` 控制。
4. 清理策略保留现有 7 天、每 viewer 3 份、总数 50 份上限，可按 schemaVersion 兼容旧报告。
5. 每份失败报告在 server log 打一条摘要：`WRD_STUN_FAILURE viewer=<id> attempt=<id> category=<cat> mode=<mode> policy=strict-stun local=<counts> remote=<counts> selected=<pair>`。

Python Host：

1. 继续接收 Signal Server relay 的 `diagnostic` 事件，用于实时排查。
2. 将 `WRD_FAILURE_DIAG` 升级或新增为 `WRD_STUN_FAILURE`，包含 `connectionAttemptId`、`failureCategory`、candidate counts、selected pair、pc state、ice state。
3. Host 自身 ICE 采集时记录本地 candidate 类型计数，并通过 `host-ice-summary` Socket.IO 事件发给 Viewer，避免 Viewer 只能看远端传来的 candidate 样本。
4. strict 模式下发现 TURN env 存在时记录 `WRD_POLICY_WARNING turn_ignored_strict_stun`。

## 家庭侧可达性优化方案库

这些方案全部遵守“无 TURN、无 VPS、无媒体 tunnel”。它们的作用是提高 strict STUN 成功率，不能把失败网络变成有保证可达。

### 方案 A：基线 Strict STUN

适用：家庭网络普通 NAT，公司网络允许 UDP/WebRTC。

动作：

1. 使用多个稳定 STUN server，例如 Google STUN 和一个备用 STUN。
2. Viewer 和 Host 都只收集 `host`、`srflx`、`prflx`。
3. 失败时不兜底，直接输出失败分类。

优点：改动小，风险低，最符合当前产品边界。

限制：遇到 CGNAT、双重 NAT、企业 UDP 阻断、地址和端口依赖过滤时会失败。

### 方案 B：家庭网络整理

适用：Host 在家庭宽带，用户可以调整路由器或光猫。

动作：

1. 避免双重 NAT：光猫改桥接，主路由拨号；或只保留一级 NAT。
2. 路由器优先选择 endpoint-independent mapping/filtering、NAT cone、Full Cone、Open NAT 这类更利于 UDP hole punching 的选项。
3. 关闭会改写 UDP/STUN 的 SIP ALG、严格防火墙、家长控制或企业安全网关功能。
4. macOS 防火墙允许 Python、Node、浏览器相关进程接收本地网络连接；如果使用 LaunchAgent，确保实际运行的 Python 解释器被允许。
5. 确认 ISP 没有 CGNAT：路由器 WAN IP 应与公网查询 IP 一致；不一致时 strict STUN 成功率会明显下降。
6. 优先有线网络或稳定 Wi-Fi，避免热点和多层 Mesh 中继带来的 NAT 和丢包。

优点：不改代码也能显著提高家庭侧可达性。

限制：不能解决公司侧 UDP 阻断；CGNAT 下仍可能失败。

### 方案 C：IPv6 优先直连

适用：家庭宽带和公司网络都提供可用公网 IPv6。

动作：

1. Host 检测是否有 global IPv6 address，并在诊断里标记 `hostIpv6Available`。
2. Viewer 收集 IPv6 candidate，并在候选摘要中区分 `ipv4` / `ipv6`。
3. UI 成功时显示 `ipv6-direct`，失败时提示“双方未同时具备可用 IPv6”。
4. 路由器和 macOS 防火墙允许入站 UDP/WebRTC 相关流量；IPv6 没有 NAT，但仍可能有防火墙过滤。

优点：绕过 IPv4 NAT 类型限制，家庭到公司场景可能明显更稳定。

限制：公司网常常禁 IPv6 或只提供代理访问；IPv6 防火墙策略仍会阻断。

### 方案 D：STUN 预检与 NAT 倾向判断

适用：需要先判断“这条网络有没有希望 strict STUN”的场景。

动作：

1. Viewer 页面在连接前或失败后运行多 STUN server 候选采集，记录是否能得到 `srflx`。
2. Host 也记录自身 STUN 候选计数，并上报到诊断。
3. 比较多个 STUN server 下的 server-reflexive 端点是否稳定；不稳定时提示可能是 symmetric/endpoint-dependent NAT。
4. 预检只用于分类和提示，不把失败预检改为 tunnel 或 TURN。

优点：失败原因更快可见，减少盲试。

限制：浏览器和 aiortc 对候选来源暴露有限，只能做倾向判断，不能作为绝对 NAT 类型检测。

### 方案 E：固定 UDP 端口范围与家庭端口映射

适用：用户愿意做高级路由器配置，并且我们愿意维护 aiortc/aioice 适配。

当前事实：本机 `aioice` 在 `ice.py` 中用 `local_addr=(address, 0)` 绑定 UDP socket，端口由系统随机分配；aiortc 公开 `RTCConfiguration` 只接受 ICE servers，不暴露端口范围配置。因此首期不能可靠要求用户做固定端口映射。

后续增强：

1. 增加 `WRD_ICE_UDP_PORT_RANGE=50000-50100`。
2. 通过 vendored `aioice` patch 或可维护的 monkey patch，让 Host ICE 在该范围内绑定 UDP。
3. 路由器把该 UDP 端口范围转发到 Mac 的固定内网 IP。
4. 诊断报告写入实际绑定端口范围、端口分配失败原因和 router mapping 建议。

优点：家庭侧可达性最高，尤其适合家庭 Host 长期使用。

限制：需要维护底层库改动；公司侧如果禁止 UDP 仍失败；端口映射会扩大家庭网络暴露面，必须配合认证和防火墙。

## UI 行为

网络模式面板：

1. 显示当前策略：`媒体策略：Strict STUN - 禁止 TURN / 禁止媒体 tunnel`。
2. 可选模式只保留 `本地直连`、`自动直连`、`外网 STUN 直连`。
3. `外网中继` 和 `隧道中继` 不作为可点击选项；如果保留在 UI 中，只能显示禁用态和原因。
4. 旧 localStorage 模式被修正时显示一次小提示：`当前策略禁止媒体中继，已切换到自动直连`。

连接失败面板：

1. 标题明确：`WebRTC 直连失败，未切换媒体隧道`。
2. 展示 `failureCategory`、`connectionAttemptId`、候选摘要、selected pair 状态。
3. 给出按分类收敛的建议，例如检查公司网 UDP、家庭路由器 NAT、macOS 防火墙、IPv6。
4. 显示诊断状态：`诊断日志已自动发送到后端` / `发送失败，已本地缓存待重发`。

成功状态：

1. 顶部状态栏显示 `LAN direct`、`STUN direct` 或 `IPv6 direct`。
2. 如果出现 `relay` 或 `tunnel`，不显示成功，而是 policy violation。

## 输入通道边界

视频媒体失败时，不允许通过 Socket.IO input fallback 继续形成“看不到画面但还能控制”的半中继会话。

允许的控制通道：

1. 信令、认证、诊断继续走 Socket.IO/HTTP。
2. 当 direct media 已连接且 selected pair 符合 strict policy 时，输入优先走 WebRTC DataChannel。
3. direct media 已连接但 DataChannel 短时不可用时，可以保留 Socket.IO input fallback 作为控制兜底，但必须在日志中标记 `inputTransport=socketio-control-fallback`，且不能用于恢复媒体失败。

禁止的控制通道：

1. 媒体失败后继续发送可交互输入。
2. 以 Socket.IO input fallback 作为“远控已可用”的成功判据。
3. 任何 JPEG/video frame over Socket.IO。

## 测试方案

前端单测：

1. public origin + no TURN + `auto` 不再调用 `startTunnelRelay()`。
2. `stun` 连续失败后进入 terminal failure，不调用 `startTunnelRelay()`。
3. `relay` / `tunnel` localStorage 在 strict policy 下保留但不影响默认模式。
4. relay candidate 在 `auto` / `stun` 模式下被识别为 `policy-violation-relay-candidate` 并自动上报。
5. tunnel media 入口在 `auto` / `stun` 模式下触发 `policy-violation-media-tunnel`。
6. `scheduleReconnect()` 只尝试一次 ICE restart 和一次 full reconnect。
7. 自动诊断 payload 包含 `connectionAttemptId`、`events`、`candidateSummary`、`failureCategory`，不包含 SDP、token、keyboardDebug。
8. 成功 selected pair 为 `host`、`srflx`、`prflx` 时分别显示 direct success。

Signal Server 测试：

1. Socket.IO `diagnostic` 和 `POST /api/diagnostics` 共用脱敏函数。
2. 持久化报告包含 `network`、`events`、`failureCategory`、`connectionAttemptId`。
3. 默认不持久化，`WRD_ENABLE_DIAG_PERSIST=1` 时写入 `os.tmpdir()/wrd-diag`。
4. candidate endpoint 默认脱敏；开启 `WRD_DIAG_INCLUDE_ENDPOINTS=1` 才保留完整端点。
5. 非 viewer role 不能上传诊断。

Host 测试：

1. strict policy 下 `build_ice_servers()` 忽略 TURN env，只返回 STUN。
2. Host 收到 schemaVersion 2 诊断时输出 `WRD_STUN_FAILURE` 摘要。
3. Host 能处理旧 schemaVersion 1 报告，不崩溃。

手工验证：

1. 本机 `localhost`：应为 `lan-direct`。
2. 同一局域网另一设备：应为 `lan-direct` 或 `stun-direct`。
3. Cloudflare public URL + 家庭普通 NAT + 手机热点或外部网络：成功时必须为 `stun-direct` 或 `ipv6-direct`。
4. 模拟 UDP/STUN 阻断：页面必须 terminal failure，日志自动上报，不出现 tunnel frame。
5. 人为设置 TURN env：strict policy 必须忽略 TURN，并记录 warning。
6. 人为把 localStorage 设为 `tunnel`：页面必须 normalize，不可进入 tunnel relay。

## 文档迁移

实现时必须同步更新：

1. `README.md`：删除或重写“公网入口无 TURN 直接/最终切隧道”的旧说明。
2. `docs/runbook-safe-startup.md`：明确 quick tunnel 只保证网页入口，不代表媒体可达。
3. `docs/需求文档/WebRemoteDesktop-需求文档.md`：网络模式从“中继兜底”改为“严格直连，失败上报”。
4. `.env.example`：增加 strict policy 和诊断 endpoint 相关变量说明。

## 分阶段落地建议

### Phase 1：硬策略与日志

1. 引入 `mediaPolicy=strict-stun`。
2. 移除所有 strict policy 下的 tunnel fallback。
3. 禁用 relay/tunnel UI。
4. 增加连接事件缓冲和 terminal failure 自动上报。
5. 后端持久化 schemaVersion 2 诊断报告。

### Phase 2：失败分类与家庭侧指导

1. 完善 `failureCategory`。
2. UI 展示分类建议。
3. Host 上报自身 candidate 计数。
4. README/runbook 增加家庭路由器、IPv6、CGNAT 检查步骤。

### Phase 3：高级可达性

1. STUN 预检页面或面板。
2. IPv6 成功/失败专项显示。
3. 评估 `WRD_ICE_UDP_PORT_RANGE` 和 vendored `aioice` 端口绑定策略。

## 验收标准

1. 在 strict policy 下，代码路径中任何自动恢复都不会调用媒体 tunnel。
2. 用户无法手动选择媒体 tunnel 或 TURN relay。
3. 失败时页面明确显示“未切换媒体隧道”，并显示失败分类。
4. 失败诊断自动发送到后端；开启持久化后可在系统临时目录找到 schemaVersion 2 报告。
5. 报告中能看到候选类型、连接状态、重试轨迹、失败分类和 attempt ID。
6. 文档不再把 tunnel relay 描述为当前公网远控的兜底路径。
7. 单测覆盖旧行为不会回归。
