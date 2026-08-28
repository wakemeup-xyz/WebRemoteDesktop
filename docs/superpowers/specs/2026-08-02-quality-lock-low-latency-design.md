# Quality Lock 低延迟设计（不压画质）

日期：2026-08-02  
状态：Draft for implementation  
关联：TURN 多节点 `2026-08-02-multi-turn-server-selection`；既有媒体自适应 `link-quality-controller.js`

## 1. Goal

在 **网络 RTT 已可接受（TURN 约 100–110ms，直连约 1–5ms）** 的前提下，把远程桌面的体感延迟从「偶发秒级卡顿/发糊」收敛到 **稳态端到端约 150–200ms，且无秒级尖峰**，同时 **默认绝不自动压缩画质**（不自动降分辨率；拥塞时也不落到“看不清 UI”的码率/帧率）。

一句话：

> **画质由用户锁定；系统只做连续性恢复（关键帧、缓冲复位、地板之上的码率/帧率微调），禁止用糊画面换通畅。**

## 2. Background

### 2.1 实测事实（代码 + 日志）

| 观察 | 含义 |
|---|---|
| Relay RTT ≈ 100–110ms | 网络路径不是主矛盾 |
| 直连 RTT 1–5ms、Jitter &lt;10ms、20fps | 管道本身能做到低延迟 |
| 尖峰：`fps=0` 后 `jitter_buffer` 1.5–3s | 体感“慢”来自播放侧囤帧 + 断流 |
| `low ↔ survival` thrash | 自动改 size/重开编码器制造新断流 |
| `relay.initialProfile=low` + `maxProfile=medium` | 一连接就主动降质 |
| `playoutDelayHint=0` / `jitterBufferTarget=1` 已设 | 断流后浏览器仍会拉高缓冲 |
| 默认已关 `adaptiveResolution` + 码率地板 | 正确起点，但控制环仍是“降质保活”模型 |

### 2.2 现状架构问题

`LinkQualityController.profiles` 将 **width×height ⊕ fps ⊕ bitrate** 绑成单一梯子（high→medium→low→survival）。这是通话式弱网模型，与远程桌面「文字/UI 必须可读」冲突。

正反馈环：

```text
短暂 0-fps / 关键帧空窗
  → jitter 尖峰 (≥150ms)
  → degrade / survival
  → 可能 reopen H.264
  → 再 0-fps
  → 更大 jitter
```

### 2.3 已落地且保留的行为

1. `adaptiveResolutionEnabled` 默认 **false**（`wrdAdaptiveResolution` 仅 `'1'` 开启）  
2. 分辨率面板开关文案与 localStorage  
3. 锁定分辨率时 applyMediaProfile 的码率/帧率地板（补丁级，本设计升级为正式契约）  
4. relay 上避免因 structural RTT 触发 ICE restart（保留）  
5. Host `media-profile` 完全相同则 ignore（保留并扩展为 size 不变时热更新）

## 3. Confirmed Product Decisions

1. **默认 Quality Lock**：不自动改分辨率。  
2. **用户手调分辨率** 始终允许，且是画质的唯一来源（Lock 模式下）。  
3. **开启「自动调整分辨率」** 才允许旧式 size 阶梯（兼容逃生，非默认）。  
4. **不压画质** 定义为：  
   - 不自动降低 width/height；  
   - 自动调节时码率/帧率不得低于分辨率对应的 **质量地板**；  
   - 禁止把 survival（640×360 / 8fps / 500kbps）作为 Lock 模式常规档。  
5. **连续性优先于“再降一档画质”**：stall 先关键帧与缓冲复位，不先糊化。  
6. **状态可解释**：UI/诊断区分 网络 RTT、播放缓冲、当前档位/码率。  
7. **TURN 节点选择** 与本设计正交；默认阿里云等既有策略不变。

## 4. Non-Goals

1. 不实现脏矩形/桌面分区编码。  
2. 不实现客户端指针预测（可二期）。  
3. 不自动从 Strict STUN 失败切 TURN/tunnel。  
4. 不把 tunnel JPEG 路径与 WebRTC 自适应强行合并（tunnel 保持独立 backpressure）。  
5. 不引入 SVC/AV1 等新编码栈（本阶段仍 H.264 + VideoToolbox/libx264）。  
6. 不以下调默认分辨率或默认 540p 来“优化延迟”。

