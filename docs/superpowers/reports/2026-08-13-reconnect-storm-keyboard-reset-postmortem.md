# 复盘报告：黑屏重连风暴 + 键盘需复位

**日期**：2026-08-13  
**涉及提交**：`3ff9859`、`2d244e8`、`57632aa`、`949db96`、`ec1cc81`  
**状态**：第五轮修复已实施（keepalive + 测试补充），等待长效验证

---

## 一、问题现象回顾

用户反馈两个独立但同源的症状：

**症状 A — 黑屏 + 重连风暴**  
每次 Alt-Tab 切换标签页，返回投屏时触发黑屏并连续重连，每轮约 1.7 秒，有时持续数十轮才稳定。

**症状 B — 键盘需复位**  
重连后页面显示「键盘：需复位」，所有键盘输入被阻断，必须手动点击复位或等待很久才能恢复。两个症状有时独立出现，有时联合出现。

---

## 二、历次修复回顾与失败原因分析

### 第一轮：`3ff9859`（2026-08-12，relay jitterBuffer 感知）

**修复内容**：`configureVideoReceiver` 中将 `jitterBufferTarget` 从 1ms 改为 relay 路径 80ms，`playoutDelayHint` 从 0 改为 0.08s。

**修复的问题**：周期性 fps=0 假死黑屏。relay 路径30-40ms RTT，1ms jitter buffer 无法吸收抖动 → 帧凑不齐 → 解码器停摆 → fps=0 触发健康检查误报 → scheduleReconnect。

**为什么没有彻底解决**：  
这轮只解决了「视频路径假死导致的重连」。但黑屏/重连还有另一条根因：DataChannel 在后台独立死亡，而这与 jitter buffer 无关。修的是症状之一，不是全部。

---

### 第二轮：`2d244e8`（2026-08-12，DC 重建不发 offer）

**修复内容**：新增 `rebuildDataChannels` 路径。relay 模式下 DC 故障时只重建 DataChannel，不触发 full refresh（不拆视频）。

**修复的问题**：每次 DC 关闭都触发全量 refresh → 把健康的视频 relay 一起拆掉 → 重连风暴。

**为什么没有彻底解决**：  
`rebuildDataChannels` 有一个 fallback：当 `pc.sctp?.state !== 'connected'` 时，说明 SCTP 协议栈已死，无法复用，此时正确地回落到 `scheduleReconnect`。

但这个 fallback 正是触发风暴的路径！Chrome 后台标签节流会让 SCTP 心跳超时，SCTP association 死亡（而 ICE 因为 STUN consent probe 仍然存活）。所以每次 DC 关闭 → SCTP dead → rebuildDataChannels 回落 → scheduleReconnect → 风暴。F1 修复的路径（SCTP alive）在现实场景中不是主路径；主路径是 SCTP dead 的 fallback，没有修到。

---

### 第三轮：`57632aa`（2026-08-12，四部分修复）

**修复内容**：
- F1：rebuildDataChannels 移除 createOffer（防止 host 全量重建）
- F2：wait_for_fresh_capture 超时 0.5s → 2.0s（防止 applied=false storm）
- F3：TURN channel dead detection（20s no bytes → auto refresh）
- F4：requestTimeoutMs relay 1500ms → 4000ms

**修复的问题**：
- F2 有效解决了因 capture 超时导致的 applied=false 风暴（日志中 fresh-capture-timeout 从 15次/日降至 4次/日）
- F3 有效解决了超过20分钟的长时黑屏不自愈
- F4 有效减少了 request-timeout 导致的误触 refresh

**为什么没有彻底解决**：

**F3 的盲区**：`isHealthSuppressed()` 在 `suspended / suspending / resuming` 三个 phase 均返回 true，所以 F3 的 `_noRelayReceiveCount` 在 page-hidden 期间被持续清零，无法探测。page-hidden 期间 TURN channel 死亡，F3 永远不会触发，隐患在用户返回时才爆发。

**退避崩溃**：`_reconnectAttempt` 在每次 `pc.connectionState === 'connected'` 时被重置为 0（`webrtc.js:2680`）。由于 DC 死亡后的每次重连都会使 PC brief-connect 然后 DC 又死，`_reconnectAttempt` 在每轮结束时归零，导致退避延迟永远是 1500ms = 风暴节拍稳定在 ~1.7s/轮。

