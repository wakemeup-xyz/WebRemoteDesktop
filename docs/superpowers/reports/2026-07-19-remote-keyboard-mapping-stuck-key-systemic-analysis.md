# 远程桌面键盘映射与卡键系统诊断报告

> 日期：2026-07-19
>
> 代码基线：`8adb6ab515dabcecc1f53f215a729eb862281bb2`
>
> 范围：Viewer DOM 键盘事件、虚拟快捷键、DataChannel/Socket.IO 输入传输、Signal Server 转发、Host 输入队列、Quartz 映射、断线与卡键恢复
>
> 边界：本轮只做代码审计、纯状态模拟和自动化测试，没有向真实 Host 注入键盘事件

## 1. 结论

当前键盘功能属于“常用 US/Mac 键位基础可用，但状态机和异常恢复不完整”，不能视为完整开发和验收完成。

- 没有 P0 阻断项。
- 有 7 个 P1：Windows 模式实际没有完成 Ctrl -> Command、keyup 可被 UI/IME 过滤、释放消息没有可靠收敛、虚拟组合键脱离按键状态、左右修饰键状态错误、Host watchdog 可被持续输入永久推迟、fresh tunnel 缺少唯一控制者租约。
- 有 6 个 P2：Host reset 与输入执行存在锁外竞态、Option/Dead/AltGraph 组合被过滤、国际键盘和小键盘映射不完整、modifier 自身 flags 与文档契约冲突、8 秒 watchdog 会误伤合法长按、Host 启动会修改全局输入源且不恢复。
- 常见字母、数字、标点、方向键、F1-F12 和 Mac 下常见 Command/Ctrl/Shift 组合具备基础实现；可靠有序 DataChannel、Socket.IO 兜底、Viewer/Host 双端 reset 和直接 WebRTC 的 stale-viewer 过滤方向是合理的。
- 当前自动化测试全部通过，但通过的测试没有覆盖上述关键状态组合。因此“测试绿”只能证明已写测试的行为没有回归，不能证明键盘功能完整。

综合评级：

| 维度 | 评级 | 结论 |
|---|---:|---|
| US/Mac 常用键映射 | B | 主键位覆盖完整，常见输入可用 |
| Windows 模式 | F | 归一化结果未进入发送 payload |
| 组合键状态 | C- | 单修饰键常用路径可用，左右键、Dead key、虚拟组合存在缺口 |
| 卡键恢复 | C- | 有多条 reset，但没有可靠释放屏障和 per-key Host 租约 |
| 多 Viewer 隔离 | C | 直接 WebRTC 有过滤，fresh tunnel 控制归属不完整 |
| 国际键盘/IME | D+ | 以 US ABC 物理键位为中心，ISO/JIS 和本地组合输入不完整 |
| 自动化覆盖 | D+ | 有生命周期基础测试，没有映射矩阵和跨传输状态机测试 |

## 2. 当前端到端模型

```text
KeyboardEvent
  -> Input.shouldIgnoreKeyboardEvent()
  -> Input.normalizeKeyboardEvent()
  -> Input._pressedKeys
  -> Input.sendInput()
       -> reliable ordered WebRTC input DataChannel
       -> or Signal Socket.IO fallback
  -> Signal Server viewerId relay
  -> WebRemoteHost.on_input()
  -> InputHandler._input_lock
  -> InputHandler._handle_keyboard()
  -> Quartz CGEventCreateKeyboardEvent / CGEventSetFlags / CGEventPost
```

系统目前有三份键盘状态真相：

1. Viewer 的 `_pressedKeys`。
2. Host 的 `_pressed_key_codes`、`_pressed_modifier_key_codes` 和 `_modifier_flags`。
3. macOS Quartz/HID 的真实按键状态。

三者之间没有版本号、总序号、状态摘要或可靠 reset ack。正常链路靠事件顺序保持一致；丢包、切 transport、页面焦点变化、多 Viewer 或执行竞态发生时，只能依赖 8 秒 watchdog 和若干生命周期 reset 猜测收敛。这是本轮多数问题的共同根因。

## 3. 已确认有效的保护

