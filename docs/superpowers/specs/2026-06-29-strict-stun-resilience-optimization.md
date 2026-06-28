# Strict STUN 韧性优化设计

## 背景

近期失败日志显示，远程桌面并不是完全无法建立 STUN 直连，而是直连建立后媒体路径迅速退化：

1. Viewer 与 Host 完成 WebRTC 连接，selected pair 为 `prflx -> host`。
2. 视频初期有 17-18 FPS。
3. 随后 RTT 从个位数毫秒跳到 90ms 级别，`packetsLost` 突增，FPS 降到 0。
4. 浏览器进入 `ice-disconnected` / `pc-failed`。
5. Host 收到 `WRD_FAILURE_DIAG reason=ice-disconnected` / `pc-failed`。

这说明 Strict STUN 的当前问题不是“信令不通”或“登录失败”，而是弱 UDP/NAT 路径在承载视频时不稳定。继续坚持默认不自动走 TURN、不自动走媒体 tunnel 的前提下，优化重点应放在三件事：

1. 在链路恶化早期自动降载，降低视频码率、分辨率和 FPS。
2. 在 ICE 正式断开前主动恢复，而不是等到 `ice-disconnected` 后才处理。
3. 把家庭侧 UDP 可达性优化做成明确的可配置方案和诊断结论。

## 目标

1. 在 `auto` / `stun` 模式下保持 Strict STUN：不自动切 TURN，不自动切 Cloudflare/Socket.IO 媒体 tunnel。
2. 根据 Viewer stats 识别链路退化，提前触发分级降载。
3. 在连续媒体退化时最多主动 ICE restart 一次；失败后按 Strict STUN 终止并上报诊断。
4. 将分辨率、FPS、码率档位和降载原因写入前端诊断、Host 日志和后端诊断 payload。
5. 调研并记录 Host 侧固定 UDP 端口范围的实现事实；首期不 monkey patch `aioice`。

## 非目标

1. 不承诺在公司 UDP 阻断、CGNAT、双重 NAT 或地址端口依赖过滤场景下必定连通。
2. 不把 HTTP 拉流、Socket.IO JPEG、Cloudflare Tunnel 媒体转发作为 `auto` / `stun` 失败后的自动兜底。
3. 不在首期修改 `aioice` 源码或 vendored 依赖来强行固定 UDP 端口。
4. 不上传完整候选公网 IP、SDP、token、密码或输入内容。

## 自适应链路质量模型

Viewer 每 2 秒已有一次 WebRTC stats 采样。新增一个 `LinkQualityController`，只消费脱敏后的 stats：

```js
{
  fps: 17,
  rttMs: 92,
  jitterBufferMs: 271.2,
  framesReceived: 199,
  framesDecoded: 199,
  packetsLost: 54,
  bytesReceived: 1880000,
  selectedCandidateType: "prflx",
  selectedCandidatePair: {
    localType: "prflx",
    remoteType: "host",
    protocol: "udp",
    rttMs: 92
  }
}
```

质量等级：

| 等级 | 触发条件 | 动作 |
|------|----------|------|
| `good` | FPS >= 12、RTT < 120ms、连续丢包增量 < 20、jitter < 150ms | 保持当前档位 |
| `degraded` | 连续 2 次出现 FPS < 8、RTT >= 120ms、丢包增量 >= 20、jitter >= 150ms 任一项 | 降一级视频档位 |
| `critical` | 连续 2 次 FPS = 0，或 selected pair 存在但 decoded/received 不增长，或 RTT >= 300ms | 降到最低档并准备 ICE restart |
| `dead` | selected pair 消失，或 ICE/PC failed/disconnected 超过恢复窗口 | terminal failure |

阈值应保守，避免单次 stats 抖动导致频繁降载。质量状态必须有 hysteresis：

1. 每 2 秒最多评估一次。
2. 两次连续异常才降载。
3. 降载后 20 秒内不自动升档。
4. 首期不做自动升档，只提供手动刷新/重连后恢复默认档位。

