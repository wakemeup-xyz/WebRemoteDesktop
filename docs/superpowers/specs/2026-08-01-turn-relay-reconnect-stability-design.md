# TURN Relay 重连稳定性设计

日期：2026-08-01

关联：

- `docs/superpowers/specs/2026-07-20-turn-integration-design.md`（TURN 接入已落地）
- `docs/superpowers/specs/2026-07-19-remote-desktop-media-suspension-design.md`（media resume/首帧门闩）
- 运行证据：`back-debug.log` 2026-08-01 21:xx–22:xx（relay 死循环与半中继诊断）

代码基线：以实施时 `main` HEAD 为准。

## 1. Goal

让手动 **外网中继（`networkMode=relay`）** 在真实 TURN 路径上可稳定建连并保持会话，消除今天日志中的：

1. media-resume 首帧超时触发的 ~2s `refresh` 死循环
2. ICE/PC 已 connected 时 input DataChannel error/close 误杀整条媒体链路
3. Host 在 relay 模式下仍使用 host/srflx 形成半中继
4. 无退避重连与旧 ICE 任务堆积放大故障

不改变公网入口、Strict STUN 不自动切 TURN、tunnel 兜底语义。

## 2. Background（已证实事实）

| 事实 | 证据 |
|------|------|
| TURN Allocate 正常 | Host 日日志 `TURN allocation created` 百次级；本机 UDP 3478 有 STUN 响应 |
| ICE 可完成 | 日 `ICE connection: completed` 43 次；曾稳定 ~37 分钟 |
| 选中 pair 多为半中继 | Viewer diag：`localType=relay` → `remoteType=srflx`（Host 公网），RTT ~400ms |
| Viewer 只出 relay 候选 | `SDP_viewer-offer ice_candidate_summary={'relay': 1}` |
| Host 仍 gather host/srflx/relay | `SDP_host-answer ... summary={'host':2,'srflx':2,'relay':2}`；aiortc `RTCConfiguration` 无 `iceTransportPolicy` |
| P0 死循环 | `RESUME` → ~1.5s → `OFFER`/`close=new-offer` 固定节拍；`beginConnectionAttempt` 重置 `_mediaResumeRefreshFallbackUsed` |
| P1 DC 误杀 | `WRD_FAILURE_DIAG reason=dc-error` 且 `pc=connected ice=connected`；Host `DataChannel CLOSED` 时 ice 仍 completed |
| 风暴放大 | 单分钟 36 offer；`taskCount` 峰值 300+；大量旧 Connection `TransactionTimeout` |

## 3. Confirmed Decisions

1. **范围 B（已选）**：Viewer 策略修复 + Host relay 候选偏好 + 最小 ICE 清理；**不改**远端 coturn 配置。
2. **真相源不变**：`MediaActivityController`/`MediaActivityRuntime` 仍只拥有 desired/applied phase；本设计只改 recovery 与 ICE 适配。
3. **relay 首帧超时默认 12s**；tunnel 保持偏短 soft recover（不换 attempt）。
4. **fresh-frame 首次超时不得 full `refresh()`**（WebRTC/relay）；优先 soft recover。
5. **video 仍健康时 DC 故障不 full refresh**。
6. **Host `mode=relay`**：ICE servers 不含纯 STUN；发出的 trickle/SDP 仅保留 `typ relay` 候选。
7. **重连退避 + relay 熔断**；成功 connected 后清零计数。

## 4. Non-Goals

1. 不修改 coturn 服务器或凭证体系（无 REST 短期票）。
2. 不让 `auto`/`stun` 自动切 `relay` 或 tunnel。
3. 不重写全局 session actor / lease / port-search。
4. 不把 Terminal `webrtc-turn` 作为本轮主改（仅避免回归）。
5. 不引入第二套 media desired 状态机。

## 5. Architecture

