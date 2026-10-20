# W4a — ACK 观测采样与增量字节预算

- 日期：2026-10-17。
- 任务依据：`.superpowers/sdd/2026-10-17-reliability-latency-remediation-plan/task-W4a-brief.md`。
- 已核对：任务 binding constraints、仓库 AGENTS、当前需求的诊断隐私/验收约束及稳定性整改 spec。实施起点为 `3d88e1c`，包含批准的 C/M/W3a/W3b 前置变更；初始工作树既有 README、runbook、需求及 review-anchor 修改均未纳入本任务。
- 范围：8 个 Viewer JS/测试文件；新增本报告。没有修改 wire envelope、ACK 成功判断、控制门禁、恢复、媒体/rVFC 计时或 frame metrics。

## 实现

1. 真实 Socket `input-ack` 和 DC `input_ack` 共用接收入口先截取只读摘要，再执行原有 `Input.acceptMouseAck` / `acceptKeyboardAck` 和原有 M1 分支，最后提交被动 trace。`finally` 覆盖原有 unordered/stale 提前返回，观察异常不会阻断 C/M1。未引入不存在的 `Input.onInputAck`。
2. `KeyboardTransport.peekAckMetadata()` 仅返回实际 pending 的原动作、可靠性、匹配和 attempt；不调用 expiry、不 drain、不接受 ACK、不返回输入内容。鼠标可靠匹配从真实 `_desktopWritePending` 截取。业务删除 reset pending 后，先前摘要仍能保留 reset ACK。
3. unordered 原动作缺于既有 ACK wire，因此 Input 仅为已接受、明确 `reliable:false` 的 move/wheel send 保存有界动作提示：最多 256 个 ID、10 秒 TTL；在 trace/查询时按 attempt、lease epoch 清理，ACK 后删除提示。存储只含 action、transport、scope、发送时刻及通道对象身份，不含键码、文本、坐标或原 payload；可靠匹配真值始终来自实际业务 pending。提示淘汰/过期、错误 epoch/通道、混合未知 ID 一律退为 unknown 并保留 trace。
4. 只采样明确 unordered、`applied`、move/wheel、无可靠 pending 匹配且非 late 的鼠标 ACK，新增 `counters.sampledAckEvents`。此处 `accepted:false` 可表示 C 的可靠 ledger 未匹配到 unordered move，不表示 Host 执行失败。duplicate、失败、未知、迟到、可靠/reset 都保留。采样不删除任何可靠等待记录；原 DOM/send 高频聚合保持原有计数。
5. append 只序列化/测量当前 public event，缓存字节数；包括每条分隔符和 2 KiB header/counter/schema3 余量。哈希完成只更新对应 live entry 的长度，已淘汰项不会复活，未完成哈希继续占有并发槽。snapshot 最后独立做 UTF-8 全量上限检查并按实际淘汰更新 droppedEvents。schema1 和可选 schema3/bootIdHash 保持兼容。

## RED

命令：

```sh
node --test web-client/js/input-trace.test.js web-client/js/input-recovery.test.js web-client/js/webrtc.test.js
```

输出摘要（`/tmp/w4a-red.log`，exit 1）：295 tests / 290 pass / 5 fail。

- 新 unordered ACK 反例：`sampledAckEvents` 为 undefined，期望 1000。
- 新增量计费反例：byteLength 注入计数为 0，期望 append 后为 1。
- 两个真实 Socket/DC 接收入口反例：实际顺序缺少 peek/trace，期望 `peek → mouse → keyboard → latency → trace`。
- 第 5 项为已存在的 frame trace fixture 失败：`webrtc.test.js:345` 缺真实 receiver identity，matched.length 为 0、期望 1。root 单独提交 `3bcb5d6` 给 fixture 补充匹配的 video track / receiver SSRC 与显式诊断启用；本任务没有纳入该独立 hunk。

## GREEN

最终命令（在 root 独立 fixture 修复后）：

```sh
node --test web-client/js/input-trace.test.js web-client/js/input-recovery.test.js web-client/js/webrtc.test.js web-client/js/keyboard-transport.test.js
```

最终输出见 `/tmp/w4a-green-verified.log`：327 tests / 327 pass / 0 fail，exit 0。

补充定向命令：

```sh
node --test --test-name-pattern='unordered hints|peekAckMetadata' web-client/js/input-recovery.test.js web-client/js/keyboard-transport.test.js
node --test web-client/js/input-trace.test.js
```

输出分别为 2/2 pass、17/17 pass。最终 own-file `git diff --check` 通过。

## 行为与成本证据

- 真实 VM Socket/DC 注册 handler 各回放 1000 次；legacy 路径的 mouse、keyboard、M1 onInputAck 每路各收到 1001 次（含最先一条 reset），trace 在所有消费者之后，1000 条 unordered 仅增加 sampledAckEvents。
- 真实 Input + M1 的 v2 Socket/DC 路径各发送并接收 1000 个 move，可靠鼠标业务入口 1001 次、unordered M1 1000 次、M1 onInputAck 1001 次（含最先一条真实可靠 reset）；v2 mouse 按原规则不会调用 keyboard。真实 reset ACK 后实际 pending 已删除，其 trace 动作仍为 reset，reset timeout 也仍保留。
- 注入 byteLength：两次 append 恰好两次当前 event 测量；一个异步哈希完成再增加一次对应 event 测量；淘汰后的哈希完成不再测量/插入。没有机器耗时门槛。
- 覆盖 256 event / 64 KiB / 64 hash / 256 pending 上限、乱码/孤立 surrogate 金丝雀、hash 晚到与环淘汰、故意低估缓存后 snapshot 独立裁剪、duplicate/late/timeout、scope/TTL/通道身份负路径，以及观察异常隔离。
- 纯 keyboard peek 测试将时钟推进至过期后查询，仍得到原 pending，且返回值修改不污染内部记录；恢复时钟后状态、pending 与发送数均未变。

## 自查与限制

- 自查 ACK 顺序、source 保留、原 M1 validated/unordered 分支及错误处理、直接调用 Input 的 trace 兼容、真实可靠 pending 先读后删、公开字段白名单与哈希 live 标志；未发现本任务遗留缺陷。
- 仍是 offline synthetic / VM / fake-clock 证据。真实公网、浏览器设备、Quartz/原生输入、光学效果、生产 Viewer 与长会话：**NOT RUN**。
- 未启动/重启任何服务、Viewer、tunnel；未联网抓屏或触发原生输入；未构建 dist、安装依赖或运行压力/全仓测试。
- 工作树其他任务/既有修改保持原样。本报告同步至忽略的任务工作目录作交接，版本化真本在 `docs/superpowers/reports/2026-10-17-task-W4a-report.md`，未 force-add 忽略文件。