- `web-client/js/webrtc.js:933-945` 创建可靠有序 `input` DataChannel；鼠标 move 才使用可丢弃通道。
- `web-client/js/input.js:107-120` 用物理 `code` 作为本地 pressed key 标识，重复普通键可继续发送但不会重复增加状态；modifier repeat 被抑制。
- `web-client/js/input.js:184-194` 在 window blur 和 document hidden 时进入释放路径。
- `web-client/js/input.js:544-600` 在暂停、停用、重新激活和显式 reset 时尝试清理 Viewer/Host 状态。
- `python-host/input_handler.py:303-340` 通过 `_input_lock` 串行处理正常输入，普通键盘事件不会并发执行。
- `python-host/host.py:1133-1140` 在已知 `current_viewer_id` 时拒绝旧 Viewer 的输入。
- `python-host/host.py:1384-1386`、`1748-1760` 在 WebRTC 失败、最后一个 Viewer 消失时释放 Host 按键。
- `python-host/input_handler.py:665-716` 覆盖 113 个 `KeyboardEvent.code`，本轮静态矩阵确认需求范围内的 US 字母、数字、F1-F12、常见控制键和标点没有缺项。
- Viewer、Signal 和 Host 默认日志已不记录原始键值文本，降低密码/文本泄露风险。

这些保护是有价值的，但它们没有形成一个统一、可验证的键盘状态模块。

## 4. P1 问题

### K-01 Windows 模式的 Ctrl -> Command 结果被发送层丢弃

**证据**

- `web-client/js/input.js:249-270` 正确计算了 Windows 模式下的 `normalized.modifiers.meta=1`、`ctrl=0`。
- `web-client/js/input.js:89-126` 随后却重新调用 `getEventModifiers(e)`，把原始浏览器 `ctrl=1` 写入 `_pressedKeys` 和发送 payload，没有使用 `normalized.modifiers`。
- 纯状态复现中，Windows `Ctrl+C` 产生：

```json
[
  {"key":"Meta","code":"MetaLeft","modifiers":{"ctrl":1,"meta":0}},
  {"key":"c","code":"KeyC","modifiers":{"ctrl":1,"meta":0}}
]
```

**影响**

- modifier 物理键被改成 Meta，但主键 `C` 仍携带 Control flag。
- Windows Viewer 的复制、粘贴、保存、全选等物理快捷键可能执行为 macOS Control 组合，而不是 Command 组合。
- README 和需求文档原先标记“已完成”，与当前代码事实冲突。

**根因置信度：确定。** 这是数据流断裂，不依赖浏览器或 Quartz 推断。

**整改方向**

归一化只执行一次，`normalized` 必须同时成为 key/code/modifiers 的唯一发送真相；keyup 从按下时存储的“已归一化状态”恢复，不再混用原始 DOM modifiers。

**验收**

- Windows 左/右 Ctrl 的 down/up 均映射到左/右 Meta。
- `Ctrl+C/V/X/Z/A/S/F` 主键 payload 只有 `meta=1`。
- Windows Ctrl+Shift、Ctrl+Alt 和左右 Ctrl 混合矩阵通过。

### K-02 keyup 会因当前焦点位于 modal/input/IME 而被直接丢弃

**证据**

- `web-client/js/input.js:132-150` 在查找 `_pressedKeys` 前调用 `shouldIgnoreKeyboardEvent()`。
- `web-client/js/input.js:197-206` 对 modal、INPUT、TEXTAREA、SELECT、contenteditable、composition、Dead 和 AltGraph 一律返回 ignore。
- 纯状态复现：在桌面按下 `KeyX`，把焦点切到 modal 后释放，发送序列只有 `keydown`，`_pressedKeys.size` 仍为 1。

**典型触发**

1. 按住 Shift/Cmd。
2. 鼠标打开“分辨率”“网络”或“诊断”弹窗。
3. 焦点落在弹窗按钮/单选框后释放按键。
4. keyup 以 modal 内元素为 target，被过滤。

桌面与 Terminal 切换、浏览器 IME 状态变化也有同类窗口。

**影响**

Host 最长保持按下约 8 秒；如果 Viewer 本地状态又因其他路径提前清除，可能持续更久。

**根因置信度：确定。**

