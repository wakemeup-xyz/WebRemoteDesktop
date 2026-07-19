# Review Blockers Closure Plan

## Task 1: Lease expiry reset barrier

1. 在 `desktop-control-lease.test.js` 增加 heartbeat、authorize、snapshot、requestControl 触发 deadline 后不吞 reset 的失败测试，以及 ack 前拒绝旧凭据/新 grant、timeout 不绕过 reset 的测试。
2. 在 `signaling.test.js` 增加 scheduler race 测试，确认 Host 恰好收到一个 reset transition，transition/log 不带 lease token。
3. 抽取单一显式 expiry/dispatch seam；accessor 保持无副作用；所有进入 `REVOKING` 的路径经过 dispatcher；ack 前不进入 `FREE`。
4. 运行 lease、signaling、takeover、disconnect 和 legacy relay 测试，提交 `fix(signal): preserve reset barrier across lease expiry races`。

## Task 2: Rejected Terminal composer input

1. 在 `terminal.test.js` 覆盖未附着、已关闭和 PTY write 抛错三种 `terminal:input` rejection，确认错误包含可信 `sessionId`/`inputId` 且不含命令正文。
2. 在 `web-client/js/terminal.test.js` 增加匹配错误释放 pending、草稿保留、不匹配错误隔离和 retry 新 inputId/单次 payload 测试。
3. 在 `signal-server/websocket/terminal.js` 统一错误 envelope；在 `terminal.js` 仅清理匹配 pending，保留 draft 并刷新 composer。
4. 运行 Signal terminal、composer 和完整 Terminal UI 回归测试，提交 `fix(terminal): unlock composer after rejected input`。

## Closure

检查两个提交只包含所属实现、测试和本 blocker 文档；不修改 `review-anchors.md`、safe tunnel skill 缓存、日志或其他已有脏文件。完成 blocker 后继续执行媒体暂停计划。
