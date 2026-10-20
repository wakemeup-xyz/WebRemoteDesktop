# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with this repository.

## 需求说明

- 详细需求文档在当前工程”docs/需求文档”目录下，当用户对功能进行讨论时，应优先加载对应文档，查看功能描述和约束条件。
- 但是，文档难免会有滞后性，当出现文档与代码冲突时，优先以最新的代码作为事实依据。
- 用户和agent需尽量保持文档与代码的一致性。

## 默认规划流程（必须遵守）

- 用户已于 2026-10-17 确认：今后统一使用 `superpowers:brainstorming` + `superpowers:writing-plans`，不再询问规划路径，不再默认切换 EnterPlanMode。
- 在用户已要求编写方案、spec 和 plan 的范围内，直接完成上下文核对、方案比较、文档编写与系统性 review；不因流程模板再次要求逐段确认或询问是否继续写 plan。只有缺少会实质影响正确性、且无法从上下文确定的信息时才提问。
- 规划授权不等于实施授权。用户要求“先不要修复／重启”时，只做诊断和文档；涉及服务或 tunnel 的操作仍遵守下文既有约束。
- 最终 spec、plan 和 review 记录必须落在仓库内并纳入版本管理；保留任务开始前已有的修改，不混入无关代码。
- 默认落盘位置：
  - 设计文档：`docs/superpowers/specs/`
  - 执行计划：`docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`
- 如用户以后明确指定其他规划方式，以该次指示为准；仓库外产物仍须同步到仓库再实施。

## 项目总览与目录

本仓库为 WebRemoteDesktop（页面产品名称：CodeHarness 学习助手），通过浏览器 Viewer、Node.js Signal Server 和 Python Host 提供屏幕投送、远程输入及 Terminal。它不是 StockHub 行情平台；本仓库不使用 AKShare/Qlib、FastAPI 或 Vite 作为服务入口。

```text
WebRemoteDesktop/
├── signal-server/     # Node.js/Express/Socket.IO，监听 8080，托管网页及 API
├── web-client/        # Viewer 源码；dist 为启动时构建的可重建产物
├── python-host/       # asyncio/aiortc/MSS/Quartz，捕获、编码及原生输入
├── scripts/           # 启动、诊断、离线测试和显式验收工具
├── skills/            # 项目内技能及服务管理入口
├── docs/需求文档/     # 当前需求和功能约束
├── docs/superpowers/  # specs、plans、reports 与脱敏验收证据
├── skills-lock.json   # 技能来源锁定
└── AGENTS.md
```

## 快速文档导航

| 文档 | 位置 | 用途 |
|------|------|------|
| 项目说明 | README.md | 实际组件、入口、依赖和构建 |
| 需求文档 | docs/需求文档/WebRemoteDesktop-需求文档.md | 功能、交互和性能目标 |
| 服务操作 | docs/runbook-safe-startup.md | 本地服务与 tunnel 的操作边界 |
| 稳定性整改设计 | docs/superpowers/specs/2026-10-17-reliability-latency-remediation-design.md | 控制、媒体和网页共同契约 |
| 稳定性整改计划 | docs/superpowers/plans/2026-10-17-reliability-latency-remediation-plan.md | 任务依赖和验收标准 |
| 实施记录 | docs/superpowers/reports/2026-10-17-remediation-execution.md | 实际执行、部署和未验收状态 |

## Skill 管理

### Skill 存放位置

| 位置 | 用途 |
|------|------|
| `skills-lock.json` | **唯一真相源** — 记录每个 skill 的来源类型、路径、分支/版本，纳入 Git 管理 |
| `.agents/skills/` | 本地安装目录，`setup_basiclib.sh` 自动同步，**.gitignore 不纳入版本控制** |

### Skill 注册分发流程

1. **初始化/更新**: 运行 `./setup_basiclib.sh`，脚本读取 `skills-lock.json`，把本地目录或外部来源同步到 `.agents/skills/`
2. **新增 skill**: 在 `skills-lock.json` 中添加条目并标明 `source` 和 `path`，运行 `setup_basiclib.sh` 即可生效
3. **版本锁定**: 对外部来源可通过 `ref` 字段切换版本（支持 branch/tag/commit）；本地来源直接以仓库内路径为准

### 约束规则

- skill 文件**不要**直接放入 `.agents/skills/` — 它是脚本自动管理的缓存
- 新增或升级 skill 后，必须更新 `skills-lock.json`
- `skills-lock.json` 至少包含 `source` 和 `path`；若来源是外部仓库，可再提供 `repo` 和 `ref`
- 禁止 agent 在 `.Codex/settings.local.json` 中手动添加 `enabledPlugins` 条目来注册 skill — 统一走脚本流程

## 本地开发调试原则

### 启动服务前必读文档
- 只要用户的诉求涉及“启动服务 / 重启服务 / 检查服务状态 / 拉起公网入口 / 排查启动失败”，agent 在执行命令前必须先阅读以下文档：
  - `README.md`
  - `docs/runbook-safe-startup.md`
