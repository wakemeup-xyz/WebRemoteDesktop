# TURN 长会话监督器增量计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 将已运行过的私有归属监督器用于三小时TURN连续性验收，故障后只取一次线程栈。

**Architecture:** Task1扩展受控时长/触发及Host身份；Task3只给原helper增加向后兼容关闭码诊断，不改变连接行为。

**Tech Stack:** Python3.11、现有psutil和macOS sample。

**Spec:** docs/superpowers/specs/2026-10-17-owned-turn-long-design.md

## Global Constraints

- Task1只修改/tmp/wrd-owned-turn-probe-private/supervisor.py与test_supervisor.py以及本任务私有report；Task3只改下列验收工具与测试，由指定单写者管理index。实施者均不得操作生产服务、live浏览器/sample/网络、依赖安装或再spawn子agent。
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

### Task 3: 最小关闭码诊断（Task2失败后所需）

**Files:** Modify `scripts/passive_session_sampler.js`, `scripts/passive_session_soak.py`; tests `scripts/passive-session-sampler.test.js`与`scripts/test_passive_session_soak.py`。
**Interfaces:** ec事件可选`ws:{code:1006,wasClean:false}`；其他数据/准入接口不变。

- [ ] RED：mock engine `close('transport close',{description:'websocket connection closed',context:{code:1006,wasClean:false}})`，期望ec ws；原sampler遗漏。Python validator对合法ws原本拒绝，补跨语言fixture。
- [ ] projector用try/catch仅在固定reason/description门控读取code和wasClean，全部验证后返回`{r:'transport-close',ws:{code,wasClean}}`；无效时仅原r。禁止读取rawreason/error或保留context对象。
- [ ] Python `validate_event`只在ec且存在ws时把ws加入允许keys，`exact_keys(ws,{'code','wasClean'})`，`type(code) is int and 1000 <= code <= 4999`且`type(wasClean) is bool`；保持原192B和schema1。
- [ ] GREEN覆盖正常1000/true、异常1006/false、缺失和getter抛错、NaN/float/bool-code/string-bool/范围错误、额外键/错误事件类型拒绝；保留firstDisconnectEvent不覆写、旧事件可读、delta/final容量；只跑离线定向Node/Python测试，不构建dist。
- [ ] 只提交工具/测试，独立task review。root更新私有supervisor两项固定hash及fakefixture验证后才允许未来调用；不因工具更新重载服务，不改已保存run。当前Task2三小时验收仍open。
