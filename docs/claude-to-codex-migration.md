# Claude → Codex 迁移说明

本仓库已从 Claude Code 工作流迁移到 Codex 工作流。

## 已迁移原则

- **主指令文件**：以根目录 `AGENTS.md` 作为 Codex 的主入口说明文件。
- **需求文档入口**：功能讨论优先查看 `docs/需求文档/`，代码与文档冲突时以最新代码为准。
- **Plan 约束**：规划前必须先与用户确认规划路径；最终计划文件必须落在仓库内并纳入版本管理。
- **Skill 管理**：继续以 `skills-lock.json` 作为唯一真相源，不通过本地运行时配置手工注册 skill。当前仓库只做仓库内 `.agents/skills/` 安装，不写入 `~/.Codex/skills/`。

## Claude 遗留文件处理策略

### `CLAUDE.md`

- 保留根目录 `CLAUDE.md` 作为历史兼容文件，避免旧工作树、旧脚本或旧协作流程失效。
- 其内容应与 `AGENTS.md` 保持一致，后续若更新项目级协作说明，应优先更新 `AGENTS.md`，再视需要同步 `CLAUDE.md`。

### `.claude/`

- `.claude/settings.json`、`.claude/settings.local.json` 视为 **Claude 本地运行时遗留配置**。
- 这些文件不是 Codex 的主配置来源，不应继续作为仓库协作规范的事实依据。
- 若其中包含环境变量、PATH、工具白名单等本机信息，迁移时只保留“对项目有长期价值”的内容到仓库文档；不要把个人机器上的本地权限模型直接平移为仓库规范。

## Memory 迁移说明

当前仓库内未发现独立的项目 memory 文档（如 `memory.md`、`MEMORY.md` 等）。

因此本次迁移采用以下映射：

- 项目长期约束 → `AGENTS.md`
- 功能/产品知识 → `docs/需求文档/`
- 设计与执行计划 → `docs/superpowers/specs/`、`docs/superpowers/plans/`

如果后续需要把 Claude 会话里的外部记忆沉淀回仓库，建议新增：

- `docs/project-memory.md`：沉淀跨功能的长期决策、约束、约定
- 或按主题拆分到 `docs/architecture/`、`docs/operations/` 等目录

## 后续维护建议

- 新增项目协作规则时，先更新 `AGENTS.md`。
- 新增产品需求时，更新 `docs/需求文档/`。
- 新增设计/计划时，落盘到 `docs/superpowers/`。
- 若确认 Claude 遗留文件已不再被任何外部流程依赖，可在单独变更中删除 `.claude/` 与 `CLAUDE.md`。
