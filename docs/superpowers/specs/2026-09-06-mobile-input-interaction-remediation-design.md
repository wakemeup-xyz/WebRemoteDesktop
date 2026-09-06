# 手机 / iPad 输入交互整改设计

日期：2026-09-06。状态：Task1–7及主审追加拖拽提示修复已提交、完成自动化并通过限定复审；主线程本人最终审查无未解决P1/P2。严格离线Chromium通过，真机/系统IME/Quartz/公网仍NOT RUN。开发分支`codex/mobile-input-interaction-remediation`，未合main、未push、未重启服务。见[当前验收](../reports/2026-09-06-mobile-input-interaction-remediation-acceptance.md)与[历史方案审查](../reports/2026-09-06-mobile-input-interaction-remediation-plan-review.md)。执行subagent使用gpt-5.6-luna/max，最终review由主线程完成。

基线：`main@000547ff37dc1a05c3b5b953954af81e9ed7d43a`。输入依据：[F1–F7 问题报告](../reports/2026-09-05-mobile-touch-keyboard-logic-review.md)、[既有移动设计](2026-08-30-mobile-remote-control-design.md)。

## 1. 目标、方案取舍

目标：使连续出画时可持续输入，手机与宽屏 iPad 的软键盘/虚拟键可用，草稿失败不静默丢失，拖拽起点正确，并让全屏保留完整操控入口。

| 方案 | 收益 / 代价 | 决策 |
|---|---|---|
| 在现有 Input、MobileTextInput、ChromeLayout 接口上修复 | 沿用租约/协议，改动集中，能逐任务回归 | 采用 |
| 另建移动控制器和独立输入队列 | 表面隔离，但复制 pressed、seq、ACK、恢复状态 | 不采用 |
| 移动文本全部改为手动整段提交 | 文本模型简单，但失去现有即时 IME 输入和导航能力 | 不作为此次默认；保留已有普通文本 modal |

本次全屏产品语义选择“完整操控”。这延续既有移动设计目标；浏览器不支持元素全屏时保留普通可操控视图，给出可见提示。

## 2. 全局约束

- 不新增移动协议、控制租约、Host API 或并行可靠传输队列；鼠标与键盘沿用各自现有 seq/ACK/reset。
- 不修改 Terminal/PTY、媒体编码、SPS、jitter、TURN、formal watcher 或 tunnel 生命周期。
- 不自动启动/停止/重启服务，不操作 cloudflared，不更换公网地址；部署、merge/push 与服务操作另按用户明确指令执行。
- 不记录或持久化用户文本、按键、坐标、剪贴板、密码、token；草稿仅保存在当前页面内存。
- 真实 Android/iPhone/iPad、系统软键盘、Quartz、公网与 live watcher 无实际证据时保持 NOT RUN；离线模拟不得替代。
- 保留既有可靠控制/安全释放规则、虚拟 modifier 的 pressed truth、输入 DOM 去重及 4096 Unicode scalar 的 Host 单条限制。

## 3. 焦点契约（F1）

`Input.setActive()` 只更新门禁及必要的停用清理，绝不修改焦点。新建 `Input.focusDesktopSurface(element, reason) -> boolean`，reason 仅取 `surface-user`、`initial-ready`、`restore`；该方法不得写 lease。

- `initial-ready` 只在该连接首次可输入且没有文本/Terminal/弹窗焦点时使用；每帧、stats、playing 不触发 focus。
- `surface-user` 是用户明确点画面后允许聚焦的路径；有 composition 或未解决草稿时先执行 §5 的外部动作门禁，禁止隐式取消输入。
- `restore` 仅在没有新的用户焦点时生效。移动键盘入口保存 `document.activeElement`；关闭时仅在当前焦点还属于本次移动输入流程且 return target 仍连接、可见、可聚焦时恢复，否则不抢焦点。
- 同步修正 video/relay click、video playing、非 touch pointerdown 以及 UI fullscreenchange 的现有直接 focus。网络/分辨率 modal 自己的 focus/returnFocus 逻辑保留，但门禁不得覆盖。
- `ChromeLayout` 的 idle 判断加入“移动文本显示/组合中/有未解决草稿”：这些状态下不自动藏起虚拟键栏；操作其按钮后保留 textarea 焦点。系统键盘真正关闭与应用 Dock 隐藏分开判断。