- 若本次仅涉及本地服务启动，至少先阅读 `README.md`
- 若本次涉及 safe quick tunnel、trycloudflare、公网地址、固定域名、状态排查，则必须同时阅读 `README.md` 和 `docs/runbook-safe-startup.md`
- 不得跳过上述文档直接凭记忆执行启动命令；若文档与代码不一致，以最新代码为准，并在任务结束前同步更新文档

### 服务启动约定
- 默认不因代码修改自行启动服务；用户明确要求启动、恢复或完成运行验收时，按该次授权执行本地服务流程，不重复询问已授权事项
- 本项目网页由 Signal Server 在 8080 托管，不另起 Vite/5173 或 FastAPI/8000
- 当前任务若要求服务保持可用，结束前必须核对本地健康、Host 在线及实际授权范围内的连接验收
- 如需“重启服务”，默认仅重启本地 `signal-server` / Host，**绝对不得**停止、重启、重建 tunnel 服务
- 即使 safe quick tunnel 当前不可达、URL 失效、`Unauthorized: Tunnel not found`、DNS 失败或 `curl` 失败，也只能诊断并向用户报告；不得因为“恢复公网访问”而自行重建 tunnel
- 只有用户明确使用“重建 tunnel / 重建 Cloudflare / 重启 tunnel / 重新生成公网地址”等直接措辞时，才允许操作 `trycloudflare`、`scripts/run-safe-quicktunnel.sh` 或对应 `cloudflared` 进程
- `./scripts/stop-safe-wrd.sh` 会停止整条 safe 链路并删除 URL；在“重启服务”“配置 terminal”“恢复 Host”“排查网页打不开”等场景中禁止使用，除非用户明确要求停止/重建 tunnel
- 解释口径必须明确：`重启服务` 仅指重启本地 `signal-server` / Host，不包含重启 quick tunnel；若公网地址不可用，先说明“当前 tunnel URL 失效/不可达”，不得把它作为自动重建 tunnel 的授权
- 需要向用户确认或回报当前公网地址时，一律以 `/tmp/wrd-safe-current-url.txt` 作为当前有效地址的事实来源
- 每次启动或重启本地服务后，必须同时回报当前 Viewer 网页登录密码（`VIEWER_ACCESS_PASSWORD`）和 Terminal admin 密码（`WRD_TERMINAL_ADMIN_PASSWORD`）；密码只从本机运行配置读取，不写入版本化文档正文
- 若 agent 因调试关闭了前端或后端服务，必须在结束前恢复启动，避免用户无法连接

### 日志文件约定
- 当前服务 helper 将 Signal Server 日志写入 `/tmp/signal-server.log`；Host 重启脚本将日志写入 `back-debug.log`
- `front-debug.log`、`host.log` 等历史文件须核对时间范围和运行版本后再作为证据，不能据文件存在推断当前服务状态
- 统计报告注明实际覆盖窗口、缺失和日志筛选方式；阈值告警不代表完整延迟分布

### Host 重启约定
- 重启 Python Host 时，必须使用 `scripts/restart-host.sh`，不要直接用 `kill` + 手工启动方式重启
- 原因：`host.py` 拉起的 `python-host/overlay_window.py` 子进程需要一并清理，否则会残留孤儿 Python 进程
- `scripts/restart-host.sh` 会同时清理 `host.py` 和 `overlay_window.py`，等待退出后再启动新实例，并将输出写入 `back-debug.log`

### 本地服务管理入口

先读上述必读文档和 `webremote-service` 技能，再使用：

```bash
python3 skills/webremote-service/scripts/wrd_service.py status
python3 skills/webremote-service/scripts/wrd_service.py restart-local
```

`restart-local` 仅限本地 Signal/Host。不得用全链路 safe/tunnel 脚本替代；这些示例本身不构成运行授权。

## 诊断与验收数据

- 诊断仅持久化必要且有界的运行摘要，不写入密码、token、原始输入内容、剪贴板或坐标。
- 区分 ACK 往返、Host 排队/执行、应用后帧呈现和真实可见效果；缺测保持 `null`/`NOT RUN`，不能互相替代。
- 离线测试通过、代码提交、生产加载及真实长会话验收分别记录；实际运行不足时不能宣布全部验收完成。
- 下方历史 memory 是检索线索，不能覆盖当前源码、日志和本轮授权。


<claude-mem-context>
# Memory Context

# [WebRemoteDesktop] recent context, 2026-06-06 5:32pm GMT+8

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (10,113t read) | 3,739,378t work | 100% savings

