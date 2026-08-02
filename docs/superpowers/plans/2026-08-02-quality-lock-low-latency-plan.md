# Quality Lock 低延迟 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or executing-plans. Track with `- [ ]`.

**Goal:** 默认 Quality Lock——不自动降分辨率/不落到不可读画质；在 RTT≈100ms 级链路上消灭秒级 jitter 尖峰与 0fps 正反馈；连续性靠关键帧与地板之上的码率/帧率调节。

**Spec:** `docs/superpowers/specs/2026-08-02-quality-lock-low-latency-design.md`

**Architecture:** 演进 `LinkQualityController` + `applyMediaProfile` + Host `on_media_profile_change` / encoder 热更新；Lock 模式下 size 只读用户 `currentResolution` / 最后一次 `resolution-change`。

**Tech Stack:** 既有 Viewer JS、signal-server 转发、python-host aiortc + VideoToolbox encoder、Node/pytest 单测。

**Out of scope:** 脏矩形、指针预测、AV1、自动切 TURN/tunnel、默认降低面板分辨率。

**DoD:** Spec §12 对应当前 Phase 的条目；相关单测绿；relay 实机日志无自动 640×360 覆盖用户 720p。

---

## File map

| 文件 | 动作 |
|---|---|
| `web-client/js/link-quality-controller.js` | 信号重分类、Lock 策略、去掉 jitter→degrade 正反馈 |
| `web-client/js/link-quality-controller` 测试（新建或扩展 webrtc 测） | RED/GREEN |
| `web-client/js/webrtc.js` | applyMediaProfile / syncMediaProfile / stall keyframe / 状态分列 |
| `web-client/js/webrtc.test.js` | Lock 行为 |
| `web-client/viewer.html` / 状态条 | RTT vs 缓冲展示 |
| `python-host/host.py` | 尊重 adaptiveResolution；热更新；keyframe |
| `python-host/h264_videotoolbox_encoder.py` | 热更新 bitrate 真正生效 |
| `python-host/test_*.py` | Host 侧契约 |
| `docs/runbook` / README 短节 | Phase 4 |

---

## Phase 1 — Continuity 控制环（必做）

### Task 1.1: LinkQuality 信号重分类

**Files:** `web-client/js/link-quality-controller.js`, 测试文件

- [x] **Step 1: 失败测试**

```js
test('lock mode: high jitter with fps>0 does not degrade profile', () => {
  const c = LinkQualityController.create({ path: 'relay' });
  c.currentProfile = 'high';
  // two samples: jitter 2000, fps 15, rtt 110, loss 0
  // expect action hold or recovery flag, profile still high, profileConfig null
});

test('lock mode: brief zero fps requests recovery not survival size', () => {
  // mediaStalled samples < threshold → hold/recovery, not setProfile survival
});

test('relay structural rtt 120ms alone does not degrade', () => {
  // fps ok, rtt 120, jitter low → hold
});
```

- [x] **Step 2: RED** 跑测  
- [x] **Step 3: 实现**  
  - 区分 `observe` 返回：`hold | recover | degrade-rate | upgrade-rate | critical-stall`  
  - `highJitter && fps>0` → 不增加 degrade 画质阶梯  
  - relay 下 rtt 低于 veryHigh 且 fps>0 → 不因 high-rtt 降档  
  - critical survival **不携带 size 义务**（由 applyMediaProfile Lock 剥离 size）；或 Lock 下 critical 改为 recover  
- [x] **Step 4: GREEN**

### Task 1.2: applyMediaProfile / connection-sync 尊重用户分辨率

**Files:** `web-client/js/webrtc.js`, `webrtc.test.js`

- [ ] **Step 1: 测试**

```js
test('connection-sync on relay keeps user 1280x720 when adaptive res off', () => {
  WebRTC.adaptiveResolutionEnabled = false;
  WebRTC.currentResolution = { width: 1280, height: 720, label: '1280x720' };
  WebRTC.networkMode = 'relay';
  // syncMediaProfile / apply low profile → emit width 1280 height 720, bitrate >= floor
});
```

