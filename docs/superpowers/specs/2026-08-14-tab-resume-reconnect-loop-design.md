# Tab 恢复重连环设计

**日期**：2026-08-14  
**状态**：待实施  
**关联复盘**：`docs/superpowers/reports/2026-08-13-reconnect-storm-keyboard-reset-postmortem.md`  
**日志依据**：`back-debug.log.1` 2026-08-14 15:31–16:51

---

## 1. 背景与问题陈述

用户在 TURN relay 下离开标签页再回来，会看到：持续连不上、闪屏、黑屏。上一轮补丁（`949db96` 3s 冷却 + `dc-dead-on-resume`，`ec1cc81` DC keepalive）上线后体感没有变化。

今天日志证明能力本身是好的：ICE 约 0.7s 完成，DC 能 open，稳定时 19fps / RTT 31–41ms。被拆掉的是刚连上的健康连接。

典型一轮（15:38:29 回到前台之后 20 秒内 `epoch=3,5,7…19`）：

```
host_media_resumed
  → 0.5s 内 DC CLOSED + ICE closed（同时）
  → Received offer epoch=N+2
  → Closing peer connection reason=new-offer
  → ICE completed + DC open
  → 0.4–1.4s 后再拆
```

ICE 与 DC 同时关闭 = viewer 主动 `pc.close()` / `refresh()` / `createOffer()`，不是 SCTP 空闲死亡。Host 的 `wait_for_fresh_capture(2.0s)` 经常打在已经拆掉的 PC 上，留下 `host_media_resume_failed closed`。

---

## 2. 根因（已用代码对上）

不是「TURN 连不上」，也不是 keepalive 没部署。是回到前台后多条恢复路径互相拆连接：

1. `visibilitychange` 发现 DC 死 → **直接** `refresh({reason:'dc-dead-on-resume'})`，绕过 `scheduleReconnect` 的 3s 冷却。
2. `handleControlGrant` 在 PC 已 `connected` 时仍调用 `createOffer()`。Host `on_offer` 无条件 `_close_peer_connection(reason="new-offer")`，把刚建好的视频和 DC 整链拆掉。
3. `refresh()` 把 `_refreshing` **同步**放回 `false`，新 ICE 尚未完成就可以再被拆。
4. 每次 `pc.connectionState === 'connected'` 把 `_reconnectAttempt`、`_mediaResumeRefreshFallbackUsed` 清零。熔断器永远接不上。
5. `pc-connected` 再发一遍 `media-active`，Host 又进入 2s `wait_for_fresh_capture`，和上面的拆连接互抢。

上一轮三层防御都不在这条环上：keepalive 防空闲；3s 冷却只挡 `scheduleReconnect`；`dc-dead-on-resume` 反而可能是第一枪。

---

## 3. 目标与非目标

### 目标

回到前台只允许 **一条** 恢复路径，**最多一次** 全量重建。刚连上的健康 PC 在稳定窗口内禁止被 grant / media-resume / dc-dead / fresh-frame 再拆。

用户体感：离开再回来，最多闪一次「正在重新连接」，然后稳住。不再出现 1–2 秒一轮的闪屏黑屏。

### 非目标

- 不改 TURN / ICE / jitterBuffer / 编码参数
- 不改键盘 lease 协议、控制权状态机、心跳超时
- 不改隧道模式（`networkMode === 'tunnel'`）的 producer 路径，除非同一函数必须加守卫且守卫对 tunnel 也正确
- 不试图从代码层消灭 Chrome 后台掐死 SCTP；只保证恢复不再自毁
- 不重做媒体挂起/恢复状态机，只堵「resume 打在已关闭 PC 上还当成功/还触发再刷新」

### 成功标准

| 场景 | 必须 |
|------|------|
| 标签页隐藏 ≥ 30s 再回来，DC 已死 | 最多 1 次 full refresh；之后 30s 内 Host 不得再出现 `reason=new-offer` 连打 |
| 标签页隐藏再回来，PC+DC 仍活 | 0 次 refresh；只发 `media-active` |
| 已 connected 且 DC open 时再次 `control-grant` | 0 次 `createOffer` |
| 用户点击「刷新画面」 | 仍立即 refresh（按钮自身 5s debounce 保留） |
| 手动切换网络模式 / TURN 节点 | 仍立即 refresh |
| 稳定后正常使用 | 19fps 级、鼠标/键盘可用，不回归键盘 RESET_REQUIRED |