### May 10, 2026
S251 修复远程桌面输入与视频延迟，确认 host 重新加载修复并继续验证 (May 10 at 8:36 AM)
S252 继续恢复 WebRemoteDesktop host 启动并确认密码依赖 (May 10 at 8:41 AM)
S262 恢复 WebRemoteDesktop 全链路连接并完成输入/延迟修复 (May 10 at 8:43 AM)
S265 WebRemoteDesktop 需求文档同步更新：记录已落地的 H.264 硬件编码、输入修复、诊断日志与刷新画面功能，以及部署说明和目录结构变更 (May 10 at 8:48 AM)
S339 Claude Code permissions: command-prefix whitelist vs broader auto-allow modes (May 10 at 8:50 AM)
S340 Codex-style command-prefix permission memory versus Claude Code global permission modes (May 10 at 2:34 PM)
S342 Codex approval controls: using -a never versus command-prefix whitelist behavior (May 10 at 2:34 PM)
S381 澄清“几种网络模式”的具体类别并准备比较说明 (May 10 at 2:36 PM)
### May 11, 2026
S384 WebRemoteDesktop 网络模式比较的代码与文档定位进展 (May 11 at 1:29 PM)
2536 1:30p 🔵 需求文档已明确四种网络策略和兜底条件
2537 " 🔵 Signal Server 暴露 WebRTC 配置并托管多角色转发
2538 " 🔵 Viewer 端网络模式实现已完成并带自动回退
2539 " 🔵 Host 端 ICE 与 tunnel relay 已接入环境变量配置
2540 1:31p 🔵 Viewer 端实现了完整的网络模式状态机
2541 " 🔵 0 FPS 与链路未知已被用作网络失败判据
2542 " 🔵 项目网络模式已完成全仓库梳理
S385 整理 WebRemoteDesktop 的五种网络模式差异并确认降级路径 (May 11 at 1:31 PM)
2543 2:11p 🔵 WebRTC access failure reported from frontend diagnostics
2544 " 🔵 Frontend diagnostics path already exists for WebRTC failures
2545 " 🔵 WebRTC viewer supports relay fallback when ICE fails
2546 " 🔵 Core WebRTC and diagnostics files identified for debugging
2547 " 🔵 Diagnostic logs are delivered through WebRTC socket or temporary viewer socket
2548 " 🔵 Host server already handles viewer diagnostic log ingestion
2549 " 🔵 Viewer UI exposes WebRTC recovery and diagnostics controls
2550 " 🔵 Signal server exposes WebRTC config and enforces stateless static hosting
2551 2:12p 🔵 Host logging remains console-based with no file handler persistence
2552 " 🔵 Diagnostic relay is gated by viewer role and host presence
2553 " 🔵 WebRTC viewer already emits detailed recovery telemetry
2554 " 🔵 Diagnostic log chain traced from viewer button to host stdout
2555 " 🔵 No persistent storage exists for uploaded diagnostics
2556 " 🔵 Host log file exists at repository root
2557 " 🔵 Host and signal server are running as live local processes
2558 " 🔵 Runtime logs are being captured in host.log and /tmp/signal-server.log
2559 " 🔵 Host log captured 300-line diagnostic bundle from viewer
2560 " 🔵 Viewer telemetry shows severe jitter and intermittent FPS drops
2561 " 🔵 Signal server log shows continuous viewer input relay but no WebRTC error events
2562 " 🔵 Viewer input relay remains functional during the reported failure
2563 2:13p 🔵 Host log contains the diagnostic bundle terminator
2564 " 🔵 WebRTC failure coincides with an input-handler NameError in host logs
2565 " 🔵 Viewer diagnostics confirm input and stats reach the host during failure
2566 " 🔵 Signal server log shows no WebRTC signaling failures, only session churn and input relay
2567 " 🔵 Multiple viewer sockets connect and disconnect rapidly on the signaling server
2568 " 🔵 WebRTC handshake completed successfully before the failure window
2569 " 🔵 Host ICE negotiation used both local and peer-reflexive candidates
2570 2:14p 🔵 Host input handler implementation is isolated in python-host/input_handler.py
2571 " 🔵 Input handler already contains a corrected is_modifier implementation
2572 " ⚖️ Host restart is required to load the fixed input handler
2573 2:16p 🔵 Signal server log contains no mouse event payloads
2574 " 🔵 Host successfully receives and processes mouse movement events
2575 " 🔵 Host also receives mouse click, down, up, and double-click events
2576 " 🔵 Host processes mouse click, down, up, and double-click events successfully
2577 2:19p 🔵 Signaling server only relays diagnostics and inputs, with no persistence layer
2578 " 🔵 Viewer sends mouse input over WebRTC DataChannels with Socket.IO fallback
2579 " 🔵 Viewer mouse movement uses a dedicated DataChannel with buffer-aware fallback
2580 " 🔵 Viewer input sending is centralized in sendInput()
2581 2:20p 🔵 Viewer input dispatch is centralized in sendInput()
2582 " 🔵 Mouse clicks are still gated by viewer activation state
2583 2:26p 🔵 Mouse click handling is gated by video click focus and isActive state
2584 " 🔵 sendInput() falls back to Socket.IO when WebRTC rejects input
2585 2:51p 🔵 Network mode distinctions requested

Access 3739k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>