## 5. Quality Lock 契约

### 5.1 Presentation（用户拥有）

| 字段 | 来源 | Lock 下可变？ |
|---|---|---|
| `width` / `height` | 分辨率面板 / `resolution-change` | 仅用户 |
| `minBitrateKbps` | 由分辨率推导 | 系统只上调地板，不跌破 |
| `targetFps` 偏好 | 默认 20；可随 continuity 微调 | 可降但不低于地板 |
| `adaptiveResolution` | 面板开关 | 用户 |

### 5.2 质量地板（Lock 模式强制）

| 用户分辨率（短边或像素） | minBitrateKbps | minFps | 推荐 targetFps |
|---|---|---|---|
| ≥ 1920×1080 | 2500 | 12 | 20 |
| ≥ 1280×720 | 1800 | 12 | 20 |
| ≥ 960×540 | 1200 | 12 | 15–20 |
| 更低（用户手选） | 900 | 10 | 15 |

说明：

- 地板用于 **自动调节的下限**；用户若手选更低分辨率，地板随新分辨率重算。  
- 上限可保持现有 clamp（如 5000kbps）或按分辨率提高到 6000（实现阶段选定，需单测）。  
- **禁止** Lock 模式下自动落到 500kbps @ 高分辨率。

### 5.3 Continuity（系统拥有）

允许的自动动作（Lock 模式）：

1. 请求关键帧（PLI/FIR / force_keyframe）  
2. 重申接收侧 `playoutDelayHint` / `jitterBufferTarget`  
3. 在质量地板之上调节 `videoBitrateKbps`  
4. 在 minFps…targetFps 之间调节 `targetFps`  
5. 日志与 UI 提示「链路质量差，建议手调分辨率/换 TURN 节点」

禁止的自动动作（Lock 模式）：

1. 修改 width/height  
2. 应用 survival 的 640×360 包  
3. 仅因 `jitterBufferMs` 高且 fps&gt;0 而降档  
4. 因 relay structural RTT（如 80–250ms）而降画质  
5. 为“换档”而 reopen 同尺寸编码器

## 6. Architecture

### 6.1 控制面拆分

```text
┌─────────────────────────────────────────┐
│ Presentation (user)                     │
│  resolution panel → currentResolution   │
│  adaptiveResolution flag                │
└─────────────────┬───────────────────────┘
                  │ resolution-change / lock flag
                  ▼
┌─────────────────────────────────────────┐
│ ContinuityController (new semantics)    │
│  inputs: fps, rtt, jitter, loss, pair   │
│  outputs: keyframe? bitrate? fps?       │
│           NEVER size when locked        │
└─────────────────┬───────────────────────┘
                  │ media-profile-change
                  │  {width,height locked, bitrate, fps, reason, adaptiveResolution}
                  ▼
┌─────────────────────────────────────────┐
│ Host media pipeline                     │
│  ignore size if adaptiveResolution=false│
│  hot-update bitrate/fps if size same    │
│  reopen encoder ONLY on size change     │
│  force_keyframe on request              │
└─────────────────────────────────────────┘
```

实现上可：

- **演进** 现有 `LinkQualityController`（推荐，减少双轨），或  
- 新增 `ContinuityController` 并在 Lock 时接管 `handleReceiverStats`。  

本设计要求：**对外行为** 满足契约；模块名以实现 plan 为准，优先演进而非平行两套互相打架。

### 6.2 信号重分类

| 信号 | 分类 | Lock 动作 |
|---|---|---|
| 无 selected pair | hold | 不调媒体 |
| media warmup（启动 grace） | hold | 不降档 |
| `fps=0` 短时 | recovery | keyframe；累计 stall |
| `fps=0` 持续（如 ≥6 个 1Hz 样本，可配置） | stall | keyframe + 诊断；仍不改 size |
| `jitter` 高且 `fps>0` | observe | **不降档**；可重申 jitterBufferTarget |
| `jitter` 高且 `fps≈0` | recovery | 同 fps=0 |
| relay RTT 80–250 | structural | **忽略** 作为 degrade 理由 |
| RTT 极高（如 ≥1200，可配置） | congestion | 仅地板上降码率/fps |
| packet loss 显著 | congestion | 地板上降码率；可略降 fps |
| 连续 good（如 10 样本 + 冷却） | upgrade | 码率/fps 向推荐值回升 |

