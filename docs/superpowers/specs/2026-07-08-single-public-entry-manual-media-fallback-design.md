# 单公网入口与手动媒体降级链设计

日期：2026-07-08

## 背景

当前仓库同时存在两类公网访问路径：

1. 固定域名命名隧道：`link.stockhub.wiki`
2. 临时 quick tunnel：`trycloudflare` URL

这两条路径并存带来了两类问题：

1. 用户入口不稳定。`trycloudflare` 临时域名会过期，不适合作为长期正式入口。
2. 入口和媒体路径混在一起。用户很容易把“网页能打开”和“远程桌面媒体可连通”当成一件事。

同时，当前产品仍然需要保留多种媒体连接模式：

- `auto / stun`：优先低延迟直连
- `relay`：TURN 中继
- `tunnel`：Cloudflare/Socket.IO 媒体 tunnel 最终兜底

本次设计目标是把“稳定公网入口”和“媒体连接降级链”系统化拆开，同时增强连接日志与失败诊断，让用户只记一个公网地址，但仍能在网络受限时手动切换媒体模式。

## 已确认的产品边界

本设计基于以下已确认约束：

1. 正式用户入口只保留一个公网域名：`https://link.stockhub.wiki`
2. 不引入 Tailscale / Headscale 作为浏览器媒体备路
3. 不新增面向用户的“内部设备入口”
4. 继续保留媒体 `tunnel` 模式，作为 TURN 之后的最终兜底
5. 用户体验采用手动优先策略：系统只提示，不自动切换 mode
6. 连接失败时，前端必须主动向服务端发送结构化诊断日志

## 目标

1. 把 `link.stockhub.wiki` 收敛为唯一正式公网入口。
2. 把 quick tunnel 降级为调试/应急工具，不再作为长期交付给用户的公网地址。
3. 保留并清晰表达三层媒体降级链：`direct -> TURN -> tunnel`。
4. 让用户在同一个公网入口下手动切换媒体模式，而不是切换入口域名。
5. 建立统一的连接尝试日志、失败分类和诊断上报机制。
6. 让运维可以区分入口问题、Host 问题、STUN 问题、TURN 问题和 tunnel 问题。

## 非目标

1. 不在本阶段引入 Tailscale / Headscale。
2. 不在本阶段改为自动切换 `relay` 或 `tunnel`。
3. 不在本阶段删除现有 `lan / auto / stun / relay / tunnel` 模式。
4. 不在本阶段彻底废除 quick tunnel 脚本；它仍可作为调试和临时排障工具存在。
5. 不承诺不配置 TURN 的公网环境下仍能稳定媒体直连。

## 现状与问题

### 入口层现状

仓库和本机当前已经具备固定域名命名隧道能力：

- `~/.cloudflared/config.yml` 将 `link.stockhub.wiki` 绑定到本地 `http://localhost:8080`
- `cloudflared tunnel run wrd-tunnel` 已作为固定域名入口运行

但 quick tunnel 仍常驻，并且历史上被用于对外交付，导致：

1. 用户可能继续使用不稳定的 `trycloudflare` URL
2. 运维状态源分裂为 fixed-domain 和 safe quick tunnel 两套
3. tunnel 过期时，用户误以为整个系统不可用

### 媒体层现状

当前前端保留多种模式，并且 `tunnel` 模式仍作为低成功率网络下的最终兜底存在。仓库内已有 strict STUN 设计与相关优化，但当前产品策略仍需要保留：

- `auto / stun`：尝试直连
- `relay`：TURN 中继
- `tunnel`：Cloudflare/Socket.IO 媒体转发

现有问题是：

1. 模式语义对用户不够清楚
2. 失败时系统给出的下一步动作不够明确
3. 连接失败的过程证据不完整，服务端常常只有零散控制台日志

## 总体设计

### 一、入口与媒体解耦

公网入口与媒体路径必须明确解耦：

1. `link.stockhub.wiki` 只承担：
   - 静态页面
   - 登录认证
   - `/api/webrtc-config`
   - Socket.IO 信令
   - 诊断日志上传
2. 媒体模式只决定“桌面画面和输入的传输方式”，不决定用户访问哪个地址。

