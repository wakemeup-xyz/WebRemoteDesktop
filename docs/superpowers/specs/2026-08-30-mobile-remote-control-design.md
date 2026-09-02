# 移动端远程桌面操控设计

**状态：** 设计完成，待实施

**日期：** 2026-08-30

**范围：** 在普通手机和平板浏览器中完成远程屏幕点击、拖动、滚动、右键和文本/虚拟键盘输入。

**核心决策：** 移动端是 Viewer 的输入适配层，不是第二套客户端、第二套信令协议或第二个控制权模型。

**入口决策：** 手机、Pad 与桌面 Viewer 共用正式入口 `https://link.stockhub.wiki`，移动端不引入独立域名、端口、认证或信令入口。本机调试使用 `http://127.0.0.1:8080`；`*.trycloudflare.com` 只作为 safe quick tunnel 的临时排障地址，来源为 `/tmp/wrd-safe-current-url.txt`，不得作为长期分享地址或替代固定域名。

## 1. 背景与现状事实

本仓库已有完整的桌面输入基础，不应重复实现：

| 现有能力 | 当前真相位置 | 对移动端的影响 |
|---|---|---|
| 相对坐标和 contain/cover/fill 映射 | `web-client/js/input-geometry.js` | 触控坐标必须复用该公式 |
| Pointer Events、capture、button reset | `web-client/js/input.js` | 移动触控扩展到同一 mouse envelope |
| 键盘 pressed truth、组合键、Unicode text | `web-client/js/remote-keyboard-controller.js` | 软键盘文本接入 `sendText()` |
| DataChannel / Socket.IO 选择、seq、ACK、reset barrier | `web-client/js/keyboard-transport.js` | 移动端不绕过可靠传输 |
| lease、接管、过期、Host reset | `signal-server/lib/desktop-control-lease.js`、`signal-server/websocket/signaling.js` | 移动端只在 ACTIVE lease 下写入 |
| Host Quartz 物理键与 Unicode 注入 | `python-host/remote_keyboard_state.py`、`python-host/quartz_keyboard_adapter.py` | 不增加移动专用 Host API |
| 移动端 Dock、safe-area、dvh、44px 触控尺寸 | `web-client/css/viewer.css`、`web-client/js/chrome-layout.js` | 新控件必须纳入既有 chrome/capability seam |

现有输入约束继续有效：点击、释放、滚轮和键盘属于不可静默丢失的控制事件；高频 move 可以合并或丢弃；输入日志不记录原始文本、按键或坐标。

## 2. 目标与非目标

### 2.1 目标

1. 手机和平板用单指点击、双击、拖动操作远程 macOS 桌面。
2. 支持双指滚动、显式右键和约定的长按右键。
3. 软键盘可以输入英文、中文、日文、Emoji 和其他 Unicode 文本。
4. 提供可用的移动虚拟按键栏：Esc、Tab、Enter、Backspace、方向键、修饰键和常用组合键。
5. 触控、软键盘、虚拟按键和桌面实体键盘经过同一个 lease、transport、ACK、reset 生命周期。
6. 软键盘弹出、横竖屏变化、浏览器地址栏变化和全屏切换时，远程画面与控件不相互遮挡。
7. 在 Android Chrome、iOS Safari、iPad Safari 和桌面鼠标/实体键盘上都有自动化与真实浏览器验收路径。

### 2.2 非目标

- 不开发原生 iOS/Android 客户端，不引入 Capacitor、React Native 或 PWA 推送能力。
- 不改变 WebRTC 媒体、ICE、TURN、Cloudflare tunnel 或 Terminal 协议。
- 不允许移动端绕过 Viewer 认证、`DesktopControlLease` 或 Host 输入校验。
- 不把手机触控模拟成 Host 端触摸屏；Host 继续接收 Quartz mouse/key/text 事件。
- 不承诺捕获浏览器或操作系统保留的快捷键；无法由普通网页捕获的按键必须在验收中明确记录。
- 不在第一版实现三指手势、缩放远程桌面、自由旋转、虚拟鼠标指针或剪贴板双向同步。

## 3. 主流方案调研与采用结论

### 3.1 浏览器标准

