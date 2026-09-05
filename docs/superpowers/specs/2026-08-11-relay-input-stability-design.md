# Relay 输入稳定性优化设计

**日期**：2026-08-11  
**状态**：已实施；B1 终态为 pin 0ms（废止 80ms），SLA 见 `docs/superpowers/specs/2026-08-29-relay-paint-continuity-design.md`
**关联症状**：黑屏/卡顿、重连风暴、多打 Ctrl、IME 丢失、表情弹出

---

## 1. 背景与问题陈述

用户通过阿里云 TURN relay 远程桌面时，反复出现以下四个症状：

1. **黑屏 / 卡顿**：视频 fps 周期性降到 0，2-3 秒后恢复，出现画面抖动/追帧。
2. **重连风暴**：DataChannel 关闭后每 3 秒触发一次 full refresh，把健康的 relay 视频通道一起拆掉，造成连续掉线。
3. **多打 Ctrl / 幽灵修饰键**：host 侧键盘修饰键状态只增不减，keyup 事件在 DataChannel 断开时丢失，导致 Control/Command 幽灵位积累，污染后续所有按键。
4. **中文 IME 丢失 + 方向键触发表情**：幽灵 Ctrl + Space 触发 macOS 输入法切换；幽灵 Ctrl+Cmd + Space 触发表情检视器，再按 `e` 搜出一堆表情。

### 根因链（单一来源）

```
relay RTT 抖动
  → SCTP input DataChannel 心跳超时关闭（PC/ICE 仍 connected）
    ├─ keyup 事件丢失 → host _modifier_flags |= 只增不减 → 幽灵 Ctrl/Cmd
    │    └─ Ctrl+Space / Ctrl+Cmd+Space → 切输入法 / 弹表情面板
    └─ _dcReconnectTimer(3s) 到期 → noteDataChannelFault
         → 旧版 jitterBufferTarget=1ms 判定过激 → fps=0
              → scheduleReconnect → refresh() → 拆掉健康视频 relay
                   → 每 3s 一轮重连风暴
```

上述链路是本设计记录的历史故障路径。B1 的 80ms/0.08s 缓冲试验已废止；当前终态固定 relay `jitterBufferTarget=0ms`、非 relay `1ms`，`playoutDelayHint=0`，出画与卡顿口径以 2026-08-29 出画连续性 SLA 为准。

---

## 2. 修复范围与优先级

| ID | 优先级 | 改动简述 | 消除症状 |
|----|--------|----------|---------|
| B1 | P0 | relay 路径固定 `jitterBufferTarget=0ms`，`playoutDelayHint=0s`（80ms 方案已废止） | 以出画门闩和同尺寸 SPS 追帧处理黑屏、卡顿与 fps=0 |
| A1 | P0 | DC 故障 relay 模式只重建 DataChannel，不 full refresh | 重连风暴、掉线 |
| C1 | P1 | host 修饰键 reconcile，以浏览器 payload 为权威清幽灵位 | 幽灵 Ctrl/Cmd，IME 丢失，表情弹出 |
| B2 | P2 | 视 B1 效果决定是否微调 `playoutDelayHint` 下限 | 辅助改善卡顿 |

B1 先行，解决健康判定误报，让 A1 的 DC 重建路径能正确判断"视频是否真的健康"。C1 独立可并行。

---

## 3. 详细设计

### 3.1 B1 — jitterBufferTarget relay 感知（80ms 方案已废止）

**文件**：`web-client/js/webrtc.js`  
**方法**：`configureVideoReceiver(receiver)`（L1103-L1123）

**历史根因**：旧实现把 `jitterBufferTarget = 1`（1ms）用于 relay，曾导致健康判定误报。80ms/0.08s 缓冲试验随后被废止；当前实现由 2026-08-29 出画连续性设计收敛为 relay pin `0ms`、非 relay `1ms`，并配合同尺寸 refresh 与 12s SPS cooldown。

**改动**：