用户视角始终是：

```text
打开 https://link.stockhub.wiki
  -> 登录
  -> 进入 viewer
  -> 如有需要，在同一页面手动切换媒体 mode
```

### 二、正式入口策略

正式公网入口只保留：

- `https://link.stockhub.wiki`

quick tunnel 调整为：

1. 不再作为 README、runbook、状态回报里的默认推荐入口
2. 不再作为对用户的长期交付地址
3. 保留给：
   - 调试
   - 临时排障
   - fixed-domain 尚未配置完成时的短期过渡

这意味着后续文档、状态脚本和对用户的说明都要把 `link.stockhub.wiki` 提升为唯一正式入口。

### 三、媒体降级链

保留现有五个模式，但产品语义按下面三层收敛：

1. 直连优先
   - `auto`
   - `stun`
2. 稳定中继
   - `relay`
3. 最终兜底
   - `tunnel`

其中：

- `lan` 继续保留，仅作为同局域网/同机调试模式
- `auto` 作为公网默认推荐模式
- `stun` 保留给明确想测试公网直连的人

推荐用户降级顺序：

1. `auto`
2. `relay`
3. `tunnel`

系统不自动替用户切换，只负责：

1. 判断当前失败类型
2. 给出明确建议
3. 让用户一键切到建议模式

## 前端设计

### 一、模式定义与文案

建议保留以下展示语义：

| 模式 | 用户可见名称 | 语义 |
| --- | --- | --- |
| `lan` | 本地直连 | 同局域网或本机调试 |
| `auto` | 自动直连 | 默认推荐，优先低延迟 direct |
| `stun` | 外网直连 | 明确测试公网直连 |
| `relay` | 稳定中继 | TURN 中继，适合办公网/学校网/严格 NAT |
| `tunnel` | 最终兜底 | Cloudflare/Socket.IO 媒体 tunnel，最慢但最不依赖 UDP |

### 二、切换规则

系统必须遵守“手动优先”：

1. 不自动把 `auto` 切到 `relay`
2. 不自动把 `relay` 切到 `tunnel`
3. 不自动覆盖用户当前选择的 mode
4. 用户最后一次选择继续保存在 `localStorage`

允许的系统行为：

1. 显示建议
2. 显示当前失败分类
3. 提供一键切换到建议模式按钮
4. 记录用户手动切换行为

### 三、连接状态卡片

Viewer 页面需要有一个固定连接状态卡片，至少显示：

1. 当前入口：`link.stockhub.wiki`
2. 当前 mode
3. 当前连接阶段
4. 当前失败分类或成功摘要
5. 当前建议动作

建议的连接阶段：

- `signaling-connected`
- `peer-created`
- `ice-checking`
- `direct-connected`
- `relay-connected`
- `tunnel-connected`
- `terminal-failure`

### 四、Host 捕获源韧性

媒体 mode 是否能成功，不只取决于公网入口、ICE 和 TURN，还取决于 Host 侧能否拿到一个可用的屏幕捕获区域。

2026-07-09 的实际故障说明了这一点：

1. 页面和 Socket.IO 信令都正常
2. 用户切到 `tunnel` 作为最终兜底
3. Host 侧 `MSS` 瞬时只返回 `[{left:0, top:0, width:0, height:0}]`
4. `ScreenCaptureTrack` 和 `TunnelRelayStreamer` 都因为拿不到有效 monitor 而失败

因此 Host 端的设计要求应补充为：

1. 捕获源优先使用 `MSS`
2. 若 `MSS` 当前只返回 `0x0` monitor，占位结果不能直接当成“无屏幕”终态
3. 此时应回退到 `screeninfo` 提供的主屏矩形
4. 只有 `MSS` 与 `screeninfo` 都拿不到有效区域时，才把失败上报为 Host 捕获源故障

这条规则同时适用于：

- WebRTC `ScreenCaptureTrack` 初始化
- Cloudflare/Socket.IO `TunnelRelayStreamer` 启动
- 连接重试过程中重新创建 capture track 的场景

### 五、提示动作