回归必须包含生产 `setupEventListeners()` 对 tabindex 的设置、连续 120 次帧/门禁回调、真实 DOM activeElement，以及普通 modal 和 Terminal textarea 不被抢焦点。

## 4. 文本状态与重试契约（F5）

扩展现有 `MobileTextInput`，不另建 transport。公开接口保持 attach/detach/show/hide/reset/getSnapshot，新增：

```ts
retryPending(): boolean
discardPending(): void
sendControlKey(code: string, modifiers?: {shiftKey:boolean,ctrlKey:boolean,altKey:boolean,metaKey:boolean}): boolean
runExternalAction(kind: 'navigation' | 'context-change', send: () => boolean): boolean
onTransportState(state: 'ready' | 'blocked' | 'revoked' | 'reacquire-required', options?: {resetAcknowledged?: boolean}): void
refreshDeliveryState(): void
```

config新增`isDeliverySettled: () => boolean`，Input注入现有KeyboardTransport snapshot的`state==='ready' && pendingCount===0`；adapter不另建ACK队列。Input.acceptKeyboardAck完成现有ACK处理后调用refreshDeliveryState，只更新retry UI，不发送输入。普通成功ACK不一定触发subscribeState，因此不能只订阅state来更新此门禁。reset/连接异常的contextValid=false具有更高优先级，不能用pending被清空绕过。

Input是唯一新增桥接所有者：直接订阅KeyboardTransport小写state，原样映射ready/blocked/reacquire-required至adapter；未授权由setControlLease(null)显式reset后传revoked。controller既有内部订阅保留，其大写READY只用于isEnabled，不作为第二个adapter通知源。Input持有一个unsubscribe，重复init不得增加订阅；adapter后创建时主动投递当前snapshot，拆除/重建transport先unsubscribe。controller onStateChange仍只更新UI。

内部区分 `acceptedValue`（传输接受的本地前缀，不是 Host 已应用）、`draftValue`（用户当前编辑值）、本地 cursor、composition、`generation`、`contextValid` 和未接受的 diff。`getSnapshot()` 只增加 `hasPending`、`retryable`、`deliveryUncertain` 和枚举 `status=idle|composing|pending|blocked|uncertain`；不输出文本、选区、键值或新增序号，只输出上述状态元数据。不要把界面写成“远端已输入”。

### 4.1 正常输入与失败

1. composition 期间不发送；结束后以同一个 generation 合并重复 input。
2. 每个删除 chord 或 text 只有返回 true 才推进 acceptedValue；false 时保存未接受 diff 和用户选区，不调用 restoreBuffer 覆盖草稿。
3. `beforeinput` 对草稿模式正常编辑；不能再以 `DOM value !== acceptedValue` 判断非法选区。已接受历史中的任意选区替换仍 fail-closed，但只撤销本次非法编辑，不删除待发草稿。
4. 同一明确上下文内的临时拒绝可点“重试”；只重发未接受部分。举例：`a` 已接受，`b` 被拒绝，再输入 `c`，恢复后只发送 `bc`。
5. 部分删除成功后，只保留剩余删除/插入工作。每轮最多 16 个 Backspace；全部被接受但还有剩余时用 `setTimeout(..., 0)` 继续同一事务，最多按当前 4096 长度处理。定时回调绑定 generation，reset/detach/context-change 必须取消；任意 false 立即停，等待显式重试，不轮询。
6. 每次发送前确认 enabled 与 generation。新增 DOM 编辑先保存草稿，已经在执行的删除/插入事务必须先稳定到已接受前缀，再从最新 draft 计算剩余 diff，不能并发两条事务。