- W3C Pointer Events 规定触摸、鼠标和笔使用同一事件模型；`setPointerCapture()` 保证拖动离开元素后仍能收到事件；`pointercancel` 和 `lostpointercapture` 必须进入释放路径。
- W3C/MDN 明确指出页面平移和缩放由 `touch-action` 声明，不能只依赖事件监听器中的 `preventDefault()`。
- `KeyboardEvent.code` 是物理键位，`keyCode` 是实现相关数值，不能把后者直接当作 macOS Quartz key code。
- `beforeinput` 并非所有 IME、自动纠错或浏览器操作都可取消；必须同时处理 `input` 和 composition 生命周期。
- Virtual Keyboard API 仅作为增强能力；通过 `navigator.virtualKeyboard` 和 `geometrychange` 调整布局时必须保留 `visualViewport`/resize fallback。
- `RTCDataChannel.ordered`、`reliable`、`bufferedAmount` 和 `bufferedamountlow` 应被用于可靠控制事件和高频移动事件的区别与背压。

### 3.2 成熟远程桌面实现

| 实现 | 采用原则 | 本项目如何使用 |
|---|---|---|
| noVNC | 专用输入框、input diff、`_keyDownList`、失焦全量释放、移动端虚拟键盘按钮 | 采用输入框和 composition 兼容策略，不复制 RFB keysym |
| Apache Guacamole | pressed map、幂等 press/release、reset、触摸与鼠标事件去重 | 采用 pressed/reset 和触摸后兼容鼠标抑制原则 |
| RFB | down/up 分离，repeat 只发送 down，释放是正确性要求 | 与本仓库 v2 key envelope 一致 |
| FreeRDP/RustDesk | 物理 scancode 与 Unicode 分流、左右修饰键独立、焦点同步 | 复用 `code + location` 和 `keyboard/text` 两条路径 |

调研后的结论是：移动端不能单独依赖 `keydown/keyup`，但也不应把所有输入降级为字符猜测。物理键、提交文本、手势鼠标和安全 reset 必须通过不同的内部接口汇合到同一控制传输。

## 4. 总体架构与 seam

```text
Touch / Pointer Events
        |
        v
  TouchInputAdapter ----> InputGeometry ----> Input.sendInput(mouse)

Soft keyboard / IME
        |
        v
 MobileTextInputAdapter -> RemoteKeyboardController.sendText()

Virtual keys / shortcuts
        |
        v
 RemoteKeyboardController.sendChord()/handleDomEvent()
        |
        v
 KeyboardTransport -> DataChannel or Socket.IO -> Signal lease -> Host Quartz
```

### 4.1 `TouchInputAdapter`

新增 `web-client/js/touch-input-adapter.js`，只负责把 Pointer Events 解释为已存在的 mouse actions。

外部 interface：

```javascript
const adapter = TouchInputAdapter.create({
  element,
  mapPoint: (event, allowOutside) => Input.getRelativeCoords(event, allowOutside),
  sendMouse: (action, payload) => Input.sendInput('mouse', action, payload),
  isEnabled: () => Input.isActive,
  getClickCount: (event) => Input.getPointerClickCount({
    // Touch PointerEvent.up commonly exposes button=-1; normalize it to the
    // primary button used by the existing desktop double-click policy.
    button: 0,
    timeStamp: event.timeStamp,
    clientX: event.clientX,
    clientY: event.clientY,
  }),
  clock: () => performance.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (id) => clearTimeout(id),
});

adapter.bind();
adapter.reset('visibility-hidden');
adapter.unbind();
adapter.clickButton('right');
adapter.getSnapshot();
```

`Input` 仍是编排者和发送入口；适配器不维护 lease、不直接访问 WebRTC、不调用 Quartz，也不复制 `InputGeometry`。

`clickButton(button, coords?)` 是给显式右键按钮使用的同一安全 seam；未传坐标时使用
最近一次触控坐标，发送配对的 `down/up`，任一步失败都触发 `mouse/reset` 并保留
pending reset。适配器发出的 payload 只有既有 mouse envelope 所需字段：`down/up` 使用
`{relX, relY, button, clickCount, buttons}`，`move` 使用
`{relX, relY, buttons}`，`wheel` 使用
`{relX, relY, deltaX, deltaY}`，`reset` 使用脱敏 `reason`。`Input.sendInput()`
负责补充 schema、lease、seq 和 input id；适配器不自行生成这些字段。

