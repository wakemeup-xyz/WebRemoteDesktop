# 远程键盘状态可靠性与控制租约设计

日期：2026-07-19

代码基线：`73272955cc16768bfb55d4015177d97dc9d4e212`

关联诊断：`docs/superpowers/reports/2026-07-19-remote-keyboard-mapping-stuck-key-systemic-analysis.md`

## 1. 目标

本设计在不改变现有部署和媒体架构的前提下，系统性解决远程桌面的键盘映射、组合键、卡键、断线释放、跨 transport 顺序、多 Viewer 污染、国际键盘和文本输入问题。

完成后的系统必须具备以下性质：

1. 一个按键从按下到释放只有一个状态真相，keyup 使用 keydown 时记录的同一物理身份和映射结果。
2. direct WebRTC 与 fresh tunnel 使用同一套单控制者租约，不允许多个 Viewer 同时写入 Host 键盘状态。
3. DataChannel 与 Socket.IO 可以切换，但切换必须经过有确认的 reset barrier，不能逐事件自由跳转。
4. 组合键、虚拟快捷键和 reset 在 Host 的同一串行队列中原子执行。
5. 物理按键与 Unicode 文本输入分离，不使用字符猜测物理键，也不把 IME composition 伪装成 keydown/keyup。
6. 合法长按不被固定 8 秒 watchdog 误释放；失联释放由控制租约、transport teardown 和 Host fail-safe 驱动。
7. 默认日志和诊断不记录原始按键、文本、剪贴板内容或完整输入 payload。

## 2. 已确认约束与产品决策

### 2.1 部署约束

本设计继承 `2026-07-18-remote-desktop-reliability-latency-remediation-design.md` 的约束：

1. 不配置、不部署、不实现 TURN。
2. 服务端没有公网入站能力。
3. Viewer 只使用普通浏览器，不安装客户端。
4. `https://link.stockhub.wiki` 继续作为固定公网入口。
5. Cloudflare Tunnel 继续承载页面、API、信令和 Terminal。
6. Strict STUN 失败后由用户手动选择 JPEG tunnel，不自动切换媒体 relay。
7. 本设计不引入 VPS、FRP、反向 SSH、Tailscale 或 Headscale。

键盘协议与媒体路径解耦。控制租约和 Socket.IO control plane 必须在 direct WebRTC 与 tunnel 两种媒体模式下保持相同语义。

### 2.2 多 Viewer 控制权

采用用户确认的方案 B：**单一控制租约**。

- 第一个请求控制且 Host 在线的 Viewer 可以取得控制权。
- 其他 Viewer 保持只读，可以显式请求接管。
- 接管时先冻结旧控制者输入，在 Host 完成旧租约 reset 后再发放新租约。
- 旧控制者收到撤销通知后立即清空本地 pressed-state；其迟到事件由 Signal 和 Host 双重拒绝。
- Viewer 断开、主动释放、租约心跳超时、Host 断开或 Signal 重启都会撤销租约并释放 Host 状态。
- Terminal 共享会话不使用此桌面租约，继续保持独立授权和共享输入语义。

## 3. 当前问题与设计覆盖

| 诊断项 | 设计机制 |
|---|---|
| K-01 Windows Ctrl -> Command 丢失 | Viewer 归一化一次，normalized press record 成为发送和 keyup 的唯一真相 |
| K-02 keyup 被 modal/IME 过滤 | tracked keyup 在 ignore 规则之前处理 |
| K-03 release fire-and-forget、跨 transport 乱序 | `leaseEpoch + seq + reset barrier + applied ack` |
| K-04 虚拟组合键非原子 | `keyboard/batch` 单消息、Host 单锁执行、逆序释放 |
| K-05 左右 modifier 共享 flag | Host pressed physical code set 派生 flags |
| K-06 全局 watchdog 可被持续输入推迟 | lease heartbeat 和 teardown reset；删除固定 8 秒按键超时 |
| K-07 tunnel 多 Viewer 污染 | Signal `DesktopControlLease` 统一 direct/tunnel 控制权 |
| K-08 reset 在锁外执行 | 所有 apply/reset 进入 Host 同一串行 interface |
| K-09 Dead/AltGraph/IME 被粗暴忽略 | 物理 code 与 committed Unicode text 分离；AltGr 状态机 |
| K-10 ISO/JIS/Numpad 映射不完整 | 明确的 Quartz physical-code table 和 unsupported 行为 |
| K-11 modifier 自身 flags 不一致 | modifier 状态只由 pressed codes 派生，payload flags 仅作校验 |
| K-12 8 秒误伤长按 | repeat 只重复 down；释放由真实 up/reset/lease 触发 |
| K-13 Host 修改全局输入源 | 删除启动时 `defaults write` 和 ABC 强制切换；文本使用 Unicode injection |

