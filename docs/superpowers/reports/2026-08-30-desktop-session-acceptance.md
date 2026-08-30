# Desktop Session State 验收报告

日期：2026-08-30

## 自动化

- Snapshot reducer：覆盖初始 idle、PC connected 的 media-pending、fresh-frame gate、旧 attempt 隔离和输入门禁。
- Acceptance harness：`--local-only` 只读取 `/health`，不注入 frame、ack 或输入事件；公网、tunnel、双 Viewer、物理输入默认 `NOT RUN`。

## 运行矩阵

| 验收项 | 状态 | 证据边界 |
| --- | --- | --- |
| fresh frame | NOT RUN | 需要真实 Viewer 渲染帧 |
| stall/resume | NOT RUN | 需要真实卡顿和恢复帧 |
| disconnect/reset | NOT RUN | 需要真实断开与复位 barrier |
| dual Viewer | NOT RUN | 需要两浏览器和 Signal 写入拒绝 |
| tunnel/public frame | NOT RUN | 未操作 tunnel，不以 URL/health 替代 |
| physical input | NOT RUN | 需要真实键鼠 ack |

本报告不把未运行项标记为 PASS。
## Desktop session owner convergence follow-up

- `18d100d` removed the duplicate `DesktopSessionCoordinator`; `dffb55c` updated the WebRTC harness; the final working-tree fix aligns WebRTC with the global `DesktopSessionState` singleton and defers tunnel readiness until image `onload`.
- Focused Viewer tests: `190/190` passed.
- Signal server: `npm run build:web` passed; `npm test` `317/317` passed.
- Full Viewer suite: `472/473`; the single `input.test.js` blur fixture failure reproduces on the pre-change baseline (`15/16`) and is unrelated.
- `git diff --check`: passed.
- NOT RUN: real browser, dual Viewer, physical input, public tunnel/path, and sleep/wake validation.
