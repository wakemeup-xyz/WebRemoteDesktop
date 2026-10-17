# JPEG Worker Stages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 区分 JPEG processor 执行与结果等待 Host loop 的耗时。
**Architecture:** 在原 worker Condition 内记录固定时间戳，复用 runtime 队列快照和白名单；无新任务、历史及协议。
**Tech Stack:** Python 3.11 asyncio/threading/unittest。
**Spec:** `docs/superpowers/specs/2026-10-17-jpeg-worker-stages-design.md`

## Global Constraints

- 所有时间使用同一可注入 monotonic_ns 时钟。合法 0 保留；缺失/非法/负值在输出白名单变为 null。
- 只为 relayFrames 增加字段；inputReliable/inputUnordered 的格式保持不变。
- 旧 generation 的正在执行/等待回送阶段仍占真实资源，invalidate 不得抹去它。
- worker 保持一个 running、一个 latest pending、16 MiB 单 JPEG 上限及 stop 2 秒的退休 worker 防护。
- 不得新增采样任务、历史数组、逐帧日志；不记录图像、请求内容、坐标、token 或原始身份。
- 只改隔离工作树；无原生输入/抓屏、网络/浏览器、服务/tunnel、配置/依赖操作；不用 npm test/pretest。
- source/index 仅本 task implementer 写；root 独立维护 docs。保留已有 dirty 文件，不 reset/stash。

### Task 1: Worker 阶段与 runtime 白名单

**Files:**
- Modify: `python-host/relay_frame_worker.py`
- Modify: `python-host/runtime_observability.py`
- Test: `python-host/test_relay_frame_worker.py`
- Test: `python-host/test_runtime_observability.py`

**Interfaces:** `RelayFrameWorker(process, *, max_pending=1, now_ns=time.monotonic_ns)`；现有 snapshot 新增 spec 表中八字段。RuntimeObservability.snapshot() 在 relayFrames 上保留并验证八字段，其它队列不增加字段。Host 已通过 snapshot_relay_queue 注册该 worker，无需修改 host.py。

- [x] **Step 1: RED，真实 worker 状态边界测试。** 用 fake 单调时钟从 0 开始；processor 通过 threading.Event 保持阻塞；测试提交→开始→processor 完成→loop 完成。测试时仅在这个 worker 捕获的 loop 回送适配上拦截 `_complete`，把 callback 暂存一项，手动调用，不能冻结真实 Host 或 monkeypatch 生产库。示例核心断言：

```python
snapshot = worker.snapshot()
self.assertTrue(snapshot['processorActive'])
self.assertFalse(snapshot['deliveryPending'])
self.assertEqual(snapshot['processorAgeMs'], 0)
# processor released; completion callback held by the offline fixture
snapshot = worker.snapshot()
self.assertFalse(snapshot['processorActive'])
self.assertTrue(snapshot['deliveryPending'])
self.assertEqual(snapshot['deliveryAgeMs'], 7)
# Run held callback on test loop, then await original future.
self.assertIsNone(worker.snapshot()['deliveryAgeMs'])
self.assertEqual(worker.snapshot()['lastDeliveryWaitMs'], 7)
```

另测 latest pending 替换重置年龄，invalidate 保留 in-flight/delivery 的实际状态，processor 错误仍回送并更新阶段，stop 退休边界不被诊断阻塞；完整 finally 释放事件并 stop worker。Runtime 测试非法 bool/NaN/负数→null、0 保留、两种布尔值、canary 被过滤、input 队列 schema 不变、snapshot_relay_queue 锁忙即时 unavailable。

- [x] **Step 2: 运行 RED 并记录具体缺字段/错误阶段断言。** `cd python-host && python3 -m unittest test_relay_frame_worker test_runtime_observability`。不以导入错误当 RED。

- [x] **Step 3: 最小实现。** 保持 pending item 原有前三项含义，可追加 submitted_ns；新增 processor/delivery 当前时间戳及 last* 固定标量。核心计算：

```python
def elapsed_ms(started_ns, now_ns):
    return None if started_ns is None else max(0, now_ns - started_ns) / 1_000_000
# Under existing Condition:
# on dequeue: lastQueueWaitMs = elapsed_ms(item[3], now); processor start = now
# on processor exit: lastProcessorMs = elapsed_ms(processor start, now)
#   clear processor timestamp; set delivery timestamp = now
# on _complete: lastDeliveryWaitMs = elapsed_ms(delivery timestamp, now)
#   clear delivery timestamp
```

snapshot 根据 `_pending`、`_inflight`、`_delivery_pending` 及时间戳返回状态与年龄；不把 0 当缺失。Runtime 仅 relayFrames 扩充固定字段，processorActive/deliveryPending 按布尔校验，其余按有限非负 number 校验。沿既有非阻塞 snapshot_relay_queue，异常仍 unavailable。

- [x] **Step 4: GREEN 及相邻测试。** 先重复上述两文件，再运行 `cd python-host && python3 -m unittest test_input_admission_queue`（若模块不存在，报告并使用现有对应队列测试文件，不新增生产路径）。记录命令/输出；不运行无关全仓库/原生测试。
- [x] **Step 5: 自审、提交上述四文件。** `git diff --check`；逐路径 git add；提交 `feat(diagnostics): distinguish JPEG processing and loop delivery`。报告 RED/GREEN、字段语义、没有原生/服务操作及剩余限制。不得自行派 reviewer。

### Task 2: Root 集成复审与受控加载

- [x] 用 Task 1 的 BASE..HEAD 生成独立 review package，fresh reviewer 给 spec/quality 两项结论；必要修复走原 implementer。
- [ ] 与独立传输准入方案合并前审查边界，更新实施/验收文档；保留 JPEG 原 FAIL 和输入到可见效果 NOT RUN。
- [ ] 仅在已授权本地维护下同步冻结源码，保留原 checkout HEAD/index/用户修改和 tunnel。Host 重载只用 service helper，确认健康/Host/构建身份与口令；在线 Viewer 状态决定是否允许自动 proof 验收。
- [ ] 新实际观测与长会话分别记录，不把新字段存在当性能达标。
