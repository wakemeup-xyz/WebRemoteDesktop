# Terminal 多行命令编辑器设计

**日期：** 2026-07-19
**状态：** 已确认，待实施
**范围：** `web-client` 的 Shared Terminal 前端；不改变 Signal Server、PTY 或 quick tunnel 生命周期。

## 目标

为每个 Shared Terminal 会话提供一个本地多行命令编辑器：

- `Shift+Enter` 只在编辑器内插入真实的 `\n`，不向 PTY 发送数据，也不执行命令。
- 未处于 IME 组合输入时，`Enter` 提交当前编辑缓冲区；缓冲区内的 `\n` 原样保留。
- 若终端程序已声明 bracketed paste（DEC private mode `?2004h`），提交内容使用 `CSI 200~` / `CSI 201~` 包裹并追加 `\r`，使 Readline/Zsh 等能以一次粘贴接收多行内容后执行。
- 若终端程序未声明 bracketed paste，仍提交原始内容和追加的 `\r`；UI 明确提示该程序将自行解释多行 `\n`，避免承诺不存在的通用“换行但不提交”PTY 语义。

## 背景与约束

现有 xterm.js 的 `term.onData()` 是字节流直通路径。把 `Shift+Enter` 直接映射为 `\n` 并不能通用地实现“编辑时换行”：多数 shell/REPL 会将该字符解释为命令分隔或提交。因此，多行编辑必须在浏览器本地 textarea 中完成，再作为一个完整输入负载发送。

现有 `TerminalPanel` 已追踪 alternate-screen 控制序列，并为每个会话维护 xterm、回显控制器与会话状态。新能力必须复用该单一面板，不修改服务器的 `terminal:input` contract：`data` 继续是单个字符串。

## 备选方案

### 方案 A：xterm 中直接把 `Shift+Enter` 发送为 `\n`

改动很小，但 textarea 不存在，用户无法在提交前编辑多行；而且 `\n` 的含义由当前终端程序决定，通常会立即执行。**不采用。**

### 方案 B：独立 textarea，所有提交均直接发送原始内容

可满足本地编辑和保留 `\n`，但 Bash/Zsh 已启用 bracketed paste 时失去其安全的多行粘贴语义，可能导致逐行执行。**不采用。**

### 方案 C：会话级 textarea + mode-aware bracketed paste

为每个会话保留本地草稿；根据对端 `?2004h` / `?2004l` 输出决定是否使用 bracketed paste。它在支持的终端中保证最自然的多行命令体验，并在不支持时诚实地保留原始 `\n`。**采用。**

## 交互设计

### 编辑与提交

1. Terminal 面板在 xterm workspace 下方显示 textarea、发送按钮和一行快捷键说明：`Shift+Enter 换行 · Enter 发送`。
2. textarea 的原生 `Shift+Enter` 行为不拦截，浏览器将真实换行写入 `textarea.value`。
3. textarea 的普通 `Enter`（不含 Shift，且 `event.isComposing === false`）调用提交逻辑并 `preventDefault()`；发送按钮走同一提交逻辑。
4. 空草稿上的普通 `Enter` 仍发送原始 `\r`，保持终端常规回车语义。
5. 有内容的草稿会被规范化为 LF（`\r\n` / `\r` 转为 `\n`），并作为单次 `terminal:input` 的 `data` 发送；收到匹配的 `terminal:input_ack` 后才清空当前会话草稿；断线、拒绝或未确认时保留草稿，重连后可重试。
6. composer 禁用时不接受提交：未授权、socket 未连接、没有活动会话或活动会话未附着都属于禁用状态。

### 会话与草稿

- 草稿以 `sessionId -> string` 映射保存在当前浏览器页面内存中；切换 Shared Terminal 标签时保存当前 textarea 值并恢复目标会话的值。
- 关闭会话、销毁 xterm 或刷新网页时相应草稿被丢弃；**不写入 `localStorage`、诊断上报或服务端日志**，避免命令内容（尤其密钥）意外持久化。
- 原始 xterm 区域仍使用既有 `onData` 直通路径，鼠标/键盘控制、全屏 TUI 和 optimistic local echo 的行为不因 composer 改变。

