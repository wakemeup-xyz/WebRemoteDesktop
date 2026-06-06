# CLAUDE.md

> 兼容说明：本仓库已迁移到 Codex，当前协作规则以 `AGENTS.md` 为准。
> 如需查看迁移策略，请参考 `docs/claude-to-codex-migration.md`。


This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## 需求说明

- 详细需求文档在当前工程”docs/需求文档”目录下，当用户对功能进行讨论时，应优先加载对应文档，查看功能描述和约束条件。
- 但是，文档难免会有滞后性，当出现文档与代码冲突时，优先以最新的代码作为事实依据。
- 用户和agent需尽量保持文档与代码的一致性。

## Plan 路径与流程确认规范（必须遵守）

- 进行规划前，agent 必须先与用户确认规划路径：
  1. EnterPlanMode（Claude Code 内置，产物在 `~/.claude/plans/`）
  2. superpowers:brainstorming + superpowers:writing-plans（产物在 `docs/superpowers/`）
- 未经用户确认，不得自行选择规划路径。
- 无论采用哪种规划方式，最终计划文件必须落在仓库内并纳入版本管理。
- 推荐落盘位置：
  - 设计文档：`docs/superpowers/specs/`
  - 执行计划：`docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md`
- 若 EnterPlanMode 产物出现在 `~/.claude/plans/`，需在继续实施前同步/迁移到仓库内对应路径。

## 项目目录结构

```
/Users/macstudio1/AI/Claude/StockHub/
├── basiclib/         # 基础依赖库（从GitHub拉取）
│   ├── akshare/     # 金融数据接口库
│   ├── qlib/        # 量化投资平台
│   └── tickflow/    # TickFlow Python SDK
├── backend/          # 后端服务（Python + FastAPI）
│   └── CLAUDE.md    # 后端技术约束文档
├── frontend/         # Web前端应用
│   └── CLAUDE.md    # 前端技术约束文档
├── docs/            # 项目文档
│   └── 需求文档/    # 产品需求文档
│       ├── 项目总需求.md
│       ├── 后端模块/
│       ├── 前端模块/
│       └── API接口/
├── demo/            # 网页Demo输出目录
│   └── YYYY-MM-DD/  # 按日期组织
└── CLAUDE.md        # 本文件 - 项目总入口
```

## 文档分层说明

| 文档类型 | 位置 | 内容偏向 |
|---------|------|---------|
| 根目录 CLAUDE.md | ./ | 项目总览 + 目录结构 + 各部分入口链接 |
| 后端 CLAUDE.md | backend/CLAUDE.md | 后端技术栈 + 目录结构 + 开发规范 + 编码规范 |
| 前端 CLAUDE.md | frontend/CLAUDE.md | 前端技术栈 + 目录结构 + 开发规范 + 编码规范 |
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
| 后端技术约束 | backend/CLAUDE.md | 后端技术栈、代码结构、开发规范 |
| 前端技术约束 | frontend/CLAUDE.md | 前端技术栈、代码结构、开发规范 |

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
| `~/.claude/skills/` | Claude Code 运行时读取的 skill 目录，由脚本自动同步 |

### Skill 注册分发流程

1. **初始化/更新**: 运行 `./setup_basiclib.sh`，脚本读取 `skills-lock.json`，从 GitHub 拉取指定仓库的指定子目录，同步到 `~/.claude/skills/`
2. **新增 skill**: 在 `skills-lock.json` 中添加条目（repo + path + ref），运行 `setup_basiclib.sh` 即可生效
3. **版本锁定**: 修改 `skills-lock.json` 中的 `ref` 字段即可切换 skill 版本（支持 branch/tag/commit）

### 约束规则

- skill 文件**不要**直接放入 `.agents/skills/` — 它是脚本自动管理的缓存
- 新增或升级 skill 后，必须更新 `skills-lock.json`
- `skills-lock.json` 格式: `{"skills": {"<name>": {"repo": "...", "path": "...", "ref": "main"}}}`
- 禁止 agent 在 `.claude/settings.local.json` 中手动添加 `enabledPlugins` 条目来注册 skill — 统一走脚本流程

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

### 日志文件约定
- 前端服务的日志文件存放位置：`front-debug.log`
- 后端服务的日志文件存放位置：`back-debug.log`
- 服务启动时使用重定向将控制台日志写入上述文件
- 如需debug，可查看这些日志文件获取相关信息

### 启动命令示例
- 前端：`npm run dev 2>&1 | tee ../front-debug.log`
- 后端：`python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000 2>&1 | tee ../back-debug.log`

## 数据本地化策略

- **数据尽量落库**：所有可获取的数据优先持久化到 MySQL，即使前端暂不展示
- **原因**：除网页展示外，后续还要对接大模型进行股票和财务分析，需要本地化存储作为数据基础
- **原则**：只有极少数实时快照类数据（如盘中实时行情）不落库，其余数据一律同步到 MySQL
