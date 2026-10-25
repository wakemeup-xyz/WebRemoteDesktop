# Reboot Autostart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 修复用户登录后 Signal、Host 与正式入口的持久恢复路径，并完成隔离测试。

**Architecture:** 两个缺失的服务使用持久用户 LaunchAgent。现有运维入口共用这些配置；统一安装器只写配置、只读检查不激活任何服务。Host、awake、watch 保留已有职责。

**Tech Stack:** Python stdlib/plistlib/unittest，bash，Node test runner，macOS launchd。

**Spec:** `docs/superpowers/specs/2026-10-26-reboot-autostart-design.md`

## Global Constraints

- 用户登录后恢复；FileVault/登录前不可用，不远程解锁。
- 不操作生产服务或 tunnel；不改 quick URL/PID，不恢复旧 token daemon。
- RunAtLoad=true、KeepAlive=true、ThrottleInterval=10；Signal ProcessType=Interactive。
- plist 无凭据正文；参数数组；失败回滚、精确 owner、有界健康检查。
- 本轮真实重启、正式公网画面和真实输入 NOT RUN。

### Task 1: Signal 持久启动与恢复

**Files:** 修改 `skills/webremote-service/scripts/wrd_service.py`、`wrd_service_test.py`。

**Interfaces:** 保留 `signal_launch_configuration(project_dir)`、`validate_signal_launch_inputs(project_dir)`；新增 `signal_plist_path()` 返回用户持久文件路径。统一安装器消费配置生成函数，不调用生命周期函数。

- [x] 添加反例：重启使用 `~/Library/LaunchAgents/com.webremotedesktop.signal.plist`；RunAtLoad/KeepAlive/ThrottleInterval；失败恢复原配置，首次失败不留下错误自启；probe失败不停止旧服务。
- [x] 执行 `python3 -m unittest discover -s skills/webremote-service/scripts -p '*_test.py'`，确认新反例在修复前失败。
- [x] 实现持久原子安装并保留既有 Interactive 和 legacy recovery 的诚实失败语义；本地 curl 加 `--noproxy '*' --connect-timeout 2 --max-time 3`，状态不依赖过期 PID。
- [x] 重跑同套测试并检查真实文件持久性与故障路径。

### Task 2: 正式 connector 持久启动与统一维护

**Files:** 新建 `scripts/wrd_fixed_launchagent.py`、对应 Python 测试、`scripts/run-fixed-domain-launchctl.sh`；修改 `lib-fixed-domain.sh`、`restart-fixed-domain-tunnel.sh`、`start-fixed-domain.sh` 及相应 Node tests。

**Interfaces:** `build_configuration(project_dir: Path) -> dict` 与 `validate_configuration(configuration: dict) -> None` 供安装器消费；独立 CLI 执行显式正式 connector restart。环境沿用 `CLOUDFLARED`、`CLOUDFLARED_CONFIG`、`WRD_FIXED_TUNNEL_PROTOCOL`、`WRD_FIXED_TUNNEL_NAME`、`WRD_FIXED_LABEL`、`WRD_FIXED_DOMAIN_LOG`。

- [x] 增加临时 HOME、fake launchctl/cloudflared 测试：持久配置、参数安全、重入、token/multiple-owner拒绝、probe及真实注册失败恢复、外部 owner拒绝且不 kill。
- [x] 先执行新测试记录失败，再实现 wrapper 清 token、绝对参数和 config/credential预检。
- [x] 正式维护共用持久配置与精确 label 停止，删除宽 pkill；start-fixed-domain 显式调用本地 helper 和正式 restart，保留可选 dev 提示。
- [x] 全量启动先做 formal 输入/归属及唯一 bootstrap probe；动态 fixture 验证 local 失败不动 connector、formal 失败保留 local。区分进程退出 KeepAlive 与已有健康 watcher 预算，不新增健康循环。
- [x] 执行 `python3 -m unittest discover -s scripts -p '*launchagent_test.py'` 与相关 `node --test`，确认旧 preflight 仍只读且 quick canary不变。

### Task 3: 统一配置安装与文档、集成审查

**Files:** 新建 `scripts/install-reboot-autostart.py`、`scripts/reboot_autostart_test.py`；同步 README、runbook、需求、服务技能及 `docs/superpowers/reports/2026-10-26-reboot-autostart.md`。

**Interfaces:** 安装器通过 importlib 加载 Task 1/2 的配置函数；`--check` 只读输出五个文件匹配状态和当前运行状态，`--install` 只安装文件、不执行生命周期。所有五个文件先验证再写入，写入失败逆序恢复。

- [x] 新增测试断言安装路径在临时 HOME，五个 plist 无 secret/临时目录依赖，不调用生产工具，二次安装不改文件，失败恢复旧字节，拒绝 symlink。
- [x] 执行 `python3 -m unittest discover -s scripts -p 'reboot_autostart_test.py'` 观察缺实现失败，再实现只安装/只读 CLI。
- [x] 更新健康等待的本机代理绕过和有界 curl，执行对应 Host 测试。
- [x] 独立 review 对照 spec、检查所有变更的脚本调用和回滚；修复发现后重跑覆盖测试。
- [x] 报告测试命令、数量与 NOT RUN 边界，所有 spec/plan/review 与代码一并纳入版本管理；不推送、不激活。

## 自审

Task 1 的持久配置函数由 Task 3 消费；Task 2 的环境接口由 shell 与 Task 3 共用。两者不互相调用；Task 3 在两者完成后集成。文档与代码保持同一安装/激活边界，离线测试不声称真实重启已验证。