**整改方向**

ignore 规则只阻止“未被桌面控制器接管的新 keydown”。任何与 `_pressedKeys` 中 code 匹配的 keyup 必须优先释放，即使当前 target 已变为 modal/input 或事件进入 composition。

### K-03 键盘释放是 fire-and-forget，没有跨 transport 总序和可靠 reset 屏障

**证据**

- `web-client/js/input.js:141-148` 在调用 `sendInput()` 前就从 `_pressedKeys` 删除 key。
- `web-client/js/input.js:558-585` 的批量释放先清空全部本地状态，再逐条发送 keyup；发送失败不会恢复或进入 pending。
- `web-client/js/input.js:588-600` 的 `sendKeyboardReset()` 不返回、记录或重试 `sendInput()` 结果。
- 鼠标已有 `_pendingMouseReset`，键盘没有等价机制。
- `web-client/js/input.js:453-505` 每个事件独立选择 DataChannel 或 Socket.IO；`web-client/js/webrtc.js:1051-1074` 只表示消息已进入浏览器通道，不表示 Host 已执行。
- 两个 transport 各自有序，但跨 transport 没有共享 `sequence`；Host 也不做重排或去重。
- 独立 `input_ack` 当前只进入延迟统计，不参与键盘状态提交或 reset barrier。

**影响**

- keydown 走 DataChannel、keyup 因 buffer/close 改走 Socket.IO 时，Host 看到的全局顺序没有保证。
- 浏览器把 keyup 当作已完成后，如果消息在连接关闭窗口丢失，Viewer watchdog 已失去该键的本地真相。
- `channel.send()` 或 `socket.emit()` 抛异常时没有统一捕获；keyup 状态已删除但恢复路径可能没有执行。

**根因置信度：高。** 可靠 DataChannel 的稳定连接可降低概率，但不能消除 teardown 和跨通道窗口。

**整改方向**

- 增加 `controllerEpoch + monotonicallyIncreasingSeq`。
- 一次按键生命周期固定使用同一 transport；切换前先完成有 ack 的 reset barrier。
- keyup/reset 失败时保留 pending reset；下一个 keydown 前必须先完成 reset。
- Host 对 epoch/seq 去重、拒绝旧 epoch，并回传已应用状态摘要。

### K-04 虚拟快捷键绕过 `_pressedKeys`，不是原子组合

**证据**

- `web-client/js/input.js:630-670` 的 `sendKey()` 直接发 modifier down、main down，再用两个 30ms timer 发 main up、modifier up。
- 这些虚拟按键不进入 `_pressedKeys`，timer 也没有生命周期所有者、取消或失败处理。
- modifier down 与 main down 在同一个 JS turn 立即发送，和需求文档“每步约 20ms”也不一致。
- 释放 modifier 时按原插入顺序，而不是按按下顺序逆序。
- 纯状态复现：调用虚拟 Command+C 后立即触发 window blur，blur 当时只看到两个 keydown；因为 `_pressedKeys.size=0`，没有发送 keyboard reset。两个 keyup 只能寄希望于页面上的 timer 继续运行。

**影响**

- blur、页面关闭、模式切换、transport 切换或 timer throttling 可以把组合键截断在任意一步。
- 截屏的 Command+Shift+A 可能在 modifier 只释放一部分时留下错误状态。
- 四步可能跨 DataChannel/Socket.IO，不能称为一个组合键事务。

**根因置信度：确定。**

**整改方向**

虚拟组合键必须进入同一个键盘控制器。优先发送单个 `keyboard/batch` 消息，由 Host 在同一锁内按完整步骤执行；至少也要让四步共享 transport、batch id、pending 状态和 reset。

### K-05 左右同类修饰键共用一个 flag，释放一侧会错误清除另一侧

**证据**

- `python-host/input_handler.py:635-644` 把左右 Command/Shift/Alt/Control 映射到四个共享 bit。
- `python-host/input_handler.py:767-791` 任意一侧 keyup 都执行 `_modifier_flags &= ~modifier_flag`，没有检查另一侧 code 是否仍在 `_pressed_modifier_key_codes`。
- 纯状态复现：ShiftLeft down -> ShiftRight down -> ShiftLeft up 后，`pressed_modifier_key_codes=[60]`，但 `_modifier_flags=0`。

