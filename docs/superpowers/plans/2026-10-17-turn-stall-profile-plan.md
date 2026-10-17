# TURN 首次停帧受控采样执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 对当前TURN停帧获取有界线程栈，并补充本次验收浏览器进程退出旁证。

**Architecture:** 私有独立supervisor运行原始helper，按OS父子关系记录归属，旁车保存诊断结果。生产源码及协议不变。

**Tech Stack:** Python3.11、现有psutil7.2.2、macOS sample、现有Playwright helper。

**Spec:** docs/superpowers/specs/2026-10-17-turn-stall-profile-design.md

## Global Constraints

- 不修改/重启Host、Signal、tunnel，不安装依赖，不业务输入，不绕过或重新领取proof。
- 所有工具仅写/tmp/wrd-owned-turn-probe-private；父目录0700、文件0600；不写repo源码/index。
- 现有helper路径 /Users/macstudio1/AI/Claude/WebRemoteDesktop/scripts/passive_session_soak.py，SHA256=2dfc5ee1e669c7f60662eb4b8cd17c1596bc146d3641845cfb12fd55d98592ed。
- Spec约束为binding。测试过程使用fake process adapter或本次owned的无网络短生命周期子进程，不能启动真实浏览器/连接服务。

### Task 1: 私有supervisor及离线回归

**Files:** Create /tmp/wrd-owned-turn-probe-private/supervisor.py and test_supervisor.py. Report .superpowers/sdd/2026-10-17-turn-stall-profile-plan/task-1-report.md.

**Interfaces:** CLI --output-dir (新的0700目录；helper写其下session子目录)，--host-pid=87412，--duration-seconds=300，--origin=https://link.stockhub.wiki。仅允许指定正式origin/mode relay，helper使用生产signal-server/.env路径；密码不经过argv。--help无副作用。Root负责真实调用。

- [ ] 阅读spec、未改helper、/tmp/wrd-owned-turn-probe-design-review.md；采用spec里无proxy的最小方案。
- [ ] 先写离线行为回归：未知父链与重用PID不signal、后代身份登记、自然失败与deadline清理、单次sample、Hostidentity变更拒绝、原helper产物不写。
- [ ] 实现最小supervisor，subprocess使用argv列表；有界输出/异常类型，独立deadline及finally；每30s只打印紧凑进度。run创建前校验helper/sampler当前SHA并记录，helperSHA不匹配拒绝；记录log inode/offset及Hostbirth以便关联。
- [ ] 执行离线测试、self-review，报告代码hash、测试、已知轮询/信号竞态边界。不提交私有脚本、不运行生产验收、不spawn子agent。

### Task 2: 独立复核和一次真实诊断（controller）

- [ ] 独立审查私有脚本/测试，修正发现。
- [ ] 当前health/Host/zeroViewer合格后运行一次300s诊断；保留所有失败、缺测和清理结果。
- [ ] 关联首次帧停滞、encoder/loop/resource窗口及sample覆盖区间；更新报告。没有stack覆盖则不宣称已定位。