## 视频档位

默认档位沿用当前约 720p / 20 FPS / 2.5 Mbps。新增三档：

| 档位 | 分辨率 | FPS | 码率 | 用途 |
|------|--------|-----|------|------|
| `high` | 1280x720 | 20 | 2500 kbps | 默认，局域网或稳定外网 |
| `medium` | 960x540 | 15 | 1400 kbps | 第一次退化 |
| `low` | 854x480 | 12 | 900 kbps | 明显丢包/抖动 |
| `survival` | 640x360 | 8 | 500 kbps | 只保留最低可用画面 |

Viewer 侧降载动作通过现有信令扩展完成：

1. Viewer 调用 `requestResolution(width, height)` 通知 Host 降分辨率。
2. 新增 `media-profile-change` 信令事件，携带 `targetFps`、`videoBitrateKbps`、`reason`、`profile`。
3. Host 收到后更新屏幕采集 `target_fps`、编码器目标码率和缩放尺寸。
4. Host 在日志中输出 `WRD_MEDIA_PROFILE viewer=<id> profile=low size=854x480 fps=12 bitrate_kbps=900 reason=packet-loss`。

如果首期无法稳定热更新 H.264 VideoToolbox 码率，则允许采用保守方案：

1. 立即应用分辨率和 FPS。
2. 码率只在下一次 encoder 创建时生效。
3. 诊断中标记 `bitrateApplyMode=reconnect-required`。

## 主动 ICE 恢复

现有逻辑主要在 `ice-disconnected` / `pc-failed` 后恢复。新增 proactive recovery：

1. 当质量进入 `critical` 且 selected pair 仍存在时，先降到 `survival`。
2. 如果 4 秒后仍 `critical`，调用一次 `pc.restartIce()`。
3. ICE restart 后创建新 offer，确保浏览器实际发送带 ICE restart 的 SDP。
4. 10 秒内仍无有效媒体，则进入 terminal failure。

Strict STUN 模式下的恢复预算：

| 动作 | `auto` | `stun` |
|------|--------|--------|
| 自适应降载 | 最多 3 次 | 最多 3 次 |
| proactive ICE restart | 最多 1 次 | 最多 1 次 |
| full PeerConnection reconnect | 最多 1 次 | 最多 0 或 1 次，按现有策略确认 |
| 自动 TURN | 禁止 | 禁止 |
| 自动 media tunnel | 禁止 | 禁止 |

`auto` / `stun` 达到恢复预算后必须终止并上报：

```json
{
  "failureCategory": "media-path-degraded-after-selected-pair",
  "reason": "adaptive-recovery-exhausted",
  "mediaPolicy": "strict-stun",
  "fallbackUsed": false
}
```

## 诊断字段

新增字段放入 `connection-diagnostic` schemaVersion 2：

```json
{
  "adaptiveMedia": {
    "enabled": true,
    "currentProfile": "survival",
    "profileChanges": [
      {
        "at": 1782643094000,
        "from": "high",
        "to": "medium",
        "reason": "packet-loss",
        "stats": {
          "fps": 4,
          "rttMs": 92,
          "jitterBufferMs": 8.1,
          "packetsLostDelta": 54
        }
      }
    ],
    "iceRestart": {
      "proactiveAttempted": true,
      "attempts": 1,
      "reason": "critical-media-quality"
    }
  }
}
```

Host 日志新增：

1. `WRD_MEDIA_PROFILE`：记录 Host 实际应用的媒体档位。
2. `WRD_MEDIA_RECOVERY`：记录 proactive ICE restart、full reconnect 和 terminal failure。
3. `WRD_STUN_FAILURE` 中补充 `adaptiveProfile`、`profileChanges` 数量和最后一次降载原因。

前端 console 事件新增：

1. `[MEDIA] quality=degraded reason=packet-loss profile=medium`
2. `[MEDIA] applying profile low size=854x480 fps=12 bitrate=900kbps`
3. `[RECOVERY] proactive ICE restart reason=critical-media-quality`
4. `[RECOVERY] strict-stun exhausted, not using tunnel`