### 4.2 不确定投递与生命周期

- `sendText/sendChord` 的 true 仅表示 transport 接受；不因 ACK 缺失自动重发。沿用现有 KeyboardTransport 对 barrier/ACK 的处理，本次不修订其协议语义。
- `blocked/reacquire-required` 或 accepted 消息后的连接/上下文异常使 `contextValid=false`，显示“连接或输入位置已变化，请核对远端”；保留当前页面内未解决草稿，但禁用重试，允许用户显式放弃。已有 transport 回到 ready 不自动恢复 contextValid、不自动发草稿。
- `retryPending()` 要求同一 generation、contextValid、未 composition、controller READY、isDeliverySettled()为true，且没有接受结果不明的先前操作。只有从未提交的拒绝且没有上下文/连接异常才可重试。已有接受但尚未ACK的前缀必须先收齐当前pending，期间保留并允许编辑未发草稿，不自动发送追加内容。
- 用户选择放弃后清空本地草稿、重建哨兵/游标基线，不发送文本或 Backspace；下一次明确输入建立新上下文。
- `reset(reason)` 保持现有安全含义：lease 撤销/页面隐藏/断连所触发的 reset/park 清空本地文本与定时任务，并隐藏 Dock；本轮不把敏感草稿带入新的 lease。UI 普通 hide 仅收起，保留同一上下文草稿；不可隐式重放。
- `Input.setControlLease()` 比较leaseId和leaseEpoch；任何身份变化（包括非空直接替换、撤销、重新授予）必须在controller.setLease之前调用adapter.reset('lease-changed')，递增generation、清草稿与drain并隐藏Dock。相同lease幂等调用不清草稿。不能靠transport的ready通知判断上下文连续；新lease只能由下一次用户明确show/input建立文本上下文。
- UI 同一 Dock 加 status 区和“重试 / 放弃”按钮，失败不能只在 console 里出现。按钮不是 Host ACK 确认器。

主动复位的生命周期例外：`Input.resetKeyboard()` 入口立即清旧草稿/Dock，使用现有 controller/transport 发起复位屏障。只有 Input 确认本次 owned reset 的 applied/duplicate ACK 已让现有 transport 返回 ready，才调用 `onTransportState('ready', {resetAcknowledged:true})` 建立清空后的新输入上下文；普通 ready、旧/失败 ACK、无关 blocked/reacquire 不得走此入口。该通知不发送、不再次reset，不清掉 reset 后 ACK 前新编辑的草稿；新草稿只通过显式重试发送。lease变更、park及无关上下文失效须取消旧 owned-reset 关联；park仍只清本地状态，不新增复位报文。Task4的surface不确定状态具有独立否决权，键盘owned-reset ACK不能解除鼠标目标不确定性。此关联只复用现有 ACK 处理，不新增可靠队列或wire字段。

### 4.3 Unicode 与缓存范围

DOM `maxlength` 与 Host scalar 限额分别测试，不把两者混同。新增 pending 缓冲不得超过 4096 Unicode scalar，计数使用 `Array.from`；原 DOM maxlength 仍生效，不能因新缓冲放大到无限内存。缓存不持久化，已接受历史仍以现有哨兵模式保存。复杂 grapheme 的远端 Backspace 单位与本地 code point 不一定相同，回归覆盖 ZWJ/组合附加符的保留与发送，精确远端删除效果保持设备验收项；不承诺远端文档镜像。

## 5. 统一导航和上下文门禁（F3）

新增 `Input.runMobileEditingAction(action, send) -> boolean` 作为编排接口，由 `setupActionButtons` 和画面 pointerdown 共用。`send` 是已有发送函数的回调，不允许 adapter 直接拿 WebRTC。