- [ ] **Step 2: 实现**  
  - `syncMediaProfile` 禁止用 profile 默认 size 覆盖 Lock  
  - emit 始终带 `adaptiveResolution`  
  - 正式化质量地板函数 `qualityFloorsForResolution(w,h)`（从现有 max 逻辑提取）  
- [ ] **Step 3: GREEN**

### Task 1.3: Stall → keyframe 通道（最小可用）

**Files:** `webrtc.js`, `host.py`, 可选 signaling 白名单若新事件

- [ ] **Step 1: 约定**  
  - 优先复用已有 sender keyframe API（`aiortc_media_sender` / track）；若无信令则 DataChannel 或 `media-profile-change.continuityAction='keyframe'`  
- [ ] **Step 2: 测试** Host 收到 keyframe 请求调用 force 路径（mock）  
- [ ] **Step 3: Viewer** 在 recover 动作限频 ≤1/s 触发  
- [ ] **Step 4: 日志** `WRD_KEYFRAME reason=media-stalled` 无 secrets  

### Task 1.4: 状态分列（最小 UI）

**Files:** `viewer.html`, `webrtc.js` stats 更新处

- [ ] 在现有 latency 显示旁或同一文案内区分：`RTT` 与 `缓冲`（jitterBufferMs）  
- [ ] 无缓冲数据时退化仅 RTT  

### Task 1.5: Host 忽略 Lock 下的 size 变更

**Files:** `python-host/host.py`, tests

- [ ] `adaptiveResolution is False` 时 width/height 固定为当前用户分辨率真相源  
- [ ] 日志：`WRD_MEDIA_PROFILE size locked ...`  

**Phase 1 出口验收**

- [ ] 单测全绿  
- [ ] 实机 relay：用户 720p，日志无自动 `640x360` / 无 low size 覆盖  
- [ ] 短时卡顿有 keyframe 日志而非 survival size  

---

## Phase 2 — Relay 初始档与速率带

### Task 2.1: pathPresets 重写（Lock 语义）

**Files:** `link-quality-controller.js`, tests

- [ ] relay：`initialProfile` 不再意味 854×480；改为逻辑档 `high` 或 `rate-ladder` 名，**size 不读 profile 表**  
- [ ] `maxProfile` 在 Lock 下不限制用户清晰度；仅限制是否允许低于推荐码率的自动 down（仍 ≥ 地板）  
- [ ] 文档注释更新：删除“relay 必须 low 起步”的过时假设（RTT 100ms 已反例）

### Task 2.2: 速率阶梯（无 size）

- [ ] 定义 rate levels 例：`{ name, bitrateKbps, fps }` 不含 width/height  
- [ ] degrade-rate / upgrade-rate 只在 levels 间移动并夹紧地板  
- [ ] 冷却：升级 ≥15s；降级最小间隔 ≥3s，避免 thrash  

### Task 2.3: 实机对照

- [ ] 同 TURN 节点，Lock 开，记录 1 分钟 VIEWER_STATS：jitter p95、0fps 次数、有无 Opening encoder  

---

## Phase 3 — Encoder 热路径

### Task 3.1: 打通 bitrate 热更新

**Files:** `h264_videotoolbox_encoder.py`, `host.py` screen track

- [ ] profile 仅 bitrate 变：设置 `encoder.target_bitrate`，断言无新的 Opening 日志  
- [ ] size 变：允许 Opening  

### Task 3.2: force_keyframe 限频与 GOP

- [ ] stall 时 force_keyframe  
- [ ] 全局限频（如 1s）  
- [ ] 评估 gop_size：在可接受码率波动下缩短最坏恢复（记录选择理由）  

### Task 3.3: reopen 审计

- [ ] 日志字段 `encoderReopen=true/false` 便于回归  

---

## Phase 4 — Docs / 诊断