**没有 proactive 检测**：visibilitychange 返回 tab 时只调用 `ensureMediaActiveIfVisible`，不检查 DC 是否存活。DC 死了还是发 media-active 请求，然后等 3s timer 触发 DC close → scheduleReconnect → storm。多了 3 秒的启动延迟，但风暴还是一样发生。

---

## 三、本轮修复：`949db96`（2026-08-13）

### 修复内容

**FIX-A（黑屏重连风暴）— 2 处改动**

1. **3s 冷却保护**（`scheduleReconnect`）  
   在 `refresh()` 中记录 `_lastRefreshAt = Date.now()`。`scheduleReconnect` 入口加判断：若距上次 refresh 不足 3 秒，直接返回，不再排队。  
   作用：截断「PC brief-connect → `_reconnectAttempt = 0` → 下一轮 1500ms delay → refresh()」的循环。即使 DC 又死，3s 内不会触发第二次 refresh。

2. **tab 返回主动检测 DC**（`visibilitychange`）  
   用户返回 tab 时，若 `pc.connectionState === 'connected'` 且 `inputChannel.readyState !== 'open'`，立即调用 `refresh({ reason: 'dc-dead-on-resume' })`，不进入 media-active + 3s timer 的路径。  
   作用：提前1次单次干净重连，避免先发媒体请求再等3秒才发现 DC 死了的浪费。

**FIX-B（键盘需复位）— 1 处改动**

在 `remote-keyboard-controller.js` 的 `syncTransportState('ready')` 里，新增：
```javascript
if (resetRequired && !resetBarrierPending) {
  resetRequired = false;
}
```

**根因**：DC 死亡 → `markAdapterUnavailable('dataChannel')` → `sendReset` → barrier（deadline = now + 3000ms）→ barrier 超时（`expireBarrier`）→ `reacquireRequired = true`，**同时** `leaseId = null` → `syncTransportState` 通知 controller：state = `'reacquire-required'` → `resetRequired = true, resetBarrierPending = false`。

之后新连接建立，`setLease(newLease)` 使 transport 恢复 `'ready'`，`syncTransportState('ready')` 触发 `reconcilePendingMode()`，但其条件是 `resetRequired && resetBarrierPending`，因为 `resetBarrierPending = false`，条件为 false → `resetRequired` 永不清除 → 键盘永久卡在 `RESET_REQUIRED`。

修复逻辑：transport 已经 ready + 新 lease 已绑定 + 没有 in-flight barrier，说明旧的 reset 上下文已经完全失效，直接清除 `resetRequired`。

---

## 四、为什么之前修复一直没能成功？根因总结

### 根因一：误判了「主路径」

每次修复都在解决能观测到的症状，但没有识别出哪条代码路径是真正的主路径。

- `rebuildDataChannels`（F1）是理想路径，但现实中 SCTP 死了走不到；
- F3 是合理的保护，但它只在活跃状态下运行，page-hidden 期间完全盲区；
- 每次修复都是在"可见的"失败点打补丁，忽略了更深处的链路。

### 根因二：没有追到退避崩溃

`_reconnectAttempt = 0` 在 PC connected 时重置，这是很早就存在的代码（2680 行）。设计意图是合理的：成功连接后退避计数应该清零。但在 DC 持续故障的场景下，PC brief-connect + DC 立即死亡 + `_reconnectAttempt` 归零，形成一个无上限的1500ms 定频风暴。这个问题从未被识别为根因，而是被当成"风暴已经在发生"的背景噪音。

### 根因三：没有读懂 SCTP vs ICE 的生存逻辑

ICE consent probes 走 STUN，SCTP 心跳走 DTLS-SRTP over TURN。两者独立。Chrome 后台节流只影响 SCTP，不影响 STUN。所以 ICE = completed 给了「连接健康」的假象，掩盖了 SCTP 已死的事实。之前修复都假设「ICE alive = 通道健康」，没有把 SCTP 和 ICE 的独立性纳入考虑。

### 根因四：键盘 reset 的状态机边界没有覆盖

`resetBarrierPending` 变量有两条被设为 false 的路径：
1. `setLease(null)` — 正常路径，会清除 `resetRequired`
2. `syncTransportState('reacquire-required')` — 异常路径，只设 `resetRequired = true`，但 `resetBarrierPending = false`