- 无修饰的 Backspace、Enter、Escape、ArrowUp/Down/Left/Right 从 textarea 和导航按钮均调用公开 `MobileTextInput.sendControlKey(code)`；该函数只在发送被接受后更新本地 cursor/history。
- textarea onKeydown把event的四个modifier布尔值快照传给sendControlKey(code,modifiers)，config.sendKey同步扩展为sendKey(code,modifiers)。Input转换为既有sendChord({code,modifiers:{shift:Boolean(flags.shiftKey),ctrl:Boolean(flags.ctrlKey),alt:Boolean(flags.altKey),meta:Boolean(flags.metaKey)}})的布尔对象，不传数组；controller原有pressed集合负责合并虚拟modifier。含modifier时经runExternalAction发送平衡chord，不做cursor±1；textarea内新modifier keydown不单独转发。**安全keyup例外（R9）：**config新增releaseTrackedKey(event):boolean，Input注入controller.handleDomEvent；adapter.onKeyup必须先调用它再stopPropagation，controller既有trackedKeyup只释放已跟踪code，未跟踪keyup不发送。composition/pending/unsupported/isActive=false均不得截断该释放，不重复经document listener发送。测试画面Shift/普通键down→show移动框→textarea keyup，pressed归零且恢复文本；新textarea Shift+Arrow chord后keyup无额外up。普通可打印键仍走DOM input。
- 带任意物理/虚拟 modifier 的导航不当作简单 cursor±1；与 Tab、全选、粘贴、剪切、撤销、查找、切输入法、右键和画面点击一并进入 context-change。复制/保存也采用保守 context-change，避免臆测远端焦点是否变化。
- `runExternalAction` 在 composition、有 pending 或 deliveryUncertain 时返回 false，显示解决草稿提示，不调用 send。Mouse up/reset、keyboard reset 等安全释放永远不受草稿拦截。
- 允许的动作仅执行 send 一次；true 后清理已接受历史为哨兵、cursor=0，建立新 generation。false 不推进历史，不偷删草稿；随后 transport 状态若异常按 §4.2 处理。
- document层实体键盘同样属于外部编辑入口：移动框收起后，真正被controller接受的导航、可打印键或组合键必须同步本地cursor，或保守地通过上述context-change事务失效已接受历史；不能只检查门禁后直发，使重新打开的IME沿用旧cursor。未发送的本地输入框事件、controller拒绝及单独modifier按下不误清历史；tracked keyup始终走原安全释放。测试移动输入→收起→实体导航/输入→重新打开→继续输入，远端模型与新的本地基线一致，无重复报文。
- 新touch option `beforeGesture: () => boolean` 只做首个pointerdown的只读预检，不清历史。另加`commitGesture: (send:()=>boolean)=>boolean`，默认直接调用send；adapter把每个真实首down（tap/drag/long-press）的sendMouse封在此callback中，Input用runExternalAction('context-change',send)重新核对草稿并只在down接受后提交基线失效化。接受后同一手势move/up不重复门禁；若等待long-press期间出现composition/pending，拒绝down并结束该手势。mouse/pen的实际down也用同一事务包装，up/reset始终原释放流程。two-finger从未发down的纯滚动不虚构context提交；上下文真正改变的down才清历史。
- 导航/重试按钮 pointerdown 对移动文本焦点使用 preventDefault，click 处理后如同一 textarea 仍 shown、控制有效、无 modal，再在用户手势内恢复该 textarea；composition 时禁止通过按钮强制 blur。

虚拟modifier判定接口（R12）：Input向MobileTextInput额外注入只读 `hasVirtualModifiers():boolean`，默认false，读取既有controller snapshot的`virtualModifiers.length > 0`。`sendControlKey`以事件四flags或该查询为true判定context-change，不仅依据DOM事件；toolbar也传入click事件的物理flags。查询只用于决定本地历史是否失效，不合成modifier down/up，不替代controller pressed truth，不修改sendKey的boolean返回。测试virtual Shift锁定→textarea ArrowLeft四flags全false：远端仍是带Shift且无多余modifier步骤的chord，移动历史失效而不是cursor--，virtual Shift保持原pressed状态直到既有显式释放。

