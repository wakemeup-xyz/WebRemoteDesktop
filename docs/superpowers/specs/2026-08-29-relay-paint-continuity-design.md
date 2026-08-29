# Relay 出画连续性设计（已连接黑屏）

日期：2026-08-29  
状态：Architecture A close-out（控制面 + 默认 720p + 诚实卡顿；TURN 1s 硬线降为 SLA 目标）  
关联：

- Quality Lock：`docs/superpowers/specs/2026-08-02-quality-lock-low-latency-design.md`
- TURN 重连稳定性：`docs/superpowers/specs/2026-08-01-turn-relay-reconnect-stability-design.md`
- Relay 输入稳定性：`docs/superpowers/specs/2026-08-11-relay-input-stability-design.md`
- 媒体暂停：`docs/superpowers/specs/2026-07-19-remote-desktop-media-suspension-design.md`

运行证据（2026-08-28）：

- Host `VIEWER_STATS`：`candidate=relay received≈19 decoded=0` 周期性出现
- Viewer console：`hideLoading` 在 `readyState=0` 时把状态写成「已连接」
- Playwright 复现：`已连接` + TURN 中继，`#remoteVideo` 像素均值 240（非黑帧），但 `fps` 在 20 ↔ 0 间振荡，`WRD_KEYFRAME ok=True` 后仍 1–2s `decoded=0`
- 采集侧：`CAPTURE_STATS fps≈19 frame=1728x1080 reuse=0`；MSS 现抓亮度正常
- 错 size：Viewer 面板默认 720p / `connection-sync` 请求 1280×720，Host 因进程级 `_user_resolution` 仍编 1728×1080

## 1. Goal

让手动 **外网中继（`networkMode=relay`）** 在真实 TURN 路径上：

1. 默认 **稳态可看**：relay 允许偶发 ≤2s 追帧（Chrome TURN jitter 丢掉已组帧后需新 SPS）；连续 ≥3s 0-FPS 或 60s 内超过 2 次 ≥1s 追帧才算失败。瞬时掉帧 &lt;300ms 可接受。60s 无 ≥1s 0-FPS 仍是隧道中继 SLA，不是 TURN 硬门。
2. **状态诚实**：未真正出画不得显示「已连接」
3. **失败可行动、可复盘**：UI 提示具体下一步；Host/Viewer 日志用同一 `connectionAttemptId` 能回答「编了多大、GOP、IDR 有没有发出、Viewer 卡在哪一态」

一句话：

> **路径预算决定默认分辨率；连续性只做可验证 IDR；「已连接」只在解码增长之后。**

## 2. Product decisions（已确认）

1. **路径上限，不是 survival 糊化。** 直连仍可 1080p；relay/TURN **默认上限 720p**。用户本会话可手选 1080p（显式 override）。系统仍禁止自动掉到 540p/360p。
2. **验收线：稳态可看。** relay 默认 720p 下，60s 内无 ≥3s 黑屏，且 ≥1s 追帧不超过 2 次。60s 无 ≥1s 0-FPS 是隧道 SLA。
3. **不自动切隧道 / TURN。** 持续 stall 只提示手动切「隧道中继」或改 720p。
4. **Quality Lock 保留。** 不因 `fps=0` / structural RTT / jitter 自动改 size。路径 cap 只在进 relay、切模式、新 `connectionAttempt` 时计算一次。
5. **演进现有模块。** 不新造第二套 ContinuityController / 媒体状态机。
6. **提示与诊断是本设计一等公民。** 不是事后补日志。

## 3. Non-Goals

1. 不自动从 Strict STUN 失败切 TURN，也不从 TURN stall 切 tunnel。
2. 不引入 AV1/SVC/脏矩形。
3. 不把 tunnel JPEG 与 WebRTC 自适应合并。
4. 不重启/重建 Cloudflare tunnel；不把「重启服务」解释为 formal restart。
5. 不在本轮改 coturn 或 TURN 节点选择策略。
6. 不把 Host LaunchAgent 常驻策略改成「每次连接都重启 Host」（只修会话级 size 绑定）。

