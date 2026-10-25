# Reset Fence and Admission Timing Implementation Plan

> **For agentic workers:** 使用superpowers:subagent-driven-development逐任务实施并独立复核。用户已授权继续完成代码、main与维护验收，不重复询问流程确认。

**Goal:** 让成功mouse reset一次提交单调屏障、拒绝含糊重复确认，并补Host外层排队实测。

**Architecture:** 只改Host侧纯状态、native完成后的提交和低频日志。保留唯一Socket请求、当前DC成功ACK镜像、FIFO、原barrier与Viewer/Signal协议。

**Tech Stack:** Python asyncio、纯模型/AST fake-native测试、现有owned浏览器验收。

**Spec:** [reset-fence-admission-design](../specs/2026-10-25-reset-fence-admission-design.md)

## Global Constraints

- 不复制请求，不向生产发送业务输入或构造乱序，不重放不确定输入；不重启或重建tunnel。
- 只有native成功且commit fence通过才能提交reset屏障及证明；普通写入保持严格连续。
- 有界reset证明仅驻内存且不暴露snapshot；旧lease清空。不同ID/无证明的旧seq reset返回resync-required。
- 原hostQueueMs与RTT意义不变；hostAdmissionWaitMs只做Host同钟日志。无数据保持null。
- main源提交、各组件加载、离线通过、真实运行分开记录；健康200ms SLO与业务可见效果不预先声明。

### Task 1: Reset native提交与成功证明

**Files:** 修改`python-host/remote_desktop_write_state.py`、`remote_keyboard_state.py`、`input_handler.py`；扩展对应纯模型与`test_input_timing_contract.py`/专用AST测试。

**Interfaces:** 新增`ReliableDesktopWriteState.commit_reset(data) -> DesktopWriteResult`。InputHandler仅在执行锁内native成功和commit fence通过之后调用；普通commit接口不变。keyboard apply继续自己完成native提交。

- [x] 先复现失败：state.last=1时有效mouse reset seq3应validate applied且尚未推进；native成功commit_reset后last=3，晚到普通seq2不执行。普通command seq3仍gap。
- [x] 写失败反例：普通down seq2已提交后，不同ID reset seq2应resync-required；同ID已执行reset副本duplicate；transition后旧证明失效；native失败/stale fence没有提交或证明。
- [x] fake mouse release抛异常后tracking仍保留、重试确实再次释放；keyboard lifecycle reset/transition部分keyup失败不成功、不安装新lease。只提取AST或纯model，不导入Quartz。
- [x] legacy显式及transport-change reset失败后，不推进未提交的host-owned序号；测试下一次keyup或同transport重试可以真实释放，不永久gap。
- [x] 实施最小逻辑：reset validate允许向前跳；commit_reset复核并保存有界seq/ID证明；keyboard同样只对自己已执行reset返回positive duplicate。InputHandler按action选择提交函数。
- [x] 跑对应纯模型与AST fake-native回归，独立review证明不会越过在途native、普通seq不放宽、证明不外泄。

示例最小断言：

```python
state = ReliableDesktopWriteState()
state.transition(lease_id=LEASE_ID, lease_epoch=4)
reset = write(action='reset', seq=3, input_id='fence', payload={'reason': 'manual'})
assert state.validate(reset).status == 'applied'
assert state.snapshot().last_applied_seq == 0
assert state.commit_reset(reset).status == 'applied'
assert state.snapshot().last_applied_seq == 3
assert state.validate({**reset, 'inputIds': ['different']}).status == 'resync-required'
```

### Task 2: 外层准入等待低频观测

**Files:** 修改`python-host/host.py`、`observability.py`及对应纯观测/AST测试；不改Task1文件。

**Interfaces:** `summarize_input_event(..., admission_wait_ms=None)`产生可选`hostAdmissionWaitMs`。`_execute_input`入口用现有`input_queued_ns`和同源perf_counter_ns计算一次，仅传给既有host_input_received。

- [x] fake clock复现submit=1ms、drain入口=41ms，结构化摘要应40ms；合法0保持0；None/非法/未来queued不生成数值；原hostQueueMs和ACK不变。
- [x] 添加可选有限非负有界scalar，缺失null。高频move/wheel仍原聚合，不新增ID哈希或逐条日志；观测失败不阻断输入。
- [x] 定向测试observer、admission及Host输入路径，验证新字段不接触正文/坐标/原ID，不使用默认日志目录跑测试。

### Task 3: 整合、维护加载和验收

**Files:** 新运行报告与脱敏evidence，更新本spec/plan与需求文档。

- [x] 合并定向Python回归、diff检查与独立代码review；main按逻辑提交；Signal/Viewer源码未变时不重建dist。
- [x] 当前Viewer0才经helper restart-host；保留cloudflared PID及URL状态，重新读取并回报两密码，确认本地和公网健康。
- [x] 严格组件source/build/PID manifest下跑20对正常安全reset与正式within-grace复验；对新hostAdmissionWaitMs逐hash关联，不能比较不同网络时段而夸称健康p95改善。
- [x] 记录公网502/EOF及后续200，根因未定位部分保留；实际浏览器CF边缘/候选路径与proxy证据按可测范围记录，不改tunnel配置。
- [x] 最终review、隐私/相对链接/源摘要检查，提交报告，结束前核对服务可用和无遗留owned Viewer。三小时/业务可见效果仍NOT RUN。

执行事实：main实现`7ba8dcf`，Host-only加载PID31867，Signal83219/Viewer build`c6915df5ba8c0c6f`保持。20对40次reset通过，当前原M1 p95为347.4/348.2ms；admission p95/max为1.840/2.747ms，不将剩余时间命名为纯网络。正式within-grace恢复3.999185秒、稳定30.025816秒；前置300.240649秒/301样本，最终continuity因故意断线保留INCOMPLETE。完整记录见[实施复核](../reports/2026-10-25-reset-fence-admission-review.md)。本计划限定的恢复语义与观测优化不代表200ms、真实业务效果或三小时资格通过。
