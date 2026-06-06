# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with this repository.

## 需求说明

- 详细需求文档在当前工程”docs/需求文档”目录下，当用户对功能进行讨论时，应优先加载对应文档，查看功能描述和约束条件。
- 但是，文档难免会有滞后性，当出现文档与代码冲突时，优先以最新的代码作为事实依据。
- 用户和agent需尽量保持文档与代码的一致性。

## Plan 路径与流程确认规范（必须遵守）

- 进行规划前，agent 必须先与用户确认规划路径：
  1. EnterPlanMode（Codex 内置，产物在 `~/.Codex/plans/`）
  2. superpowers:brainstorming + superpowers:writing-plans（产物在 `docs/superpowers/`）
- 未经用户确认，不得自行选择规划路径。
- 无论采用哪种规划方式，最终计划文件必须落在仓库内并纳入版本管理。
- 推荐落盘位置：
  - 设计文档：`docs/superpowers/specs/`
  - 执行计划：`docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`
- 若 EnterPlanMode 产物出现在 `~/.Codex/plans/`，需在继续实施前同步/迁移到仓库内对应路径。

## 项目目录结构

```
/Users/macstudio1/AI/Codex/StockHub/
├── basiclib/         # 基础依赖库（从GitHub拉取）
│   ├── akshare/     # 金融数据接口库
│   ├── qlib/        # 量化投资平台
│   └── tickflow/    # TickFlow Python SDK
├── backend/          # 后端服务（Python + FastAPI）
│   └── AGENTS.md    # 后端技术约束文档
├── frontend/         # Web前端应用
│   └── AGENTS.md    # 前端技术约束文档
├── docs/            # 项目文档
│   └── 需求文档/    # 产品需求文档
│       ├── 项目总需求.md
│       ├── 后端模块/
│       ├── 前端模块/
│       └── API接口/
├── demo/            # 网页Demo输出目录
│   └── YYYY-MM-DD/  # 按日期组织
└── AGENTS.md        # 本文件 - 项目总入口
```

## 文档分层说明

| 文档类型 | 位置 | 内容偏向 |
|---------|------|---------|
| 根目录 AGENTS.md | ./ | 项目总览 + 目录结构 + 各部分入口链接 |
| 后端 AGENTS.md | backend/AGENTS.md | 后端技术栈 + 目录结构 + 开发规范 + 编码规范 |
| 前端 AGENTS.md | frontend/AGENTS.md | 前端技术栈 + 目录结构 + 开发规范 + 编码规范 |
| 需求文档 | docs/需求文档/ | 产品视角的功能需求、菜单结构、业务逻辑 |

## 项目总览

本项目旨在建设一个专业的股市行情和基本面分析平台，包含以下主要组成部分：

