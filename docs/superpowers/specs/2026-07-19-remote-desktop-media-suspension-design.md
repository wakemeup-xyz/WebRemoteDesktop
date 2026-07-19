# 远程桌面媒体暂停与恢复设计

日期：2026-07-19

## 1. 目标

当 Viewer 切换到 Terminal、浏览器页面进入后台或用户手动暂停时，停止远程桌面的视频采集、编码和帧传输，同时保留必要的控制连接，使 Terminal 和共享 PTY 不受影响，并在返回桌面后快速恢复可解码画面。

完成状态必须满足：暂停期间不把 0 FPS 误判为网络故障；手动暂停意图不会被自动切换覆盖；WebRTC 与 tunnel 两条媒体路径遵循同一媒体活动语义。

## 2. 当前事实

当前实现存在三个彼此独立但没有汇合的入口：

1. `web-client/js/ui.js` 的暂停按钮只调用 `video.pause()` 和 `Input.setActive(false)`，不会停止 Host 发送视频。
2. `web-client/js/terminal.js` 的 `showTerminal()` 只隐藏桌面面板并显示 Terminal 面板，不改变媒体状态。
3. `web-client/js/input.js` 在 `visibilitychange` 时只释放鼠标和按键，不改变媒体状态。

Host 的 `ScreenCaptureTrack` 在独立线程内持续执行 `MSS.grab()`；WebRTC sender 持续请求、编码和发送帧。现有 `media-profile-change` 只接受 `high / medium / low / survival` 四档，并把目标 FPS 限制为 5 到 30，不能表达暂停。

tunnel/JPEG 路径已经支持 `relay-stream-control { enabled: false }`，能够停止 relay streamer，但该能力尚未和页面可见性、Terminal tab、手动暂停统一。

## 3. 方案选择

### 方案 A：只暂停浏览器播放

保留现有 `video.pause()`。该方案只能减少浏览器渲染工作，Host 仍然采集、编码并发送，不能实现节约媒体流量的目标，因此拒绝。

### 方案 B：隐藏时切换到极低帧率

增加 320x180、1 FPS 的 idle profile。该方案恢复简单，能显著降载，但不是媒体暂停，仍会持续采集、编码和传输，因此只作为恢复兼容回退，不作为正常路径。

### 方案 C：基于需求的发送端暂停

Viewer 用统一状态机汇总 Terminal、页面可见性和手动暂停原因；WebRTC 路径通知 Host 暂停 capture track 与 RTP sender，tunnel 路径停止 relay streamer。保留信令、ICE、DataChannel 和 Terminal Socket。该方案节流完整、恢复成本可控，是本设计采用的方案。

## 4. 总体架构

新增 `MediaActivityController` 深模块，作为 Viewer 是否需要桌面媒体的唯一真相源：

```text
manual-pause ----+
terminal-active -+--> MediaActivityController --> active | suspended
page-hidden -----+              |
page-hide -------+              +--> WebRTC media adapter
                                +--> tunnel media adapter
                                +--> desktop input adapter
                                +--> media telemetry adapter
```

模块接口只暴露原因集合和当前快照：

```javascript
const controller = MediaActivityController.create({
  onChange(snapshot) {},
});

controller.setReason('manual-pause', true);
controller.setReason('terminal-active', true);
controller.setReason('page-hidden', true);
controller.snapshot();
```

快照结构固定为：

```javascript
{
  state: 'active' | 'suspended',
  reasons: ['manual-pause', 'terminal-active', 'page-hidden'],
  generation: 12,
}
```

规则：

- 原因集合为空时为 `active`，存在任意原因时为 `suspended`。
- 同一原因重复写入不增加 generation，也不重复发送控制消息。
- generation 只在有效状态或原因集合变化时递增，用于丢弃迟到控制消息。
- `manual-pause` 是持久意图。Terminal 或页面恢复可见时只清理各自原因，不能清理手动暂停。
- controller 不直接访问 WebRTC、Terminal 或 DOM；调用方通过 `onChange` 适配现有实现。

页面生命周期监听位于独立的 `web-client/js/media-activity-lifecycle.js` adapter。它只把 DOM/Page Lifecycle 事件翻译成 controller reasons，去抖定时器也归该 adapter 所有，controller 保持纯状态模块。

