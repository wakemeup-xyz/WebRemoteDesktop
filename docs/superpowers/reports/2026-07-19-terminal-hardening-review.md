# Shared Terminal 加固 Spec/Plan Review

**日期：** 2026-07-19
**审查对象：**

- `docs/superpowers/specs/2026-07-19-terminal-hardening-design.md`
- `docs/superpowers/plans/2026-07-19-terminal-hardening-plan.md`

## 1. 审查结论

Spec 和 plan 的范围一致，覆盖上次诊断确认的 Terminal 环境、生命周期、流控、权限、认证和观测问题。独立直连 WSS、Cloudflare LAX RTT 和 tunnel 生命周期被明确排除，没有把外部部署问题伪装成代码修复项。

当前审查没有发现会阻止实施的内部矛盾。计划可以作为后续实现基线，但必须按任务顺序执行，因为 Task 1 的配置真相和 Task 2 的环境边界是后续任务的前置条件。

## 2. Findings

### F-01 [High] 输出背压必须实现为 observer 隔离

Plan 要求慢 observer 超过队列上限后 detach，而不是暂停共享 PTY。实现时不能只检查 Socket.IO 的 `writeBuffer` 长度，因为它不是稳定的 per-observer contract。必须让 `TerminalOutputDispatcher` 自己拥有每 observer 的 bounded queue、drain 状态和一次性 warning，测试必须证明其他 observer 仍按顺序收到输出。

**处理：** 已在 spec 9.2 和 plan Task 5 明确。

### F-02 [High] exited session 必须拒绝 ack

如果 `writeInput()` 在 process state 检查前发送 ack，问题仍存在。ack 必须只在 `pty.write()` 成功且 session 为 `running` 时发送；`starting`、`exited`、`failed` 都只能发 `terminal:error`。

**处理：** 已在 spec 7.3 和 plan Task 3 明确。

### F-03 [High] PTY environment 白名单不能复制 proxy/API 凭据

只删除 `JWT_SECRET` 和 password 不够。`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`SSL_CERT_FILE`、`REQUESTS_CA_BUNDLE`、`ANTHROPIC_AUTH_TOKEN`、`TICKFLOW_API_KEY` 等也不能进入网页 PTY。环境清洗后如果仍启动普通 zsh，它又会读取 `~/.zshrc` 并重新导出其中的 token，因此必须使用受控 no-rc shell 参数。

**处理：** spec 6.2 使用 allowlist 和 no-rc shell；plan Task 2 的测试覆盖 secret/token/proxy/API key 及 shell args。

### F-04 [Medium] requestId 兼容必须避免广播泄露

创建 requestId 只能回给创建者，不能放进全局 pool snapshot，否则其他浏览器可知道别人的请求关联信息。

**处理：** spec 8.1 和 plan Task 4 已规定 creator-only echo；实现 review 时必须检查两个 event alias 都遵守这一点。

### F-05 [Medium] `WRD_TERMINAL_RECORD_IO` 的兼容语义需要文档同步

当前名称容易让运维误以为可以回放完整命令。计划选择 metadata-only 是安全的，但属于语义收敛，必须在需求文档、README、runbook 和环境示例中同时更新。

**处理：** spec 2.2、11 和 plan Task 6/8 已列出。

### F-06 [Medium] route-specific limiter 测试必须隔离状态

Express limiter 的内存状态会跨测试污染。每个测试必须使用新 app/新 limiter，或显式 reset store；否则“viewer 不消耗 admin bucket”的结论不可靠。

**处理：** plan Task 6 的测试以新建 app 为默认实现方式。

### F-07 [Low] 旧事件 alias 的去重边界要留在 adapter

删除旧事件不是本计划的必要条件。实现应在 `websocket/terminal.js` 统一 canonical event，然后只在边界发 alias；前端不应同时为两个 alias 执行有副作用的 state transition。

**处理：** spec 5.1 和 plan Task 7 已明确兼容层位置。

## 3. 一致性检查

- 配置：spec 的字段与 plan Task 1 的 parser 对齐。
- 环境：spec 要求 allowlist，plan Task 2 没有使用 denylist fallback。
- 生命周期：spec 的 `processStatus` 与 plan Task 3 对齐，未复用原有 observer `status`。
- 权限：spec 要求 server-owned socket identity，plan Task 4 不再依赖浏览器 clientId 授权。
- 流控：spec 的 64 KiB 单事件限制、token bucket 和 observer queue 在 plan Task 5 分别落地。
- 指标：spec 的 bounded counters/samples 与 plan Task 6 的固定窗口一致。
- 前端：spec 的 exited/failed 禁止输入、replay 保留和 requestId 选择与 plan Task 7 对齐。
- 运行时：plan Task 8/9 明确只读检查，不会重启 signal、Host 或 tunnel。

## 4. 实施前风险

1. `node-pty` 的首次输出不一定是 shell prompt；startup readiness 应定义为“收到任意 PTY data”，不能依赖 prompt 文本。
2. 输出队列 detach 可能让用户丢失未进入 replay 的尾部数据；实现必须先把完整 chunk 放入 session replay，再决定是否向慢 observer 分发。
3. `WRD_TERMINAL_CWD` 的允许目录需要沿用当前部署边界；不能因为本次 environment 加固而扩大 shell 权限。
4. 默认关闭 polling 可能暴露某些 Cloudflare/浏览器环境的 WebSocket 配置问题；必须先在本地和 fixed-domain 做 runtime acceptance，再决定是否显式设置兼容开关。
5. 当前工作树已有无关删除、日志和多行 composer 文档变更；实施时必须按 plan 的 commit boundary 精确 staging，不得把它们混入 Terminal 加固提交。
6. 环境白名单不是 OS 级安全隔离；同一 `macstudio1` 用户下的 Terminal admin 仍能读取该用户可读文件。若产品要求对 admin 隐藏 `.env`，必须单独设计专用 OS 用户或 sandbox。

## 5. 机械检查

- placeholder scan：未发现 `TBD`、`TODO`、`FIXME` 或空实现描述。
- consistency scan：environment、lifecycle、flow-control、metrics、processStatus、requestId 和 transport policy 在 spec/plan 中均有对应任务。
- whitespace check：`git diff --check` 通过。
- no-rc proof：`/bin/zsh -f -i` 不加载当前 `python3` alias，显式 PATH 下 `command -v python3` 和 `/usr/bin/env python3` 均解析到 Homebrew Python 3.11。
- worktree safety：三个新文档均为未跟踪文件，未触碰现有无关修改。

## 6. Review verdict

`PASS WITH IMPLEMENTATION GATES`

文档可以进入实现，但每个任务必须先写失败测试，并在 Task 9 用真实新建 Terminal 做 environment、Python、exited input、metrics 和 URL unchanged 验收。没有这些运行时证据，不能宣称 Terminal 加固完成。
