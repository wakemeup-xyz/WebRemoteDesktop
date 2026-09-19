# Terminal 代码与页面 Review

**日期：** 2026-09-19
**对应 Spec：** `docs/superpowers/specs/2026-09-19-terminal-review-optimization-design.md`
**对应 Plan：** `docs/superpowers/plans/2026-09-19-terminal-review-optimization-plan.md`

## 结论

当前 Terminal 的基础认证、共享 PTY、observer、流控和错误边界已经具备，但 presenter 事件协议存在回环风险，应作为第一优先级修复。replay buffer、PTY startup timeout、WebRTC answer listener 和 admin 密码比较属于后续资源与安全整改。页面侧主要是移动端空间利用率和 tab 关闭控件可访问性问题。

## 发现

| 严重度 | 位置 | 结论 |
|---|---|---|
| 高 | `web-client/js/terminal.js:1557-1560,1780-1792`；`signal-server/websocket/terminal.js:465-473` | attach 回调和 presenter 更新复用 `session_attached`，可能循环发送 `set_active_presenter`，并使已附着 observer 无条件抢 presenter。 |
| 中 | `web-client/js/terminal.js:1080-1088` | WebRTC answer timeout 未移除 listener。 |
| 中 | `signal-server/lib/terminal/session-manager.js:35-50` | 单个超大输出 chunk 可突破 replay byte limit。 |
| 中 | `signal-server/lib/terminal/session-manager.js:689-715` | startup timeout 只发送一次 `SIGHUP`，未进入 quarantine/retry。 |
| 中 | `signal-server/routes/auth.js:135` | admin 密码为普通字符串比较。 |
| 低/中 | `signal-server/lib/terminal/session-manager.js:793` | session title 无长度和控制字符限制。 |
| 低 | `web-client/js/terminal.js:2234-2243`、`web-client/css/viewer.css:623-654` | 关闭控件嵌套在 tab button 内；移动端固定十行布局压缩 workspace。 |

## 验证

- `cd signal-server && npm test -- --test-name-pattern='terminal'`：58 passed，0 failed。
- `node --test web-client/js/terminal*.test.js`：122 passed，0 failed。
- replay buffer 超限通过独立脚本复现。
- 本地页面可进入 Terminal 授权界面；运行时因另一个 Viewer 触发严格单桌面 Viewer 互斥，真实双浏览器共享流程未完成，记录为 `NOT RUN`。
- `semgrep`、`bandit`、`gitleaks` 当前环境未安装，因此没有把它们的扫描结果写成已执行证据。

## 运行时验收边界

真实双浏览器 presenter/observer、detach 不销毁 PTY、断线重附着、公网入口、物理 macOS 输入和 tunnel 路径仍需按新 Plan 单独执行，不能由上述自动化测试替代。
