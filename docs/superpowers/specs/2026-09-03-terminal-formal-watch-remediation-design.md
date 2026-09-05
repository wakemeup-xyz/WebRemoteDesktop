# Terminal 与 Formal Watch 修复设计

**状态：** Task 1–4 代码已实施；Task 5 文档已同步；真实单/双浏览器、物理设备与公网链路验收待执行
**日期：** 2026-09-03
**范围：** 审查 `2863560..211777d` 确认、且不属于桌面控制连续性的 Terminal / 命名隧道 watch 缺陷。
**不包含：** 桌面触控、mouse seq、SPS、jitter、Viewer chrome。那些在 `2026-09-03-remote-desktop-control-continuity-remediation-design.md`。

## 1. 问题

1. Terminal bootstrap 5xx 后 `applyBootstrap({allowPolling:false})` 但不缓存 token，`connectSocket` 把未缓存当成不能 `io()`，无限重试 bootstrap，websocket-only 回退从未连上。
2. 用户 detach 后 `pool_snapshot` 用 `LAST_ACTIVE_SESSION_KEY` 立刻 `requestAttachSession`，无法真正离开观察。
3. `ptyKillWaitMs` 默认 0，`waitForExit` 只 `await Promise.resolve()`；真 node-pty 的 onExit 赶不上 → 误报 `pty_cleanup_failed` 并 quarantine。
4. Formal watch 用 `/tmp` mkdir 锁 + EXIT trap；kickstart/SIGKILL 后锁残留，watcher `exit 0`，自愈停摆。
5. `--token` argv 的 cloudflared 既不算 owner 也杀不掉，可能双 connector。
6. 共享会话 UX：规格标已实施，缺「控制切换中」、presenter 断开冻结输入、断线「正在重新附着」。
7. `createTerminalSessionFsm` 不是运行时 owner，只被单测引用。
8. 需求文档 / README / runbook 对 trycloudflare 失效是否自动重建口径互斥；需求仍写后台立即停采集（代码 5 分钟）。

## 2. 方案

### 2.1 Bootstrap 失败回退

`ensureTerminalBootstrap` catch 后必须让**本次** `connectSocket` 能走到 `io()`：设置一次性 `bootstrapAttemptToken` 或 `allowConnectWithoutCachedBootstrap=true`，`applyBootstrap({allowPolling:false})` 后不要立刻再递归打 bootstrap。成功才写 `bootstrapAuthToken`。失败可有界重试（最多 1 次，间隔 ≥1s），不得 tight loop。

### 2.2 Detach 粘滞

`handleDetach` 必须清 `LAST_ACTIVE_SESSION_KEY`（若离开的是当前 persisted id），并设 `userDetachedSessionId`。`applyPoolSnapshot` 不得对用户刚 detach 的 id 自动 attach。显式点 tab 再附着。

### 2.3 PTY 退出等待

生产默认 `ptyKillWaitMs` ≥ 200ms（可用 `WRD_TERMINAL_PTY_KILL_WAIT_MS` 覆盖）。`waitForExit` 必须 await `exitPromise` 或等价超时，不得只 `Promise.resolve()`。单测可把 wait 设 0 并同步 emitExit，但至少一条测试用异步 onExit。

### 2.4 Watch 锁与 connector 身份

锁目录写 PID 文件；mkdir 失败时若 PID 不存在或非本 watcher，抢锁。SIGTERM 也清锁。不得在抢锁失败时对「死锁」`exit 0` 空转超过一次 tick。

`--token` 进程：拒绝 managed restart（与 `--config` 一样），或先识别再拒绝，禁止再 submit 一份 credentials-file 造成双 connector。测试允许断言该守卫存在。

### 2.5 共享会话 UX（最小）

presenter 断开：输入冻结到 reset ack，UI「控制权正在复位」。非 presenter detach 只离开观察。`activateSession` 对已附着会话不要无条件抢 presenter。断线文案「正在重新附着」。FSM 若本轮不切换 owner，至少停止声称它是运行时真相；文档改成 Panel state 为 owner，FSM 为测试 seam。

### 2.6 文档

- trycloudflare：`Unauthorized` / 过期 **不是** 自动重建授权；safe supervisor 只能在用户明确要求重建 tunnel / 重新生成公网地址后执行重建。README / 需求 / runbook 三处改成同一句。
- 后台隐藏：5 分钟后才停采集。
- 失焦：DC 开则 reset，DC 关则 park。
- Formal watch 只重启 `wrd-tunnel` **命名**隧道（`https://link.stockhub.wiki`），不碰 trycloudflare / signal / host。

## 3. 测试

1. bootstrap HTTP 500 后 `io()` 被调用一次，1s 内 bootstrap fetch ≤ 2。
2. detach 后 snapshot 不自动 attach 同一 session。
3. 异步 onExit 的 pty kill 在 waitMs=200 内标成功，不 quarantine。
4. 锁目录存在但 PID 已死时 watcher 仍能 tick。
5. presenter 断开时输入 gate 关闭直到 reset ack（若本轮做 2.5）。

不启动/重建 trycloudflare。真机 Terminal 多浏览器标 NOT RUN。

## 4. 非目标

不把 Terminal FSM 强制替换 Panel state（除非单独开一轮）。不改 DesktopControlLease。不改 awake plist 路径模板以外的 Host 睡眠策略。