## 5. Viewer 生命周期输入

### 5.1 Terminal tab

`TerminalPanel.showTerminal()` 设置 `terminal-active=true`；`showDesktop()` 清除该原因。进入 Terminal 时立即暂停桌面媒体和桌面输入，不销毁 Terminal Socket、admin token、共享 PTY 或 replay 状态。

返回桌面时，如果原因集合为空，则立即恢复媒体；如果仍有 `manual-pause` 或 `page-hidden`，保持暂停。

### 5.2 页面可见性

使用 `document.visibilitychange` 作为后台判断真相，不使用 `window.blur`：blur 会被地址栏、对话框和开发者工具触发，不能可靠表达页面不可见。

- `document.hidden=true` 后等待 750ms，再设置 `page-hidden=true`。
- 750ms 内恢复可见则取消定时器，不产生状态变化。
- 恢复可见时立即清除 `page-hidden`。
- `pagehide` 立即设置 `page-hide=true` 并尽力发送暂停；页面销毁后的最终回收仍以 Socket.IO disconnect 为准。
- `pageshow` 清除 `page-hide`，覆盖 back-forward cache 恢复场景。

### 5.3 手动暂停

暂停按钮不再自己维护局部 `isPaused`。它只切换 `manual-pause` 原因，按钮展示从 controller snapshot 派生。浏览器 `<video>` 的 `play()` / `pause()` 由媒体 adapter 执行，不再代表发送端是否暂停。

## 6. 媒体控制协议

WebRTC adapter 新增 Socket.IO 事件 `media-activity-change`：

```json
{
  "schemaVersion": 1,
  "state": "suspended",
  "reasons": ["terminal-active"],
  "generation": 12,
  "connectionAttemptId": "wrd-..."
}
```

Signal Server 负责：

1. 只接受已认证、仍在线的 Viewer socket。
2. `state` 只允许 `active` 或 `suspended`。
3. reasons 只允许 `manual-pause`、`terminal-active`、`page-hidden`、`page-hide`，去重后最多四项。
4. generation 必须是非负安全整数。
5. 丢弃同一 viewer、同一 connectionAttemptId 下小于等于最后已转发 generation 的消息；connectionAttemptId 变化时建立新的 generation 序列，允许当前 snapshot 重新同步。
6. 附加可信 `viewerId` 后转发给 Host；不信任客户端提供的 viewerId。

Host 回传 `media-activity-ack`：

```json
{
  "state": "suspended",
  "generation": 12,
  "viewerId": "socket-id",
  "applied": true
}
```

Signal Server 只把 ack 路由回对应 Viewer。Viewer 用 ack 更新诊断状态，但页面隐藏时不等待 ack 才完成本地输入和播放暂停。

该事件只控制 WebRTC capture track 与 RTP sender。tunnel adapter 不发送该事件，继续使用 `relay-stream-control`，避免同一次状态切换产生两条 Host 控制命令。tunnel 的 suspended 完成条件是 relay streamer 停止；active 完成条件是收到新的 relay frame。

## 7. WebRTC 发送端暂停

`WebRemoteHost` 保存 `self.pc.addTrack(self.screen_track)` 返回的 video sender，并只允许 `current_viewer_id` 控制当前 sender。旧 Viewer、旧 generation 或没有当前 PeerConnection 的命令返回 `applied=false`，不能改变 Host 状态。

暂停顺序：

1. 记录 `media_activity_state=suspended` 和 generation。
2. 调用 `video_sender.replaceTrack(None)` 停止新的 RTP 视频帧。
3. 调用 `ScreenCaptureTrack.set_suspended(True)`，让 capture thread 在 condition 上等待。
4. 清空 capture buffer，允许最多一个已经在途的帧完成。

恢复顺序：

1. 调用 `ScreenCaptureTrack.set_suspended(False)`，捕获一张新画面并重置 `_last_frame_time`。
2. 把现有 track 重新挂到 video sender。
3. 请求下一帧为 H.264 keyframe，避免长时间暂停后首帧依赖旧参考帧。
4. 回传 active ack；Viewer 收到首个 rendered frame 后恢复媒体健康判定。