鼠标 envelope 不进入 `KeyboardTransport` 的 keyboard pending map。`Input.sendInput()`
返回 input id 后由既有 `LatencyMonitor` 追踪 mouse ACK RTT；只有
`keyboard/key|text|batch|reset` 才更新 `RemoteKeyboardController` 的 pressed/pending
状态。这样 `input-move` 丢弃中间点不会污染键盘 reset barrier。

### 4.2 `MobileTextInputAdapter`

新增 `web-client/js/mobile-text-input.js`，只负责移动软键盘的 DOM 事件和文本变化 diff。

外部 interface：

```javascript
const adapter = MobileTextInput.create({
  element: textarea,
  sendText: (text) => Input.keyboardController.sendText(text),
  sendKey: (code) => Input.keyboardController.sendChord({ code }),
  isEnabled: () => Input.isActive && WebRTC.hasActiveControl(),
});

adapter.attach();
adapter.show();
adapter.hide();
adapter.reset('control-revoked');
adapter.detach();
adapter.getSnapshot();
```

适配器内部保存 `lastValue`、composition 状态、光标位置和最近一次提交结果；外部只看到文本提交、Backspace 和状态摘要。

### 4.3 UI seam

`input.js` 负责绑定既有桌面事件和两个 adapter；`chrome-layout.js`/`ui.js` 负责 capability 和显示状态；`webrtc.js` 继续是媒体、连接和 lease 真相源。移动 UI 不写第二份 `isActive`、`leaseId` 或 pressed state。

## 5. 触控交互契约

### 5.1 状态

```text
IDLE
  -> PRESSED (首个 primary touch)
  -> DRAGGING (超过移动阈值)
  -> TAP_COMMITTED (pointerup)
  -> IDLE

PRESSED/DRAGGING + 第二个触点
  -> SCROLLING
  -> IDLE

任意状态 + pointercancel/lostcapture/blur/hidden/disconnect
  -> RESETTING -> IDLE
```

### 5.2 单指

- `pointerdown`：只接受 `pointerType === 'touch'` 的 primary pointer；记录 `pointerId`、起点、最近坐标、时间和映射后的坐标；调用 pointer capture。此时不立即发送远程 down，等待长按/拖动判定。
- 移动距离超过 **8 CSS px**：取消 tap/长按计时，发送一次 left `down`，进入 `DRAGGING`；后续 move 使用现有 rAF 合并和 `input-move` DataChannel。
- `pointerup` 且未拖动：发送 left `down` + `up`，复用现有 500ms/6px 双击判定和 `clickCount`；随后退出到 `IDLE`。
- `pointerup` 且已拖动：发送 left `up`，释放 capture。
- `pointercancel`、`lostpointercapture`、窗口 blur、document hidden、连接/控制失效：发送幂等 `mouse/reset`，本地状态归零。

### 5.3 长按与右键

第一版产品语义固定为：**单指按住 550ms 且移动不超过 8 CSS px，发送一次 right `down`；释放发送 right `up`。**

- 长按触发后不再发送 left down。
- 触发右键后移动进入 right drag；若应用只需要上下文菜单，通常在 up 时结束。
- 浏览器 `contextmenu` 必须阻止，避免本地菜单覆盖远程画面。
- UI 同时提供显式“右键”按钮，用于不方便长按的用户和可访问性场景。

### 5.4 双指滚动

- 第二个 touch pointer 出现时，如果正在 `PRESSED` 或 `DRAGGING`，先发送一次 `mouse/reset`，不让远程留下左键或右键。
- 进入 `SCROLLING` 后只跟踪两指质心，按每帧质心位移发送 wheel；不发送 mouse move/down/up。
- 滚动事件沿用当前 Host 的 `deltaX/deltaY` 单位和归一化：浏览器正 `deltaY` 表示向下，Host 转换为 Quartz 负 axis1。
- 两指结束后回到 `IDLE`；第三指不改变状态，也不触发远程按钮。

### 5.5 非触摸指针兼容

桌面鼠标和笔继续走现有 `Input.bindMouseEvents()`。新增适配器不得重复监听会产生兼容 mouse events 的触摸序列；`touch-action: none` 与 `pointerdown.preventDefault()` 共同抑制页面手势和重复 click。

## 6. 移动软键盘与文本契约

### 6.1 DOM 输入元素

Viewer 页面增加专用 textarea，要求：

