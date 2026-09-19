# Terminal 代码与页面优化设计

**日期：** 2026-09-19
**状态：** 代码整改已实施；真实多浏览器运行验收待执行
**范围：** 共享 Terminal 的 presenter 协议、PTY 资源边界、admin 认证、WebRTC 等待器、移动端页面和可访问性
**依据：** `docs/需求文档/WebRemoteDesktop-需求文档.md`、`docs/superpowers/specs/2026-08-30-terminal-shared-session-ux-protocol-design.md`、2026-09-19 代码与页面 review

## 1. 背景与问题定义

当前 Terminal 的基础能力已经具备：独立 admin 二次授权、共享 PTY、多 observer、Socket.IO 默认传输、TURN 可选传输、输入限流、输出背压、稳定错误码和前端多会话 UI。自动化测试覆盖较充分，但本次 review 发现以下行为仍需要收敛：

1. attach 成功和 presenter 切换复用了 `session_attached`，前端在收到 attach 后自动发送 `set_active_presenter`，服务端再返回没有操作标记的 `session_attached`，可能形成事件回环，并使已附着 observer 被无条件提升为 presenter。
2. WebRTC answer 等待超时后没有移除 socket listener，重复失败会积累监听器。
3. replay buffer 对单个超大输出 chunk 不执行硬截断，配置的 256 KiB 不能作为实际内存上限。
4. PTY 启动超时只发送一次 `SIGHUP`，未进入清理重试/quarantine；底层不触发 `onExit` 时会话仍占用池容量。
5. admin 密码使用普通字符串比较，缺少固定时间校验。
6. session title 没有字节长度和控制字符边界。
7. 移动端 Terminal 使用固定十行布局，workspace 在小屏高度不足；会话 tab 的关闭操作嵌套在 button 内，键盘访问不完整。

## 2. 目标行为

### 2.1 Presenter 协议

- `session_attached` 只表示 observer attach 成功，不能隐式改变 presenter。
- presenter 切换使用独立的 `presenter_changed` canonical 事件，或使用明确的 `action: presenter`；该事件不得再次进入 attach 处理器。
- 已附着 session 被点击激活时，只切换本地观察 tab 和传输绑定，不发送 presenter 接管请求。
- 当 session 没有 presenter，或用户明确点击“接管控制权”时，才允许发送 presenter 请求。
- 服务端对 presenter 更新保持幂等；同一 client 重复请求不会产生 attach 事件或循环广播。
- presenter 断开仍遵循现有 reset barrier：输入冻结，直到 reset ack；observer detach 只离开观察，不关闭 PTY。

### 2.2 WebRTC answer 等待器

每次 answer 请求必须拥有独立的清理闭包：成功、超时、异常和 socket disconnect 都移除 listener 并取消 timer。超时错误保持现有稳定错误语义，不静默切换到另一个传输。

### 2.3 Replay 与 PTY 资源边界

- replay buffer 的总字节数必须始终不超过配置上限。
- 单个输出 chunk 超过上限时，按 UTF-8 字节边界切分或按明确策略截断；每段仍保留可追踪的序号和完整的边界元数据。
- 启动超时必须进入统一的异步 PTY 清理流程，使用已有的信号升级、等待 `onExit`、quarantine 和退避重试机制。
- 启动超时会话不能继续接受 input/resize，也不能无限占用 session capacity。

### 2.4 认证与输入边界

- admin 密码在服务启动时转换为可验证的哈希，登录时使用 bcrypt 或固定时间比较。
- 认证失败仍使用稳定错误文案和已有 rate limit，不在响应中暴露比较细节。
- session title 限制为有界 UTF-8 字节数（建议 128 字节），去除控制字符；前端继续使用 `textContent` 渲染。

### 2.5 页面与可访问性