**影响**

用户仍按着右 Shift/Ctrl/Alt/Command 时，后续主键会丢失该修饰状态。左右修饰键交替使用、远程开发快捷键和辅助功能操作会出现偶发失效。

**根因置信度：确定。**

**整改方向**

pressed code set 才是唯一真相；每次事件后从仍按下的 modifier code 集合重新计算 flags，不能对共享 bit 做单边减法。

### K-06 Host watchdog 使用全局最后事件时间，某个普通键可在持续输入时永不释放

**证据**

- `python-host/input_handler.py:776-801` 每个任意键 down/up 都覆盖 `_last_key_event_time`。
- `python-host/input_handler.py:816-821` 只在“所有键盘事件都静默 8 秒”时调用 `release_all_keys()`。
- Host 没有每个 pressed code 的 `pressedAt/lastSeenAt`。
- 纯状态复现：`W down` 的 up 丢失，7 秒后正常输入并释放 `A`，到 W 已按下 9.1 秒时 `_pressed_key_codes` 仍含 W，因为全局 age 只有 2.1 秒。

**影响**

如果 Viewer 已先删除 W 的本地状态而 up/reset 丢失，用户继续输入会不断刷新 Host 全局时间，W 可以一直保持按下，直到 blur、断线、最后 Viewer 离线或人工 reset。

**根因置信度：确定。**

**整改方向**

Host 记录每个 key code 的状态和时间。更合理的长期方案不是随意超时合法长按，而是由“唯一控制者 lease + Viewer heartbeat + transport teardown”决定全量释放；per-key watchdog 只作为最后保险。

### K-07 fresh tunnel 模式没有建立唯一控制者，多个 Viewer 可共同污染 Host 键盘状态

**证据**

- `web-client/js/webrtc.js:386-405` 在 tunnel 模式不创建 PeerConnection/offer；`1077-1102` 直接激活输入。
- `python-host/host.py:1274-1315` 只在处理 offer 时建立 `current_viewer_id`。
- `python-host/host.py:1133-1140` 只有当 `current_viewer_id` 已存在时才拒绝其他 Viewer；fresh tunnel 时它为 `None`。
- `signal-server/websocket/signaling.js:171-195` 会把每个已认证 Viewer 的输入都转发给 Host，没有 control lease。
- `python-host/host.py:1748-1760` 只有 `onlineCount==0` 才释放按键；tunnel 下某 Viewer 持键后离线、另一个 Viewer 仍在线时不会立即释放。

**影响**

- 两个 tunnel Viewer 可以交错写入同一个 Host pressed-state。
- A Viewer 的 keydown 可以被 B Viewer 的 keyup/reset 改写。
- A 断线后如果 B 仍在输入，K-06 的全局 watchdog 还可能持续被推迟。

直接 WebRTC 模式已有 current-viewer 过滤，因此问题主要集中在 fresh tunnel 和未建立 offer 所有权的窗口。

**根因置信度：高。**

**整改方向**

Signal Server 建立显式 desktop-control lease，direct 和 tunnel 都必须先 acquire；每个输入携带 lease epoch。Host 按 Viewer/lease 分区 pressed state，控制者丢失时只释放该 lease 的状态。

## 5. P2 问题

### K-08 Host 的连接 reset 在 `_input_lock` 外执行

正常输入在 `python-host/input_handler.py:277-340` 持有 async lock，并在线程池里修改 pressed sets；WebRTC state callback 和 viewer-status callback 在 `python-host/host.py:1384-1386`、`1752-1754` 直接调用同步 `release_all_keys()`，没有经过同一 lock/executor。

teardown 与正在执行的 keydown 可以交错为“reset 先发 keyup，线程随后再发 keydown”，最终留下 Host 按下状态。窗口较窄，但这是状态一致性竞态。所有 apply/reset 必须经过同一串行 interface。

### K-09 Option/Dead/AltGraph 组合与“任意键”声明不符