### 5.1 远端目标确认门禁（R10）

sendMouse返回inputId只是传输接受，不能证明目标已切换。Input增加本地surface context状态settled/pending/uncertain和generation，复用_desktopWritePending及acceptMouseAck，不新增wire/ACK队列。首down接受后进入pending；gesture仍按原流程move/up/reset，文本和新的上下文动作暂不发送，用户新文本只保留本页草稿。必须手势已经结束且该手势可靠down/up对应的ACK已applied/duplicate，才进入settled；拖拽不能因down ACK先到就提前允许文本。Input中统一跟踪touch、mouse/pen、toolbar rightClick；不要让每个adapter各建一套确认状态。

对相关inputId/lease/generation匹配的execution-failed、sequence-gap、invalid-input、stale-lease、resync-required等非成功终态，或3000ms确认超时：进入uncertain，调用adapter.onTransportState('reacquire-required')使文本contextValid=false（这只是本地adapter通知，不擅改控制租约），保留草稿、不自动重发；迟到ACK不得解锁。reset/park/lease变化取消timer并失效旧generation。显式放弃操作清本地surface等待与草稿，提示用户核对远端；下一次明确操作重新建立上下文，不向远端补发任何内容。

Input新增getMobileSurfaceContextSnapshot()只返回state/generation，不输出inputId/坐标；isDeliverySettled额外要求surface settled。新写入门禁与retry读取该状态，但安全keyup/up/reset始终放行。目标确认成功只刷新UI，不自动发送期间积累的草稿，必须显式retry。正常键盘连续输入本身不按每条ACK串行节流；只有已存在待重试草稿或surface pending时才保留追加编辑，避免把每次打字变成手动重试。

surface pending本身不等于存在未发送文本。没有草稿、composition或不确定性时，不得仅因首down进入pending而撑高文本Dock；否则提示引发viewer几何变化，会把刚开始的真实拖拽取消。保持确认门禁和外部几何变化的安全reset，不能在测试中固定假高度或关闭几何检查绕过。浏览器验证移动输入框已显示、无草稿时的真实mouse/touch拖拽跨多个rAF，down后布局稳定、正常up且无自触发reset；up后ACK前输入仍留草稿，ACK不自动发送，显式retry只发送一次。

确认超时以已发送但未确认的可靠down/up为对象，各自最多等待3000ms，不是整个手势的最长时长。down已确认而用户仍拖动时维持pending、暂停无待确认边的计时；发送up后重新等待其确认。ACK乱序与既有_desktopWritePending累计清理不能丢失当前gesture的down/up关联；只保留该gesture的id/seq/lease/generation和确认元数据，不建立第二条发送或重试队列。旧代/旧lease及uncertain后的迟到ACK仍不得解锁。

门禁同样覆盖document层新增实体keydown；不能因外接键盘走controller直达路径而绕过未确认目标。既有实体keyup与已锁定虚拟modifier的关闭仍走原controller释放路径；虚拟pressed真相读取controller snapshot，不从aria反推，不手工清pressed或合成新modifier down。关闭所需的原有keyup报文不是新增协议。public sendControlKey在composition刚开始、draft尚未变化时也必须拒绝；surface-user焦点预检见§3，拒绝的pointer/click默认行为同样不能先blur文本框。

### 5.2 普通文本弹窗（R11）

setupTextInput的普通文本modal也属于外部写入：打开前检查移动composition/pending/uncertain及surface确认门禁，不通过则不打开/抢焦点，显示既有状态提示；打开本身和取消不清移动已接受历史。点击提交、compositionend自动提交共用同一个runMobileEditingAction('context-change',()=>controller.sendText(text))，只有接受后才清移动历史再关闭modal；false时保留两个入口各自草稿、不关闭。新布局不支持时也不能绕过门禁。测试移动abc→modal X→移动left/Y，不沿用旧abc cursor；以及pending拒绝打开、取消不清历史、失败提交保留、compositionend与click去重。