```js
configureVideoReceiver(receiver) {
  if (!receiver?.track || receiver.track.kind !== 'video') return;
  const isRelay = this.networkMode === 'relay'
    || this.lastCandidateType === 'relay';

  // 80ms relay 试验已废止；当前终态 pin relay=0ms，直连保持 1ms 低延迟
  if (typeof receiver.jitterBufferTarget !== 'undefined') {
    try {
      receiver.jitterBufferTarget = isRelay ? 0 : 1;
      console.log(`[LATENCY] jitterBufferTarget=${isRelay ? 0 : 1}ms (${isRelay ? 'relay' : 'direct'})`);
    } catch (error) {
      console.warn('[LATENCY] Unable to set jitterBufferTarget:', error?.message || error);
    }
  }

  // playoutDelayHint: 当前终态固定为 0
  if (typeof receiver.playoutDelayHint !== 'undefined') {
    try {
      receiver.playoutDelayHint = 0;
      console.log('[LATENCY] playoutDelayHint=0s');
    } catch (error) {
      console.warn('[LATENCY] Unable to set playoutDelayHint:', error?.message || error);
    }
  }
},
```

**调用时机**：不变——`ontrack`、`requestKeyframe`、ICE `completed` 后均调用，relay 建连后自然生效。`lastCandidateType` 在 `processStatsSnapshot` 里实时更新，切换路径后下次 `configureVideoReceiver` 调用会自动适配。

**当前契约**：不以固定 80ms 缓冲承诺 relay 稳态；relay 允许 ≤2s 追帧，连续 ≥2s 才进入 UI「画面卡顿」，连续 ≥3s 进入失败诊断线。具体出画与同尺寸 SPS 追帧口径见 2026-08-29 设计。

---

### 3.2 A1 — DataChannel 故障仅重建，不 full refresh

**文件**：`web-client/js/webrtc.js`  
**涉及方法**：`noteDataChannelFault`、新增 `rebuildDataChannels`、`createDataChannels`

**根因**：DataChannel 关闭时，`inputChannel.onclose` 3 秒后触发 `noteDataChannelFault → scheduleReconnect → refresh()`，把视频 transceiver、TURN allocation 一起拆掉。但日志显示 PC/ICE 在 DataChannel 关闭时仍 `connected/completed`，视频 relay 是健康的，拆掉是过度反应。

#### 3.2.1 可行性约束

重建 DataChannel 需确认 SCTP transport 仍存活：

- `this.pc.sctp?.state === 'connected'` → 直接 `createDataChannel`，后端 `ondatachannel` 接收，走一次 re-offer（不涉及 video transceiver）。
- `this.pc.sctp?.state` 为其他值或 `null` → SCTP 也断了，fallback 走原有 `scheduleReconnect`。

#### 3.2.2 新方法 `createDataChannels()`

提取现有 `createPeerConnection` 中建 DataChannel 的逻辑为独立方法，方便复用：

```js
createDataChannels() {
  if (!this.pc || this.inputChannel) return;
  // 现有 createDataChannel('input') 和 createDataChannel('input-move') 逻辑移入此处
  // ... (不改变 onopen/onclose/onerror/onmessage 处理器)
},
```

#### 3.2.3 新方法 `rebuildDataChannels(reason)`

```js
async rebuildDataChannels(reason) {
  if (this._rebuildingDc) return false;           // 防并发
  if (!this.pc || this.pc.connectionState !== 'connected') return false;
  if (this.pc.sctp?.state !== 'connected') {      // SCTP 已断 → full reconnect
    this.scheduleReconnect(reason);
    return false;
  }
  this._rebuildingDc = true;
  console.warn('[INPUT-DC] rebuilding DataChannels reason=%s', reason);
  try {
    // 清旧引用（onclose 不会再触发重建，因为 _rebuildingDc=true）
    this.inputChannel = null;
    this.inputMoveChannel = null;
    this.createDataChannels();           // 重建
    await this.createOffer();            // 轻量 re-offer（不碰 video transceiver）
  } finally {
    this._rebuildingDc = false;
  }
  return true;
},
```