## 4. Why previous designs were not enough

| 已落地设计 | 解决了什么 | 本次仍失败的原因 |
|---|---|---|
| Quality Lock | 禁止 stall→survival size / 编码器 thrash | Host lock 把 **进程旧 1080p** 当成用户意愿，否决本次 720p |
| TURN reconnect stability | resume 死循环、半中继、DC 误杀 PC | 不覆盖「ICE 已 connected、RTP 仍到、解码周期性 0」 |
| Relay input B1 | `jitterBufferTarget=80ms` | 已生效；1080p IDR 仍把 jitter 打到 300–900ms |
| Keyframe 限频 | `WRD_KEYFRAME ok=True` | `ok` 只表示调到 `_send_keyframe`；VideoToolbox 常不产 IDR |

本次修的是 **预算错误 + IDR 不可验证 + 假已连接**，不是再加一层恢复。

## 5. Architecture

```text
userPreference (panel; default 720p)
pathCap        (relay=1280x720; direct=1920x1080)
        │
        ▼
Viewer sessionPresentation = min(pref, pathCap)
        │  unless explicit 1080p override this attempt
        │
        ├─ offer / resolution-change / media-profile-change
        │    {width,height, path, adaptiveResolution:false}
        ▼
Host on_offer(attemptId)
        reset _user_resolution ← THIS presentation
        encoder GOP ← path (relay 1s / direct 2s)
        │
        ▼
Encoder
        periodic IDR by GOP
        force_keyframe → must emit NAL IDR within 1s
        if not: one codec recreate, then log emitted=false
        │
        ▼
Viewer paint gate
        signaling → media-pending → connected
        connected only if hasPaintedFrame
        stall ≥1s → media-stalled (honest UI, no PC teardown)
        │
        ▼
Diagnostics (same connectionAttemptId)
        WRD_SESSION_PRESENTATION / WRD_KEYFRAME / WRD_PAINT / WRD_STALL_SAMPLE
```

模块落点（演进，不平行）：

| 职责 | 模块 |
|---|---|
| pathCap + sessionPresentation | `web-client/js/webrtc.js` |
| 出画四态 / hideLoading | `webrtc.js` `ontrack` / `onPeerConnected` / `processStatsSnapshot` |
| stall → keyframe only | 现有 `LinkQualityController`（Lock 语义不变） |
| 用户提示 | 现有网络顾问 `updateNetworkUI` / failure recommendation |
| 诊断 | `diagnostic.js` + Host structured events |
| 会话 size 重置 + GOP | `python-host/host.py` `on_offer` / `on_media_profile_change` |
| 可验证 IDR | `h264_videotoolbox_encoder.py` + `AiortcMediaSender.request_keyframe` |

## 6. Control plane — session presentation

### 6.1 公式

```
userPreference      = 本 Viewer 分辨率面板
                      HTML 默认 720p checked；无选择时 1280×720
pathCap             = relay 或 lastCandidateType=relay → 1280×720
                      lan / stun / auto 直连 → 1920×1080
                      tunnel → 不走本 WebRTC size 契约（既有 JPEG 自适应）
sessionPresentation = min(userPreference, pathCap)
```

`min` 按像素面积，并保持档位表离散值（540p / 720p / 900p / 1080p），不得算出 1600×720 这种中间值。

### 6.2 显式 1080p override

仅当 **本会话** 用户在分辨率面板点选 1080p（或等价 `resolution-change`）时，允许 `sessionPresentation = 1920×1080` 超过 relay cap。

- 必须打 UI 警告：外网中继上 1080p 容易卡顿
- override **不**写入下一个 `connectionAttempt`，也不写入 Host 进程作为跨 viewer 默认
- 新 attempt / 新 viewer / 切回 720p / 切模式：重新按 §6.1 计算

