# Sample Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** 修复采样超时的误报时间，保留有界诊断以判断零字节失败。
**Architecture:** 私有supervisor的非阻塞poll/pipe增量；原helper产物只读。
**Tech Stack:** Python3.11、psutil、subprocess、os。
**Spec:** `docs/superpowers/specs/2026-10-17-sample-observation-design.md`

## Global Constraints

- 实施者只改`/tmp/wrd-owned-turn-probe-private/supervisor.py`和原离线测试；禁止生产采样/服务/网络/Viewer/nativeinput。
- 不更改10秒预算、helper/sampler固定hash、原产物、proof策略、Host校验或已验证进程归属清理逻辑。
- raw仅0600私有保存，root复审后归档脱敏实现报告，不把原始stack/诊断存入仓库。

### Task 1: 单次采样生命周期观测

- [ ] fake clock/process复现：采样在10秒timeout、10.25秒观察退出、worker到100秒结束，首次退出时间必须保持10.25，不得变100；timeout结果和kill尝试分别保留。
- [ ] 增加`timeoutDetectedEpoch/Monotonic`、`exitObservedEpoch/Monotonic`、`finalizedEpoch`，缺测null，不保留有歧义的finishedEpoch。每轮无论timeout与否poll；第一次code非None才锁定退出观测。
- [ ] `Popen(stdout=PIPE, stderr=STDOUT)`后用`os.set_blocking(fd, False)`；每check先deadline/poll，再最多65536bytes非阻塞read，缓存上限16384bytes；超额累计discarded不缓存。收尾关闭pipe，原始prefix独占创建0600。
- [ ] 测试普通退出、timeout后退出、未观察退出、重复finalize、overflow/EAGAIN/EOF与读错误；assert prefix上限和单轮读取上限，无无限循环；原16项回归维持。
- [ ] 私有文件sha256和测试结果交独立review，不触碰git index。root通过后只做一次自建sleep子进程能力检查；确认问题阶段后再决定是否需要Host下一次采样，不自动启动新长测。