`web-client/js/input.js:197-206` 直接忽略 `Dead`、`AltGraph` 和 composition。macOS Option+E、Option+U 等本地事件常表现为 Dead key，因此即使 `code=KeyE/KeyU` 可用于远端物理快捷键，也不会发送。

这使需求文档“Command/Control/Shift/Alt + 任意键”不成立。应明确区分：

- 物理快捷键模式：以 `code` 为准，可发送 Dead key 对应的物理键。
- 文本/IME 模式：使用单独的文本输入 interface，不把 composition 强行伪装成物理 keydown/up。

### K-10 国际键盘和小键盘映射曾存在确定缺口

Task7 与后续 P1 已修复以下扩展键映射和物理码拒绝行为：

| Browser code | 当前 macOS code | macOS SDK 常量 | 结论 |
|---|---:|---:|---|
| `NumpadEnter` | 76 | 76 (`kVK_ANSI_KeypadEnter`) | Task7 已修复为独立小键盘 Enter |
| `IntlBackslash` | 10 | 10 (`kVK_ISO_Section`) | Task7 已修复 ISO 物理键 |
| `NumpadComma` | 95 | 95 (`kVK_JIS_KeypadComma`) | Task7 已修复 JIS 小键盘逗号 |
| `IntlYen` | 93 | 93 | Task7 已加入 JIS 映射 |
| `IntlRo` | 94 | 94 (`kVK_JIS_Underscore`) | Task7 已加入 JIS 映射 |
| `Lang2` / Eisu | 102 | 102 | Task7 已加入 JIS 映射 |
| `Lang1` / Kana | 104 | 104 | Task7 已加入 JIS 映射 |
| `ContextMenu` | 拒绝 | 无直接等价 | P1 返回 `unsupported-code`，不投递 Quartz 事件 |

SDK 证据来自本机 CommandLineTools 的 `HIToolbox.framework/Headers/Events.h`。这些映射已由适配器测试覆盖；真实 macOS 运行验收仍是独立工作项。

### K-11 modifier 自身事件携带自身 flag，违反现有契约

- 需求文档 `docs/需求文档/WebRemoteDesktop-需求文档.md:97` 规定 modifier 自己的 down/up 不携带自身 flag。
- 物理键路径在 `web-client/js/input.js:91-126` 发送浏览器原始 modifiers，所以 Shift down 自带 `shift=1`。
- Host 在 `python-host/input_handler.py:767-783` 又把该 flag 写到 modifier 自身的 Quartz keydown。
- 虚拟按钮路径反而发送空 modifiers，形成两种语义。

代码与文档确定冲突；Quartz 上的具体副作用仍需真实运行测试确认。应统一契约并由 Host pressed set 计算主键 flags。

### K-12 8 秒 watchdog 会误释放合法长按

Viewer 和 Host 都使用 8 秒阈值。普通键 auto-repeat 会刷新 Viewer pressedAt，但 modifier 不允许 repeat；用户合法按住 Command/Shift 超过 8 秒会被 Viewer 主动 keyup/reset。Host 在完全静默 8 秒时也会释放所有键。

安全恢复不能只依赖“按住多久”。建议改成控制 lease heartbeat：Viewer/transport 仍健康时允许长按，lease 失效时立即 reset。

### K-13 Host 启动修改全局 Press-and-Hold 和输入源，但停止时不恢复

`python-host/input_handler.py:55-88` 在 Host 启动时：

1. 写全局 `ApplePressAndHoldEnabled=false`。
2. 把系统输入源切到 ABC。

这些是整台 Mac 的可见全局副作用；`stop()` 没有保存/恢复原值。之后用户或远程按钮又可切换输入源，映射正确性依赖一个控制器外部的可变全局状态。

应把输入源策略变成显式、可观测、可恢复的 adapter，或者至少保存启动前状态并在 Host 退出时恢复。不能把“强制 ABC 成功”当作键盘模块的隐含前置条件。

### K-01 至 K-13 整改证据矩阵（2026-07-19）

下表将已提交代码、自动化测试和真实运行验收分开记录。`未执行（Task12）` 不等于问题已经关闭；在 Task12 取得浏览器和真实 Quartz 证据前，需求文档不得使用“完整验收完成”的表述。

