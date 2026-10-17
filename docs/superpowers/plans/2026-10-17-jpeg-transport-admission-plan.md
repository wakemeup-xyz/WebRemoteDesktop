# JPEG Transport Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 阻止 ACK TTL 释放后旧 JPEG 仍在 Engine.IO 队列/batch 中累积。
**Architecture:** 在每次捕获前对当前连接 queue.join 作有界、持续拒绝的等待；用完整生命周期 token 围住所有 await。保留原完整二进制 emit 和单 producer。
**Tech Stack:** Python 3.11 asyncio、现有 python-socketio5.16.1/python-engineio4.13.1。
**Spec:** `docs/superpowers/specs/2026-10-17-jpeg-transport-admission-design.md`

## Global Constraints

- 当前同一 Engine.IO queue 在首次 gate 排空旧积压后，最多一项未完成 writer accounting 的 JPEG event；单个 JPEG 仍 ≤16 MiB。
- queue.join 不是网络 flush、Signal receipt、Viewer load 或输入可见效果，也不是排他 drain-and-reserve。
- 不改全局队列、库 writer、共享 accounting、自动重连、ACK TTL/window、profile/FPS、分辨率、质量及控制身份协议。
- 缺失或异常 fail closed；超时/取消不能 task_done、清理 queue 或重新 emit。
- 只改隔离工作树；无原生输入/抓屏、网络/浏览器、服务/tunnel、配置/依赖操作；不用 npm test/pretest。
- source/index 单 implementer；保留其它 dirty 文件。Task 完成后 root 独立 review 和受控加载，不自行启动服务。

### Task 1: 完整生命周期约束的 JPEG gate

**Files:** Modify `python-host/host.py` 的 TunnelRelayStreamer；Modify `python-host/test_tunnel_relay.py` 的 FakeSio 合约；Create `python-host/test_relay_transport_admission.py`。

**Interfaces:** 在 TunnelRelayStreamer 中新增私有 `_capture_transport_token()`、`_transport_token_is_current(token)`、`async _wait_for_transport_admission(token)`。token 可用固定 tuple/dict，包含 task/generation/scope副本/sio/eio/queue/writer。wait 返回 bool；False 只能重回外层循环，不能 capture/feedback/emit。所有检查失败均拒绝；helper 不改变业务状态。

- [ ] **Step 1: RED 实际 streamer 回归。** AST 加载实际 streamer 及所需纯常量/函数（避免 Host 原生导入），或沿已有严格 native stub 装载。真实 asyncio.Queue，fake worker 通过 Event 控制返回；writer 同样可控。核心堵塞测试：

```python
queue.put_nowait(old_binary_packet)
held = queue.get_nowait()
assert queue.qsize() == 0  # writer owns the unfinished packet
task = asyncio.create_task(relay._run())
relay.task = task
# Wait through multiple 0.25 s gate deadlines, expire ACK metadata as well.
assert captures == []
assert jpeg_emits == []
assert feedback_emits == []
queue.task_done()
await first_capture.wait()
assert len(captures) == 1
```

增加：暂停/resume 和 stop/start replacement 首帧仍等待旧 queue；旧 queue完成与新 client/generation 不相干；join期间及 capture期间分别替换 client/queue/writer/task或撤销authority，不能发送旧帧；writer死亡（包括queue已空与 capture期间）拒绝；健康 writer 排空后进下一帧，ACK window仍独立生效；取消 producer 不积累 waiter、不触碰 accounting。所有 finally 清理自建 task/worker，禁止遗留。

- [ ] **Step 2: RED 命令。** `cd python-host && python3 -m pytest -q test_relay_transport_admission.py`，记录预期行为失败，不能以导入错误充当证据。

- [ ] **Step 3: gate 实现及 _run 接线。** 把 feedback 移到成功 gate 后（含 ACK timeout 分支移除直接反馈）。捕获 token 时 generation/scope 均冻结。所有 wait 后和 frame emit 前完整检查，示意：

```python
token = self._capture_transport_token()
if not await self._wait_for_transport_admission(token):
    continue
await self.emit_feedback_if_due(time.monotonic() * 1000.0)
if not self._transport_token_is_current(token):
    continue
# existing ACK window wait always continues to loop head
frame = await self._jpeg_worker.submit_latest(request_from_token)
if frame is None or not self._transport_token_is_current(token):
    continue
# unchanged metadata insertion and whole binary emit, through token sio
```

wait 核心：

```python
if not self._transport_token_is_current(token):
    await asyncio.sleep(0.25)
    return False
try:
    await asyncio.wait_for(token_queue.join(), timeout=0.25)
except asyncio.TimeoutError:
    return False
# CancelledError propagates; malformed queue/join exceptions fail closed with yielding.
if not self._transport_token_is_current(token):
    await asyncio.sleep(0.25)
    return False
return True
```

不要 catch CancelledError/不要 shield。立即失败和反复 post-await failure 均有 yield；保留原异常/引用清理/单 worker/stop 退休逻辑。普通 FakeSio 增加 connected、state、真实 asyncio.Queue、可稳定表示未完成的 writer stub；专项 race tests 用实际受控 task，不新增生产 bypass。

- [ ] **Step 4: GREEN 与相邻验证。** `cd python-host && python3 -m pytest -q test_relay_transport_admission.py test_tunnel_relay.py test_relay_frame_worker.py test_runtime_observability.py`；若 AST loader 要额外全局名，确保从真实生产源导入/提供，不复制实现。

实际安装库的无网络 synthetic emit：实例化 AsyncClient、不 connect，设置合成 namespace/EIO connected，启动一个仅标记 scheduler turn 的 sibling；await emit 含一个 bytes 字段后，验证 queue 两包且 sibling未在 envelope/attachment之间运行。finally 清理仅测试 sibling，绝不启动 reader/writer/socket。版本记录进报告；不修改依赖。

- [ ] **Step 5: 自审及提交。** `git diff --check`；仅 add 指定文件；commit `fix(relay): gate JPEG capture on transport accounting`。报告 RED/GREEN 和实际行为限制。root 随后用 BASE..HEAD package 独立 review；不用重跑已经通过的相同套件除非修复改变代码。

### Task 2: Root review、部署和验收

- [ ] 独立 task spec/quality review；与 worker stages 增量再做跨层 review，保留原全分支历史 review。
- [ ] 冻结并仅同步允许文件，验证 primary HEAD/index/未触及文件与 tunnel身份；Host-only helper reload，验证源 hash/健康/Host在线并报告运行配置口令。
- [ ] fresh zeroViewer + server单次proof 条件下执行真实短 JPEG/TURN与暂停恢复；保留所有失败，不重新签 proof 绕过自动恢复约束。
- [ ] 连续性与资源长测及输入可见效果分别报告；未测保持 NOT RUN，不以 gate join/ACK 代替呈现证据。