## 4. 成熟远程桌面方案对照

本设计对以下公开实现的固定 commit 做了源码级对照：

| 方案 | 固定版本和来源 | 采用的原则 | 不直接照搬的部分 |
|---|---|---|---|
| noVNC | [`7c36fabe`](https://github.com/novnc/noVNC/blob/7c36fabe599e053c5a81e98e091ac636f6c1e174/core/input/keyboard.js) | `_keyDownList` 作为 pressed truth；keyup 使用 keydown keysym；blur/ungrab 全量释放；处理 Meta、AltGr、双 Shift、CapsLock quirks | RFB keysym 不是本项目 macOS Quartz 的最终键码 |
| RFB protocol | [`152107db`](https://github.com/rfbproto/rfbproto/blob/152107db63cd34b3536ad8ddf54a0cfc9017a9f9/rfbproto.rst#keyevent) | down/up 明确分离；repeat 只重复 down；高延迟 release 必须被当作正确性问题；左右 modifier 独立 | 基础 RFB KeyEvent 不提供本项目需要的 lease/seq/reset ack |
| Apache Guacamole | [`0b65b785`](https://github.com/apache/guacamole-client/blob/0b65b785afa3de481d08b90c44c9a748c6f5c316/guacamole-common-js/src/main/webapp/modules/Keyboard.js) | `pressed` map；press/release 幂等；`reset()` 释放全部；Dead/Meta/lock quirks；独立 `type(str)` 文本路径 | Guacamole tunnel 本身有单一有序协议，本项目有 DataChannel 和 Socket.IO 双 transport |
| FreeRDP | [`d88dd947`](https://github.com/FreeRDP/FreeRDP/blob/d88dd947e68ed5a7ae636a37897b7f1410f626d6/libfreerdp/core/input.c) | scancode 与 Unicode 是两个 interface；synchronize event；focus-in 状态屏障；特殊键原子序列 | RDP 自身可靠有序通道不能解决本项目跨 transport 排序 |
| RustDesk | [`5f015c9d`](https://github.com/rustdesk/rustdesk/blob/5f015c9da13cb227a414c6d295a5c81e5360eccb/src/keyboard.rs) | `TO_RELEASE`；左右 modifier；grab owner；map/translate/legacy 模式；lock state；物理 HID 优先 | RustDesk 需要原生客户端和系统级 hook，本项目必须留在普通浏览器能力内 |

这些实现的共同结论是：pressed-state 必须显式、按下和释放必须成对、焦点/会话变化必须形成释放屏障、物理键和文本不可混为一条含糊路径。它们没有现成解决本项目双 transport 和无原生 Viewer 的限制，因此本设计增加 lease/epoch/seq 层，而不是复制任一项目的代码。

## 5. 方案比较

### 5.1 方案 A：现有文件内逐点修补

直接修复 Windows modifiers、keyup ignore、左右 modifier 和 watchdog。

优点是改动少。缺点是 Viewer、Signal、Host 仍分别猜测控制者和状态，跨 transport、接管、断线和迟到事件没有统一证明。该方案只能降低复现概率，不能建立可靠性不变量，因此拒绝。

### 5.2 方案 B：Viewer/Host 双状态机，不增加 Signal 租约

Viewer 和 Host 分别增加 pressed-state 与 reset ack，沿用 `current_viewer_id`。

该方案可修复多数单 Viewer 问题，但 `current_viewer_id` 由 WebRTC offer 建立，fresh tunnel 没有 offer，direct/tunnel 会继续形成两套所有权语义。多 Viewer 接管仍可能污染 Host，因此拒绝。

### 5.3 方案 C：控制租约 + 键盘会话协议

Signal 维护唯一 `DesktopControlLease`，Viewer 维护 `RemoteKeyboardController`，transport 维护顺序和 barrier，Host 维护 `RemoteKeyboardState` 并通过 Quartz adapter 执行。

该方案改动面最大，但每个 seam 只有一个职责和一个真相源，能够覆盖全部 P1/P2 根因。采用此方案。

## 6. 总体架构

```text
DOM KeyboardEvent / text commit / virtual shortcut
                 |
                 v
       RemoteKeyboardController
       - normalized pressed truth
       - mapping/quirks/batch/text
                 |
                 v
         KeyboardTransport
       - leaseEpoch + seq
       - DataChannel adapter
       - Socket.IO adapter
       - ack/reset barrier
                 |
                 v
        DesktopControlLease
       - single controller
       - takeover/heartbeat/expiry
       - authorize before relay
                 |
                 v
         RemoteKeyboardState
       - epoch/seq validation
       - pressed physical codes
       - derived modifiers/locks
       - one serialized executor
                 |
                 v
        QuartzKeyboardAdapter
       - physical key events
       - Unicode text events
       - atomic reset/batch
```

### 6.1 Seam 1：Viewer `RemoteKeyboardController`

外部 interface 只暴露：

```javascript
controller.setLease(leaseOrNull)
controller.handleDomEvent(event)
controller.sendChord(chord)
controller.sendText(text)
controller.reset(reason)
controller.getSnapshot()
```

DOM quirks、Windows/Mac 映射、pressed map、repeat、Dead/AltGr、虚拟组合键和 pending reset 都隐藏在模块内部。`input.js` 只负责事件绑定、pointer 输入和页面展示，不再直接维护键盘状态。

### 6.2 Seam 2：Viewer `KeyboardTransport`

外部 interface 只暴露：

```javascript
transport.setLease(leaseOrNull)
transport.send(action)
transport.resetBarrier(reason)
transport.acceptAck(ack)
transport.getSnapshot()
```

DataChannel 和 Socket.IO 是两个 adapter。模块负责选择和固定 transport、生成 seq、等待 ack、处理失败并阻止未完成 reset 后的新 keydown。

### 6.3 Seam 3：Signal `DesktopControlLease`

外部 interface 只暴露 acquire、heartbeat、release、disconnect、host transition、authorize 和 snapshot。Socket.IO 事件注册只是 adapter，不持有第二份 lease 状态。

### 6.4 Seam 4：Host `RemoteKeyboardState`

外部 interface 只暴露：

```python
apply(envelope) -> ApplyResult
reset(lease_epoch, reason) -> ApplyResult
snapshot() -> KeyboardSnapshot
```

所有方法在同一个串行 executor 中执行。Quartz 是注入的 adapter；测试使用 recording adapter。`host.py`、WebRTC callback 和 viewer-status callback 不得直接调用 Quartz 或修改 pressed sets。

## 7. DesktopControlLease 状态机

### 7.1 状态

```text
FREE -> GRANTING -> ACTIVE -> REVOKING -> FREE
                     |           |
                     +-> GRANTING+  (explicit takeover)
```

- `FREE`：没有控制者，所有 Viewer 只读。
- `GRANTING`：候选控制者已选定，等待 Host reset ack；不转发任何桌面输入。
- `ACTIVE`：仅匹配 `viewerId + leaseId + leaseEpoch` 的输入可转发。
- `REVOKING`：旧控制者已冻结，等待 Host reset ack。

### 7.2 租约字段

```json
{
  "leaseId": "128-bit random opaque token",
  "leaseEpoch": 42,
  "controller": true,
  "heartbeatIntervalMs": 3000,
  "expiresAfterMs": 12000
}
```

- `leaseEpoch` 在 Signal 进程内严格单调增加，不按 Viewer 分区。
- `leaseId` 只发给当前控制者和 Host；只读 Viewer 只收到 `controller=false` 和是否存在控制者。
- Signal 重启后 epoch 可从 1 重新开始，但 Host socket 同时断开并必须 reset；新的 Host connection generation 隔离旧 epoch。
- 心跳周期 3 秒，连续 12 秒没有合法 heartbeat 视为租约失效。

### 7.3 首次获取

1. Viewer 桌面激活后发 `control-acquire`。
2. Signal 在 Host 在线且状态为 `FREE` 时进入 `GRANTING`，生成新 epoch/leaseId。
3. Signal 向 Host 发 `control-transition`，要求在串行队列内 reset 旧状态。
4. Host 回 `control-transition-ack`。
5. Signal 进入 `ACTIVE`，只向候选 Viewer发送完整 lease，向其他 Viewer广播只读状态。

Host 不在线时请求返回 `host-offline`，不预占租约。

### 7.4 显式接管

1. 只读 Viewer 发 `control-acquire { takeover: true }`。
2. Signal 进入 `REVOKING`，立即停止转发旧控制者输入，并通知旧 Viewer `control-revoked`。
3. Signal 向 Host 发旧 lease reset。
4. Host 在同一执行队列中释放旧 lease 的全部键和鼠标按钮，并确认。
5. Signal 生成新 epoch/leaseId，完成 `GRANTING -> ACTIVE`。

若 3 秒内没有 Host ack，接管失败并回到 `FREE`。Signal 不在未确认 reset 时乐观发放新控制权。Viewer 可以重试；Host 重连时会先执行 unconditional reset。

### 7.5 自动撤销

以下事件进入同一 revoke 流程：

- controller Socket.IO disconnect；
- 主动 `control-release`；
- heartbeat timeout；
- Host disconnect/replacement；
- Viewer logout；
- Signal shutdown 能执行清理时。

window blur 只触发键盘 reset，不释放控制租约；document hidden、页面 unload、桌面显式 disconnect 会同时 reset 并主动 release。这样短暂切出浏览器不会立即失去控制，但后台 tab 不会长期占有控制权。

## 8. 输入协议 v2

### 8.1 通用 envelope

```json
{
  "schemaVersion": 2,
  "type": "keyboard",
  "action": "key",
  "leaseId": "opaque",
  "leaseEpoch": 42,
  "seq": 101,
  "inputIds": ["inp_..."],
  "payload": {}
}
```

约束：

1. `seq` 在一个 lease 内从 1 开始严格递增。
2. 普通 action 只接受 `seq == lastAppliedSeq + 1`。
3. `seq <= lastAppliedSeq` 是重复或迟到事件，幂等丢弃并返回当前 ack。
4. `seq > lastAppliedSeq + 1` 是 gap，Host 不执行并返回 `resync-required`。
5. `reset` 是 barrier：只要 epoch 匹配且 `seq > lastAppliedSeq` 就执行，完成后把 `lastAppliedSeq` 提升到 reset seq。更低 seq 的迟到 DataChannel 消息随后会被拒绝。
6. epoch 小于 active epoch 的全部事件拒绝；epoch 大于 active epoch 只能由 Signal 的 `control-transition` 建立。

`leaseId + leaseEpoch` 也必须附加到 mouse 和 command 输入，Signal/Host 对所有桌面写操作执行同一 authorize。连续 `seq` 只属于可靠键盘流；可丢弃的 mouse move 使用独立 best-effort `moveSeq`，不能制造键盘 sequence gap。

### 8.2 物理键 action

```json
{
  "action": "key",
  "payload": {
    "phase": "down",
    "code": "ShiftRight",
    "location": 2,
    "repeat": false,
    "modifiers": {
      "controlLeft": false,
      "controlRight": false,
      "shiftLeft": false,
      "shiftRight": true,
      "altLeft": false,
      "altRight": false,
      "metaLeft": false,
      "metaRight": false
    },
    "locks": { "capsLock": false }
  }
}
```

- `code + location` 是物理身份，`key` 和字符不参与 Host physical mapping。
- down/up 都使用 keydown 时记录的 normalized physical identity。
- repeat 使用 `phase=down, repeat=true`，不插入伪 up。
- payload modifier snapshot 用于一致性检查；Host 实际 flags 从自身 pressed code set 派生。
- CapsLock 在浏览器报告不可靠的平台允许 `null`；Host 不根据未知值改变 lock state。

### 8.3 Unicode text action

```json
{
  "action": "text",
  "payload": {
    "text": "已完成的 composition 文本"
  }
}
```

- 只接受 `beforeinput`/`compositionend` 已提交文本或显式文本输入框提交。
- 单消息最大 4096 Unicode scalar values；超限拒绝，不截断代理对。
- 文本 action 不进入 pressed-state，不生成伪 modifier，不用于系统快捷键。
- Host 使用 Quartz Unicode injection，不切换 macOS 输入源。
- 文本内容属于敏感数据，不进入默认日志、诊断 bundle、metrics 或持久化。

### 8.4 原子 batch action

```json
{
  "action": "batch",
  "payload": {
    "steps": [
      { "phase": "down", "code": "MetaLeft" },
      { "phase": "down", "code": "KeyC" },
      { "phase": "up", "code": "KeyC" },
      { "phase": "up", "code": "MetaLeft" }
    ]
  }
}
```

- 最多 16 步。
- modifiers 按固定顺序按下，主键释放后按逆序释放 modifiers。
- Host 在同一锁和同一 executor job 中执行全部步骤。
- batch 执行前记录已经由物理路径按下的 codes；只释放本 batch 新按下的 batch-owned codes，不能释放用户原本仍按住的 modifier。
- 任一步 Quartz 失败时立即 best-effort release batch 已按下键，再执行 lease reset，返回 `execution-failed`。
- Viewer 的 action bar 和未来特殊组合键必须使用 batch，不再使用独立 timer。

### 8.5 reset action

```json
{
  "action": "reset",
  "payload": { "reason": "visibility-hidden" }
}
```

reset 同时释放当前 lease 的键盘键和鼠标按钮。允许的 reason 是固定枚举；未知 reason 归一化为 `unspecified`，避免把任意文本带入日志。

### 8.6 applied ack

```json
{
  "type": "input_ack",
  "schemaVersion": 2,
  "leaseEpoch": 42,
  "appliedSeq": 101,
  "status": "applied",
  "pressedKeyCount": 0,
  "modifierMask": 0,
  "hostExecuteMs": 1.7,
  "inputIds": ["inp_..."]
}
```

允许 status：`applied`、`duplicate`、`stale-lease`、`sequence-gap`、`resync-required`、`execution-failed`。ack 不包含 key、code 或文本。

## 9. Viewer 键盘状态

### 9.1 Pressed truth

内部 map 以 normalized `code + location` 为 key，value 保存完整 press record：

```javascript
{
  code,
  location,
  normalizedModifiers,
  downSeq,
  transport,
  pressedAt,
  repeatCount
}
```

规则：

1. 新 keydown 只有在有 ACTIVE lease、没有 pending reset、transport 可接受时才进入 map。
2. 已跟踪普通键的 repeat 可以发送重复 down；modifier repeat 被抑制。
3. keyup 先查 pressed map，再执行 modal/form/IME ignore。匹配到 tracked press 必须释放。
4. 未跟踪 keyup 幂等忽略，不根据当前 DOM key 猜测远端状态。
5. pressed map 表示浏览器当前物理状态：keyup 被 transport 接受后立即删除，以允许快速再次按下；对应 seq 保留在有界 pending-ack ledger 中，直到 Host ack 提交远端状态。
6. keyup 发送失败时清除本地物理状态、保留远端未确认记录并进入 `RESET_REQUIRED`；reset barrier 完成前不接受新的 keydown，因此不会假装远端已经释放。

### 9.2 Windows/Mac 映射

- Mac 模式：物理 `code` 直通，左右 modifier 保持独立。
- Windows 模式：`ControlLeft -> MetaLeft`、`ControlRight -> MetaRight`；主键 modifier snapshot 同时把左右 Control 转为对应 Meta。
- 映射只在 keydown 时执行一次；keyup 和 repeat 读取 press record。
- Windows Meta、Alt、Shift 保持各自物理语义，不隐式做第二套 remap。
- mode change 必须先完成 reset barrier；barrier 未确认前 UI 不切换生效状态。

### 9.3 Browser quirks

- macOS Meta 按住时浏览器可能不可靠地产生普通键 keyup。对 Meta+非 modifier 键，Viewer 可发送一个原子 down/up batch，但 Meta 本身仍保持 pressed-state。
- Windows AltGr 使用短暂 armed state 识别 fake `ControlLeft + AltRight`，归一化为右侧 AltGraph 语义；真实 Control 已在按下时不被吞掉。
- Windows 两侧 Shift 同时按下且浏览器漏发一侧 up 时，在任一 Shift up 后用 `getModifierState('Shift')` 校验；不一致时触发 reset barrier，而不是伪造一串普通事件。
- CapsLock 作为原子 tap，并携带可用的 lock snapshot。
- `Dead` 不因 key 值被过滤：物理快捷键模式按 `code` 发送；composition 产生的字符只走 text action。
- `Process`、`Unidentified` 且没有稳定 `code` 的新 keydown 不发送；已有 tracked keyup 仍优先释放。

### 9.4 物理映射范围

Quartz adapter 的 canonical table 覆盖：

- US 主键区、F1-F20、导航键、左右 modifier；
- 完整 Numpad：数字、四则、decimal、enter、equal、clear、comma；
- ISO：`IntlBackslash` 映射 ISO Section，不再错误复用 US Backslash；
- JIS：`IntlYen`、`IntlRo`、`Lang1/KanaMode`、`Lang2/Eisu`；
- 无可靠 macOS 等价键的 `ContextMenu`、`Convert`、`NonConvert` 明确返回 `unsupported-code`，不映射到 End 或其他无关键。

unsupported 是显式、可诊断的结果，不做字符 fallback。字符输入应走 text action。

## 10. KeyboardTransport 顺序与恢复

### 10.1 正常发送

- ACTIVE lease 开始时选择当前最优可靠 transport。
- 只要 pressed map 非空，普通 key action 固定在该 transport。
- DataChannel 必须是 ordered/reliable；mouse-move volatile channel 不允许承载键盘。
- Socket.IO emit 成功只代表本地接受，最终提交仍以 Host applied ack 为准。

### 10.2 Transport 切换

当 pinned transport 关闭、buffer 超限或发送抛错：

1. controller 进入 `RESET_REQUIRED`，停止接收新 keydown 和 batch/text。
2. 使用仍可用的 control-plane Socket.IO 发送更高 seq 的 reset barrier。
3. Host reset 提升 appliedSeq，使迟到的旧 DataChannel 事件失效。
4. 收到 reset ack 后清空 pressed/pending，选择新 transport，进入 `READY`。
5. 无 transport 时保持 pending reset；重连和重新取得 lease 后第一条消息必须是 reset。

不实现跨 transport 重排 buffer。普通事件固定 transport，加上 reset 的高水位语义后不需要额外复杂度。

### 10.3 Ack timeout

- 普通 key ack 主要用于状态提交和指标，不在每个键上阻塞后续连续 seq。
- reset barrier 必须等待 ack，3 秒超时后撤销本地 lease 并重新 acquire，不能继续发送。
- pending ack 有 256 条硬上限；达到上限进入 reset，不无限增长。

## 11. Host `RemoteKeyboardState`

### 11.1 状态真相

每个 active lease 保存：

```python
KeyboardSessionState(
    connection_generation,
    lease_epoch,
    last_applied_seq,
    pressed_codes,
    lock_state,
)
```

`pressed_codes` 是 modifier flags 的唯一真相。每次 apply 后从左右 modifier code 集合重新计算 Quartz flags，不对共享 bit 做单边加减。

### 11.2 串行执行

- key、text、batch、reset、lease transition、WebRTC teardown、Signal disconnect 和 Host stop 全部进入同一个单 worker executor。
- `host.py` callback 只能调用 async reset interface，不得直接调用 `release_all_keys()`。
- reset 在队列中的顺序与 key apply 可证明，不再存在锁外 reset 与线程中 keydown 交错。

### 11.3 失联与长按

- 删除 Viewer 和 Host 的固定 8 秒 key stale timeout。
- 合法长按依靠浏览器 repeat down，直到真实 keyup。
- Viewer 生命周期 reset、lease heartbeat timeout、controller disconnect、DataChannel/PC teardown、Signal disconnect 和 Host stop 都会 reset。
- Host 保留 connection-generation fail-safe：Signal socket 断开时立即排队 unconditional reset；重连后的第一个 lease transition 也先 reset。
- 不用普通鼠标或其他键盘事件刷新一个全局 watchdog。

### 11.4 Quartz adapter

- physical key 使用 `CGEventCreateKeyboardEvent` 和 canonical code table。
- Unicode text 使用 `CGEventKeyboardSetUnicodeString`；按 Unicode scalar 安全分块。
- batch 在一个 adapter 调用中依次 post，默认不加 30ms 浏览器 timer。只有真实 macOS 验收证明需要时，才允许 adapter 内使用一个有界、可测试的 0-12ms step delay 配置。
- 不执行 `defaults write -g ApplePressAndHoldEnabled`。
- Host 启动不调用 `TISSelectInputSource`，不改变全局 ABC/中文输入源。
- `switchInputMethod` 作为用户显式虚拟快捷键保留，但它必须使用 batch，不能成为 Host 启动副作用。

## 12. 兼容与迁移

采用 Host-first 的三阶段升级：

### 12.1 阶段 1：Host 双读

先部署支持 v2 的 Host。Host 仍接受现有 v1 input，但 v1 只进入 `LegacyInputAdapter`，adapter 将其转换为内部 v2 action 后再调用 `RemoteKeyboardState`。Quartz 和 pressed truth 不允许 v1/v2 分别写入。

### 12.2 阶段 2：Signal 租约与 Viewer v2

部署 Signal lease 和新版静态 Viewer：

- v2 Viewer 必须 acquire 后才能输入。
- 缓存中的 v1 Viewer 在发送 direct offer 或启动 tunnel relay 时触发 legacy lazy-acquire；Signal 必须先完成 Host reset/grant，再允许媒体控制通道激活。
- 同一时间仍只有一个 legacy 或 v2 controller。
- direct v1 DataChannel 绑定到 offer 对应的 server-issued lease；Host 的唯一 `LegacyInputAdapter` 为到达的 v1 DataChannel/Socket.IO 事件分配内部 seq。
- legacy Viewer 不具备 applied reset barrier。其 transport 发生变化时，Host adapter 必须先 reset 再应用新 transport；takeover 和 disconnect 由 Signal 强制 Host reset。

### 12.3 阶段 3：收紧兼容

一个发布周期后删除 lazy-acquire，v1 Viewer 只读并提示刷新页面。Host 的 `LegacyInputAdapter` 保留一个发布周期后删除。兼容窗口和删除提交必须在需求文档中记录，不长期维护两套写协议。

### 12.4 回滚

- 阶段 1 可独立回滚，因为 Signal/Viewer 仍发 v1。
- 阶段 2 回滚必须同时回滚 Signal 静态资源和租约模块，Host 双读可保留。
- 不允许只回滚 Host 到 v1 而保留 v2 Signal；部署检查必须先确认 Host capability。

## 13. UI 行为

状态栏增加紧凑控制状态：

- `控制中`：当前 Viewer 持有 ACTIVE lease。
- `只读`：其他 Viewer 持有 lease。
- `请求控制`：无控制者或用户要显式接管时的命令按钮。
- `正在切换`：等待 Host reset ack，桌面输入禁用。

窗口 blur、页面 hidden、transport reset 和 takeover 不弹阻塞式 modal。状态通过现有 status/action bar 展示，避免和 Terminal admin 输入焦点冲突。

文本输入使用 action bar 中独立的 `文本输入` 命令打开小型 modal；composition 只发生在该输入框中。提交后发送 text action并清空，取消不发送。桌面 document 级 keyboard handler 必须忽略该 modal 的新 keydown，但仍释放进入 modal 前已跟踪的 keyup。

## 14. 安全、诊断与性能

### 14.1 安全

- Signal 使用 token 派生的真实 Viewer 角色和 socket id，不信任客户端提交的 viewerId。
- leaseId 使用密码学随机值，比较时同时校验 socket owner 和 epoch。
- text 最大 4096 scalar，batch 最大 16 步，payload 深度和字段均白名单校验。
- 默认日志不得包含 key、code、location、text、leaseId、完整 inputId 或坐标。
- leaseId 在诊断中只显示不可逆短 hash；inputId 延续现有 hash/脱敏规则。

### 14.2 可观测性

允许记录：

- `control_lease_granted/revoked/takeover/expired`；
- `keyboard_input_applied/rejected/reset`；
- schemaVersion、leaseEpoch、seq、action 类别、transport、payload byte count；
- pressedKeyCount、modifierMask、pendingAckCount、reset reason enum；
- Host execute time 和 reset barrier RTT。

不记录原始键值。Viewer 诊断面板展示状态摘要而不是最近按键文本。

### 14.3 性能预算

- Viewer 纯状态归一化和 envelope 构造 p95 小于 1ms。
- Signal authorize 为 O(1)，不访问数据库。
- Host physical key apply 在不含网络的情况下 p95 小于 5ms。
- takeover/reset barrier 在本地链路 p95 小于 100ms；公网值单独展示，不与 Host execute 混合。
- pressed map、pending ack 和诊断 ring buffer 都有明确上限。

## 15. 测试策略

### 15.1 Viewer 纯状态测试

使用 Node test runner 覆盖：

- Mac/Windows 左右 modifier 映射矩阵；
- Ctrl+C/V/X/Z/A/S/F 和 Ctrl+Shift/Ctrl+Alt；
- keydown 在桌面、keyup 在 modal/input/composition；
- duplicate down、repeat down、untracked up；
- Meta keyup quirk、AltGr、双 Shift、CapsLock、Dead key；
- blur/hidden/mode change/transport failure/pending reset；
- batch 正序按下、逆序释放和失败恢复；
- text composition 不污染 pressed map；
- 长按超过 8 秒仍保持，真实 up 后释放。

### 15.2 Signal lease 状态机测试

使用 fake clock 和 fake sockets 覆盖：

- first acquire、只读拒绝、显式 takeover；
- revoke -> Host reset ack -> new grant 的严格顺序；
- old viewer/old epoch/stolen leaseId 输入拒绝；
- heartbeat refresh、12 秒 expiry；
- controller disconnect、Host disconnect/replacement、Signal restart generation；
- direct/tunnel 输入走同一 authorize；
- legacy lazy-acquire 仍只有一个控制者；
- 日志不包含原始 leaseId、key 或 text。

### 15.3 Host 模型与 adapter 测试

- seq applied/duplicate/gap/reset-high-water；
- old/new epoch、connection generation；
- 左右 Shift/Ctrl/Alt/Meta 派生 flags；
- reset 与并发 keydown 都经过同一队列；
- batch 原子性和 exception cleanup；
- Unicode scalar、emoji surrogate pair、4096 上限；
- US/ISO/JIS/Numpad Quartz mapping table；
- unsupported code 不错误 fallback；
- Signal disconnect/Host stop 无条件 reset；
- 不调用 `defaults write` 或 TIS global switch。

### 15.4 跨层契约测试

使用共享 fixtures 验证 Viewer envelope、Signal validator、Host parser 的字段名、状态和错误码一致。至少包含 key、repeat、text、batch、reset、duplicate、gap、stale epoch 和 takeover fixture。

## 16. 真实浏览器验收

自动化和模型测试通过后，必须使用真实普通浏览器和真实 macOS Host 做最终闭环，不能用 mock 代替。验收不要求 Viewer 安装客户端。

### 16.1 单 Viewer

- direct WebRTC 和手动 tunnel 各执行一次；
- Mac 与 Windows mode；
- 左右 modifier、复制/粘贴/撤销/保存/查找；
- 长按方向键超过 10 秒，释放后立即停止；
- 打开 resolution/network/diagnostic/text modal 前按住 Shift，modal 内释放后 Host 状态为 0；
- 双 Shift、AltGr、Option/Dead key、CapsLock；
- ISO/JIS/Numpad 在有对应实体键盘时验证；没有硬件的项保留为自动化已验证、运行时未覆盖，不伪装通过；
- 中文、emoji 和多行文本通过独立 text modal 输入；
- action bar 每个组合键执行后 pressedKeyCount 为 0。

### 16.2 双 Viewer 租约

- Viewer A 取得控制，Viewer B 为只读且输入不生效；
- B 请求接管时 A 立即冻结，Host reset ack 后 B 才可输入；
- A 的迟到 keyup/down 不影响 B；
- A 按住 modifier 后断网，B 接管前 Host pressedKeyCount 回到 0；
- direct A 与 tunnel B、tunnel A 与 direct B 两个方向都验证。

### 16.3 失败注入

- keydown 后关闭 DataChannel，Socket.IO reset barrier 收敛；
- reset ack 丢失时 Viewer 不继续发送新 keydown；
- Signal restart、Host reconnect、页面 hidden/unload；
- 连续快速 mode change、takeover、reconnect；
- 任何场景最终 `pressedKeyCount=0`、`modifierMask=0`，并且新控制者首个普通 key 正确执行。

验收证据必须记录浏览器版本、Viewer 平台、媒体模式、selected candidate pair、lease epoch、reset barrier RTT、Host pressed count 和可见结果。证据不记录输入内容。

## 17. 完成定义

本设计只有在以下条件全部满足时才算开发完成：

1. 诊断 K-01 至 K-13 均有对应自动化测试和实现提交。
2. direct/tunnel 都只能由 ACTIVE lease controller 输入。
3. takeover、disconnect、transport change 和 Signal/Host 重连均通过 reset barrier 收敛。
4. Host 不再使用固定 8 秒按键 watchdog，不再修改全局 Press-and-Hold 或输入源。
5. 物理键、text、batch 三条路径在协议和 Host adapter 中分离。
6. Viewer/Signal/Host 的 schema fixtures 和 focused/full regression 全部通过。
7. 两个真实普通浏览器完成 16.1-16.3 的可执行项；受硬件限制未执行的 ISO/JIS 项明确标记为未覆盖。
8. 需求文档同步更新，旧的“Windows 模式已完成”和“任意键均支持”等失实描述被纠正。

## 18. 非目标

- 不捕获浏览器或操作系统禁止网页截获的 secure attention/system-reserved shortcuts；需要的产品快捷键使用显式 batch 按钮。
- 不为 Windows/Linux Host 实现 native adapter，本轮 Host 仍是 macOS。
- 不改变媒体编码、STUN/tunnel 选择、Terminal transport 或公网入口。
- 不引入持久数据库保存 lease；当前单 Host/单 Signal 进程使用内存状态即可。
- 不把控制租约扩展为多用户权限系统；认证仍沿用现有 Viewer JWT。