### 6.3 断流恢复状态机

```text
NORMAL
  │ fps≈0 / media-stalled
  ▼
RECOVERING_KEYFRAME ──(限频, e.g. ≤1/s)──► 请求关键帧 + 重申接收缓冲
  │ 恢复 fps>0
  ▼
NORMAL

  │ 持续 stall 超过阈值
  ▼
RECOVERING_STALL
  │ 可选：检查 DC/PC 状态；relay 上默认不 restartIce
  │ 仍禁止改 resolution
  ▼
DEGRADED_RATE (可选)
  │ 仅 bitrate/fps ∈ [floor, target]
  ▼
NORMAL（good 累计后）
```

### 6.4 Viewer 行为

1. `applyMediaProfile(profile, reason)`  
   - Lock：`width/height = currentResolution`；bitrate/fps 经地板夹紧；`adaptiveResolution: false` 写入事件。  
   - Unlock：允许 profile 自带 size（旧梯子），但建议仍避免无意义 reopen。  
2. `syncMediaProfile` / `connection-sync`  
   - **不得**用 relay low 的 854×480 覆盖用户分辨率。  
   - 初始：用户分辨率 + 推荐码率/帧率（见地板表「推荐」）。  
3. `handleReceiverStats`  
   - 按 §6.2 分类；recovery 走 keyframe API，不走 survival size。  
4. 接收侧  
   - 保持 playoutDelayHint=0、jitterBufferTarget 低值。  
   - 在 RECOVERING_* 结束、首帧恢复时 **再次** 设置 jitterBufferTarget（对抗浏览器囤积）。  
5. UI  
   - 分辨率面板：保留自动分辨率开关（默认关）。  
   - 状态：`RTT x ms · 缓冲 y ms · 码率 z kbps`（文案可中文精简）。  
   - 可选顾问提示：缓冲长期过高时建议检查编码/换节点，**不自动改分辨率**。

### 6.5 Host 行为

1. `on_media_profile_change`  
   - 若 `adaptiveResolution === false`（或缺失且产品默认 Lock）：**强制 width/height 保持当前 media_profile/screen_track 用户分辨率**（以最后一次 `resolution-change` 为准）。  
   - 若仅 bitrate/fps 变化且 size 不变：调用热更新，**不**走会触发 `Opening H.264 encoder` 的重建路径。  
   - 若 size 真变（仅 Unlock 或用户 resolution-change）：允许重建。  
2. `resolution-change`  
   - 更新用户分辨率真相源；必要时重建/重配 track 与 encoder。  
3. Keyframe  
   - 增加明确路径：信令或 DataChannel `request-keyframe` / 复用既有 sender API；stall 恢复优先走此路。  
4. GOP  
   - 评估缩短关键帧间隔或 stall 时 force_keyframe，使最坏恢复 &lt; ~1s（实现阶段用数据选定，避免无限制关键帧风暴：限频）。  

### 6.6 与「自动调整分辨率=开」的兼容

| 模式 | size | 码率/fps | survival |
|---|---|---|---|
| Lock（默认） | 固定 | 地板上调节 | 禁止作为 size 来源 |
| Adaptive Res ON | 允许阶梯 | 随 profile | 允许但需冷却/滞回，减少 thrash |

Unlock 模式不作为本阶段主验收路径，但不得回归死循环 thrash（保留 reopen 防护与 duplicate ignore）。

## 7. API / 事件契约

### 7.1 `media-profile-change`（Viewer → Host，经既有信令）

```json
{
  "schemaVersion": 2,
  "leaseId": "...",
  "leaseEpoch": 1,
  "profile": "high|medium|low|survival|lock-hold",
  "width": 1280,
  "height": 720,
  "targetFps": 20,
  "videoBitrateKbps": 2200,
  "reason": "connection-sync|packet-loss|keyframe-recovery|sustained-good|...",
  "adaptiveResolution": false,
  "continuityAction": "none|keyframe|rate-down|rate-up|hold"
}
```

- Lock 下 Host 以 `adaptiveResolution=false` 为准忽略非法 size。  
- `continuityAction=keyframe` 时可与独立 keyframe 消息合并实现。

### 7.2 Keyframe 请求（推荐独立，便于限频）

```json
{
  "type": "request-keyframe",
  "reason": "media-stalled",
  "leaseId": "...",
  "leaseEpoch": 1
}
```