2026-07-20：本地服务已通过受控重启加载当前工作树，健康检查和 Host 在线状态均通过。普通浏览器已产生 Host 对 v2 key/reset 的脱敏接收/执行摘要，并在接管中拒绝旧控制者输入；但完整的双 Viewer 最终状态快照、tunnel、实体硬件和保留快捷键矩阵仍未形成可复核记录。K-01 至 K-13 继续保持“代码完成/运行未验收”；自动化汇总和待执行案例见 [运行时验收记录](2026-07-19-remote-keyboard-runtime-acceptance.md)。

| 编号 | 当前整改代码/提交 | 自动化测试证据 | 真实运行验收 |
|---|---|---|---|
| K-01 | `64744ae` Windows modifier 归一化 | `web-client/js/remote-keyboard-controller.test.js` 的 Windows Ctrl/Meta 矩阵 | 未执行（Task12） |
| K-02 | `67e2729` 统一 tracked key 状态 | `web-client/js/remote-keyboard-controller.test.js` 的 modal/keyup 路径 | 未执行（Task12） |
| K-03 | `dc650a9`、`b83788f` v2 seq/ack/reset barrier；本次 legacy transport reset 兼容补充 | `web-client/js/keyboard-transport.test.js`；`python-host/test_remote_keyboard_state.py::test_legacy_adapter_resets_before_the_first_event_on_a_new_transport` | 未执行（Task12） |
| K-04 | `67e2729` controller batch | `web-client/js/remote-keyboard-controller.test.js` 的 batch/blur 状态用例 | 未执行（Task12） |
| K-05 | `2260bb0`、`e8d091f` 从 pressed codes 推导 modifier flags | `python-host/test_remote_keyboard_state.py::test_sided_modifier_mask_comes_only_from_pressed_physical_codes` | 未执行（Task12） |
| K-06 | lease/reset 已替代全局事件时间作为主要释放路径；per-key watchdog 真实行为仍需核验 | `python-host/test_remote_keyboard_state.py` 的 reset/transition 状态用例 | 未执行（Task12） |
| K-07 | `ad5127f`、`c277049` desktop lease；本次补充 Host/Viewer capability、legacy 单 controller 和 `legacy-takeover` reset | `signal-server/websocket/signaling.test.js` 的 legacy lazy acquire、旧 Host 拒绝 v2、single-writer/takeover 用例 | 未执行（Task12） |
| K-08 | `7e04e76` Host 串行 control transition | `python-host/test_offer_epoch.py` 的 transition/reset serialization 用例 | 未执行（Task12） |
| K-09 | v2 `key` 与 `text` 分流已定义；Dead/AltGraph 的真实输入语义仍未关闭 | `web-client/js/remote-keyboard-controller.test.js` 与 `python-host/test_remote_keyboard_state.py` 的 text 合约用例 | 未执行（Task12） |
| K-10 | `f33ade2` Quartz adapter；当前映射含 ISO/JIS/Numpad 扩展 | `python-host/test_quartz_keyboard_adapter.py` 映射矩阵 | 未执行（Task12） |
| K-11 | `64744ae` / `e8d091f` modifier 自身 flags 由 pressed set 派生 | `web-client/js/remote-keyboard-controller.test.js`、`python-host/test_remote_keyboard_state.py` | 未执行（Task12） |
| K-12 | `b83788f` reset timeout 后要求重新 acquire；合法长按的真实行为仍未关闭 | `web-client/js/keyboard-transport.test.js` 的 reset timeout 用例 | 未执行（Task12） |
| K-13 | `f33ade2` Quartz adapter 不再在启动时修改输入源 | `python-host/test_quartz_keyboard_adapter.py::test_no_startup_input_method_side_effects_remain` | 未执行（Task12） |

## 6. P3 与文档/测试问题

### K-14 需求中的固定 20ms 间隔与当前实现冲突，且不宜直接恢复

需求文档要求每个键盘事件间隔约 20ms。当前 Host 只保证串行，没有统一 sleep；`python-host/test_input_handler.py:206-224` 还明确验证不在锁内 sleep。虚拟组合键只有后两步各等待 30ms，前两步无等待。