当前 aiortc 1.14.0 的 `RTCRtpSender.replaceTrack()` 是公开接口；主动 keyframe 入口不是稳定公开接口。新增 `python-host/aiortc_media_sender.py` adapter，把版本检查、keyframe 请求和失败结果集中在一个 seam：

```python
def suspend_sender(sender) -> None:
    sender.replaceTrack(None)

def resume_sender(sender, track) -> bool:
    sender.replaceTrack(track)
    return request_keyframe(sender)
```

若 adapter 无法请求 keyframe，Host 仍恢复 track，但 ack 带 `keyframeRequested=false`；Viewer 在 1500ms 内没有 rendered frame 时调用现有 `WebRTC.refresh()`。不引入新的 SDP 或 ICE 恢复规则。

`ScreenCaptureTrack.shutdown()` 必须唤醒 condition，确保关闭 PeerConnection 时不会等待暂停状态而挂住。

## 8. Tunnel 路径

Viewer 的 tunnel adapter 复用 `relay-stream-control`：

- suspended：发送 `{ enabled: false }`，停止 JPEG capture/encode/send，并断开专用 relay-viewer socket。
- active：重新建立 relay-viewer socket，发送当前分辨率和 FPS 控制参数。

主 Viewer 信令 socket保持连接，用于媒体活动状态、Host 状态和控制租约。Terminal namespace 不受影响。

Host 对 relay stop 继续校验 viewerId，不能让旧 relay-viewer 停止当前 Viewer 的流。

## 9. 输入与控制语义

`MediaActivityController` 的 suspended 状态统一调用 `Input.setActive(false)`；现有 `releasePointer()`、`releaseAllKeys()` 和 reset barrier 负责释放 Host 输入状态。

恢复时只有同时满足以下条件才调用 `Input.setActive(true)`：

- controller state 为 active；
- 当前 UI surface 为桌面；
- WebRTC 或 tunnel 媒体连接已建立；
- 用户没有执行显式断开。

本设计不改变 desktop control lease 的所有权规则，也不把媒体暂停和 Terminal admin 授权耦合。

## 10. 媒体健康与自动恢复

暂停是预期状态，不能进入现有故障恢复链。WebRTC adapter 增加 `mediaSuspended` 真相，所有媒体消费者读取该状态：

- 暂停期间停止 video frame callback 和 rendered FPS 更新。
- `handleReceiverStats()` 不把 0 FPS 送入 `LinkQualityController`。
- 不增加 `noMediaTicks`，不触发质量降档、主动 ICE restart 或 `scheduleReconnect()`。
- 保留 PeerConnection、ICE、candidate pair 和 DataChannel 状态采样。
- UI 连接状态保持 connected，媒体状态显示 paused，FPS 显示暂停而不是 0 FPS 故障。

恢复时：

1. 重置 WebRTC stats interval baseline、`noMediaTicks` 和 link-quality 短期计数。
2. 重新调用 `video.play()` 和 video frame callback。
3. 在 rendered frame 到达前处于 `resuming`，不执行 0 FPS 故障判断。
4. 1500ms 无 rendered frame 且 keyframe 请求失败或无 ack 时，执行一次现有 `WebRTC.refresh()`；同一 generation 只允许一次。

## 11. 多 Viewer 与竞态

当前 Host 只有一个活动 PeerConnection 和一个 `current_viewer_id`，本设计按当前活动 Viewer 控制媒体，不建立多路广播。

为避免未来多 Viewer 演进时出现全局暂停错误，Host 的媒体活动状态必须包含 viewerId 和 generation，不能只保存一个无归属布尔值。若未来支持同时观看，Signal Server 必须按消费者需求聚合，只有所有活动消费者都 suspended 时才暂停共享采集；该聚合不在本轮范围内。

Viewer disconnect、Host reconnect、新 offer 和网络模式切换都会生成新的连接上下文。新 PeerConnection 默认 active，并从当前 controller snapshot 立即同步一次；旧 connectionAttemptId 的 ack 只记录诊断，不改变当前 UI 状态。

