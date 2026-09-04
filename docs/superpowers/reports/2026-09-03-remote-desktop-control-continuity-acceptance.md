# Remote desktop control continuity acceptance

**执行日期：** 2026-09-05
**对应设计：** `docs/superpowers/specs/2026-09-03-remote-desktop-control-continuity-remediation-design.md`
**范围：** 自动化回归、active design 状态同步、正式入口和出画/SPS SLA 文档同步

## 结论

自动化范围通过，控制连续性设计已更新为“已实施（自动化范围内）”。真实 Android/iOS/iPad 浏览器、窄屏实机几何、macOS Quartz 物理输入、正式公网入口和 tunnel 媒体路径均为 **NOT RUN**；没有用桌面模拟或 health/URL 文件代替这些验收。

## 自动化结果

| 范围 | 命令 | 结果 |
|---|---|---|
| Viewer JS/CSS 全量 | `node --test web-client/js/*.test.js web-client/css/*.test.js` | **PASS** — 572 tests, 572 passed, 0 failed, 0 skipped, 0 todo |
| Signal Server（计划原命令） | `cd signal-server && npm test` | **环境阻断** — 隔离 worktree 没有 `signal-server/node_modules/esbuild`，`pretest` 在 `scripts/build-web-client.js` 以 `MODULE_NOT_FOUND` 退出；没有安装依赖或修改依赖文件 |
| Signal Server（完整套件，复用现有依赖并串行化启动） | `cd signal-server && NODE_PATH=/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/node_modules npm test -- --test-concurrency=1` | **PASS** — 323 tests, 323 passed, 0 failed, 0 skipped, 0 todo |
| Python Host 全量 | `cd python-host && PYTHONPATH=. python3 -m pytest -q` | **PASS** — 212 passed, 0 failed, 1 existing `mss.mss` deprecation warning |

补充说明：复用依赖但使用默认并行度时，Signal 的独立启动测试曾出现 `server_failed_to_start` 5 秒超时（两次尝试分别为 1/323、2/323）；独立 `terminal-bootstrap.test.js` 为 3/3。串行化完整套件通过，故将 Signal 自动化结果记为 323/323 PASS，同时保留 worktree 依赖缺失和并行启动资源争用的环境边界。

## 契约验收矩阵

以下 15 项由上述全量自动化套件覆盖，均为 **AUTOMATED PASS**：

1. 不可枚举 PointerEvent 几何仍能映射触控输入
2. `#mobileKeySurface` / 虚拟键在 pointer-disabled docks 下可命中
3. 可靠 mouse down 发送失败不烧毁 desktop sequence
4. stale-lease mouse reset 释放按钮且 offer 绑定 desktop writes
5. keyboard ACK 不清除 mouse reset barrier，重新获取 lease 可清屏障
6. 断 Socket 的 disconnected 模式切换重新进入信令连接
7. 非 signaling 阶段 loading overlay 不拦截画面输入
8. 媒体暂停不调用键盘 reset barrier
9. 未出真实帧时 connected phase 保持 media pending
10. refresh 后新 PeerConnection 从零开始的 decoded-frame baseline 可出画
11. 未有健康 8–25 FPS 样本时冷启动 SPS refresh 不触发
12. 旧 DataChannel wait timer 不会清掉新一轮 refresh
13. refresh 期间非强制恢复 refresh 被互斥门禁拒绝
14. v2 modifier payload 能释放 Host 幽灵修饰键再发送普通键
15. grant 后不重建 PC 的 DataChannel close 使用当前 lease 做 reset/释放

以下边界保持 **NOT RUN**：

- 真实 Android Chrome、iPhone Safari、iPad Safari 的触控、虚拟键和 tab-resume
- 真实窄屏浏览器几何与实体 macOS Quartz 输入（含组合键、IME、长按）
- `https://link.stockhub.wiki` 的真实公网/Cloudflare/tunnel 媒体链路

## 文档同步

- 六份 active design 已按控制连续性 spec §2.9 标记为已实施或部分实施，并明确真机/公网 NOT RUN；relay B1 记录为 relay pin `0ms`，80ms 方案废止。
- 需求文档 §5、README、safe-startup runbook 统一正式入口为 `https://link.stockhub.wiki`；`/tmp/wrd-safe-current-url.txt` 仅为临时 quick-tunnel 排障来源。
- README/runbook 明确 relay ≤2s 追帧窗口、连续 ≥2s 才显示“画面卡顿”、连续 ≥3s 进入失败诊断线，以及 Host 同尺寸 SPS 的健康样本门槛和 12s cooldown。
- 当前 remediation plan 已勾选已完成的 Task 1–5 与范围自检；物理/公网验收单独保持未勾选并标记 NOT RUN。

## 运行与提交边界

本次没有启动、停止、重启或重建 signal-server、Host、Cloudflare tunnel 或其他服务；没有执行公网或物理设备操作。提交范围仅包含本任务指定的 docs/spec/plan/report 文件。

提交消息：`docs: sync control-continuity status and record acceptance`
