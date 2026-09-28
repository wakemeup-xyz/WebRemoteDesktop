# WebRemoteDesktop 稳定性整改验收记录（2026-09-28）

## 结论

离线自动化回归通过；本次未启动 Host、Signal Server、浏览器或 Cloudflare tunnel，因此真实 TURN/Relay、公网浏览器和 30–60 分钟长跑验收标记为 `NOT RUN`，不把离线测试结果等同于公网通过。

## 已执行并通过

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| Python Host 全套 | `python3.11 -m pytest -q python-host` | `332 passed`，1 个 `mss` deprecation warning |
| Signal Server 全套 | `npm test`（含 web bundle 构建） | `365 passed` |
| 诊断告警 | `node --test test/diagnostic.test.js` | `17 passed` |
| Python 语法 | `python3.11 -m py_compile python-host/host.py python-host/h264_videotoolbox_encoder.py python-host/media_apply_coordinator.py` | PASS |
| 工作树补丁检查 | `git diff --check` | PASS |

覆盖内容包括固定 Relay policy 的码率 no-op/coalescing、真实 codec 首帧应用确认、Peer/capture/sender 释放、单 Viewer 与 lease/reset barrier、双 reset ACK 身份校验、ICE/DC 恢复状态机、诊断脱敏/持久化和告警码。

## 未执行边界

以下项目需要用户在实际运行环境中手动启动服务并从真实浏览器完成，当前记录为 `NOT RUN`：

- 真实 TURN Allocate、双方 Relay candidate 和候选对确认；
- Chrome/Chromium 跨网络 Relay 视频、输入 ACK、断网恢复；
- 30–60 分钟教学会话长跑，验证 FPS、事件循环 lag、内存和 `pendingMouseReset` 不累积；
- Cloudflare 正式域名访问和公网控制权恢复。

执行这些项目时只允许按 `docs/runbook-safe-startup.md` 重启本地 Signal/Host；不要因验收失败重建 tunnel。验收记录应附 `WRD_MEDIA_APPLY`、`WRD_ENCODER_RATE`、`WRD_ENCODER_SAMPLE`、`host_event_loop_lag`、`dc-error`、`ice-disconnected` 和 reset ACK 证据。

## 2026-09-28 现场补充结果

本次在不重建 tunnel 的前提下执行了真实浏览器和 Relay 检查，结果如下：

| 场景 | 结果 | 证据 |
|---|---|---|
| 本地 Relay 20s | `PASS`（出画、TURN relay、控制 ACTIVE） | `local-relay-20s.json` |
| 本地 Relay 离线 3s 后恢复 | `PASS`（恢复后 19 FPS、控制 ACTIVE） | `local-relay-offline-flap.json` |
| 正式域名 Relay 20s | `PARTIAL`（出画、控制 ACTIVE，最终约 16 FPS） | `public-relay-20s.json` |
| 正式域名 Relay 60s | `FAIL`（最终约 7 FPS） | `public-relay-60s.json` |

正式域名 60s 失败窗口对应 Host 日志中的编码 P95 约 264ms、单次编码约 410ms、event-loop lag 约 233ms critical、系统负载约 8–9.5。该证据说明固定 Relay 编码在当前运行环境下仍会出现 CPU/事件循环退化，Phase 2/4 不能标记为完全通过；需要继续做编码策略或运行资源隔离整改后重新长跑。

## 2026-09-29 VideoToolbox 重跑结果

已将 Relay peak 默认编码器切换为 VideoToolbox，并增加 Host 启动预热；可通过 `WRD_RELAY_PEAK_CODEC=libx264` 回退。日志确认 `WRD_VT_WARMUP success=true`，正式域名 Relay 60 秒会话完成连接、TURN 中继、视频出画和控制权保持，编码 P95 降至约 45–64ms，最大约 80ms。

本次仍未通过 18 FPS gate：最终约 9 FPS，出现一次约 389ms event-loop lag。同期主机 systemLoad1 约 17–27，WindowServer、Codex/ChatGPT、Activity Monitor 及其他 Python 任务占用大量 CPU。该结果将环境外部 CPU 争用与应用编码瓶颈区分开：VideoToolbox 已显著降低编码耗时，但当前机器无法作为干净验收环境。证据：`relay-vt-warmup-60s.json`、`relay-vt-flap.json`。