为建立该归属关系，Viewer 的 `offer` payload 必须携带当前 `connectionAttemptId`，Signal Server 校验并转发，Host 在接受 offer 时保存为 `current_connection_attempt_id`。`media-activity-change` 和 ack 使用同一个值；没有匹配 attempt id 的控制消息不得改变当前 sender。

## 12. 可观测性

新增结构化事件：

- Viewer：`media_activity_requested`、`media_activity_acknowledged`、`media_resume_timeout`。
- Signal：`media_activity_forwarded`、`media_activity_rejected`。
- Host：`host_media_suspended`、`host_media_resumed`、`host_media_activity_ignored`。

事件只记录 state、reasons、generation、viewerId、connectionAttemptId、PC 状态、captureSeq 和 keyframe 请求结果，不记录 token、密码、Terminal IO 或 SDP。

`Diagnostic.getNetworkSnapshot()` 增加 `mediaActivity`：当前 state、reasons、generation、最后 ack generation、resume timeout 次数。Host event-loop 摘要增加 `mediaActivityState`，便于确认暂停期间 captureSeq 是否保持稳定。

## 13. 测试与运行时验收

### 13.1 自动化测试

1. `media-activity-controller.test.js`
   - 多原因 OR 语义、幂等 generation、手动暂停保留。
2. `media-activity-lifecycle.test.js`
   - 750ms hidden debounce、visible 取消、pagehide/pageshow 和 listener cleanup。
3. `terminal.test.js` / `webrtc.test.js`
   - Terminal 切换、page visibility、manual pause、WebRTC/tunnel adapter、暂停期间禁止恢复逻辑、resume timeout 单次 refresh。
4. `signaling.test.js`
   - payload 校验、generation 去重、可信 viewerId、ack 定向路由、旧 Viewer 拒绝。
5. `test_media_suspension.py`
   - sender detach/attach adapter、capture condition、buffer 清理、shutdown 唤醒、current_viewer_id 和 generation 校验。
6. `test_tunnel_relay.py`
   - suspended 停止 relay，旧 viewer stop 不影响当前 relay，恢复使用当前 profile。

### 13.2 普通浏览器验收

使用真实 Chrome 浏览器分别验证 WebRTC 和 tunnel：

- 桌面播放时记录 Host captureSeq、Viewer outbound/inbound bytes 和 rendered FPS。
- 切换 Terminal 15 秒：captureSeq 保持不变，视频 bytes 增量仅允许连接保活级别，Terminal 可继续输入输出。
- 返回桌面：WebRTC 1500ms 内出现可解码新帧；tunnel 2500ms 内恢复 JPEG 帧。
- 浏览器切到后台 15 秒再回来，结果与 Terminal 切换一致。
- 手动暂停后切换 Terminal 再返回，仍保持暂停，直到用户手动恢复。
- 暂停期间不出现 quality degrade、ICE restart、media-stalled 或 reconnect 事件。

### 13.3 量化门槛

- suspended 期间 Host `captureSeq` 增量为 0，允许暂停切换时最多一个在途帧。
- WebRTC RTP 视频 payload bytes 在 15 秒暂停窗口内不增长；ICE/DTLS/RTCP 保活流量不计入视频 payload。
- Host 暂停期间不执行新的视频编码调用。
- WebRTC 恢复首个 rendered frame P95 小于等于 1500ms。
- tunnel 恢复首帧 P95 小于等于 2500ms。

## 14. 文档同步

实现完成后更新：

- `docs/需求文档/WebRemoteDesktop-需求文档.md`：补充自动媒体暂停、恢复和暂停期健康语义。
- `README.md`：说明 Terminal tab、页面后台和手动暂停的媒体行为。

不修改 safe startup、quick tunnel 生命周期和 Terminal 共享会话规则。

## 15. 非目标

- 不断开或重建 Cloudflare tunnel。
- 不修改 TURN、Strict STUN 或网络模式策略。
- 不销毁 Terminal session、admin token 或 PTY replay。
- 不实现多 Viewer 同时观看或媒体广播。
- 不以低帧率 idle profile 代替正常暂停路径。
- 不在本轮改变 desktop control lease 语义。