#### 3.2.4 修改 `noteDataChannelFault`

```js
noteDataChannelFault(reason) {
  // relay 且 PC 仍 connected → 仅重建 DataChannel
  if (this.networkMode === 'relay'
      && this.pc?.connectionState === 'connected'
      && !this._rebuildingDc) {
    this.rebuildDataChannels(reason);
    return true;
  }
  // 原逻辑（非 relay 或 PC 已失效）
  if (!this.shouldReconnectForDataChannelFault(reason)) {
    this._inputDcDegraded = true;
    console.warn('[INPUT-DC] degraded reason=%s video-healthy=true skip-reconnect', reason);
    if (typeof Input !== 'undefined') Input.setKeyboardDataChannelAvailable?.(false);
    return false;
  }
  this.scheduleReconnect(reason);
  return true;
},
```

**新增状态**：`_rebuildingDc: false`（加入初始化对象）。

**预期效果**：relay 下 DataChannel 断开 → 视频画面不中断 → 3s 内重建 DC 完成 → 输入恢复。重连风暴消失。

---

### 3.3 C1 — host 修饰键 reconcile

**文件**：`python-host/input_handler.py`  
**方法**：`keyboard_input`（L708-L743）+ 新增 `_release_lost_modifier_flags`

**根因**：`_modifier_flags |= payload_flags` 只增不减；通过 payload 路径进入的修饰位（非 modifier key code 路径）不登记进 `_pressed_modifier_key_codes`，keyup 丢失后永远无法被清除。

#### 3.3.1 reconcile 逻辑

在 `action == 'keydown' and not is_modifier` 分支的**最前面**插入：

```python
# Reconcile: 浏览器 payload 是修饰键权威状态。
# payload 里没有、但 host 还记着的修饰位 → keyup 已丢失，补发清除。
if action == 'keydown' and not is_modifier:
    lost_flags = self._modifier_flags & ~payload_flags
    if lost_flags:
        self._release_lost_modifier_flags(lost_flags, reason="reconcile")
```

#### 3.3.2 新增 `_release_lost_modifier_flags(lost_flags, reason)`

```python
def _release_lost_modifier_flags(self, lost_flags: int, reason: str = "reconcile") -> None:
    """补发丢失的修饰键 keyup，清除幽灵修饰位。"""
    flag_to_keycodes = {
        kCGEventFlagMaskCommand:   [55, 54],   # Left/Right Cmd
        kCGEventFlagMaskShift:     [56, 60],
        kCGEventFlagMaskAlternate: [58, 61],
        kCGEventFlagMaskControl:   [59, 62],
    }
    logger.warning(
        "reconcile: releasing lost modifier flags=0x%08x reason=%s",
        lost_flags, reason
    )
    for flag, keycodes in flag_to_keycodes.items():
        if not (lost_flags & flag):
            continue
        self._modifier_flags &= ~flag
        for kc in keycodes:
            if kc in self._pressed_modifier_key_codes:
                self._pressed_modifier_key_codes.discard(kc)
                self._pressed_key_codes.discard(kc)
                event = CGEventCreateKeyboardEvent(self.source, kc, False)
                CGEventSetFlags(event, self._modifier_flags)
                CGEventPost(kCGHIDEventTap, event)
                logger.info("  -> reconcile keyup mac_code=%s flag=0x%08x", kc, flag)
                break  # 每个修饰族补一个 keyup 即可
```

**IME 安全性**：方向键/Esc 在 `_ime_nav_keys` 白名单，不进此分支，IME 候选词导航不受影响。Reconcile 仅在**非修饰键 keydown**时触发，不干扰正常的修饰键按下/释放序列。

**预期效果**：DataChannel 断开丢失 keyup → 下一次按键 reconcile 自动清幽灵位 → 不再触发 Ctrl+Space、Ctrl+Cmd+Space → IME 稳定，无表情弹出。

---

## 4. 数据流与错误处理

### 4.1 B1 数据流