```html
<textarea id="mobileTextInput"
  inputmode="text"
  autocomplete="off"
  autocapitalize="off"
  spellcheck="false"
  enterkeyhint="done"
  aria-label="远程文本输入"></textarea>
```

它可以视觉隐藏但不能使用 `display:none`，否则 iOS/Android 不会弹出键盘。默认采用 1px、透明、无边框的可聚焦样式；打开移动输入模式时显示清晰的焦点/输入状态，并用底部面板承载可提交文本。

### 6.2 事件处理

1. `compositionstart`：设置 `composing=true`，保存 `compositionBaseValue=lastValue`，不发送临时组合字符串。
2. `compositionupdate`：只更新 `observedValue`，不调用 Host；组合期间的 `input` 同样只更新 `observedValue`。
3. `compositionend`：读取稳定 value，执行一次 `flushDiff(value)`，清除 composing 状态，并把 `lastValue` 更新为该 value。
4. `beforeinput`：在 `insertText`、`insertCompositionText`、`deleteContentBackward` 等类型可取消时记录意图，但不把它当作唯一来源。
5. 非组合态 `input`：执行 `flushDiff(value)`；若浏览器在 `compositionend` 后重复派发同值 `input`，因 `lastValue` 已更新而成为 no-op，不能重复发送。
6. `keydown/keyup`：若来自专用 textarea，只处理明确的非文本控制键（Escape、Enter、Backspace、Arrow）；不把 `keyCode` 转成 Quartz code。

`flushDiff()` 使用 `lastValue` 与当前 value 的最长公共前缀/后缀计算一次插入或删除；删除按 UTF-16 安全的 code point 数量拆成最多
`MAX_BATCH_STEPS=16` 个 Backspace，插入按 Unicode scalar 发送。这样即使浏览器省略
`beforeinput`，仍能提交一次；组合事件和后续 `input` 共享同一基线，不会重复提交。

文本提交必须满足：持有 ACTIVE lease、没有 keyboard reset barrier、没有物理 pressed key、长度不超过现有 4096 Unicode scalar 限制。失败时保留输入框内容并显示可重试状态，不静默清空。

### 6.3 软键盘布局

- 优先使用 `navigator.virtualKeyboard.overlaysContent = true` 和 `geometrychange`；不支持时使用 `visualViewport.height/offsetTop` 与 `resize`。
- CSS 使用 `env(safe-area-inset-bottom)` 和 `env(keyboard-inset-height, 0px)`；JS 只写一个 `--mobile-keyboard-bottom` 变量。
- 软键盘可见时，虚拟按键栏和提交控件必须位于键盘上方；远程画面允许缩小但不能被控制栏覆盖。
- 关闭移动输入模式时恢复原焦点；控制权撤销、连接断开和页面隐藏时隐藏 textarea 并 reset。

## 7. 虚拟按键与修饰键

移动端操作栏分为三组：

1. 导航：Esc、Tab、Enter、Backspace、上/下/左/右。
2. 修饰：Shift、Control、Alt、Command，采用 latch 状态；首次点击发送并保持真实 down，再次点击发送 up 释放。
3. 快捷操作：复制、粘贴、剪切、撤销、全选、查找、右键。

每个快捷键调用现有 `sendChord()`，作为一个 `keyboard/batch` 原子消息；不在 UI 中连续调用多个 `sendInput()`。修饰键 latch 通过新增的
`RemoteKeyboardController.setVirtualModifier(name, pressed)` 进入同一 pressed map、transport 和 reset barrier，不允许 UI 直接调用 transport。每个按钮最小触控尺寸为 44px，带 `aria-label`、`aria-pressed` 和可见 disabled 状态。

`setVirtualModifier()` 只接受逻辑名称 `shift|ctrl|alt|meta`，再按现有
keyboard mode 解析物理 code，返回布尔值；成功的
`pressed=true` 保留对应 modifier code 在 controller pressed map 中，
`pressed=false` 发送释放并移除它。未知名称、无 lease、reset barrier 或无可用
transport 均返回 `false`，UI 不改变 `aria-pressed`。

修饰键 latch 的生命周期：

- 普通文本提交前自动释放 latch，避免文本路径意外携带 Command/Control。
- 点击远程画面后保留 latch，便于“Shift + 点击”选择。
- reset、失焦、页面隐藏、控制权撤销、transport 切换和断连全部清除 latch。

## 8. 能力、权限与失败语义