这是文档和实现不一致，但不建议全局强加 20ms，因为它会把快速输入和组合键延迟线性放大。正确约束应是“严格有序、同一 batch 原子执行”；只有真实 Quartz 验收证明特定步骤需要最小间隔时，才在 Host batch adapter 内增加小而可配置的间隔。

### K-15 诊断与测试没有覆盖键盘状态机的核心不变量

现有 focused 测试通过，但缺少：

- Mac/Windows 左右 modifier 映射矩阵。
- modifier 自身 payload flags。
- keydown 后 target 变 modal/input/composition 的 keyup。
- 左右同类 modifier 同时按住再释放一侧。
- keyup/reset transport 失败和重连前 reset barrier。
- down/up 分别走 DataChannel/Socket.IO 的乱序。
- 虚拟组合键中途 blur/hidden/disconnect/timer throttling。
- 单键丢失 keyup 后持续输入超过 8 秒。
- 合法长按超过 8 秒。
- fresh tunnel 双 Viewer 控制权和其中一方断线。
- ISO/JIS/Numpad 映射矩阵。
- CapsLock 初始状态、F1-F12 系统功能键偏好、Dead key、远端中文输入法。

诊断 snapshot 只有 pressed count、最后 reset reason 和有限事件列表，没有 controller epoch、最后 seq、pending reset、每个 transport 的最后已应用 seq 或 Host pressed-state 摘要，难以定位“down 到了、up 到底丢在哪一层”。

## 7. 推荐完整方案

### 7.1 Viewer：建立深模块 `RemoteKeyboardController`

推荐 interface：

```text
handleDomEvent(event)
invokeShortcut(command)
transition(lifecycleEvent)
snapshot()
```

模块内部统一负责：

- Mac/Windows 归一化。
- pressed key set 和左右 modifier 集合。
- repeat、keyup 优先释放、IME/Dead 分流。
- physical key 与 virtual shortcut 的同一状态机。
- controller epoch、sequence、batch、pending reset。
- 生命周期 reset 与诊断 snapshot。

调用者不再直接拼 keyboard payload、setTimeout 或操作 `_pressedKeys`。删除这个模块后复杂度会重新散落到 DOM listener、按钮、WebRTC 和诊断，因此这个 seam 有真实深度和 locality。

### 7.2 Transport：一次按键生命周期只选择一个 adapter

DataChannel 和 Socket.IO 是两个真实 adapter。统一 interface 至少返回：

```text
accepted
transport
epoch
seq
```

规则：

1. pressed set 非空时不切 transport。
2. 必须切换时，先在旧/新链路完成 reset barrier。
3. 无法确认 reset 时，禁止接受新的 keydown并显示输入恢复中。
4. ack 不只做延迟统计，还提交 `lastAppliedSeq`。
5. Host 对旧 epoch、重复 seq 和非控制者 lease 的输入幂等拒绝。

### 7.3 Host：建立 `RemoteKeyboardState` 并把 Quartz 作为 adapter

Host pressed-state 应保存：

```text
leaseId
epoch
lastAppliedSeq
pressedByCode: Map<code, {pressedAt, lastSeenAt}>
pressedModifierCodes: Set<code>
```

所有 apply/reset/disconnect 都通过同一个 async interface 和同一执行队列。flags 每次从 modifier code set 派生；release left 不会清除仍按下的 right。`release_all_keys()` 同时清理 `_last_key_flags` 等全部派生状态。

虚拟组合键使用一个 batch，在同一 Host lock 内完成。Quartz adapter 只负责把已验证的 mac key code、down/up 和派生 flags 投递到系统。

### 7.4 Signal：显式 desktop control lease

- Viewer 连接不等于获得控制权。
- direct、relay、tunnel 使用同一 acquire/release 协议。
- 同一时间只有一个 desktop controller；其他 Viewer 只读或明确申请接管。
- disconnect、takeover、lease heartbeat 超时必须向 Host 发带 lease id 的 reset。
- Host 不再用“onlineCount 是否为 0”推断哪个控制者需要释放。

### 7.5 映射和文本输入分离