后者是 barrier 超时后走的路径。超时后 `leaseId = null`，transport 通知 `'reacquire-required'`，controller 记录 `resetBarrierPending = false`。这意味着 `reconcilePendingMode` 的清除条件永远无法满足，状态机进入了设计者没有考虑到的角落状态：「reset 已请求但 barrier 已过期且新 lease 已来但 resetRequired 未清除」。

---

## 五、本轮修复能否成功？诚实的自我审查

### 有效性已得到初步日志验证

| 阶段 | DataChannel CLOSED | new-offer | fresh-capture-timeout |
|------|-------------------:|----------:|----------------------:|
| log.2（57632aa 前）| 318 | 151 | 15 |
| log.1（57632aa 后，新修复前）| 196 | 94 | 4 |
| 今日旧代码段（21:03-21:34）| 28 | 14 | 1 |
| **今日新代码段（21:34-21:46）** | **0** | **0** | **0** |

**新代码上线时间**：21:19 提交，但前端 JS 由浏览器加载，用户在 21:34 刷新页面后新代码才生效。  
新代码生效后 12 分钟内（21:34-21:46），触发了一次 page-hidden（21:40），但没有产生任何 DC 死亡、new-offer 或 storm 事件。这是积极信号。

### 仍然存在的不确定性

**1. 样本时间太短**  
新代码上线后只有约 12 分钟的数据（21:34~21:46），且包含一次 page-hidden。时间窗口太短，无法排除偶然性。

**2. FIX-A 的3s 冷却是「截流」而非「根治」**  
冷却保护阻止了风暴的持续，但 DC 死亡的根因（Chrome 后台节流 SCTP）没有被消除。每次 tab 返回还是会触发一次 fresh 重连（来自 FIX-A2 的主动检测），只是不会再连续循环。用户体验从「黑屏几十轮」变成「黑屏一次然后恢复」。

**3. DC 死亡 → 重连 → 稳定的路径假设是否总成立？**  
FIX-A2（proactive refresh on tab return）依赖一个假设：重连后新 DC 能稳定。但如果新 TURN 分配的 UDP 通道也不稳定（高 RTT 导致 SCTP 心跳再次超时），理论上可能在下一次 tab-hide 再发生一轮。3s 冷却会阻止短时间内的第二轮，但不能保证永不再发。

**4. 键盘 reset 修复的逻辑安全性**  
在 `syncTransportState('ready')` 里清除 `resetRequired` 的条件是 `resetRequired && !resetBarrierPending`。需要审查：
- 是否存在「transport ready 但 reset 仍有意义」的场景？  
  答：transport ready = 新 lease 绑定 + 无 barrier + 可发送。此时继续持有 `resetRequired` 没有实际作用（所有新发送都会被 `transportReady()` 检查放行）。风险极低。
- 是否有测试覆盖？  
  现有 167 个 JS 测试全部通过。测试文件 `remote-keyboard-controller.test.js` 和 `keyboard-transport.test.js` 覆盖了 barrier、reacquire、lease 等路径，但**没有专门测试「barrier 超时 + 新 lease 来 → resetRequired 清除」这个新修复路径**。需要补测试。

---

## 六、用户反馈问题完整清单核对

| 问题 | 状态 | 说明 |
|------|------|------|
| 黑屏 / fps=0 周期性黑屏 | ✅ 已修 | `3ff9859` jitterBuffer 80ms，消除假死 fps=0 |
| 重连风暴（每次 tab 切换）| ⚠️ 部分改善 | `949db96` 3s 冷却 + proactive 检测；风暴从「数十轮」降为「1次重连」；SCTP 根因未消除 |
| 键盘需复位 | ✅ 已修 | `949db96` 清除过期 resetRequired；需补充测试 |
| 幽灵 Ctrl/Cmd 按键 | ✅ 已修 | `6610705` modifier flags reconcile |
| IME 丢失 + 方向键弹表情 | ✅ 已修 | `6411c87` + `6610705` 修饰键重置 + IME nav key 白名单 |
| 投屏长时间无操作后黑屏不恢复（14min 黑屏）| ✅ 已修 | `57632aa` F3 TURN channel dead detection（20s no bytes） |

**遗留问题**：`reconnect storm` 的 SCTP 根因（Chrome 后台节流）是浏览器行为，代码层面无法完全规避，只能靠健壮的 recovery 机制减少影响。当前修复将「风暴」降级为「一次正常重连」，属于可接受的处理方式。

---

## 七、后续建议

1. **补充测试**：为 `syncTransportState('ready')` 的 `resetRequired && !resetBarrierPending` 清除逻辑写专项测试，防止回归。