### 6.3 Host 权威切换

当前 bug：`on_media_profile_change` 在 `adaptiveResolution=false` 时调用 `_locked_user_size()`，用进程里旧 `_user_resolution` 否决更小的合法 Viewer 请求。

目标：

1. `on_offer`：若 offer 带 `width`/`height` 或随后首个 `media-profile-change` / `resolution-change` 到达，**把 `_user_resolution` 设为本 attempt 的 sessionPresentation**，丢弃上一 viewer 的值。
2. Lock 下 Host **采纳**本次 Viewer 发来的 width/height，只要它是合法档位（320–1920 / 180–1080），不再用旧值否决「变小」。
3. 仍禁止 Viewer 在 Lock 下发 survival 640×360 作为自动档；Host 可拒绝 `reason=survival` 且 `adaptiveResolution=false` 的缩小。
4. size 变化才允许 reopen encoder；同 size 只热更新 bitrate/fps。

### 6.4 何时重算 pathCap

| 事件 | 重算？ |
|---|---|
| 新 `connectionAttemptId` | 是 |
| 用户切换网络模式 | 是 |
| 用户改分辨率面板 | 是（可走 override） |
| `fps=0` / media-stalled | **否** |
| ICE restart / 刷新画面（同 attempt 软恢复） | 否（保留本会话 presentation） |
| 切 TURN 节点 | 否（仍是 relay cap） |

### 6.5 与 Quality Lock 的关系（写死）

路径 cap **不是** `LinkQualityController` 的 size 梯子。  
Lock 模式禁止的自动动作原文保留；本设计只新增一条 **传输预算**：relay 默认不超过 720p。

## 7. Encoder IDR contract

### 7.1 GOP

| 路径 | `gop_size`（20fps） | 周期 |
|---|---|---|
| relay | 20 | ≈1s |
| direct（lan/stun/host/srflx） | 40 | ≈2s（现状） |

随 offer 绑定，存在 encoder 实例上，不搞运行中滑动 GOP 状态机。

### 7.2 force_keyframe 必须可观测

`H264VideoToolboxEncoder._encode_frame(force_keyframe=True)`：

1. 设置 `pict_type=I` 并 encode
2. 扫描产出 bitstream：是否存在 IDR（NAL type 5，含 FU-A/STAP-A 聚合）
3. 若无 IDR：对该 codec **recreate 一次**（关闭再打开）并再编同一帧
4. 若仍无：`emitted=false`，打 `WRD_IDR_RECREATE` + 失败原因，**不要**再循环 reopen

`AiortcMediaSender.request_keyframe()` 继续调 `_send_keyframe` 钩子；Host `_request_keyframe` 限频 ≤1/s。

### 7.3 日志两段式

废弃单独的 `WRD_KEYFRAME ok=True` 作为成功含义。

```
WRD_KEYFRAME requested=true emitted=<bool|pending> reason=... viewer=... codec=... gop=... size=...
```

- `requested=true`：钩子或 force 路径已调用
- `emitted=true`：随后 ≤1s 内编码器产出 IDR
- `emitted=false`：1s 内未产出（含 recreate 失败）

### 7.4 码率

relay + 720p：质量地板 1800kbps，目标 ≤2500kbps（与 Quality Lock 720p 行一致）。  
relay + 显式 1080p override：地板 2500kbps，GOP 仍 1s。  
禁止默认路径上 1080p 地板 2500kbps 走 TURN。

### 7.5 禁止

- 每次 0-fps 都 reopen codec（只在 force 未产出 IDR 时一次）
- stall 时 ICE restart / 拆 PC（relay Lock 已禁止）
- 把 keyframe 风暴当成恢复手段（限频 1/s）

## 8. Paint gate + honest UI

### 8.1 四态（互斥）