当失败发生时，页面必须提供明确动作，而不是只有错误提示。典型动作包括：

- `切换到 relay`
- `切换到 tunnel`
- `重新发起连接`
- `发送诊断日志`

## 后端与信令设计

### 一、signal-server 职责扩展

`signal-server` 除了原有静态资源、认证、信令职责外，还要承担连接诊断汇聚职责。

服务端职责明确分三层：

1. 入口层
   - 静态页面
   - 登录
   - `/api/webrtc-config`
   - Socket.IO
2. 连接配置层
   - 返回 STUN/TURN 能力
   - 返回当前系统支持的 mode 能力摘要
3. 诊断汇聚层
   - 接收前端连接日志
   - 存储结构化 attempt
   - 提供运维摘要接口

### 二、`/api/webrtc-config` 扩展

当前接口除了返回 `stunUrls / turnUrls / turnConfigured` 外，建议再返回：

```json
{
  "directAvailable": true,
  "turnConfigured": true,
  "tunnelAvailable": true,
  "recommendedMode": "auto",
  "manualFallbackChain": ["auto", "relay", "tunnel"]
}
```

这样前端在不写死策略文案的情况下，也能拿到后端当前支持能力。

### 三、诊断上报通道

保留并增强两条上报路径：

1. Socket.IO 诊断事件
2. HTTP 诊断接口兜底

规则：

1. 如果 Socket.IO 可用，优先通过实时事件上报
2. 如果 Socket.IO 已断，退化为 HTTP POST 上报
3. 对用户来说，“发送诊断日志”动作只是一键操作，不需要理解使用哪条传输路径

## 日志系统设计

### 一、统一的 `connectionAttemptId`

每次 viewer 发起连接时生成一个 `connectionAttemptId`。一次连接尝试内的所有事件都必须带上这个 ID。

一次 attempt 包含：

1. 页面进入 viewer
2. 模式选择
3. signaling 连接
4. SDP/ICE 过程
5. 重试、刷新、ICE restart
6. 成功或失败
7. 用户手动切 mode

### 二、日志类型

至少定义四类结构化日志：

1. `attempt-start`
2. `attempt-progress`
3. `attempt-failure`
4. `attempt-success`

建议字段：

```json
{
  "connectionAttemptId": "uuid-or-stable-id",
  "eventType": "attempt-failure",
  "mode": "relay",
  "timestamp": "2026-07-08T12:00:00.000Z",
  "publicOrigin": true,
  "turnConfigured": true,
  "candidateSummary": {
    "local": { "host": 1, "srflx": 1, "relay": 1, "prflx": 0, "other": 0 },
    "remote": { "host": 0, "srflx": 0, "relay": 1, "prflx": 0, "other": 0 }
  },
  "selectedCandidatePair": null,
  "failureCode": "turn-failed-suggest-tunnel",
  "nextSuggestedMode": "tunnel"
}
```

### 三、失败分类

建议至少覆盖以下失败码：

- `signaling-unavailable`
- `token-invalid`
- `stun-no-remote-candidate`
- `ice-check-timeout`
- `direct-failed-suggest-relay`
- `turn-misconfigured`
- `turn-failed-suggest-tunnel`
- `tunnel-start-failed`
- `tunnel-stream-stalled`
- `host-monitor-unavailable`
- `host-offer-processing-failed`

其中 `host-monitor-unavailable` 的判定口径要明确为：

1. Host 捕获链在 `MSS` 和 `screeninfo` 两条来源下都无法拿到有效 monitor
2. 不能把单次 `MSS` 返回 `0x0` monitor 直接上报为最终 Host 故障
3. 这类故障与入口域名、TURN 配置和 UDP 连通性分开统计

分类要求：

1. 前端和后端共享同一套失败码语义
2. 页面提示必须由失败码驱动
3. 运维统计也由失败码驱动

### 四、主动上报规则

前端在以下场景必须主动向服务端发结构化日志：

1. 进入 viewer，发 `attempt-start`
2. signaling 建立，发 `attempt-progress`
3. direct 失败，发 `attempt-failure`
4. relay 失败，发 `attempt-failure`
5. tunnel 启动失败或断流，发 `attempt-failure`
6. 用户手动切 mode，发 `attempt-progress`
7. 最终成功，发 `attempt-success`