## 输入协议

### Canonical truth

浏览器侧的 `TerminalComposer` 模块是唯一的 composer 草稿与序列化真相源。`TerminalPanel` 只提供活动会话、连接状态、当前 paste mode 和 `terminal:input` 发送适配。

### Mode tracking

`TerminalPanel` 扩展现有终端输出控制序列追踪：每会话保留短尾缓冲并识别可能跨 PTY 输出分块的 `\x1b[?2004h` 与 `\x1b[?2004l`。最后一个完整序列决定该会话的 `bracketedPasteEnabled` 状态；会话销毁时删除状态。

### 负载编码

设规范化后的编辑文本为 `text`：

| 对端状态 | `terminal:input.data` |
| --- | --- |
| `bracketedPasteEnabled === true` | `\x1b[200~${text}\x1b[201~\r` |
| `bracketedPasteEnabled === false` | `${text}\r` |
| 空草稿 | `\r` |

不支持 bracketed paste 的程序仍能收到完整的 `text`，其中包含真实 `\n`；是否把这些换行当作语句分隔由该程序自身决定，前端不伪造新的 PTY 协议。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `web-client/js/terminal-composer.js` | textarea 草稿、快捷键判定、换行规范化、负载编码和每会话草稿状态的唯一实现。 |
| `web-client/js/terminal-composer.test.js` | 纯逻辑和 DOM 事件边界的 Node 测试。 |
| `web-client/js/terminal.js` | 挂载 composer、提供连接/会话适配、追踪 `?2004h/l`、统一发送 `terminal:input`。 |
| `web-client/js/terminal.test.js` | 验证 panel 集成、跨输出分块的 mode tracking、会话切换和不扰动原始 xterm 输入。 |
| `web-client/viewer.html` | 加载新脚本并提供 composer DOM。 |
| `web-client/css/viewer.css` | 布局、可访问焦点、禁用状态和移动端可用性。 |
| `web-client/css/viewer-layout.test.js` | 终端网格位置与 composer 无障碍属性的静态回归测试。 |

Signal Server 无需修改：既有 `terminal:input` 允许字符串 `data` 原样写入 PTY，且不应记录内容。

## 验收标准

1. textarea 中按 `Shift+Enter` 后 `value` 包含一个 `\n`，且没有 `terminal:input` emit。
2. 输入 `echo one`、`Shift+Enter`、`echo two` 后，普通 `Enter` 在 paste mode 下只 emit 一次，负载精确为 `\x1b[200~echo one\necho two\x1b[201~\r`。
3. 在 paste mode 关闭时，同样的草稿只 emit 一次，负载精确为 `echo one\necho two\r`。
4. `?2004h` 和 `?2004l` 即使被拆在两个 output chunk 中也能正确切换模式。
5. 会话 A/B 切换分别恢复各自的未提交草稿；关闭会话后其草稿不存在。
6. raw xterm `onData('ls\r')` 仍走既有直通 emit 和 optimistic local echo；alternate screen 时仍禁用 optimistic echo。
7. 未授权、断线或没有活动会话时，composer 控件禁用且不会 emit；序列化后 UTF-8 负载超过 64 KiB 时保留草稿、不 emit 且不留下 pending 状态。
8. focused Node tests 通过；在浏览器中手动验证 shell 启用与未启用 bracketed paste 两种状态，并确认浏览器 console 无错误。

## 非目标

- 不改动 signal-server、`node-pty`、Host、WebRTC、tunnel 或服务启动流程。
- 不在浏览器中解析 shell 语法、自动加反斜杠或承诺所有 REPL 都支持多行粘贴。
- 不持久化草稿、不记录输入内容，也不改变 raw terminal 的任何快捷键含义。