- 桌面端保留当前工具栏、状态、workspace 和 composer 语义。
- 小于 640px 时，pool note、transport、session info 和非关键 warning 合并为紧凑状态区或可折叠区域；workspace 和 composer 保留主要可视高度。
- session tab 与关闭操作使用并列的可聚焦控件，支持键盘 Enter/Space 和清晰的 aria-label。
- presenter、observer、控制切换中、PTY exited/failed 等状态继续使用 `aria-live`，并保持现有中文稳定文案。

## 3. 设计边界

### 3.1 事件与状态归属

`TerminalPanel` 仍是浏览器运行时状态的唯一 owner；`createTerminalSessionFsm` 只保留为确定性测试 seam。Socket adapter 负责把 legacy alias 归一化到 canonical 事件，不能让 presenter 变更伪装成 attach。

建议的 canonical 事件：

| 事件 | 用途 | 是否触发 attach | 是否触发 presenter 请求 |
|---|---|---:|---:|
| `session_attached` | observer attach 成功，包含 replay | 否 | 否 |
| `session_presence` | observer 数量、presenter 和 reset 状态变化 | 否 | 否 |
| `presenter_changed` | 明确的 presenter 更新确认 | 否 | 否 |
| `session_detached` | 当前 observer detach | 否 | 否 |
| `session_closed` | PTY 被显式销毁 | 否 | 否 |

`presenter_changed` 可以在迁移期同时带旧字段，但前端必须只进入 presenter 更新路径，不再调用 `announceActivePresenter`。

### 3.2 资源清理

所有 PTY 终止路径最终调用同一清理函数。启动超时不能只设置 `exitHandled` 后退出；应标记为不可写，开始清理，并在清理失败时放入 quarantine。只有确认 `onExit` 或已确认进程死亡后，才从容量统计中释放资源。

### 3.3 兼容与非目标

- 不改变共享 PTY、admin 二次授权、默认 WebSocket-only 和 TURN 显式选择语义。
- 不新增独立 Terminal 服务，不引入第二套移动端输入协议。
- 不删除 legacy alias；删除条件仍是连续发布周期零命中并有迁移证据。
- 不自动重建 quick tunnel、named tunnel、Signal Server 或 Host。
- 本 Spec 不把真实双浏览器、公网、物理 macOS Quartz 验收标记为已完成。

## 4. 验收要求

### 自动化

1. attach success 不产生 `set_active_presenter`；presenter_changed 不再次产生 attach 或 presenter 请求。
2. 已附着 observer 激活 tab 不改变服务端 presenter；明确接管后才改变。
3. WebRTC answer 在 timeout、success、disconnect 后 listener 数量回到基线。
4. replay buffer 在单个超大 chunk、连续 chunk 和多字节 UTF-8 下都不超过上限。
5. startup timeout 在无 `onExit` 时进入 quarantine 并可重试回收；确认 `onExit` 后从容量统计释放。
6. admin 密码验证通过正确密码、错误密码和空密码路径；失败响应不泄漏密码内容。
7. title 长度和控制字符边界稳定，pool snapshot 不包含未清理控制字符。
8. 移动 viewport 下 workspace/composer 最小高度、tab 键盘操作和 aria 语义有测试。

### 运行时

在隔离的单 Viewer 环境执行单浏览器流程，再使用两个独立浏览器上下文执行：共享输出、observer attach、明确 presenter 接管、presenter 断开 reset、非 presenter detach、close 销毁。公网、真实 macOS 输入和 tunnel 路径仍单独记录为 `NOT RUN` 或实际结果，不能用单测替代。

## 5. 风险与回滚

- presenter 新事件需要同时兼容旧客户端；服务端可在迁移期继续发旧 snapshot，但前端禁止从旧 snapshot 自动发起 presenter 请求。
- replay 超大 chunk 的切分会改变极端情况下的 replay 分段形式，必须保留序号和完整性标记。
- admin 密码哈希迁移需要兼容现有环境变量；部署切换前先在测试配置验证启动和登录。
- 页面响应式改动只影响 Terminal panel，不改变 Desktop 的布局和控制栏。
- 每个阶段保持可独立回滚，先落测试和协议保护，再做 UI 调整。