这条规则的目标是让“连接失败”能够变成完整证据链，而不是只剩一两行零散控制台输出。

### 五、落地与保留策略

诊断日志采用结构化 JSON 落地，遵守以下原则：

1. 默认保留最近 N 天或最近 N 条
2. 按 `connectionAttemptId` 可追踪完整链路
3. 对 token、候选地址、敏感标识做脱敏
4. 控制台只打摘要，不把所有原始细节都塞进普通日志

## 运维与可观测设计

### 一、运维最小真相源

正式用户入口真相源改为：

- `link.stockhub.wiki`

运维仍需保留以下状态观测：

1. fixed-domain tunnel 是否在线
2. `signal-server` 是否健康
3. Host 是否在线
4. TURN 是否配置完整
5. 最近连接失败分类

### 二、摘要接口

至少新增两个结构化接口：

- `/api/admin/connection-summary`
- `/api/admin/connection-attempts?limit=50`

摘要内容建议包括：

1. 当前在线 Host
2. 当前 viewer 数
3. 每个 viewer 当前 mode
4. 最近一次 attempt 的结果
5. 最近失败分类 Top N
6. `auto -> relay` 建议次数
7. `relay -> tunnel` 建议次数

### 三、最小日志摘要

即使暂时不做完整后台面板，也要保证服务端有单行摘要，便于终端排查：

```text
[ATTEMPT] id=... mode=auto result=failed code=direct-failed-suggest-relay next=relay
[ATTEMPT] id=... mode=relay result=failed code=turn-failed-suggest-tunnel next=tunnel
[ATTEMPT] id=... mode=tunnel result=success fps=8
```

## 测试设计

### 一、入口层测试

1. `link.stockhub.wiki` 可达
2. `/health` 正常
3. `/api/status` 正常
4. `/api/webrtc-config` 正常返回能力摘要
5. 文档、状态脚本、用户提示不再把 quick tunnel 当正式默认入口

### 二、模式层测试

1. `auto / stun / relay / tunnel` 切换正确
2. 用户选择能持久化
3. 系统不自动改 mode
4. 失败建议链正确

### 三、日志层测试

1. 每次连接都有 `connectionAttemptId`
2. 成功、失败、切 mode 都能形成结构化日志
3. Socket.IO 断开时 HTTP 兜底上报可用

### 四、网络场景测试

1. 家庭网/手机热点：
   - `auto` 应优先成功
2. 办公网/学校网/严格 NAT：
   - `auto` 失败时建议 `relay`
3. TURN 关闭或配置错误：
   - `relay` 明确失败并建议 `tunnel`
4. `tunnel` 成功时：
   - 页面明确显示当前为最终兜底模式

## 上线策略

建议分两阶段上线：

### 阶段 1：入口收敛

1. `link.stockhub.wiki` 成为唯一正式入口
2. quick tunnel 从文档和交付口径降级为调试工具
3. 状态脚本和文档同步入口真相源

### 阶段 2：媒体与日志增强

1. 完善 mode 提示链
2. 完善失败分类
3. 完善结构化日志与主动上报
4. 增加运维摘要接口

## 兼容与回滚

1. 兼容已有 `localStorage` mode 值
2. 保留 `tunnel` 模式，不删除
3. 未配置 TURN 时，`relay` 必须明确显示不可用或高风险，而不是假装可用
4. 如需回滚，应允许快速回退到：
   - fixed-domain 主入口不变
   - 仅恢复旧的 mode UI 和旧的提示逻辑

## 设计结论

本设计把系统稳定性问题拆为两件独立的事：

1. **公网正式入口稳定**
   - 由 `link.stockhub.wiki` 负责
2. **远程桌面媒体连通性兜底**
   - 由 `auto/stun -> relay -> tunnel` 手动降级链负责

这样用户只记一个网址，但仍然保留低延迟优先、TURN 中继和最终媒体 tunnel 三层能力。同时通过结构化日志与主动上报，把失败过程转化为可追踪、可统计、可定位的证据链。