| `uiPhase` | 进入条件 | 状态栏文案 | loading |
|---|---|---|---|
| `signaling` | 点击开始 → ICE/PC 未 connected | 连接中 | 显示 |
| `media-pending` | PC 或 ICE 已 connected，且尚未 `hasPaintedFrame` | **正在出画** | 显示；文案「正在等待第一帧」 |
| `connected` | `hasPaintedFrame` | 已连接 | 隐藏 |
| `media-stalled` | 曾经 connected 后，relay 连续 ≥2s（直连 ≥1s）`fps=0` 且 `framesReceived>0` | **画面卡顿** | 不盖全屏；顾问浮层 |

`hasPaintedFrame`（WebRTC）：

```
video.videoWidth > 0 && video.videoHeight > 0
&& framesDecoded 相对本 attempt 基线增长 ≥ 1
```

tunnel：JPEG `frameSeq` 相对基线增长等价。

### 8.2 明确禁止的绿灯路径

1. `ontrack` 时 `paused===false` 且 `readyState<2` 就 `updateConnectionStatus('connected')`
2. `onPeerConnected` 安全网直接 `已连接`
3. 8s fallback 仅凭 `videoWidth>0`（无 decoded 增长）就绿灯
4. Host `capture_stats` 的采集 FPS 覆盖状态栏，使人以为已经在播（采集 FPS 可作次要诊断，不得单独把 UI 标成已连接）

### 8.3 stall 不拆链路

`media-stalled` 只请求关键帧 + 重申 `jitterBufferTarget`/`playoutDelayHint` + 提示。  
GOP IDR 救不了 Chrome TURN 解码；Host 可在冻结秒做 **同尺寸** codec 重开以发新 SPS（不改 width/height，不算 Quality Lock size 阶梯）。  
不得 `scheduleReconnect` / `refresh()`，除非同时满足既有「TURN channel dead」条件（relay + ICE completed + `bytesReceived=0` 连续 20s）。

`received>0 && decoded=0` **不是** channel dead。

## 9. User-facing prompts

走现有网络顾问，不新模态。文案必须可行动，避免裸 ICE/NAL 行话。

| 条件 | 提示 | 建议动作 |
|---|---|---|
| `media-pending` 3–8s | 链路已通，正在等待第一帧 | 等待 |
| `media-pending` &gt;8s | 第一帧仍未到达 | 点「刷新画面」 |
| `media-stalled` 且 relay | 外网中继正在追帧，画面可能短暂发黑（约 2 秒） | 等待新 SPS；3 秒内不恢复或反复出现则改 720p 或切隧道中继 |
| 手选 1080p + relay | 外网中继上 1080p 容易卡顿 | 改回 720p，或改用隧道中继 |
| Host `emitted=false` | 编码器没能及时打出完整画面 | 刷新画面；仍失败则重启 Host（`scripts/restart-host.sh`，不重建 tunnel） |
| 持续 stall ≥6s | 当前中继出画不稳定 | 手动切换「隧道中继」 |

顾问 `nextSuggestedMode` 可以指向 `tunnel`，但 **不得自动切换**。

## 10. Diagnostics

### 10.1 Correlation

所有本设计新增事件带：

- `connectionAttemptId`
- `viewerId`（Host 侧）
- `networkMode`
- `turnServerId`（若有）

### 10.2 Viewer

`Diagnostic.autoSendFailure` / 手动「发送日志到服务端」扩展 `traceSummary`（无则新增扁平字段，不另起 socket 事件名）：

```json
{
  "uiPhase": "media-pending|connected|media-stalled",
  "hasPaintedFrame": false,
  "userPreference": {"width": 1280, "height": 720},
  "pathCap": {"width": 1280, "height": 720},
  "sessionPresentation": {"width": 1280, "height": 720},
  "explicitOverride1080": false,
  "videoWidth": 0,
  "videoHeight": 0,
  "readyState": 0,
  "framesReceived": 19,
  "framesDecoded": 0,
  "fps": 0,
  "jitterBufferMs": 0,
  "bytesReceived": 1234,
  "lastKeyframeAt": 0,
  "keyframeRequested": true,
  "keyframeEmitted": false
}
```