日志验收（回到前台后 60s）：`Closing peer connection reason=new-offer` ≤ 1；`DataChannel CLOSED` 不得呈 1–2s 定频。

---

## 4. 设计

所有 viewer 改动在 `web-client/js/webrtc.js`。Host 只加一处早退。测试补在 `web-client/js/webrtc.test.js` 与 `python-host/test_media_suspension.py`。

### 4.1 单一 refresh 门闸

新增 `canBeginRefresh(reason)`，**所有** `refresh()` 入口先过这扇门。冷却只看 `_lastRefreshAt`，不看 `_reconnectAttempt`。

分类：

| 类别 | reason | 冷却 |
|------|--------|------|
| 用户强制 | `manual`、`manual-mode-switch`、`manual-turn-switch`、**无 reason**（兼容旧测试里的 `refresh()` 直调） | 不挡。按钮自己的 5s debounce 保留 |
| 恢复 | `dc-dead-on-resume`、`reconnect:*`、`fresh-frame-timeout`、`media-request-failed`、`turn-channel-dead`，以及其它非空、非强制的 reason | 距上次成功开工的 refresh < 3000ms 则拒绝 |

无 reason 视为强制，避免改现有单测。所有恢复路径必须传显式 reason（当前代码已经这么做）。

`scheduleReconnect` 现有 3s 检查保留（双闸）。`refresh()` 自己也必须检查，因为今天风暴走的是直调。

`refresh()` 被拒绝时：打 `[RECOVERY] Suppressing refresh reason=...`，不改 `_offerEpoch`，不 `pc.close()`，不 `createOffer`。

「刷新画面」按钮改为 `refresh({ reason: 'manual' })`，与手动模式切换同一类。

### 4.2 `handleControlGrant` 禁止把 grant 当重连

在绑定 lease / 心跳 / `ensureMediaActiveIfVisible` 之后：

- `networkMode === 'tunnel'`：保持现有 tunnel 分支，不改。
- 否则：
  - 若 `pc.connectionState === 'connected'` 且 (`inputChannel?.readyState === 'open'` 或 `_refreshing === true`)：**不** `createPeerConnection()`，**不** `createOffer()`。仍 `replayMediaActivityIntent('control-regrant')`。
  - 否则（无 PC / failed / closed / disconnected，且 DC 也不是 open）：保持现有 `createPeerConnection` + `createOffer`。

禁止「grant = 再发一次 offer」。Host 对任何新 offer 都会整链拆掉。

### 4.3 `_refreshing` 覆盖到新连接落地

`refresh()` 开工后 `_refreshing = true`，**禁止**在函数末尾同步改回 false。

放下条件（谁先到谁算）：

1. 新 PC `connectionState === 'connected'`，且 `inputChannel.readyState === 'open`
2. 新 PC 已 connected，但 DC 在 connected 后 2000ms 仍未 open（避免永远卡死）
3. 安全上限：开工后 8000ms

`markRefreshSettled(reason)` 只清 `_refreshing`，不重置冷却时间、不重置熔断计数。

在 `_refreshing === true` 期间：

- `scheduleReconnect` 继续直接 return（已有）
- `oniceconnectionstatechange` / `onconnectionstatechange` 的 failed/closed 继续直接 return（已有，现在会真正生效）
- `dc-dead-on-resume` 不得再调 `refresh()`

### 4.4 熔断计数只在稳定后清零

`pc.connectionState === 'connected'` **不再**把下列字段清零：

- `_reconnectAttempt`
- `_relayHardRefreshCount`
- `_mediaResumeRefreshFallbackUsed`
- `_mediaResumeSoftRecoverUsed`

改为 `armStableRecoveryReset()`：connected 后 5000ms，若 PC 仍 connected，再清零上述字段。PC 在窗口内掉线则取消 timer，计数保留。