## 6. 手势起点（F4）

Touch pointer record 增加 `startPoint`（初始归一化坐标）与 `point`（当前点）。8 CSS px 阈值不变；越过阈值后发 `down(startPoint)`，再排队 `move(point)`；up 和 reset 沿用原逻辑。失败不发拖动 move，仍走既有 reset 屏障。

拖动期间 resize/旋转/object-fit 切换不能继续混用旧几何：Input 在已存在手势且几何签名改变时调用一次 releasePointer/reset，然后结束本地手势；下一个触点重新映射。签名只在本地内存使用，不进日志。

几何签名固定为surface rect(left,top,width,height)、源width/height、object-fit/scale模式。增加touch option `validateGeometry:()=>boolean`：Input刷新签名，变化时结束旧gesture并返回false；adapter在pointermove/up映射前、long-press和rAF flush前先检查，false立即return。事件入口保存本地gesture generation，mapPoint后再检查generation，防止重入reset后继续queue；reset递增generation使旧定时器/rAF失效。mouse/pen在映射前采用同一检查。不得在reset中递归刷新几何。

down被拒绝（含commit门禁失败）立即consume本次手势：清timer/pendingMove/pendingWheel、清pointer表、释放capture、清activeButton/primaryId、递增generation；同一pointer后续move/up不建新手势。真正尝试发送却失败时只走一次既有reset，reset成功不能让旧PRESSED复活；纯本地门禁拒绝无需发reset。新的pointerdown且原reset屏障已解除后才可开始。不得用rearm恢复已经consume的pointer。

长按 550ms、双击 500ms/6px 保持。第三指行为不是此次扩展目标，不实现三指或 pinch。

## 7. 单一布局计算（F2/F6）

ChromeLayout 继续独占 visualViewport/VirtualKeyboard 监听。将原键盘 bottom padding 从 `#mobileKeySurface` 移除；所有 touch-capable 宽度均显示移动按键，899px 只控制排列与密度。

新增纯函数 `ChromeLayout.computeMobileLayout({layoutHeight, visualHeight, offsetTop, keyboardRectHeight, keyboardOverlay, safeBottom, chromeTop, dockContentHeight, textDockHeight, textVisible, touchSupported})`，输出 `{visibleTop,visibleBottom,availableHeight,bottomInset,dockBottom,viewerTop,viewerHeight,compact,ultraCompact,unsupportedViewport}`。所有输入归一化为有限非负数；visualViewport不可用时visualHeight=layoutHeight、offsetTop=0。

```text
visibleTop = keyboardOverlay ? 0 : clamp(offsetTop, 0, layoutHeight)
visibleBottom = keyboardOverlay
  ? layoutHeight - clamp(keyboardRectHeight, 0, layoutHeight)
  : clamp(visibleTop + visualHeight, visibleTop, layoutHeight)
availableHeight = max(0, visibleBottom - visibleTop)
bottomInset = max(0, layoutHeight - visibleBottom)
textReserve = textVisible ? textDockHeight : 0
dockBottom = bottomInset + safeBottom + textReserve + 8
viewerTop = visibleTop + chromeTop
viewerHeight = max(0, availableHeight - chromeTop - safeBottom - textReserve - dockContentHeight - 8)
```