- **akshare/** - 金融数据接口库（获取市场数据）
- **qlib/** - 量化投资平台（AI驱动的量化分析）
- **backend/** - 自定义后端服务（Python + FastAPI）
- **frontend/** - Web前端应用（用户交互界面）
- **docs/** - 项目文档（需求文档）

它们是互补的关系：AKShare获取数据 → Qlib分析数据 → Backend提供服务 → Frontend展示结果。

## 快速文档导航

| 文档类型 | 位置 | 说明 |
|---------|------|------|
| 项目总需求 | docs/需求文档/项目总需求.md | 业务概述、菜单结构、用户故事 |
| 后端需求 | docs/需求文档/后端模块/后端总需求.md | 后端模块详细需求（产品视角） |
| 前端需求 | docs/需求文档/前端模块/前端总需求.md | 前端模块详细需求（产品视角） |
| 前后端对应关系 | docs/需求文档/前后端模块对应关系.md | 前后端模块和API对应关系 |
| 指数配置规范 | docs/需求文档/指数配置规范.md | 指数配置文件格式和动态加载机制 |
| 后端技术约束 | backend/AGENTS.md | 后端技术栈、代码结构、开发规范 |
| 前端技术约束 | frontend/AGENTS.md | 前端技术栈、代码结构、开发规范 |

## AKShare (basiclib/akshare/)

### 源代码位置
AKShare源代码位于：`basiclib/akshare/`（项目内 basiclib 目录）

### 常用命令

```bash
# Install (editable)
cd basiclib/akshare
pip install -e .

# Lint/format
ruff format .
ruff check .
```

AKShare是一个全面的金融数据源库，支持股票、期货、债券、期权、外汇、宏观经济等多种数据类型，所有数据都以pandas DataFrame格式返回。

如需查看AKShare的源代码或了解其API实现，请访问 `basiclib/akshare/` 目录。

## Qlib (basiclib/qlib/)

### 源代码位置
Qlib源代码位于：`basiclib/qlib/`（项目内 basiclib 目录）

### 常用命令

```bash
# Build Cython extensions (required before first run)
cd basiclib/qlib
make prerequisite

# Install
make install

# Lint
make lint

# Test
pytest
```

Qlib是微软开源的AI导向量化投资平台，提供数据处理、模型训练、回测等全流程支持。

如需查看Qlib的源代码或了解其量化模型实现，请访问 `basiclib/qlib/` 目录。

## TickFlow (basiclib/tickflow/)

### 源代码位置
TickFlow SDK源代码位于：`basiclib/tickflow/`（项目内 basiclib 目录）

TickFlow 是一个 Python 金融数据 SDK，提供 A股/港股/美股的实时行情、K线、财务数据、盘口深度等接口。

如需查看 TickFlow 的源代码或 API 实现，请访问 `basiclib/tickflow/` 目录。

## Skill 管理

### Skill 存放位置

| 位置 | 用途 |
|------|------|
| `skills-lock.json` | **唯一真相源** — 记录每个 skill 的 GitHub 仓库、路径、分支，纳入 Git 管理 |
| `.agents/skills/` | 本地缓存目录，`setup_basiclib.sh` 自动从 GitHub 拉取，**.gitignore 不纳入版本控制** |
| `~/.Codex/skills/` | Codex 运行时读取的 skill 目录，由脚本自动同步 |

### Skill 注册分发流程

1. **初始化/更新**: 运行 `./setup_basiclib.sh`，脚本读取 `skills-lock.json`，从 GitHub 拉取指定仓库的指定子目录，同步到 `~/.Codex/skills/`
2. **新增 skill**: 在 `skills-lock.json` 中添加条目（repo + path + ref），运行 `setup_basiclib.sh` 即可生效
3. **版本锁定**: 修改 `skills-lock.json` 中的 `ref` 字段即可切换 skill 版本（支持 branch/tag/commit）

### 约束规则

- skill 文件**不要**直接放入 `.agents/skills/` — 它是脚本自动管理的缓存
- 新增或升级 skill 后，必须更新 `skills-lock.json`
- `skills-lock.json` 格式: `{"skills": {"<name>": {"repo": "...", "path": "...", "ref": "main"}}}`
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
- 用户会使用独立的终端手动启动**前端服务**和**后端服务**
- 每次完成任务后，不用主动启动新的服务
- 如需要测试，请告知用户手动启动服务
- 如需“重启服务”，默认仅重启前端和后端，不要主动重启 tunnel 服务
- 若 agent 因调试关闭了前端或后端服务，必须在结束前恢复启动，避免用户无法连接

### 日志文件约定
- 前端服务的日志文件存放位置：`front-debug.log`
- 后端服务的日志文件存放位置：`back-debug.log`
- 服务启动时使用重定向将控制台日志写入上述文件
- 如需debug，可查看这些日志文件获取相关信息

### Host 重启约定
- 重启 Python Host 时，必须使用 `scripts/restart-host.sh`，不要直接用 `kill` + 手工启动方式重启
- 原因：`host.py` 拉起的 `python-host/overlay_window.py` 子进程需要一并清理，否则会残留孤儿 Python 进程
- `scripts/restart-host.sh` 会同时清理 `host.py` 和 `overlay_window.py`，等待退出后再启动新实例，并将输出写入 `back-debug.log`

### 启动命令示例
- 前端：`npm run dev 2>&1 | tee ../front-debug.log`
- 后端：`python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000 2>&1 | tee ../back-debug.log`

## 数据本地化策略

- **数据尽量落库**：所有可获取的数据优先持久化到 MySQL，即使前端暂不展示
- **原因**：除网页展示外，后续还要对接大模型进行股票和财务分析，需要本地化存储作为数据基础
- **原则**：只有极少数实时快照类数据（如盘中实时行情）不落库，其余数据一律同步到 MySQL


<claude-mem-context>
# Memory Context

# [WebRemoteDesktop] recent context, 2026-06-06 2:44pm GMT+8

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