```text
Viewer
  MediaActivityRuntime.phase = resuming|active|...
           │
           ▼
  ResumeRecovery (逻辑内聚于 webrtc.js)
    - arm 条件：ack applied + phase=resuming + (pc connected | ice connected/completed)
    - timeout by mode (relay 12s / default 8s / tunnel 2.5s)
    - soft budget → hard refresh 升级；fresh-frame 触发的 attempt 继承 used 标志
           │
           ▼
  LinkRecovery (scheduleReconnect 策略)
    - reason class: ice|pc|dc-input|media|signal
    - DC + framesDecoded 增长 → 输入降级 only
    - exponential backoff + relay exhausted

Host
  build_ice_servers(mode)
    relay → TURN only (no STUN list)
  filter_ice_candidate_for_mode / filter_sdp_candidates_for_mode
    relay → keep typ relay only
  on_icecandidate + answer SDP 发送前过滤
  _close_peer_connection 保持 await close（最小清理，不新造连接池）
```

## 6. Viewer：ResumeRecovery

### 6.1 Arm 时机

当前：`handleMediaActivityAck` → phase `resuming` → 立刻 `armMediaResumeFallback()`（1500ms non-tunnel）。

目标：

1. ack 进入 `resuming` 时调用 `ensureMediaResumeFallbackArmed()`：
   - 若媒体路径已 connected（见下）→ 立即 arm
   - 否则设 `_mediaResumeArmPending = true`，在 `pc.onconnectionstatechange` / `iceconnectionstatechange` 进入 connected/completed 时 arm
2. tunnel 模式：可在 ack 后 arm（不依赖 PC）；保持现有 soft recover（`recoverTunnelMediaOnCurrentAttempt`）。

**Connected 判定（WebRTC 路径）：**

```text
pc && (pc.connectionState === 'connected'
     || pc.iceConnectionState === 'connected'
     || pc.iceConnectionState === 'completed')
```

### 6.2 超时常量

```js
const MEDIA_RESUME_FRAME_TIMEOUT_MS = {
  tunnel: 2500,
  relay: 12000,
  auto: 8000,
  stun: 8000,
  lan: 6000,
  default: 8000,
};
```

### 6.3 超时动作

| 模式 | 第 1 次超时 | 第 2 次（同逻辑预算） |
|------|-------------|----------------------|
| tunnel | `recoverTunnelMediaOnCurrentAttempt('fresh-frame-timeout')`（不换 attempt） | 仍不 full refresh attempt；沿用现有 bound replay |
| relay / 其他 WebRTC | soft：最小动作 `replayMediaActivityIntent('fresh-frame-soft')`；若 PC 仍 connected 可可选 `restartIce`；**禁止 `refresh()`**；soft 后若 phase 仍为 `resuming` **必须重新 arm** 定时器 | 允许 `refresh({ reason: 'fresh-frame-timeout' })` 且继承 escalate |

实现计数：

- `_mediaResumeSoftRecoverUsed`：本 generation/attempt 是否已 soft
- `_mediaResumeRefreshFallbackUsed`：是否已 hard refresh（跨因 fresh-frame 触发的 refresh **继承**，防止套娃）
- `_relayHardRefreshCount`：**仅**统计 `reason === 'fresh-frame-timeout'` 的 hard refresh（relay 模式）；`scheduleReconnect` 熔断读同一计数；PC `connected` 成功时清零

### 6.4 `beginConnectionAttempt` 标志语义

当前每次 `beginConnectionAttempt` 无条件：

```js
this._mediaResumeRefreshFallbackUsed = false;
this._mediaRequestRetryUsed = false;
```

目标：

```js
beginConnectionAttempt(trigger, { resetResumeBudget = null } = {})
```

- 默认：`resetResumeBudget = (trigger !== 'refresh' || this._refreshReason !== 'fresh-frame-timeout')`
- 当 `refresh` 且 reason 为 `fresh-frame-timeout`：**保留** `_mediaResumeRefreshFallbackUsed = true`，并递增 `_relayHardRefreshCount`（或通用 hard 计数）
- 手动 `viewer-open` / `manual-mode-switch`：完整重置预算与退避计数
- PC `connected` 成功：清零 hard/soft 计数与 reconnect backoff

`refresh()` 签名扩展为接受 optional reason，写入 `this._refreshReason` 供 beginAttempt 读取。