- 仅 VirtualKeyboard overlaysContent 确认可用且 rect 有效时使用 overlay 分支，否则 visualViewport 分支。不得把已经缩小的 visual viewport 再扣一遍 keyboardHeight。CSS 使用该函数写入的 viewerHeight，不再组合 dvh 与第二次 inset。
- visualViewport.offsetTop>0 时顶部chrome固定于visibleTop，画面从viewerTop开始；offsetTop不是额外可用高度。统一输出定位，禁止一处用layout坐标另一处用visual坐标再叠加offset。
- 在 `touchSupported && textVisible` 下强制 compact：顶部只留桌面/Terminal切换、移动键盘开关、退出全屏/收起；底部仅一行 44px 高、横向可滚动的移动键，普通 action/control bar 收入“更多”。错误/重试状态放在文本 Dock 内，实际测量其高度，不能固定写 44px。
- `availableHeight < 360px` 时进入 ultraCompact：压缩为顶部一行44px、文本/重试一行44px、导航一行44px；正文预览可折叠，真正textarea保留可聚焦且不以display:none隐藏composition。该极限状态允许画面小于120px；空间足够时必需按钮必须可达，不通过CSS min-height把控件顶出屏幕。
- 375×812/768×1024/1024×1366、300px inset 下以compact策略保证viewerHeight≥120px；568×320/inset160使用ultraCompact。`availableHeight < 140 + safeBottom`时设置unsupportedViewport=true，暂停新增文本与桌面写入、保留草稿与安全释放，提示收起系统键盘/旋转；此几何条件无法容纳三个44px行及8px间距，不要求假造全控件可达。恢复到支持尺寸只恢复输入门禁，不自动发送草稿，也不打断当前composition去强制blur。
- ChromeLayout把该结果单向传给`Input.setViewportInputSupported(supported: boolean)`，只保存派生门禁，不重写lease/isActive、不reset草稿。文本isEnabled、新touch/mouse down、toolbar动作、物理keydown读取此门禁；keyup/mouse up/reset始终保持现有释放路径。缺少布局计算时默认true，避免桌面无touch退化。
- unsupported暂停的是新的手势/上下文入口；已被接受且尚未结束的touch/mouse手势move保留原通路，但仍受几何失效/reset检查。普通hover或仅带buttons字段的未接受动作不得据此绕过门禁。既有mobileInputStatus须明确提示收起键盘或旋转，包括空草稿；恢复尺寸移除该提示，不清草稿或覆盖仍存在的不确定性。
- `compact=touchSupported && textVisible`；`ultraCompact=compact && availableHeight<360`；`unsupportedViewport=ultraCompact && availableHeight<140+safeBottom`。模式选择不依赖自己改变后的DOM高度；先定模式再测量，不能按viewerHeight反向切换造成振荡。无touch桌面保持原布局和可输入门禁。ResizeObserver测量真实Dock内容；一次rAF批量写CSS，值不变不重写，同尺寸20帧不得抖动。
- 所有键保持至少44×44 CSS px，溢出水平滚动；mobileInputMode 显式从适配器状态派生，不再永远默认 off；软键盘开时暂停 chrome auto-idle。

### 7.1 CSS写入与DOM落点

touch桌面模式使用`body.mobile-layout-managed`，ChromeLayout仅在desktop tab且touchSupported时启用；退出该模式移除派生样式，Terminal和非触控桌面保留原布局。该模式body的padding-top=0，viewer-container为position:fixed、top:var(--mobile-viewer-top)、height:var(--mobile-viewer-height)、margin:0；不再叠加旧flow/dvh/reserve公式。写入CSS属性`--mobile-visible-top/--mobile-viewer-top/--mobile-viewer-height/--mobile-dock-bottom/--mobile-text-bottom`（均px）；分别来自visibleTop/viewerTop/viewerHeight/dockBottom/(bottomInset+safeBottom)。statusBar fixed top=visibleTop；chromeDocks fixed bottom=dockBottom且禁用idle translateY；textDock fixed bottom=mobile-text-bottom。旧899px高度/inset规则限定到非managed模式或删除，被managed规则唯一覆盖；全屏使用同一坐标来源。