传输：优先 DataChannel；fallback Socket.IO（与 input 一致需租约）。

## 8. Encoder 热更新语义

| 变更 | 期望 |
|---|---|
| 同 W×H，改 bitrate | `target_bitrate` 热写；无 Opening 日志 |
| 同 W×H，改 fps | track `set_target_fps`；无 reopen |
| 改 W×H | 允许 reopen；先 keyframe |
| 连续相同包 | 已有 ignore；保持 |

实现注意：当前 open 时 bitrate 可能未全程跟随 `media_profile["video_bitrate_kbps"]`——本设计要求 **打通** profile 码率 → encoder.target_bitrate。

## 9. Security & Safety

1. 媒体事件仍需控制租约（既有 lease 模型）。  
2. keyframe 限频，防止恶意/失控刷屏。  
3. 不在日志打印 TURN 凭据、码率调节可打 kbps 数字。  
4. 不因本设计扩大匿名 ICE 配置暴露。

## 10. Compatibility

1. 旧 Viewer 不传 `adaptiveResolution`：Host 默认按 **Lock**（false）处理 size。  
2. 旧 Host 忽略新字段：Viewer 仍不发非法 size（Lock 下 width/height 已是用户值）。  
3. `wrdAdaptiveResolution`、`wrdNetworkMode`、`wrdTurnServerId` 键保持。  
4. tunnel 模式不走本 WebRTC continuity 主路径。

## 11. Phased Delivery

### Phase 1 — Continuity 控制环（必做）

- 信号重分类；stall→keyframe  
- Lock 下禁止 survival size / 自动改分辨率（双端）  
- connection-sync 使用用户分辨率 + 质量码率  
- 基础分列状态（RTT / 缓冲）  
- 测试：模拟 0fps/jitter 不触发 640×360

### Phase 2 — 质量地板与 relay 初始档

- 正式地板表  
- relay 取消“初始 low、上限 medium”的降质策略（Lock 下）  
- 码率/fps 在地板上 up/down + 冷却  

### Phase 3 — Encoder 热路径与 GOP/关键帧

- 同 size 热更新 bitrate  
- keyframe 限频通道  
- reopen 审计日志  

### Phase 4 — 观测与文档

- 诊断 snapshot 字段  
- README/runbook 简述 Quality Lock  
- 需求文档一句对齐（若有媒体章节）

## 12. Acceptance

- [ ] 默认 Lock：全程用户分辨率不变（日志无自动 640×360 / 854×480 覆盖用户 720p/1080p）  
- [ ] Relay RTT~100ms 场景：不因 structural RTT 降画质  
- [ ] 注入短时 0fps：优先 keyframe 日志；不 emit survival size  
- [ ] 长时 good：码率/fps 回到推荐带，分辨率仍不变  
- [ ] 同 size 调码率：无 `Opening H.264 encoder`（Phase 3）  
- [ ] 状态栏或诊断可区分 RTT 与播放缓冲  
- [ ] 开启自动分辨率后，仍可手动阶梯（逃生），但有 thrash 防护  
- [ ] 单测/集成测试覆盖 Lock 主路径  
- [ ] 凭据不泄漏

## 13. Open Follow-ups

1. 端到端延迟主动测量（帧 timestamp / glass-to-glass）  
2. 指针本地预测  
3. 按内容复杂度的码率（仍 ≥ 地板）  
4. AV1/VP9 实验  

## 14. Spec Self-Review

| 风险 | 结论 | 处理 |
|---|---|---|
| 只抬地板不改控制环 | 不够 | Phase 1 强制信号重分类 |
| Lock 下仍 connection-sync 到 low size | 回归 | §6.4 明确禁止 |
| keyframe 风暴 | 中 | 限频 + 单测 |
| 真·严重丢包时只保画质会卡 | 可接受 | 提示用户手调；地板上可降码率 |
| 双控制器并行 | 高 | 演进 LinkQuality 或单一入口 handleReceiverStats |
| Host/Viewer 默认不一致 | 中 | 缺省 Lock；字段显式传递 |
| 与“不压画质”冲突的 survival | 高 | Lock 禁止 size 来源 |
| 工作量过大一次做完 | 中 | 分 Phase，DoD 可分期勾选 |

relay 默认 cap 见 2026-08-29：`docs/superpowers/specs/2026-08-29-relay-paint-continuity-design.md`。