- 物理快捷键：以 `KeyboardEvent.code` 为真相，覆盖 ANSI/ISO/JIS 明确映射。
- 文本输入：如确实需要跨本地布局/IME输入 Unicode，设计独立 text interface，不能靠猜测 `key` 与 `code`。
- 浏览器无法捕获的系统快捷键继续列为限制；可评估全屏 Keyboard Lock，但不能承诺 Cmd+Tab、Ctrl+Alt+Delete 等 OS 保留组合。
- Host 输入源切换必须显式、可见、可恢复，不在启动时永久改变用户全局配置。

## 8. 整改优先级与验收门槛

本节是建议顺序，不是已经确认的实施计划；正式进入开发前仍需按仓库规则确认 Plan 路径。

| 批次 | 内容 | 完成门槛 |
|---|---|---|
| K-A | 修 Windows payload、tracked keyup 优先释放、modifier 自身语义 | 新增 DOM/state tests；Windows Ctrl+C/V 与 modal keyup 通过 |
| K-B | Viewer controller、pending reset、transport epoch/seq、虚拟 batch | 任意 teardown 后 Host state 归零；跨 transport 不乱序 |
| K-C | Host per-code 状态、左右 modifier、锁内 reset、lease | 随机状态序列测试保持 flags=derived(pressed modifiers) |
| K-D | Signal control lease、fresh tunnel 多 Viewer | 非控制者输入被拒；控制者断线立即 reset，不依赖 onlineCount=0 |
| K-E | ANSI/ISO/JIS/Numpad、输入源策略 | 自动映射矩阵 + 真实键盘抽样通过 |
| K-F | 真实浏览器/真实 macOS Quartz 验收 | 组合键、长按、blur、断线、IME、功能键形成可复核证据 |

最低状态机不变量：

1. 任意可达事件序列后，`reset(lease)` 必须让 Host pressed keys 和 flags 都归零。
2. flags 永远等于当前 pressed modifier codes 的派生值。
3. 一个 Viewer/旧 epoch 不能释放或修改另一个 controller 的状态。
4. 未 ack 的 reset 会阻止后续 keydown，不能被静默遗忘。
5. 同一 batch 的 seq 严格递增，只执行一次。
6. keyup 只要匹配已 tracked code，就不受当前 DOM target/IME ignore 规则影响。

## 9. 验证证据

### 9.1 自动化

```text
node --test web-client/js/input.test.js web-client/js/webrtc.test.js signal-server/websocket/signaling.test.js
63 passed, 0 failed

python3 -m pytest python-host/test_input_handler.py python-host/test_offer_epoch.py -q
17 passed
```

### 9.2 纯状态复现

```text
WINDOWS_PAYLOADS:
MetaLeft down modifiers={ctrl:1, meta:0}
KeyC down     modifiers={ctrl:1, meta:0}

MODAL_KEYUP_RESULT:
pressed=1, actions=[keydown]

VIRTUAL_BLUR_IMMEDIATE:
[keydown, keydown]

DUAL_SHIFT_STATE:
pressed=[ShiftRight], flags=0

CONTINUED_INPUT_STALE_STATE:
pressed=[KeyW], W age=9.1s, global last-event age=2.1s
```

模拟替换了 WebRTC/Socket/Quartz 副作用，只检查现有状态转换，没有作用到本机桌面。

## 10. 最终判断

现有设计不是完全错误：它已经有可靠 DataChannel、物理 code 映射、双端 pressed state、生命周期 reset、Host 串行执行和基础 stale-viewer 过滤。问题在于这些机制分别存在于多个浅接口中，调用者需要同时理解 DOM target、keyboard mode、pressed map、transport fallback、timer、Host flags、viewer ownership 和 Quartz 时序，模块 depth 不足。

因此不应继续在各处追加单点 `releaseAllKeys()`。合理方案是把 Viewer 键盘生命周期、transport 提交语义、Host pressed-state 和 controller lease 分别收敛到清晰 seam，再用 epoch/seq/reset barrier 把三份状态真相闭环。完成 K-A 只能修复最明显功能错误；完成 K-A 到 K-D 后，才可以把“组合键和卡键恢复”视为工程闭环；ANSI/ISO/JIS 与真实 Quartz 验收完成后，才可以恢复“完整键盘映射已完成”的产品口径。
