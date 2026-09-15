# 输入上下文未确认交互优化计划

日期：2026-09-15

## 背景与问题

Viewer 在失焦、隐藏、输入通道变化或鼠标手势 ACK 未完成时，会把输入上下文标记为 uncertain，并通过最终 gate 阻止实体键盘和点击。这是为了避免把按键发送到错误的远端焦点，或重复发送结果不确定的文字。

当前交互存在两个问题：

1. 无本地草稿时，`输入上下文未确认，已保持安全状态` 可能只显示提示，恢复按钮被隐藏，用户无法从当前页面自助恢复。
2. 提示文本建议“释放后重新获取控制”，但页面没有与该建议对应的直接操作入口；桌面设备还可能隐藏移动输入 Dock。

目标是保留 fail-closed 的输入安全边界，同时让用户知道发生了什么、下一步能做什么，并确保恢复成功后新的键盘/鼠标输入可用，旧事件和不确定文字不会被自动重放。

## 设计决策

### 1. 区分三类状态

- **恢复中**：显示“正在安全恢复输入”，提供不可重复点击的等待状态。
- **可自动恢复但尚未开始**：自动恢复条件满足时启动一次有界双 reset；用户看到等待状态。
- **恢复失败或上下文仍不确定**：显示失败原因和可执行操作。

“键盘：就绪”必须继续反映最终 gate；如果 surface、recovery 或 draft 阻塞，应显示阻塞状态。

### 2. 恢复入口始终可达

固定提示至少提供：

- **重试恢复**：只在失败或可重试的不确定状态显示；复用现有 `requestInputRecovery({source: 'user'})`，不重放旧输入。
- **重新获取控制**：先执行现有 `releaseControl`，再允许用户显式请求控制；不自动夺取控制权。成功获得新 lease/epoch 后由现有 reset ACK 流程建立新上下文。
- **检查草稿**：仅有 pending/uncertain 草稿时显示，打开本地编辑器，不自动发送或清空。

按钮位于独立 fixed recovery overlay，桌面、触控和全屏均可操作，不依赖移动 Dock，不抢远端输入焦点。

### 3. 保留安全边界

- 没有草稿且当前 mouse/keyboard reset 均获得当前 lease、epoch、attempt 的正向 ACK 后，允许新的输入。
- 有草稿或 IME composing 时，reset ACK 不能证明文字目标焦点正确；保留草稿并要求用户检查、显式重试或放弃。
- 迟到 ACK、旧 attempt ACK、普通 READY、新视频帧或同 lease 重绑不能无条件清除 uncertain。
- tracked keyup、mouse up、reset 等安全释放路径不被最终 gate 误伤。

## 实施步骤

### Step 1：盘点并统一状态映射

- 在 `Input.getEffectiveInputGate()` 和 recovery snapshot 中明确 blocked reason、恢复动作可用性及当前 draft 状态。
- 将“surface 不确定但无草稿”“draft 不确定”“reset 失败”“无控制权”映射为不同用户文案。
- 确认 `updateKeyboardUI()`、`controlStatus` 和 recovery notice 不会互相显示矛盾状态。

### Step 2：补齐恢复操作 UI

- 修改 `web-client/viewer.html` 的 recovery overlay，增加“重新获取控制”按钮及可访问性文本。
- 修改 `web-client/js/input.js`：统一绑定重试、重新获取控制、检查草稿；按钮操作不冒泡到远端桌面，不抢本地编辑焦点。
- 修改 `web-client/js/webrtc.js`：复用现有释放/请求控制状态机，处理释放失败、请求中、拒绝和成功后的提示更新。
- 调整 CSS，确保 overlay 在窄屏、全屏、隐藏控件模式下仍可见且不遮挡全屏退出入口。

### Step 3：修正无草稿恢复后的输入解锁

- 对“失焦时在途 surface 后续 ACK 已全部到达”的场景，保留 reset/reconcile 所需身份，不把已完成的安全释放永久升级为 uncertain。
- 对真正无法确认的 surface，只有双 reset 正向 ACK 才恢复；恢复完成后允许新的 mouse down/up 和 key down/up。
- 不清除 pending 文本，不自动重发旧文本。

### Step 4：补充诊断与文案

- 将最终 gate、blocked reasons、recovery state、可用动作和 draft 摘要纳入现有脱敏诊断白名单。
- 不记录按键 code、文本、坐标、token 或原始 lease/input ID。
- 文案明确说明“旧输入不会自动重发”，减少用户重复操作和误解。

## 验收测试

在 `web-client/js/input-recovery.test.js` 增加或修正以下场景：

1. 无草稿：surface uncertain → overlay 显示重试/重新获取控制 → 双 reset ACK → 新键盘和鼠标事件成功发送。
2. 有草稿：只显示检查草稿/放弃路径；恢复不自动发送旧文字。
3. reset 失败、超时、旧 lease/attempt ACK：保持阻塞并显示可执行恢复入口。
4. 重新获取控制成功、拒绝、请求中：按钮状态与 controlStatus 一致。
5. 全屏、隐藏控件、触控和非触控设备：恢复入口均可见且可点击。
6. tracked keyup、mouse up、Terminal/local editor 焦点：安全释放和本地编辑不被误拦截。
7. 诊断快照只包含白名单字段，且不含敏感输入内容。

运行：

```bash
node --test web-client/js/input-recovery.test.js web-client/js/mobile-text-input.test.js web-client/js/remote-keyboard-controller.test.js web-client/js/keyboard-transport.test.js
```

随后运行前端完整离线测试；真实浏览器、真机/IME、Quartz 和公网链路作为独立验收，不用离线测试替代。

## 完成标准

- 输入不确定时用户始终能看到原因和至少一个可执行恢复动作。
- 无草稿的安全恢复不会永久锁住新的实体键盘和鼠标操作。
- 草稿、旧 ACK 和失败恢复仍保持 fail-closed，不发生自动重复输入。
- 状态栏、控制状态、恢复提示和诊断快照一致。
- 相关测试通过，并记录真实浏览器/设备验收边界。