移动输入能力由既有 capability snapshot 派生：

```javascript
{
  deviceClass: 'touch' | 'pointer' | 'unknown',
  touchSupported: boolean,
  virtualKeyboardSupported: boolean,
  streamReady: boolean,
  activeControl: boolean,
  transportReady: boolean,
  mobileInputMode: 'off' | 'armed' | 'visible' | 'blocked'
}
```

- 未连接、媒体未 ready、只读、GRANTING/REVOKING、reset-blocked 时，触控和虚拟键盘控件 disabled 或 hidden。
- DataChannel 不可用时沿用 Socket.IO fallback；可靠事件没有可用 transport 时不进入 pending map。
- `input_ack` 返回 `stale-lease`、`sequence-gap`、`execution-failed` 时，现有 controller 进入 reset/reacquire 语义；移动 adapter 只清本地手势和 latch。
- 任何 reset 发送失败都必须保留 `pending reset` 诊断状态，并阻止新的控制写入，直到 lease 重获或 Host transition 完成。

鼠标 reset 也有独立的本地安全屏障：`Input` 保存最近一次 reset input id，
`isEnabled` 在屏障存在时返回 `false`；`input_ack` 的 `applied/duplicate` 清除屏障，
`stale-lease/sequence-gap/execution-failed` 保持屏障并沿用现有 lease reacquire。
`WebRTC` 只需把同一 ACK 同时交给 mouse-reset 处理器和 keyboard transport，协议不变，
鼠标 ACK 不进入 keyboard pending map。

## 9. 安全、性能和隐私

- 所有 desktop writes 继续携带 `schemaVersion: 2`、`leaseId`、`leaseEpoch`、`seq`、`inputIds`。
- Signal 继续先做 Viewer 身份、控制租约和输入结构校验；Host 继续做协议、序列和 Quartz 映射校验。
- 不记录原始文本、按键 code、剪贴板、坐标或完整 envelope；诊断只记录设备类别、动作类别、transport、seq、payload bytes 和耗时。
- touch move 每帧最多发送一个最新点，超过 `input-move` 4 KiB buffer 时丢弃中间点；点击、释放、wheel、键盘和 reset 不得因背压静默丢失。
- 文本提交一次最多 4096 scalar；单次 DOM diff 和 Backspace batch 不超过现有 `MAX_BATCH_STEPS=16`。
- 适配器不保留页面生命周期之外的输入内容；`reset()` 必须清空 value、composition、pointer、latch 和 pending intent。

## 10. 测试与验收

### 10.1 自动化

- `web-client/js/touch-input-adapter.test.js`：tap、double tap、drag threshold、long press right-click、two-finger wheel、pointercancel、lost capture、reset 幂等、多指隔离。
- `web-client/js/mobile-text-input.test.js`：英文、中文 composition、Emoji surrogate pair、删除、纠错替换、beforeinput 缺失、textarea 重置不丢键盘焦点、lease/transport blocked。
- `web-client/js/input.test.js`：adapter 装配只创建一个实例；桌面鼠标行为保持原有断言；touch reset 与现有 mouse reset 共用 envelope。
- `web-client/js/webrtc.test.js`：移动输入仍经 DataChannel/Socket.IO fallback、ACK 和 lease gate；高频 move 不污染 keyboard pending。
- `web-client/css/viewer-layout.test.js`：触控 CSS、safe-area、keyboard inset、44px target、移动 Dock 无重叠。
- `signal-server` 与 `python-host` 的完整既有测试必须继续通过；无需修改 Host 协议测试，除非发现与既有契约冲突。

### 10.2 真实浏览器矩阵

| 设备/浏览器 | 必测内容 |
|---|---|
| Android Chrome | 点击、长按右键、双指滚动、英文/中文/Emoji、软键盘旋转、Socket fallback |
| iPhone Safari | 点击、双击、长按、中文 composition、visualViewport、全屏/地址栏变化 |
| iPad Safari | 横竖屏、分屏尺寸、虚拟键盘、双指滚动、虚拟按键栏、外接键盘可选验证 |
| 桌面 Chrome/Safari | 原有鼠标、实体键盘、桌面布局和无 touch 退化 |

每条路径都记录：连接方式（直连/tunnel）、control lease 状态、transport、动作摘要、Host pressed count、是否出现 stuck mouse/key、输入 ACK RTT。真实设备缺失时保持“未执行”，不以 Node 测试代替。