### 6.5 与现有测试的关系

现有 `fresh-frame fallback cancels prior timer and runs refresh only once` 断言 non-tunnel 超时直接 `refresh`。本设计改为：

- 未 connected 时超时不应 arm / 或 arm 后若仍未 connected 可视为 pending
- connected 后第 1 次超时 → soft（`refreshes === 0`）
- 第 2 次 → `refreshes === 1` 且 flag 继承

测试必须按新语义改写，而不是保留旧“一次即 refresh”的错误契约。

## 7. Viewer：DataChannel 与媒体解耦

### 7.1 健康视频判定

```js
isInboundVideoHealthy(maxAgeMs = 5000) {
  // 仅在 framesDecoded 增长时刷新 _lastInboundFramesDecodedAt
  // 无采样或超过 maxAgeMs → false（未知 ≠ healthy）
}
```

### 7.2 DC 事件策略

| 事件 | PC connected 且 video healthy | 其他 |
|------|-------------------------------|------|
| `input`/`input-move` `onerror` | 标记 `inputDcDegraded`；UI 可提示；**不** `scheduleReconnect` | 走 LinkRecovery（可 reconnect） |
| `onclose` 同上 | 同上；3s 定时器取消“无条件 refresh” | 同上 |
| `dc-stuck`（timeout） | 若仍 connecting/checking：沿用最多 2 次延长；若 connected+healthy：不 refresh | reconnect with backoff |

双 DC 之一关闭不得单独拆 PC。

## 8. Viewer：LinkRecovery（退避与熔断）

`scheduleReconnect(reason)`：

1. 保留现有门闩：`manualDisconnect` / `reconnectTimer` / `_refreshing` / port-search / media-health-suppressed
2. **分类**：
   - `dc-*` + healthy video → return（见 §7）
   - `ice-disconnected`：仍先等 5s auto-recovery（现有）
   - hard reasons：`ice-failed` / `pc-failed` / `fresh-frame-timeout` hard 等
3. **退避**：`delay = min(1500 * 2^n, 15000)`，n=`_reconnectAttempt`（成功 connected 后置 0）
4. **relay 熔断**：`networkMode==='relay' && _relayHardRefreshCount >= 5` → 停止自动 refresh；`Diagnostic.autoSendFailure('relay-reconnect-exhausted')`；UI 提示手动重试或切隧道
5. ICE restart 偏好（现有 stun 路径）保持；relay 上 structural high RTT **不**因此 ICE restart（已有 LinkQuality 行为，不回退）

## 9. Host：relay 全中继偏好

aiortc 当前 `RTCConfiguration` 仅 `iceServers` + `bundlePolicy`，**无** `iceTransportPolicy`。等价策略：

### 9.1 `build_ice_servers(mode)`

- `mode=relay` 且 TURN 就绪：只追加 TURN `RTCIceServer`，**不**追加 `STUN_URLS`
- 其他 mode：保持现有（stun 列表 + 按 policy 的 TURN）

### 9.2 候选过滤纯函数

```python
def ice_candidate_type_from_sdp_line(line: str) -> str: ...
def should_emit_ice_candidate(mode: str, candidate_sdp: str) -> bool:
    # relay mode: True only if typ relay
def filter_sdp_ice_candidates(mode: str, sdp: str) -> str:
    # drop a=candidate lines that should_emit is False; keep end-of-candidates / other lines
```

### 9.3 挂载点

1. `on_icecandidate`：发送前 `should_emit_ice_candidate(network_mode, candidate.sdp)`
2. 发送 answer 前：`sdp = filter_sdp_ice_candidates(network_mode, local_description.sdp)`
3. `_log_ice_candidate_summary` 基于过滤后 SDP，relay 模式期望 summary 近似仅 `relay`

### 9.4 关闭路径

`_close_peer_connection` 已 `await closing_pc.close()`。本轮仅确认 new-offer 路径不会在未 close 完时叠加无界任务；**不**引入连接池。若 close 后仍见大量僵尸，记录 follow-up，不阻塞本设计主路径。