- [ ] README 或 runbook 短节：Quality Lock 默认、与自动分辨率开关关系  
- [ ] 诊断 snapshot：`adaptiveResolution`, `rttMs`, `jitterBufferMs`, `videoBitrateKbps`, `continuityState`  
- [ ] 不写真实 TURN 密码  

---

## Test matrix（总表）

| 用例 | 期望 |
|---|---|
| Lock + relay + rtt 110 + fps 20 | hold，不降 size |
| Lock + jitter 2000 + fps 15 | hold/observe，不 survival |
| Lock + fps 0 ×2 | recover keyframe，不 survival size |
| Lock + fps 0 ×6+ | stall 处理，size 仍用户值 |
| Lock + loss 高 | rate-down ≥ 地板 |
| Lock + good ×10 | rate-up 向推荐 |
| Unlock + 旧梯子 | size 可变但有 thrash 防护 |
| 同 size 调 bitrate | 无 Opening H.264 |
| 用户 1080p→720p 手调 | 允许 reopen + 新地板 |

---

## Execution order

```text
Phase1 Task1.1 → 1.2 → 1.5 → 1.3 → 1.4
Phase2 → Phase3 → Phase4
```

1.3 可与 1.5 并行（接口先定字段）。  
每 Phase 结束可单独 commit，避免巨石。

---

## Risk checklist

| 风险 | 缓解 |
|---|---|
| 两套控制器行为分叉 | 单一 `handleReceiverStats` 入口 |
| Host 旧版忽略 adaptiveResolution | Viewer 已发正确 size；默认按用户分辨率 |
| 真弱网只保画质会卡 | UI 提示手调分辨率；不自动糊 |
| keyframe 风暴 | 限频 + 测试 |
| 改动触碰 ICE/lease | 不放宽租约；媒体事件仍要 lease |
| 与 tunnel 互相干扰 | `networkMode===tunnel` 早退保持 |
| 既有测试期望 packet-loss→survival size | Task 1.1/1.2 **先改编** `webrtc.test.js` 中 relay degrade 用例：Lock 下断言 size 不变、可断言 rate-down 或 recover；Unlock 用例另保留阶梯 |
| `jitterBufferTarget` 单位/是否生效因浏览器而异 | Phase1.4 日志对照 `jitterBufferMs`；无效则记 follow-up，不阻塞 Lock |
| Host 重连后用户分辨率真相丢失 | 以 Viewer 下次 `resolution-change` / offer 附带 presentation 为准；Host 默认 profile size 不得反向覆盖 Viewer Lock 发射值 |

---

## Plan Self-Review

1. **与 Spec 对齐：** Phase 对应 Spec §11；Accept 映射到出口检查。  
2. **质量约束：** 全程无“默认降分辨率”任务；survival size 仅 Unlock 或被禁止。  
3. **可验证：** 每个 Task 有测试或实机日志判据。  
4. **因果：** 先修控制环（Phase1）再热更新（Phase3），避免先做 encoder 仍被 thrash 打爆。  
5. **遗漏补全：** Host 双端 size lock（1.5）与 Viewer（1.2）成对，避免只改一端。  
6. **工作量：** 允许大，但分 Phase 可停；Phase1 单独已有用户价值。  
7. **不扩 scope：** 无 AV1/脏矩形/指针预测。  
8. **已知债：** 启动时 HTML 720p 与 JS 默认 540p 不一致——Phase1.2/连接初始化应读面板选中值（写入 Task 1.2 实现要点）。  

### Task 1.2 补充实现要点

- [ ] 初始化 `currentResolution` 从 `input[name=resolution]:checked` 读取，与面板默认 720p 一致。  

---

## Commit 建议（实施时）

```text
feat(media): quality-lock continuity control without resolution thrash
feat(media): rate ladder floors and relay initial quality
perf(host): hot-update h264 bitrate without reopen
docs(media): quality-lock low latency ops notes
```