### 10.3 产品验收门槛

1. 20 次点击中 20 次命中目标区域；双击不产生第三次 click。
2. 20 次拖动中 20 次最终释放；注入 pointercancel/断连后 Host pressed mouse count 为 0。
3. 长按右键在 20 次中 20 次产生 context menu，普通短 tap 不产生右键。
4. 中文、日文和 Emoji 文本无重复、丢失或乱码；每次提交后 Host keyboard pressed count 为 0。
5. 连接切换、页面隐藏、控制权接管和 transport 切换后，不残留 key、modifier、mouse button 或输入框 composition。
6. 375x812、768x1024、1024x1366 和 1440x900 下，远程画面与 Dock bounding boxes 无重叠；软键盘可见时控制栏仍可触达。
7. 既有桌面输入、网络模式、Terminal 和 tunnel 行为无回归。

## 11. 设计审查结论

### 主流设计符合性

符合 Pointer Events、`touch-action`、pointer capture、IME composition、Virtual Keyboard progressive enhancement 和 noVNC/Guacamole 的输入隔离原则。没有依赖已废弃的 `keyCode`，没有把手机软键盘伪装为物理键盘，也没有用固定延时掩盖事件顺序问题。

### 代码架构合理性

`TouchInputAdapter` 和 `MobileTextInputAdapter` 是两个有清晰 interface 的深模块：它们隐藏浏览器兼容、手势和 DOM diff 复杂度；`Input`、`KeyboardTransport`、`DesktopControlLease`、`RemoteKeyboardState` 继续各自拥有唯一真相。没有新增第二个 lease、第二个 transport 或 Host 专用移动协议。

本轮审查额外确认了三个深模块约束：组合输入的重复 `input` 由 adapter 内部基线消解；modifier latch 由
`RemoteKeyboardController.setVirtualModifier()` 持有，而不是由按钮维护第二份 pressed truth；显式右键通过
`TouchInputAdapter.clickButton()` 复用释放/失败屏障，而不是由 UI 拼装 envelope。鼠标 ACK 只进入
`LatencyMonitor`，不会污染 keyboard pending map。

### 交互合理性

短 tap、拖动、双指滚动和显式右键符合远程桌面用户预期；长按右键提供手机上最容易发现的上下文菜单入口，同时保留显式按钮作为可访问性和可学习性兜底。虚拟按键只保留高频控制键，避免在小屏堆叠完整桌面工具栏；软键盘使用真实系统 IME，保证中文和 Emoji 输入质量。

### 已知风险与控制措施

- iOS Safari 对后台、全屏和键盘布局的行为不完全一致：使用 visualViewport fallback，并把真实设备验收列为硬门槛。
- 浏览器可能吞掉 Command/Control 等系统快捷键：虚拟按键提供可验证替代路径，报告中区分“网页不可捕获”与“Host 执行失败”。
- 长按与双击存在时间竞争：状态机只在 550ms/8px 明确阈值下提交一次语义，并在第二触点或 cancel 时 reset。
- tunnel RTT 可能放大 wheel/keyboard 反馈：控制事件使用可靠有序传输，move 单独使用无序通道，避免高频事件阻塞控制事件。

审查结论：方案可以进入实施计划；实现完成前不能宣称移动端支持，必须通过真实 Android/iOS 浏览器和 Host Quartz 验收。

## 12. 参考资料

- [W3C Pointer Events Level 3](https://www.w3.org/TR/pointerevents3/)
- [MDN Pointer events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events)
- [MDN touch-action](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action)
- [MDN KeyboardEvent](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent)
- [MDN beforeinput](https://developer.mozilla.org/en-US/docs/Web/API/Element/beforeinput_event)
- [MDN Virtual Keyboard API](https://developer.mozilla.org/en-US/docs/Web/API/VirtualKeyboard_API)
- [MDN RTCDataChannel](https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel)
- [noVNC keyboard implementation](https://github.com/novnc/noVNC/blob/master/core/input/keyboard.js)
- [Apache Guacamole Keyboard](https://github.com/apache/guacamole-client/blob/master/guacamole-common-js/src/main/webapp/modules/Keyboard.js)
- [Apache Guacamole Mouse](https://github.com/apache/guacamole-client/blob/master/guacamole-common-js/src/main/webapp/modules/Mouse.js)
