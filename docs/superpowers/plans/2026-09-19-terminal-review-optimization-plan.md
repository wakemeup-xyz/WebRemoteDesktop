# Terminal 代码与页面优化实施计划

**目标：** 修复 presenter 事件回环和无条件抢 presenter，建立 PTY/replay 的硬资源边界，收紧 admin 认证与 session 输入，并改善移动端 Terminal 页面。

**Spec：** `docs/superpowers/specs/2026-09-19-terminal-review-optimization-design.md`

**执行方式：** 每个任务先写失败测试，再实现，再运行对应的 focused suite；本计划只描述实施步骤，本轮 review 不执行代码修改。

## 全局约束

- 不启动、停止、重启或重建 quick tunnel、named tunnel、Signal Server 或 Host。
- 不改变共享 PTY、admin 二次授权、默认 WebSocket-only 和 TURN 显式选择语义。
- 不把自动化测试通过写成真实双浏览器、公网、物理 macOS 验收通过。
- 不记录原始命令、输出、密码、token 或完整输入 payload。
- 每个阶段完成后运行 `git diff --check`，并更新对应验收记录。

## Task 1：Presenter 事件协议与状态机

**文件：** `web-client/js/terminal.js`、`signal-server/websocket/terminal.js`、相关 terminal tests。

- [x] 增加失败测试：`session_attached` 不触发 `set_active_presenter`。
- [x] 增加失败测试：服务端 presenter 更新不会发回可被 attach handler 消费的事件。
- [x] 将 presenter 更新改为独立 canonical 事件或明确 `action: presenter`，并在 adapter 层归一化。
- [x] `activateSession` 对已附着 session 只切换 active tab/rebind；新增显式接管入口。
- [x] 保留 presenter reset barrier、observer detach 和 caller-aware snapshot。
- [x] 增加事件次数断言，确保重复 presenter ack 不会产生循环。
- [x] 运行 `node --test web-client/js/terminal*.test.js signal-server/websocket/terminal.test.js`。

## Task 2：WebRTC 等待器清理

**文件：** `web-client/js/terminal.js`、`web-client/js/terminal.test.js`。

- [x] 用可观察的 socket listener 计数写 timeout leak 回归测试。
- [x] 把 answer waiter 的 timer、listener、disconnect 清理合并到单一 cleanup 函数。
- [x] 验证连续 TURN 失败后监听器数量回到基线，且错误仍明确显示为 TURN 失败。
- [x] 运行 `node --test web-client/js/terminal*.test.js`。

## Task 3：Replay 硬上限

**文件：** `signal-server/lib/terminal/session-manager.js`、`signal-server/test/terminal-session-manager.test.js`。

- [x] 增加单 chunk 超限、连续 chunk、emoji/多字节 UTF-8 的失败测试。
- [x] 实现按 UTF-8 字节边界切分或明确截断，保证 snapshot 总字节数不超过配置值。
- [x] 保持 replay seq、ack 和慢 observer 的现有语义。
- [x] 运行 `node --test signal-server/test/terminal-session-manager.test.js signal-server/test/terminal-flow-control.test.js`。

## Task 4：PTY 启动超时与 quarantine

**文件：** `signal-server/lib/terminal/session-manager.js`、相关 lifecycle tests。

- [x] 增加没有 `onExit` 的 startup timeout 测试，确认 session 不继续可写且进入 cleanup pending。
- [x] 让 timeout 使用统一 `cleanupPty`/quarantine/退避重试路径。
- [x] 增加异步 `onExit` 到达、清理成功、清理失败重试和容量释放测试。
- [x] 保持 `pty_startup_timeout`、`pty_exited` 和 `pty_cleanup_failed` 稳定错误/审计语义。
- [x] 运行 `node --test signal-server/lib/terminal/*.test.js signal-server/test/terminal*.test.js`。

## Task 5：admin 认证和 session 输入边界

**文件：** `signal-server/routes/auth.js`、`signal-server/lib/terminal/session-manager.js`、`signal-server/lib/terminal/config.js`、相关 tests。

- [x] 确定环境变量兼容的密码哈希配置方式，避免每次请求重新生成哈希。
- [x] 增加正确密码、错误密码、空密码和 rate-limit 路径测试。
- [x] 对 title 增加 UTF-8 字节上限和控制字符清理测试。
- [x] 确认 snapshot、审计和 UI 都不回显未清理 title 或密码。
- [x] 运行 `node --test signal-server/test/terminal-auth.test.js signal-server/test/terminal-config.test.js signal-server/test/terminal-session-manager.test.js`。

## Task 6：Terminal 页面响应式和可访问性

**文件：** `web-client/viewer.html`、`web-client/css/viewer.css`、`web-client/js/terminal.js`、`web-client/js/terminal.test.js`。

- [x] 为小于 640px 的 viewport 定义紧凑状态布局，保证 workspace 和 composer 有可用最小高度。
- [x] 将 session tab 的关闭操作改为可聚焦控件，保留 detach 语义和阻止 tab 激活的行为。
- [x] 增加键盘 Enter/Space、焦点顺序、aria-label、aria-live 的 DOM contract 支持。
- [x] 在桌面和移动 viewport 下检查 Terminal auth、transport、warning、workspace、composer 的显示/隐藏。
- [x] 运行 `node --test web-client/js/terminal*.test.js`；本地 Playwright 黑盒仍需隔离 Viewer 后补验。

## Task 7：集成验收与文档闭环

**文件：** `docs/需求文档/WebRemoteDesktop-需求文档.md`、相关 Spec、验收报告。

- [x] 运行 focused backend/frontend suites、完整后端测试和 `git diff --check`。
- [ ] 在隔离单 Viewer 环境完成单浏览器 attach/create/detach/close 流程。
- [ ] 用双浏览器上下文验证 observer、明确接管、presenter reset 和 detach 不销毁 PTY。
- [ ] 将未执行的公网、物理 macOS、tunnel、断网恢复场景明确记录为 `NOT RUN`。
- [ ] 根据结果把需求文档中的 `[x]`、`[ ]` 和验收边界更新到与代码一致。

## 交付顺序与完成标准

1. Task 1–4 完成后，必须先证明没有 presenter 事件回环，且 session/replay/PTY 的容量边界可测试。
2. Task 5 完成后，admin 登录和 title 边界不能引入明文凭据或原始 IO 记录。
3. Task 6 完成后，桌面端行为不回归，移动端 workspace/composer 可操作，关闭 tab 支持键盘操作。
4. Task 7 完成后，所有自动化命令、运行时结果、未运行边界和文档状态相互一致。

## 回滚点

- Task 1 的新 presenter 事件保留旧 snapshot 字段，出现旧客户端兼容问题时可暂时回退 adapter，不回退自动 announce。
- Task 3 的 replay 切分只影响超限边界；普通 chunk 可逐段回滚。
- Task 6 的 CSS 可独立回退，不影响 Signal 或 PTY。