自动触发：

- 进入 `media-pending` 超过 8s
- 进入 `media-stalled` 且持续 ≥3s
- Host 回传 `emitted=false`

### 10.3 Host structured events

默认进入运行日志（不必开 verbose）：

| 事件 | 何时 | 关键字段 |
|---|---|---|
| `WRD_SESSION_PRESENTATION` | offer/profile 绑定 attempt | size, path, gop, previousUserResolution, adopted |
| `WRD_KEYFRAME` | 每次请求 | requested, emitted, reason, codec, size, gop |
| `WRD_IDR_RECREATE` | force 失败后 reopen | success, codec |
| `WRD_STALL_SAMPLE` | 聚合：received&gt;0 且 decoded=0 | count, windowSec, lastFps |

禁止记录 TURN 密码、完整 SDP、像素内容。

`WRD_ENABLE_DIAG_PERSIST=1` 时 Viewer bundle 仍写入 `/tmp/wrd-diag/`。

### 10.4 排障最小问题单（日志必须能答）

1. 这次 sessionPresentation 是多少？是否沿用了旧 1080p？
2. GOP 是 20 还是 40？
3. keyframe requested 之后 emitted 是 true 还是 false？
4. Viewer `uiPhase` 卡在 pending / connected / stalled 哪一态？
5. `framesReceived` 是否仍在涨（通道活着）而 `framesDecoded` 为 0？

## 11. Testing

### 11.1 单测（必做）

Viewer：

- `ontrack` + `paused=false` + `readyState=0` → `uiPhase=media-pending`，不是 connected
- `framesDecoded` 相对基线 +1 → connected，loading hidden
- stall 1s `fps=0 received>0` → `media-stalled`，不 `scheduleReconnect`
- relay pathCap：pref 1080p 未 override → session 720p
- 显式点 1080p → session 1080p + 警告标志
- 新 attempt 清除 override
- 诊断 payload 含 presentation / pathCap / uiPhase / keyframeEmitted

Host：

- 新 offer 覆盖旧 `_user_resolution` 1920×1080 为本次 1280×720
- Lock 下采纳更小的合法 720p 请求，拒绝 survival 自动缩小
- encoder：`force_keyframe` 路径在 mock 无 IDR 时 recreate 一次
- `WRD_KEYFRAME` 同时有 requested 与 emitted

### 11.2 运行验收（本机，不重建 tunnel）

前置：`scripts/restart-host.sh` 一次，让新 Host 进程加载（signal 可复用）。

1. 本机 `http://127.0.0.1:8080`，模式「外网中继」，分辨率保持默认 720p
2. 开始连接：状态栏在第一帧前为「正在出画」，出画后才「已连接」
3. Host 日志 `WRD_SESSION_PRESENTATION` size=1280x720（或等比例 ≤720p 档），**不是** 1728×1080
4. 连续 60s：不得出现 ≥3s 的 0 FPS 黑屏；≥1s 追帧不超过 2 次（允许 &lt;300ms 掉帧和 ≤2s 追帧）
5. 人为切 1080p：出现警告；若 stall，顾问建议改回 720p / 隧道，不自动切
6. 点「发送日志到服务端」：payload 含 §10.2 字段

## 12. Compatibility

1. 旧 Host：忽略新 GOP/emitted 字段；Viewer 仍做 paint gate 与 pathCap（至少不再假绿灯、不再默认请求 1080p）。
2. 旧 Viewer：不发 path 字段时，Host 若 `networkMode=relay` 仍按 720p cap 采纳本次 profile size；**不得**继续用跨会话 1080p。
3. `wrdAdaptiveResolution` / `wrdNetworkMode` / `wrdTurnServerId` 键不变。
4. tunnel 模式不走本 WebRTC GOP/paint 主路径；tunnel 已连接仍以 JPEG 首帧为准（既有契约）。