```
ICE completed / ontrack
  → configureVideoReceiver(receiver)
    → 检查 networkMode / lastCandidateType
    → 设置 jitterBufferTarget (relay:0ms / direct:1ms)
    → 设置 playoutDelayHint  (relay:0s / direct:0s)
```

失败路径：`jitterBufferTarget` / `playoutDelayHint` 赋值可能在部分浏览器抛异常，已有 try/catch，降级为无 hint（现有行为）。

### 4.2 A1 数据流

```
DataChannel onclose (pc=connected)
  → _dcReconnectTimer (3s)
    → noteDataChannelFault('dc-closed')
      → relay && pc.connected?
        ├─ yes: rebuildDataChannels()
        │         → pc.sctp.state === 'connected'?
        │           ├─ yes: createDataChannels() + createOffer()
        │           └─ no:  scheduleReconnect() [fallback]
        └─ no:  原路径 (shouldReconnectForDataChannelFault / scheduleReconnect)
```

失败路径：`createOffer` 失败 → `_rebuildingDc = false`（finally 块），下次 DC 故障可再次尝试。多次重建失败（>= 3 次，可通过 `_dcRebuildFailCount` 计数）降级到 `scheduleReconnect`。

### 4.3 C1 数据流

```
keyboard keydown (非修饰键)
  → 计算 payload_flags（来自浏览器 modifiers 字段）
  → lost_flags = _modifier_flags & ~payload_flags
  → lost_flags > 0? → _release_lost_modifier_flags()
  → 继续原有 keydown 处理
```

失败路径：`CGEventCreateKeyboardEvent` 抛异常 → 已有 try/except 包裹（沿用现有模式），幽灵位仍被清除（flag 已在 `_modifier_flags &= ~flag` 先清），只是没发出 CGEvent keyup，对 macOS 影响极小。

---

## 5. 测试策略

### 5.1 B1 测试

- **现有测试**：`web-client/js/webrtc-stats.test.js`——不涉及 `configureVideoReceiver`，无需修改。
- **自动化 / 手动边界**：当前实现与 2026-08-29 出画连续性 SLA 已由自动化覆盖；真实 relay DevTools、真机和公网路径观察为 **NOT RUN**，不得以 80ms 作为验收目标。

### 5.2 A1 测试

- **新增单元测试**（`webrtc.test.js`）：
  - `rebuildDataChannels` 在 `pc.sctp.state === 'connected'` 时调用 `createOffer` 而不调用 `refresh`。
  - `rebuildDataChannels` 在 `pc.sctp.state !== 'connected'` 时 fallback 到 `scheduleReconnect`。
  - 并发调用 `rebuildDataChannels` 时 `_rebuildingDc` 防重入生效。
- **手动验证**：relay 连接稳定后，强制关闭/重开 DataChannel（通过 DevTools），验证视频画面不中断，3s 内输入恢复。

### 5.3 C1 测试

- **现有测试**：`python-host/test_remote_keyboard_state.py`、`test_quartz_keyboard_adapter.py`——添加 reconcile 场景用例：
  - 发送 keydown(Control) + keydown(普通键，modifiers.ctrl=false) → 断言 `_release_lost_modifier_flags` 被调用，幽灵 Control 位清除。
  - 发送正常 Cmd+C 序列（keydown Meta + keydown C，modifiers.meta=true）→ 断言 Meta 位**不被**清除。
- **手动验证**：relay 下打字，用方向键导航 Pinyin 候选，持续 5 分钟，不触发输入法切换或表情面板。

---

## 6. 不在本次范围内

- Host 机器 CPU 负载（`systemLoad1` 过高）——用户明确排除。
- `_autoFailCount` 计数器在重建成功后的重置策略——可后续迭代。
- B2（`playoutDelayHint` 精细调整）——80ms 方案已废止，当前终态固定为 `0`，不单独推进。
- TURN allocation 600s 过期续期——目前 aioice 已自动 refresh，不存在实际过期问题（`TURN allocation refreshed` 日志证实）。