`beginConnectionAttempt('viewer-open' | 'manual-mode-switch')` 仍按现有逻辑清零——那是用户主动新会话，不是 brief-connect。

`beginConnectionAttempt('refresh')` 且 `_refreshReason === 'fresh-frame-timeout'` 时继续 inherit `_mediaResumeRefreshFallbackUsed === true`（现有测试必须继续过）。

### 4.5 tab 回来：先修 DC，再考虑 full refresh

`visibilitychange` 可见时：

1. 若 `_refreshing` 或冷却未过：只 `ensureMediaActiveIfVisible`，不 refresh。
2. 若 PC connected 且 DC 不是 open：先 `rebuildDataChannels('dc-dead-on-resume')`。SCTP 已死再走 `refresh({reason:'dc-dead-on-resume'})`，且必须过 4.1 门闸。
3. 若 PC+DC 都活：只 `ensureMediaActiveIfVisible`。

禁止「DC 一看不是 open 就 full refresh」。

### 4.6 Host：PC 已关闭时 resume 立刻失败

`python-host/host.py` `on_media_activity_change` 在 `state == active` 分支、调用 `wait_for_fresh_capture` **之前**：

若 `self.pc is None` 或（若能取到）connection state 为 `closed` / `failed`：

- 不调用 `wait_for_fresh_capture`
- `applied=false`，`reason='closed'`
- 走现有 `host_media_resume_failed` 事件

Viewer 侧 `applied=false` + `closed` 不得再触发一次 `refresh()`（靠 4.1 冷却 + `handleMediaRequestFailure` 对「刚 refresh 过」的抑制）。`handleMediaRequestFailure` 若 reason 为 `closed`：只 replay 一次 intent，不 refresh。

---

## 5. 不变量

1. 任意 3000ms 窗口内，恢复类 `refresh()` 成功开工次数 ≤ 1。
2. `handleControlGrant` 在「PC connected 且 DC open」时 `createOffer` 调用次数 = 0。
3. `_refreshing === true` 时不得再 `pc.close()` 第二条恢复路径。
4. brief-connect 不得把 `_reconnectAttempt` 清零。
5. Host 对 closed PC 的 resume 不得进入 2s `wait_for_fresh_capture`。

---

## 6. 测试

现有 `node --test web-client/js/webrtc.test.js` 与 `python-host/test_media_suspension.py` 必须继续通过。新增：

**Viewer（`webrtc.test.js`）**

1. `handleControlGrant` + PC connected + DC open → `createOffer` 不被调用。
2. `handleControlGrant` + 无 PC → `createOffer` 仍被调用。
3. `refresh({reason:'dc-dead-on-resume'})` 在 `_lastRefreshAt` 1s 之内被拒绝，PC 不被 close。
4. `refresh({reason:'manual'})` 在冷却期内仍执行。
5. `pc.connected` 处理器不把 `_mediaResumeRefreshFallbackUsed` / `_reconnectAttempt` 清零。
6. `armStableRecoveryReset` 5s 后且仍 connected 才清零。
7. `refresh()` 之后、`markRefreshSettled` 之前，`scheduleReconnect` 为 no-op。
8. 可见 + PC connected + DC 非 open + SCTP connected → 走 `rebuildDataChannels`，不 `refresh`。
9. 「刷新画面」走 `reason:'manual'`（若测得到绑定；否则在 `refresh` 门闸测试中覆盖 manual）。

**Host（`test_media_suspension.py`）**

10. `pc is None` 时 resume：`wait_for_fresh_capture` 不被调用，ack `applied=false`，reason 含 `closed`。

---

## 7. 实施顺序

先写失败测试，再改产品代码。顺序：4.1 门闸 → 4.2 grant → 4.3 `_refreshing` → 4.4 熔断 → 4.5 visibility → 4.6 Host 早退。每步只改让该步测试通过所需的最小代码。

---

## 8. 回滚

全部改动集中在 `webrtc.js` 恢复门闸与 Host resume 早退。回滚这两个文件即可回到 `ec1cc81` 行为。不涉及协议或 TURN 配置，无需清浏览器存储。
