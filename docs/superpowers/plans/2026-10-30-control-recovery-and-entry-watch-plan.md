# 控制恢复、信令回退与入口监测修复计划

> 采用 superpowers brainstorming + writing-plans。用户已授权继续开发和 review；本计划不授权 tunnel 操作。

**Goal:** 消除入口监测误触发 tunnel 重启的放大器，缩短 signaling fallback 污染范围，抑制同 attempt 重复 bind，并修复媒体正常时 keyboard reset 失败后的控制恢复路径。

**Spec:** [control-recovery-and-entry-watch-design](../specs/2026-10-30-control-recovery-and-entry-watch-design.md)

## Global constraints

- 不重启、停止、重建或改写 tunnel；本轮只改 watcher 源码和客户端/Signal 逻辑，若需要加载 watcher 必须单独取得 tunnel 操作授权。
- 不发送真实业务输入，不构造乱序生产输入，不放宽 lease/attempt/seq/barrier 校验。
- 不改 `web-client/dist`，除非客户端源码发生改变且明确执行私有构建；所有服务加载版本分组件记录。
- 所有新日志只记录有限计数、状态、scope hash 和 decision metadata，不记录密码、token、原始键鼠、文本、坐标或 socket/lease 原值。

## Task 1: watcher multi-path guard

**Owner:** `fix_watcher_guard`

- [x] 复现 origin=true、formal environment TLS failure、watcher restart decision 的纯 fixture。
- [x] 分离 proxy/TLS/unknown 与 direct formal HTTP 失败；单一路径 proxy failure 不得触发 restart。
- [x] 添加连续证据/decisionId/actor metadata，保持恢复预算、锁和子进程退出证明。
- [x] 更新 Python/Node watcher 定向测试，验证 true outage 仍可产生候选 decision。

## Task 2: signaling fallback TTL and bind idempotence

**Owner:** `fix_signaling_fallback` plus root review

- [x] 复现一次 opening WS timeout 后整个 session 永久 polling-first。
- [x] 实现 fallback TTL/成功 WebSocket 清除，并保留 polling fallback；更新现有 signaling fallback tests。
- [x] 复现同 attempt 3–9次 bind，加入同 socket/attempt/seq/lease/network scope 的幂等门禁；变化 scope 仍发送一次。
- [x] 更新恢复逻辑，区分同 scope suppression 与 force late-offer rebind（metadata-only scope，未改变 wire contract）。

## Task 3: keyboard reset recovery

**Owner:** `fix_keyboard_reset_recovery`

- [x] 从 `keyboard-reset-send-failed` fixture 复现媒体 healthy + input blocked。
- [x] 保持有界安全 retry / explicit re-request 状态，不自动抢占，不重放未知业务输入；具体失败原因不再被压成 timeout。
- [x] 保持失败 tracking、seq、lease 和 reset barrier 不变；补 send/ACK/timeout/old-lease 测试。
- [x] 对 reset send/ACK/old-lease/execution failure 保留具体脱敏 reason，媒体/control gate 仍分离。

## Task 4: integration, review, and load boundary

**Owner:** root

- [x] 运行 Task1–3 定向测试、静态 diff、独立 review；不执行会发布 dist 的默认 pretest。
- [x] 若客户端源码变化，完成私有构建并原子更新 dist；确认当前 Viewer 占位，本轮暂不重启 Signal/Host，避免中断未确认会话；不操作 tunnel。每次本地重启前已读 README/runbook/服务规则。
- [x] 做 read-only watcher fixture acceptance，证明 formal proxy TLS false positive 不再触发 connector restart；实际 tunnel restart 不在本轮运行。
- [x] 更新实施报告，记录当前 Viewer 占位、日志覆盖、性能与未完成真实业务/可见效果/三小时资格。
- [x] 最终 git diff/隐私/相对链接/服务健康 review，提交 main；保持服务可用并不清理未确认的 Viewer。

执行事实（2026-10-30）：watcher/entry 36 Python tests + watch shell 26 Node tests；前端 `webrtc.test.js` 426 tests、signaling fallback/input continuity/diagnostic 156 tests通过。构建并加载 dist，buildId `2ead120ba885641c`；本地/正式 manifest一致。Watcher 仅重载 `com.webremotedesktop.fixed-watch`，未触碰 cloudflared；重载后正式 probe 为 direct、origin/formal 均 healthy、action=none。当前 Signal/Host 未重启；Viewer slot仍需确认归属。实现与review已完成，生产加载边界见[实施记录](../reports/2026-10-30-control-recovery-execution.md)。