2. **监控 `dc-dead-on-resume` 事件**：新修复触发时会打 `[INPUT-DC] DC dead on tab return, proactive refresh` 日志。建议统计该日志频率，作为「DC 在后台死亡的频率」指标，为是否需要进一步优化提供数据。

3. **长效验证**：需要在正常使用中观察1-2天，确认多次 alt-tab 场景下重连风暴不再出现，键盘不再卡死。

---

**Commit SHA**：`949db96`  
**文件改动**：`web-client/js/webrtc.js`（+17行）、`web-client/js/remote-keyboard-controller.js`（+6行）  
**测试**：167 JS tests pass

---

## 八、第五轮补充修复：`ec1cc81`（2026-08-14，DC keepalive）

### 背景研究结论

查阅 Chrome 官方文档后确认：

- **Chrome 88+**：background tab 在满足「5分钟后台 + 无活跃实时连接 + 无声音」时，JS timer 被 intensive throttle（最多1分钟一次）。豁免条件：有 `open RTCDataChannel` 或 live `MediaStreamTrack`。
- **Chrome 133+**：Energy Saver 模式下 CPU 密集的 background tab 会被**完全 freeze**。豁免条件完全相同。
- **Screen Wake Lock API 无效**：该 API 在 tab 变 hidden 时自动释放，对防止后台 DC 死亡毫无帮助。
- **SCTP heartbeat**：运行在 C++ 网络线程，理论上不受 JS timer throttle 影响，但 SCTP 本身有空闲超时（协议默认约30s无流量可超时），且 renderer 进程被 freeze 后包发送通道同样受阻。

**核心悖论**：DataChannel 死了 → 失去 Chrome 豁免 → Chrome 更激进地 freeze tab → SCTP 更难恢复 → 形成恶性循环。

### 修复内容

**DC 应用层 keepalive**（`webrtc.js` + `host.py`）

每 15 秒通过 `inputChannel` 发送一条 `{type:'dc_keepalive'}` 消息：
- **防 SCTP 空闲超时**：打破30s无流量的空闲计时
- **维持 Chrome open-DC 豁免**：让 Chrome 认为 tab 仍有活跃 DataChannel，不进入 intensive throttle / Energy Saver freeze

集成点：
- `inputChannel.onopen` → `startDcKeepalive()`
- `inputChannel.onclose` → `stopDcKeepalive()`
- `refresh()` / `rebuildDataChannels()` → `stopDcKeepalive()`（重建前清理旧定时器）

`host.py` 增加 `dc_keepalive` 类型过滤，静默丢弃，不当作输入处理。

**补充键盘 reset 专项测试**（`remote-keyboard-controller.test.js`）

补写了 `949db96` 修复路径的专项测试（之前遗漏）：barrier 超时 → 新 lease 到来 → `resetRequired` 被清除 → 键盘恢复 READY。测试覆盖完整状态转换链路。

### 防御深度

| 层次 | 机制 | 触发时机 | 对应提交 |
|------|------|----------|---------|
| 预防 | DC keepalive 每 15s 发 ping | DC 打开后持续运行 | `ec1cc81` |
| 检测 | tab 返回时主动检查 DC 状态 | visibilitychange visible | `949db96` |
| 熔断 | scheduleReconnect 3s 冷却 | 任何重连请求 | `949db96` |

---

## 九、最终问题清单

| 问题 | 状态 | 修复提交 |
|------|------|---------|
| 黑屏 / fps=0 周期性假死 | ✅ 已修 | `3ff9859` jitterBuffer 80ms |
| 重连风暴（tab 切换触发）| ✅ 基本解决 | `949db96` 冷却+检测；`ec1cc81` keepalive 预防 |
| 键盘需复位 | ✅ 已修 | `949db96` 清除过期 resetRequired |
| 幽灵 Ctrl/Cmd 按键 | ✅ 已修 | `6610705` modifier reconcile |
| IME 丢失 + 方向键弹表情 | ✅ 已修 | `6411c87`+`6610705` |
| 长时间黑屏不自愈（14min）| ✅ 已修 | `57632aa` F3 dead detection |

**遗留说明**：SCTP 被 Chrome 后台杀死是浏览器行为，无法从代码层完全消除。现有三层防御将用户体验从「数十轮无法用」降级为「偶发一次短暂重连」，属于可接受的工程权衡。