## 家庭侧可达性优化

### 首期文档化配置

1. 给 Host Mac 设置固定内网 IP。
2. 路由器关闭双重 NAT 或将光猫改桥接。
3. 确认 WAN IP 与公网查询 IP 是否一致；不一致则标记 `ispCgnatLikely=true`。
4. 优先启用 IPv6，并允许 Host Mac 的入站 UDP。
5. macOS 防火墙允许当前 Python 解释器和 Node 进程。

### 固定 UDP 端口范围调研结论

首期必须在代码或文档中明确：

1. 当前 `aiortc` / `aioice` 默认随机绑定本地 UDP 端口。
2. `RTCConfiguration` 不提供标准端口范围字段。
3. 因此不能只在 TP-LINK 虚拟服务器里填一个端口就保证 TURN/STUN/WebRTC 可达。
4. 若未来要支持端口转发优化，需要新增 `WRD_ICE_UDP_PORT_RANGE`，并通过可维护的 `aioice` 适配层或上游能力固定 Host 侧 UDP 绑定范围。

### 后续增强

后续可以单独设计：

1. Host 端 `WRD_ICE_UDP_PORT_RANGE=50000-50100`。
2. 路由器转发该 UDP 范围到 Mac 固定内网 IP。
3. Host 启动时自检端口范围是否可绑定。
4. 诊断页面输出“家庭端口映射状态未知/已配置/不可验证”。

## UI 行为

连接状态栏新增一行轻量状态：

```text
链路质量：降载中 · 540p · 15 FPS · STUN direct · RTT 92 ms
```

失败面板新增：

1. `已尝试自动降载：high -> medium -> low -> survival`
2. `已尝试 ICE restart：1 次`
3. `未切换 TURN / tunnel：Strict STUN 策略禁止自动中继`
4. 分类建议：
   - 丢包/抖动：降低 Host 分辨率、关闭占用上行的程序、尝试有线网络。
   - `selected pair` 消失：公司网或家庭 NAT 映射不稳定。
   - 无 `srflx`：公司网或家庭网阻断 STUN/UDP。

## 测试方案

前端单测：

1. 连续两次高丢包触发 `medium` 降载。
2. 连续 0 FPS + selected pair 存在触发 `survival` 和 proactive ICE restart。
3. `auto` / `stun` 模式恢复耗尽后不会调用 `startTunnelRelay()`。
4. 诊断 payload 包含 `adaptiveMedia.profileChanges` 和 `iceRestart`。
5. 单次异常不会降载。

Host 测试：

1. 收到 `media-profile-change` 后更新 target FPS、分辨率和码率配置。
2. 日志输出 `WRD_MEDIA_PROFILE`。
3. 无效 profile 被拒绝并记录 warning，不崩溃。

Signal Server 测试：

1. `media-profile-change` 只允许 viewer 发给 host。
2. 事件 payload 被限制在合法 profile、FPS、码率范围内。
3. 诊断脱敏保留 `adaptiveMedia` 摘要。

手工验证：

1. 本地/局域网稳定连接不应自动降载。
2. 人为降低网络质量时应先降载，再 ICE restart。
3. Strict STUN 失败后页面必须明确失败，不自动进入 tunnel。
4. 手动切换 tunnel 或 TURN 模式仍可按手动模式运行。

## 验收标准

1. 弱媒体路径出现丢包、0 FPS、RTT 或 jitter 异常时，Viewer 会先自动降载。
2. 降载记录进入诊断 payload、前端日志和 Host 日志。
3. 主动 ICE restart 只发生一次，并有明确日志。
4. `auto` / `stun` 模式不会自动调用 `startTunnelRelay()`。
5. 失败时显示 Strict STUN exhausted，而不是悄悄切中继。
6. 文档明确 TP-LINK 端口转发只有在 Host UDP 端口范围可控后才有实际意义。
