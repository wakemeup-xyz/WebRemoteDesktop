# Terminal Review 优化整改验收

**日期：** 2026-09-19
**Spec：** `docs/superpowers/specs/2026-09-19-terminal-review-optimization-design.md`
**Plan：** `docs/superpowers/plans/2026-09-19-terminal-review-optimization-plan.md`

## 实施结果

- presenter 更新改为 `presenter_changed`，attach 和 tab activation 不再自动抢 presenter；新增显式“接管控制”按钮。
- WebRTC answer waiter 在成功、超时和异常路径清理 timer/listener。
- replay buffer 对超大 UTF-8 chunk 实施硬字节上限。
- PTY startup timeout 延迟进入统一 cleanup/quarantine/retry 路径，避免立即重复发送终止信号。
- admin 密码比较改为 SHA-256 摘要后的固定时间比较。
- session title 限制为 128 UTF-8 字节并移除控制字符。
- Terminal tab 关闭控件支持焦点、Enter/Space；移动端 Terminal 使用紧凑布局，保留 workspace 和 composer 主要空间。

## 自动化验证

| 范围 | 结果 |
|---|---|
| 完整 Signal Server 测试 | PASS：364 passed，0 failed |
| Terminal 前端测试 | PASS：123 passed，0 failed |
| replay 超大 UTF-8 chunk 回归 | PASS |
| presenter activation 不隐式接管回归 | PASS |
| patch whitespace | PASS：`git diff --check` |

## 尚未执行

- `NOT RUN`：隔离环境下的真实单浏览器 Terminal create/attach/detach/close 流程。
- `NOT RUN`：独立双浏览器 presenter/observer、明确接管、presenter reset 和 detach 不销毁 PTY。
- `NOT RUN`：公网入口、物理 macOS Quartz/IME、真实 tunnel 和断线重附着。

上述场景不能由 Node 单测或一次本地页面打开替代；执行时必须避免项目的严格单桌面 Viewer 互斥干扰验收。
