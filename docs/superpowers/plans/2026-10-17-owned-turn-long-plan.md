# TURN 长会话监督器增量计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 将已运行过的私有归属监督器用于三小时TURN连续性验收，故障后只取一次线程栈。

**Architecture:** 仅扩展两个受控时长/触发条件及显式Host身份，原helper未改。修正已有两个P3测试缺口。

**Tech Stack:** Python3.11、现有psutil和macOS sample。

**Spec:** docs/superpowers/specs/2026-10-17-owned-turn-long-design.md

## Global Constraints

- 只修改/tmp/wrd-owned-turn-probe-private/supervisor.py与test_supervisor.py以及本任务私有report；不改仓库源码/index/生产服务，不启动live浏览器/sample/网络，不安装依赖，不spawn子agent。
- 既有private0700/0600、helper/sampler固定SHA、可靠身份清理、一次性proof全部保留。

### Task 1: 两个固定时长和P3回归

**Files:** Modify private supervisor.py/test_supervisor.py; report .superpowers/sdd/2026-10-17-owned-turn-long-plan/task-1-report.md.

**Interfaces:** 原CLI继续接受--output-dir及--duration-seconds；duration仅300/10800。--host-pid必填正整数，仍匹配两份PID文件。原helper原样接收选择的duration。Root负责未来live invocation。

- [ ] 读spec与/tmp/wrd-owned-turn-probe-review.md；先补新行为RED和P3测试。
- [ ] 最小修改duration绑定、deadline=duration+300、short>2000/long>=5000单次触发，preflight/final明确kind/triggered。
- [ ] offline GREEN，含原回归、sample在cleanup内超时、RLIMIT和全部临时合成文件私有权限。
- [ ] self-review报告hash/测试/边界；不commit私有代码、不执行live。

### Task 2: controller复核与运行

- [ ] 独立task review，通过后归档脱敏结果。
- [ ] 最终Host部署后核验fresh zeroViewer和身份，再运行一次10800秒；期间不重载生产和跑重测试，不拼接短测，不掩盖失败。