safeBottom来自静态无交互`#mobileSafeAreaProbe`的computed padding-bottom（CSS为env(safe-area-inset-bottom,0px)，position:fixed;width:0;height:0;visibility:hidden;pointer-events:none;aria-hidden=true），读取px有限值，缺失取0；不从待写的Dock尺寸反推safe-area。浏览器断言viewer.top=viewerTop、viewer.bottom<=dock.top、dock.bottom=visibleBottom-safeBottom-textReserve-8、text.bottom=visibleBottom-safeBottom，误差≤1px；另外确认顶栏bottom<=viewer.top。

两条.mobile-key-row及所有原按钮保留同一DOM；compact时#mobileKeySurface为单行flex nowrap横向滚动，两条row均flex:0 0 auto、flex-wrap:nowrap、高度44px，父高44px，不display:contents、不复制按钮，不拆监听器。所有导航/快捷键通过横向滚动可达，原role=group/aria-label保留。普通action/control bar以已有“更多”入口展现，紧凑状态下更多面板作为独立overlay不计入44px导航行；其按钮ID/事件保持唯一。测试父高44px、两组最后一个键滚动可达、每次click只发一次动作。

## 8. 全屏（F7）

选择 `document.documentElement` 为完整 Viewer 全屏目标：现有状态栏、desktopPanel、移动 Dock 与 modal 都已经在其中，不在运行时搬移 DOM、不复制元素/监听器。UI 的 fullscreenchange 仅更新状态和布局，走 §3 焦点规则，不直接 video.focus。

- `.viewer-container:fullscreen` CSS 改为 `html:fullscreen .viewer-container` 与全屏退出按钮规则；已有顶部高度、contain/cover/fill 和新布局算法继续生效。
- 全屏内切 Terminal 使用已有 tab 生命周期，Terminal/PTY 代码不改。静态 HTML 将唯一的 `exitFullscreenBtn` 从 `.viewer-container` 移入 `#statusBar .status-actions`，保留现有 ID 和监听器；`fullscreenBtn` 保留原启动入口。退出按钮仅在 documentElement 全屏时显示，任何 tab 和 compact/idle 状态下均可见、可点击，不依赖桌面 ACTIVE 租约。
- 可达性区分：全局`exitFullscreenBtn`须在任何自动滚动前满足完整视口边界（≤1px误差）、44px目标和hittest；位于“更多”可滚动菜单内的`fullscreenBtn`入口允许用户主动滚动菜单，滚动后、点击前再测完整边界和hittest。不得让locator.click的隐式滚动替代此证据，也不得把入口初始未滚动位置误判为全局退出缺失。
- 不支持 requestFullscreen、未允许或 promise reject 时，保留普通视图、草稿和焦点，显示可见“不支持全屏，可继续操作”；按钮 aria-pressed/文案不得假成功。不增加 iOS 私有 video-only fullscreen fallback。

## 9. 验证与交付状态

- 每个任务先增加能在旧实现失败的回归，再改生产逻辑；历史复现脚本和 results.json 保留原证据，新测试断言修复后的正确行为。
- 单元：现有7套件及新增 ui.test.js；布局纯函数验证 overlay/resize/offset/安全区与极小高度。
- 跨模块：真实 Input + Controller + Transport，在离线 DOM 中验证焦点、导航、部分失败、generation 取消和 reset/lease。
- 浏览器：新 `scripts/mobile_input_interaction_acceptance.py --out PATH`，用当前源码 HTML/CSS/JS 与 fake transport、阻断所有外网/服务请求。Chromium 和可用 WebKit 分开记录；模拟 visualViewport 与 VirtualKeyboard 场景，不冒充系统键盘。
- 构建：Signal `npm run build:web`；新增函数若仍放原文件无新增资产图要求，但构建回归必须证明移动 adapter 和调用仍在 desktop bundle。
- 物理/公网验收由既有 mobile harness 和实机执行；没有设备时不影响代码审查完成，但不能宣称移动端产品完整可用。

覆盖关系：F1→Task1，F4→Task2，F5→Task3，F3→Task4，F2/F6→Task5，F7→Task6，最终集成/文档→Task7。Task1–6 的实现顺序和共享文件约束由计划锁定。