## 13. Security

1. keyframe / media-profile 仍需控制租约。
2. keyframe ≤1/s。
3. 日志不打印 TURN 凭据、完整 SDP、帧内容。
4. 不扩大 ICE 配置对未登录访客的暴露。

## 14. Phased delivery

实施计划可按此拆任务，但 **Phase 1+2 必须同一 PR 合并验收**——只改 UI 或只改 GOP 都无法达到 Goal。

### Phase 1 — 会话 presentation + Host 重置（根因：错 size）

- Viewer pathCap / sessionPresentation
- Host `on_offer` 重置 `_user_resolution`
- Lock 采纳本次合法 size
- 单测

### Phase 2 — 可验证 IDR + relay GOP 1s（根因：冻帧）

- GOP 按 path
- force_keyframe IDR 检测 + 一次 recreate
- `WRD_KEYFRAME` requested/emitted
- 单测

### Phase 3 — Paint gate + 提示 + 诊断（根因：假已连接 / 无法排障）

- 四态 UI
- 顾问文案
- Viewer/Host 诊断字段
- 单测 + 本机 60s 验收

## 15. Acceptance

- [ ] 新 relay 会话 Host 编码 size ≤ 720p 档（除非本会话显式 1080p）
- [ ] 新 attempt 不继承上一 viewer/进程的 1080p
- [ ] relay 默认 720p：60s 内无 ≥3s 黑屏，且 ≥1s 追帧不超过 2 次
- [ ] 未 `hasPaintedFrame` 时状态栏不是「已连接」
- [ ] `received>0 decoded=0` 不触发 full refresh
- [ ] Lock 下 stall 不发 640×360 / 854×480
- [ ] `WRD_KEYFRAME` 能区分 requested vs emitted
- [ ] 自动/手动诊断含 presentation、uiPhase、decoded/received
- [ ] 不自动切隧道；顾问可建议隧道
- [ ] 不重建 Cloudflare tunnel；Host 重启只用 `scripts/restart-host.sh`

## 16. Open follow-ups（本设计不做）

1. VideoToolbox 以外的编码器（libx264 仅作 encode 失败回退，已存在）
2. 端到端 glass-to-glass 延迟仪表
3. 1080p+TURN 若用户坚持 override，自适应码率天花板（仍 ≥ 地板）
4. formal tunnel 5s 探针误报（独立运维问题，见 runbook）

## 17. Spec self-review

| 风险 | 结论 | 处理 |
|---|---|---|
| 路径 cap 被做成 stall 梯子 | 会破坏 Quality Lock | §6.4 写死 stall 不重算 |
| Host 仍用 `_locked_user_size` 否决 720p | 回归本次 bug | §6.3 改为 attempt 绑定 |
| `ok=True` 继续当成功 | 排障失败 | §7.3 两段式 |
| VideoToolbox recreate 造成新 0-fps | 中 | 每请求最多 1 次；限频 1/s |
| 只改 UI 假已连接 | 用户仍黑屏 | Phase 1+2 同验收，Phase 3 不能单独宣称完成 |
| 自动切隧道偷偷进来 | 违反既有契约 | Non-goal + 顾问 only |
| 长驻 Host 不重启则新 encoder 不生效 | 运行验收卡住 | §11.2 要求 `restart-host.sh` 一次 |
| capture_stats 覆盖 FPS | 假出画 | §8.2 禁止用采集 FPS 标已连接 |
| 1080p override 写进下一会话 | cap 失效 | §6.2 attempt 作用域 |
| 工作量拆太散 | 修不完整 | §14 要求 1+2 同 PR |

无 TBD / TODO 占位。范围单独立项，不包含 formal tunnel 慢探针。