## 10. Observability

新增/保持日志字段（无密钥）：

- Viewer console：`[RESUME] arm deferred|armed mode= timeoutMs=`、`[RESUME] soft-recover`、`[RESUME] hard-refresh`、`[RECOVERY] backoff ms=`、`[RECOVERY] relay-exhausted`、`[INPUT-DC] degraded video-healthy=true skip-reconnect`
- Host：relay 模式下 `WRD_CANDIDATE_SUMMARY side=host-answer summary` 应无 host/srflx；可选 `WRD_POLICY_INFO ice_filter mode=relay dropped=host,srflx`

`WRD_FAILURE_DIAG` reason 可增加：`fresh-frame-timeout`、`relay-reconnect-exhausted`（若走 Diagnostic.autoSendFailure）。

## 11. Testing

### 11.1 Viewer 单测（`web-client/js/webrtc.test.js`）

1. resuming ack 时 PC 未 connected → 不启动 fresh-frame 定时器（或 pending 不 fire refresh）
2. PC 随后 connected → arm，timeout=relay 12000
3. 第 1 次超时 → soft，`refresh` 次数 0，attempt id 不变
4. soft 后再超时 → hard refresh 1 次；随后 `beginConnectionAttempt('refresh')` **不**清掉 used，第三次不会再无限 soft 套娃（预算耗尽或 exhausted 路径）
5. `dc-error` + frames 健康 → 不 `scheduleReconnect`
6. `scheduleReconnect` 连续调用 delay 递增；relay 第 5 次 hard 后停止

### 11.2 Host 单测（新或现有 `python-host/test_*.py`）

1. `build_ice_servers('relay')` 在 TURN 配置下不含 stun URL
2. `should_emit_ice_candidate('relay', host_line) is False`；relay line True
3. `filter_sdp_ice_candidates` 去掉 host/srflx 行，保留 relay 与非 candidate 行

### 11.3 运行验收（用户启服务，agent 不擅自重启 tunnel）

1. Viewer 选手动「外网中继」，连接 5 分钟
2. Host 日志：无 ~2s 一次的 `Received offer` 节拍；有 `ICE connection: completed` 与持续 `CAPTURE_STATS`
3. `WRD_CANDIDATE_SUMMARY side=host-answer` 仅 relay（或无 host/srflx）
4. Viewer selected pair 为 relay 相关；输入在 DC 抖动时不强制整链刷新（若可复现）

## 12. File Impact

| 文件 | 职责 |
|------|------|
| `web-client/js/webrtc.js` | ResumeRecovery、DC 策略、backoff、refresh reason |
| `web-client/js/webrtc.test.js` | 上述不变量 |
| `python-host/host.py` | build_ice_servers、候选/SDP 过滤、挂载 |
| `python-host/test_ice_relay_filter.py`（新）或并入现有 test | 纯函数测试 |
| `docs/superpowers/plans/2026-08-01-turn-relay-reconnect-stability-plan.md` | 实施计划 |
| 可选：`docs/runbook-safe-startup.md` 或 project-memory 短注 | relay 验收注意 |

## 13. Rollout / Risk

| 风险 | 缓解 |
|------|------|
| 过滤过严导致 Host 无 relay 候选 | TURN 未配置时 relay 模式本就不可用；有 TURN 时 allocate 失败应明确日志而非塞回 host |
| 12s 超时过长导致“假死”体感 | UI loading 文案区分“等待首帧/中继协商”；熔断与手动刷新仍在 |
| soft recover 与 port-search 交互 | 保持 port-search 既有 ownership 门闩；mode=relay 时 port-search 本不启用 |
| 改 fresh-frame 测试契约 | 明确旧测试描述的是 bug 行为，以本 spec 为准 |

## 14. Definition of Done

1. 单测全绿（Viewer + Host 本设计相关）
2. 设计与计划已落盘于 `docs/superpowers/`
3. 运行验收至少一次：relay 5 分钟无 offer 风暴，且 host-answer 候选摘要符合 full-relay 偏好
4. 不引入凭据入库或日志明文密码
