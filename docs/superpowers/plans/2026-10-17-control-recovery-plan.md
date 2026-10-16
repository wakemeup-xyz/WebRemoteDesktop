# Control Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 R1–R11，使同页短断、可靠输入 ACK 失联和异步 Host 操作都通过当前身份的 reset/lease/media 屏障自动收敛，不重放不确定输入。

**Architecture:** 保留 DesktopControlLease、Host 现有 handler/adapter 和 Viewer Input/MediaActivityRuntime；用唯一 transition epoch、Host authority revision、现有 pending 的 deadline 与有界 acquire intent 补齐边界。不新增 wire 字段或第二套恢复控制器。

**Tech Stack:** Node.js 内建 test runner、浏览器 JavaScript VM/fake clock、Python asyncio、现有 pytest/pytest-asyncio 和 mock input/capture/peer adapter；不新增运行依赖。

**Spec:** [控制恢复设计](../specs/2026-10-17-control-recovery-design.md)，服从[整改总设计](../specs/2026-10-17-reliability-latency-remediation-design.md) §5。

本轮状态：计划已编写，以下所有实施、测试、构建、提交与生产验收步骤均未执行。获得后续实施授权后才能开始。以下命令默认从仓库根目录执行，括号内的 `cd python-host` 仅用于离线测试，不调用服务脚本。

## Global Constraints

以下内容须逐字复制到各执行计划的 Global Constraints：

1. 本轮仅诊断和文档；业务代码、运行配置、服务、tunnel 均不修改或重启。
2. 后续实施沿用严格单桌面 Viewer、控制租约和 fail-closed reset 屏障；不重放投递结果不确定的点击、文本或命令。
3. 不自动切换网络模式、TURN 节点或公网地址；保留 Quality Lock，不自动降低用户选择的分辨率。
4. 生产 Viewer 验收必须有明确维护窗口；普通检查不得创建会抢占用户控制的 Viewer。
5. 默认不增加运行依赖；纯函数、fake-clock 和模拟适配器测试不得启动真实抓屏、输入或公网连接。
6. 缺测使用 null/unavailable；不以 RTT/2、跨机 wall clock、frame_timing 到达或ACK冒充实际单向传输或可见效果。
7. 日志不保存键码、文本、剪贴板、坐标、token、完整URL或原始输入ID；仅保存有界关联摘要、状态和阶段耗时。
8. 不运行会重建生产dist的 npm test/pretest；定向使用 node --test、unittest 或已有独立临时构建入口。
9. 未做的真实公网、设备、光学或长时间验收必须标为 NOT RUN，不以单元测试通过替代。
10. 每个任务只提交该任务的文件或明确选择的改动，不夹带任务开始前的无关修改。

“仅诊断和文档”约束描述当前授权。计划中的代码步骤是后续获实施授权后执行的内容，不是本轮完成声明；本地部署和tunnel操作继续遵守runbook及用户直接授权。

---

## 执行顺序、接口和完成记录

串行执行 C1 → C2 → C3 → C4；共享 `host.py`、`webrtc.js`、`input.js`、`signaling.js` 不与 M/W 生产适配并行修改。每任务开始重新读取文件和 dirty diff，不回滚任务开始前的工作。pytest 已是项目现有测试依赖；复用当前已安装测试解释器，不以缺依赖为由改生产环境。若测试环境缺失，记录阻塞，不把 import error 当行为红灯。

| 接口 | 生产者 → 消费者 | 约束 |
|---|---|---|
| existing control-transition/ACK、control-state/grant | Signal ↔ Host/Viewer | 无新字段；新操作新 epoch；同 reset 重试同 epoch |
| `_capture_authority()` / `_authority_matches(snapshot)` | C2 Host → C2 handlers、M3 input queue | 不可变内部 identity/revision；不能作为日志原文 |
| `_reset_keyboard_lifecycle(reason)` | C2 Host → 既有输入 adapter | 真实完成或显式失败，不以 timeout 当完成 |
| `reset_after_quiescent(old_scope, apply_reset)` | M3 queue → C2 reset 调用点 | 等待/安全隔离旧 in-flight，再执行既有 reset；C 决定是否 ACK |
| `Input.requestInputRecovery({source})` | C3 输入失联 → 既有双 reset | 每故障代次至多一次自动双 reset，失败升级一次 release/reacquire |
| `WebRTC.requestControl({allowTakeover:false})` | C3 acquire intent → Signal | 只有权威 FREE 才消费，不自动 takeover |

每个任务结束记录：改动文件、定向测试命令/结果、未运行验收、review 结论及提交哈希。下面代码是回归和关键实现的施工样例，使用真实模块/现有 fixture；不是已经存在或已经通过的成品。

## Task C1：确认迁移时续期，并使每个 transition 唯一（R1、R5）

**Files**

- Modify: `signal-server/lib/desktop-control-lease.js`
- Modify: `signal-server/websocket/signaling.js`
- Modify: `web-client/js/webrtc.js`
- Test: `signal-server/lib/desktop-control-lease.test.js`
- Test: `signal-server/websocket/signaling.test.js`
- Test: `web-client/js/input-signaling-continuity.test.js`

**Interfaces:** 消费现有 Host rebind callback、heartbeat 和 transition ACK；产出相同 wire 的 grant/reset。C3 消费 reset 的新 epoch 和 pending acquire 语义，不能提前加入另一套自动 acquire。

- [ ] **C1.1 编写能击中旧 grant ACK 的单元回归。** 在现有 `makeLease()` fixture 后加入以下用例；把既有“pending grant 转 reset 复用 epoch”预期改为新操作语义。重复 reset retry 单独断言 epoch 不变。

```js
test('release of a pending grant allocates a distinct reset epoch', () => {
  const lease = makeLease();
  const grant = lease.requestControl({ viewerId: 'viewer-a' }).transition;
  const reset = lease.beginRelease({ viewerId: 'viewer-a', reason: 'released' });
  assert.ok(reset.transition.leaseEpoch > grant.leaseEpoch);
  assert.equal(lease.confirmTransition({ leaseEpoch: grant.leaseEpoch }).reason,
    'stale-transition');
  assert.equal(lease.snapshot().state, 'REVOKING');
  assert.equal(lease.confirmTransition({
    leaseEpoch: reset.transition.leaseEpoch,
  }).state, 'FREE');
});
```

同样覆盖 `viewerDisconnected`、takeover candidate 撤回、旧 grant rejected/timeout 与真实 reset rejected 的排列。旧 grant ACK 后再来 reset rejected 时仍须 REVOKING，重试不能被旧 ACK 清除。

- [ ] **C1.2 在真实 Signal adapter 上加入接近过期的迁移测试。** 使用文件已有 `FakeSocket/makeIo/grantActiveLease`，显式注入 `DesktopControlLease` 和 now。以下 scheduler 只登记逻辑 timer，不打开网络或定时器；测试时间由 `now` 控制。

```js
test('confirmed rebind renews only after current Host applied ACK', () => {
  resetConnections();
  let now = 0;
  const { DesktopControlLease } = require('../lib/desktop-control-lease');
  const lease = new DesktopControlLease({
    now: () => now, makeLeaseId: () => 'lease-000000000001',
  });
  const scheduler = {
    setInterval: () => ({ unref() {} }),
    setTimeout: (fn, ms) => ({ fn, ms, unref() {} }), clearTimeout() {},
  };
  const io = makeIo();
  setupSignaling(io, { desktopControlLease: lease, now: () => now, scheduler });
  const host = new FakeSocket('host-renew', 'host');
  const a = new FakeSocket('viewer-renew-a', 'viewer');
  a.handshake.auth.viewerSessionId = 'fixture-same-session';
  io.connect(host); io.connect(a);
  const granted = grantActiveLease(io, host, a);
  now = 2900; a.disconnect();
  now = 10800;
  const b = new FakeSocket('viewer-renew-b', 'viewer');
  b.handshake.auth.viewerSessionId = 'fixture-same-session';
  io.connect(b);
  const rebind = host.sent.find(e => e.event === 'viewer-session-rebind');
  assert.equal(rebind.timeoutMs, 1500);
  assert.equal(b.sent.some(e => e.event === 'control-grant'), false);
  now = 11000; rebind.ack(null, { status: 'applied' });
  now = 13000;
  assert.deepEqual(lease.getActiveLease(b.id), {
    leaseId: granted.leaseId, leaseEpoch: granted.leaseEpoch,
  });
  assert.equal(b.sent.filter(e => e.event === 'control-grant').length, 1);
});
```

增加 ACK 恰在旧 deadline、1500ms timeout 后迟到、Host socket 被替换、新 socket 再断、不同 session 顶替的变体，断言不 grant/不续期/不新增已取消操作。复用已有失败矩阵，但不能只测 callback 的 `settled` 标志。

- [ ] **C1.3 跑红灯。**

```sh
node --test signal-server/lib/desktop-control-lease.test.js signal-server/websocket/signaling.test.js
```

预期：pending grant 的新 epoch 断言失败；确认重连后 t=13000 的 lease 已过期。若仅 fixture/import 失败先修测试，不算复现。

- [ ] **C1.4 实现 epoch 与确认续期。** `beginRelease`、`viewerDisconnected` 的 pending-candidate 分支统一调用 `_beginResetTransition(reason)`；只对已有 reset 重试保留 epoch。Signal pending 操作记录捕获 Host/socket/lease/attempt 对象身份。callback 顺序必须是 current-operation 检查 → 当前 lease 未过期 → Host applied → heartbeat 续期成功 → 清 pending → grant。拒绝/timeout 清 pending 后派发新 reset；旧回调不能清别人的 pending。

关键逻辑采用已有方法，避免另造 lease deadline：

```js
// finishRebind 内，在 current socket/Host/operation/lease 检查通过后：
if (ack?.status === 'applied') {
  const renewed = desktopLease.heartbeat({ viewerId: nextId, ...activeLease });
  if (!renewed.ok) return; // expiry 已通过 withLeaseExpiry 派发正式屏障
  socket._wrdRebindPending = false;
  sendGrant(nextId, activeLease);
  return;
}
```

不要把 `rebindViewer` 直接改成“迁移即续期”。其低层 pending-grant 兼容分支不作为 Signal 的许可入口；Signal 仍只迁移 ACTIVE。审查所有直接调用者，防止以低层能力绕过正式 ACK。

- [ ] **C1.5 立即 heartbeat 和定向绿灯。** `startControlHeartbeat` 先清旧 interval，验证当前 lease 后同步发一次，再建立原周期。扩展 continuity fixture 保存真实 `startControlHeartbeat`，测试连续两次 grant 只有一个活动 interval，首次 grant 不推进 fake clock 即可看到 heartbeat；FREE/disconnect 后不再发。

```sh
node --test signal-server/lib/desktop-control-lease.test.js signal-server/websocket/signaling.test.js web-client/js/input-signaling-continuity.test.js
```

预期全绿；R1 窗口 lease 至确认时刻后 12 秒，旧 grant ACK 永远不能确认 reset。

- [ ] **C1.6 复审并提交。** 审查过期与 superseded 边界、没有新增 wire token 输出、重试同 epoch，运行 `git diff --check`。仅暂存 C1 文件/本任务 hunks，提交建议 `fix(control): renew confirmed rebinds and separate reset epochs`。保留测试输出与尚未部署说明。

## Task C2：Host await 后校验 authority，统一 peer owner（R2、R8、R9）

**Files**

- Modify: `python-host/host.py`
- Modify: `web-client/js/webrtc.js`
- Test: `python-host/test_offer_epoch.py`
- Test: `python-host/test_media_suspension.py`
- Test: `web-client/js/input-signaling-continuity.test.js`

**Interfaces:** 消费 C1 唯一 epoch；提供 `_capture_authority()` / `_authority_matches(snapshot)` 给各 handler 与 M3。当前 adapter reset 接口保留，M3 后续接入 quiescence，不能复制 authority。

- [ ] **C2.1 写两个真实 await 交错回归。** 在 `test_offer_epoch.py` 中复用 `test_newer_transition_freezes_prior_v2_lease_before_reset_completes` 的 FakeInputHandler 初始化，抽成仅测试使用的 fixture；所有 input/capture/PC 构造都 mock。用 `asyncio.Event` 暂停 `on_offer` 的旧 PC close：epoch 7 offer 开始 → close 停住 → 调真实 `on_control_transition` 完成 reset epoch 8 和 grant epoch 9 → 释放旧 close → 断言 active epoch 仍 9、current viewer/PC owner 一致、没有旧 offer answer/applied、旧任务仅关闭自己的对象。不得用 `sleep(0.1)` 代替 Event 排序，也不能只调用 CAS helper。

在 `test_media_suspension.py` 中使用现成 `_make_media_host/FakeTrack/FakeSender`，暂停真正的 capture-await 边界。示例通过 patch `asyncio.to_thread` 把 FakeTrack 调用变成可控协程，不启动真实 capture：

```python
@pytest.mark.asyncio
async def test_old_resume_completion_cannot_restore_previous_attempt(monkeypatch):
    import asyncio
    import host as host_module
    entered, release = asyncio.Event(), asyncio.Event()
    host = _make_media_host(sender=FakeSender(), track=FakeTrack())
    host._active_input_binding["connectionAttemptSequence"] = 1
    host._media_activity_suspended = True
    host.screen_track.suspended = True

    async def paused_call(fn, *args, **kwargs):
        entered.set()
        await release.wait()
        return fn(*args, **kwargs)

    monkeypatch.setattr(host_module.asyncio, "to_thread", paused_call)
    pending = asyncio.create_task(host.on_media_activity_change({
        "schemaVersion": 1, "state": "active", "reasons": [], "generation": 1,
        "connectionAttemptId": "wrd-1", "viewerId": "viewer-1",
        "leaseId": "lease-000000000001", "leaseEpoch": 3,
    }))
    try:
        await asyncio.wait_for(entered.wait(), timeout=1)
        await host.on_connection_attempt_bind({
            "viewerId": "viewer-1", "leaseId": "lease-000000000001",
            "leaseEpoch": 3, "connectionAttemptId": "wrd-2",
            "connectionAttemptSequence": 2, "networkMode": "tunnel",
        })
    finally:
        release.set()
        await pending
    assert host._media_activity_binding["connectionAttemptId"] == "wrd-2"
    assert host._media_activity_binding["connectionAttemptSequence"] == 2
    assert not any(event == "media-activity-ack" and data.get("applied")
                   and data.get("connectionAttemptId") == "wrd-1"
                   for event, data in host.sio.events)
```

实施时先确认当前 capture wait 仍经 `asyncio.to_thread`；若 M 已把此边界移到专属 worker，改为暂停该 worker 的现有测试 adapter，不 patch 其他业务 await，也不移除真实交错步骤。

- [ ] **C2.2 跑红灯并补 owner 回归。**

```sh
(cd python-host && PYTHONDONTWRITEBYTECODE=1 python3 -m pytest test_offer_epoch.py test_media_suspension.py -q)
```

预期：旧 offer 覆盖新 epoch，旧 resume 恢复旧 attempt。新增 A→B rebind rejected → reset → fresh grant B 的真实 handler 链，断言旧 PC A 已关闭或被明确隔离，B 后续 offer/ICE 不被 A 的 identity 拒绝；再做 B→C 正式 rebind。Viewer 测试中让旧 PC 仍 connected：不同 lease grant 必须关闭/重新 offer；相同 lease 确认 rebind 不得重建。

- [ ] **C2.3 实现共同 revision 和控制操作幂等元数据。** 在 Host 初始化和 `__new__` 测试 fallback 路径定义 revision 初值；不可变快照用现有标准库结构（例如 tuple），不增加依赖。快照字段为 revision、viewerId、leaseId、leaseEpoch、connectionAttemptId、connectionAttemptSequence、connectionGeneration。accepted control/owner/attempt/rebind 更新先递增 revision；同媒体 owner 的 generation 另比，不无故淘汰输入。

保存最高 accepted control epoch 与操作类型及结果，低 epoch 永久 stale；同 epoch 同 reset 重试仅幂等确认已完成结果，失败可重试实际 reset；同 epoch 不同 kind 拒绝。更新旧 `same_epoch_reset_only` 测试以验证当前契约，不能保留旧 grant→reset 同 epoch 的许可。

这里的“永久 stale”限于同一认证 Signal 连接生命周期。`on_disconnect` 先增 revision、冻结并静止/reset；新认证连接完成后才重新开始 control epoch 命名空间，revision 不清零。增加离线回归：旧连接 epoch 20 的 await 未结束 → disconnect → 新连接完成安全 reset → 接受新 Signal epoch 1 → 旧 completion 返回不能覆盖；不能把 epoch 20 存成进程级下界导致 Signal 重启后永久拒绝控制。使用现有连接回调/对象身份，不加 wire 字段。

- [ ] **C2.4 为每个异步副作用设置提交边界。** 逐项改 `on_offer`、`_apply_control_transition`、`on_viewer_session_rebind`、`on_connection_attempt_bind`、`on_media_activity_change` 及 `_close_peer_connection`。下面的局部操作骨架用于每个 await 后，不是只在最后加一次判断：

```python
authority = self._capture_authority()
closing_pc = self.pc  # 清理对象在 await 前捕获
await closing_pc.close()
if not self._authority_matches(authority):
    return  # 不再读取 self.pc 清理，不赋值新 binding，不发 applied
# 此处的检查与提交之间没有 await。
```

实际 close 还需 sender/track/candidates 对象归属校验；仅当 `self.pc is closing_pc` 时才清 self 字段。新 PC 在局部候选对象上初始化；每次 SDP/adapter await 后校验，过期候选单独关闭。adapter 绑定和 native in-flight 也必须受序列/epoch fence 或 quiescence 保护，不能让旧 coroutine 在 CAS 失败前已重绑新 adapter。

控制 reset 先冻结，再等旧工作静止并真实 reset，CAS 后提交/ACK；异常清理同样验证归属，不能清新 binding。M3 未落地时用已有 adapter 串行队列和 transition generation 完成该保证；M3 接入时只替换等待适配，不创建第二 authority。

- [ ] **C2.5 完成新 grant 的 peer 更新。** Host 发现当前 PC owner/lease 与新 grant 不同，关闭旧 peer 后才能 applied。Viewer 在创建 PC/offer 时给该 PC 记录内部 lease identity；grant 比较它，different-lease 走既有 teardown/createPeerConnection/createOffer，same-lease 正式迁移继续当前 peer。不要使用一个与 PC 生命周期无关的新全局 controller。

- [ ] **C2.6 跑绿灯、复审并提交。**

```sh
(cd python-host && PYTHONDONTWRITEBYTECODE=1 python3 -m pytest test_offer_epoch.py test_media_suspension.py -q)
node --test web-client/js/input-signaling-continuity.test.js
git diff --check
```

预期所有旧异步完成都无法覆盖、清空或执行新 scope；不同 lease 必须重协商，相同 lease 不增加 PC 重建。复审锁顺序、异常/finally 分支、旧 input handler side effect 和 M3 接口一致性。选择本任务 hunks 提交 `fix(host): fence asynchronous control and peer ownership`。

## Task C3：覆盖全部可靠 ACK 失联并自动完成 reset/reacquire（R3、R4、R6、R7）

**Files**

- Modify: `web-client/js/keyboard-transport.js`
- Modify: `web-client/js/input.js`
- Modify: `web-client/js/webrtc.js`
- Modify: `signal-server/websocket/signaling.js`
- Test: `web-client/js/keyboard-transport.test.js`
- Test: `web-client/js/input-recovery.test.js`
- Test: `web-client/js/input-signaling-continuity.test.js`
- Test: `signal-server/websocket/signaling.test.js`
- Create (test helper only): `signal-server/websocket/signaling-test-fixture.js`

**Interfaces:** 键盘传输内部增加可注入 `setTimeoutFn/clearTimeoutFn/onReliableAckTimeout(record)`，record 只在内存传递 scope、adapter/DC 对象和 seq；不改 v2 envelope。现有 `Input._recoveryCycle` 拥有双 reset；WebRTC 只保存一次 acquire intent，Signal 不自动申请。

- [ ] **C3.1 用 fake clock 复现普通键盘失联。** 在已有 `loadRecoveryFixture()` 上写如下行为测试；wheel 与 command 用表驱动重复同样场景，unordered move 单独断言不触发 reliable deadline。

```js
test('silent reliable keyboard DC is quarantined without replaying keys', () => {
  const h = loadRecoveryFixture();
  const dc = h.WebRTC.inputChannel;
  h.keydown(); h.keyup();
  const sentKeys = h.inputs().filter(p => p.type === 'keyboard' && p.action === 'key');
  assert.equal(sentKeys.length, 2);
  h.advance(3001);
  assert.equal(h.WebRTC._quarantinedInputChannel, dc);
  assert.equal(h.Input.getEffectiveInputGate().allowed, false);
  assert.equal(h.inputs().filter(p => p.type === 'keyboard' && p.action === 'key').length, 2);
  const resets = h.inputs().filter(p => p.action === 'reset');
  assert.equal(resets.filter(p => p.type === 'keyboard').length, 1);
  assert.equal(resets.filter(p => p.type === 'mouse').length, 1);
  assert.ok(resets.every(p => h.sent.find(e => e.payload === p)?.event === 'input'));
});
```

keyboard-transport fixture 的 `advance` 改成真正执行到期 callback，注入 timer；测试没有后续 key/snapshot 调用时也在 3000ms deadline 触发，累计 ACK 推进会重新指向最早 pending，scope 改变会取消 timer。给 Socket-only 和 retired-DC 变体断言不会 quarantine 不相关 DC。

- [ ] **C3.2 写真实 Viewer→Signal 的 reconnect 桥接。** 将 signaling.test.js 中 `FakeSocket/makeIo/resetConnections/grantActiveLease` 移到上述仅测试 helper 并导入；不导入含测试注册的整个 test 文件。continuity fixture 增加 fake clock、对 `socket.emit` 的可注入输出，不 stub `requestControl/handleControlState/handleControlGrant`。桥接输入调用 FakeSocket.trigger，Signal 输出调真实 Viewer handler；Host 只 mock native reset/ACK 结果。以下是 fixture 内的关键接线，`h` 是该文件现有 `fixture()` 返回值，`replacement` 是同 session 的新 FakeSocket：

```js
const viewerHandlers = {
  'control-state': 'handleControlState',
  'control-grant': 'handleControlGrant',
  'control-acquire-result': 'handleControlAcquireResult',
};
const recordServerEmit = replacement.emit.bind(replacement);
replacement.emit = (event, data, ack) => {
  const result = recordServerEmit(event, data, ack);
  const method = viewerHandlers[event];
  if (method) h.WebRTC[method](data);
  return result;
};
h.WebRTC.socket.emit = (event, data) => replacement.trigger(event, data);
```

接线前设置 Viewer 当前 socket identity/connected/hostOnline 并调用真实 reconnect listener 的 acquire 入口。执行 Host rebind rejected/timeout → reset transition → Host applied；**不调用第二次 `replacement.trigger('control-acquire')`**，断言 Viewer 收 FREE 自动产生且仅产生一次新 grant transition。没有 reset ACK、Host offline、重复 FREE、用户 release、superseded、旧 Host/socket callback 均不能重试或授权。

- [ ] **C3.3 覆盖失败 reset 与跨 socket ACK。** continuity fixture：先发 mouse/keyboard reset → disconnect 4 秒（在 8 秒 grace 内，但超过 3 秒 reset deadline）→ same-lease rebind grant。断言 failed keyboard barrier 不被 setLease 清除；Viewer 自动释放后只在真实 FREE 重新申请新 lease。对尚未失败但旧 Socket reset ACK 会发到旧 socket 的场景，丢弃旧 ACK，当前恢复不得认领旧 reset ID；新 mouse 与 keyboard reset 的各自 ACK 才解锁。保留 sequence-gap 仅一次新 reset 的规则，不补发旧 write。测试必须检查累计 appliedSeq 不能替代 exact reset ownership。

- [ ] **C3.4 跑红灯。**

```sh
node --test web-client/js/keyboard-transport.test.js web-client/js/input-recovery.test.js web-client/js/input-signaling-continuity.test.js signal-server/websocket/signaling.test.js
```

预期普通键盘不触发失联，rebind failure 后没有自动第二次 acquire，failed barrier 留在原 lease，旧 mouse reset 无法在新 socket 完成。先前人工补 acquire 的测试不能作为绿灯依据。

- [ ] **C3.5 为现有 pending 增加一个 deadline，而非每个输入一个 timer。** KeyboardTransport 与桌面 pending 各保留一个最早 deadline timer，实际 send accepted 后记录发送时 scope/adapter/DC/time，ACK、reset、撤销时清理并重排；默认 3000ms。timer 到期再次检查身份，冻结新 reliable write，然后调用现有 quarantine/recovery。移动手势已有 ACK timer 改为消费共同失联结果，保留其手势语义但不得重复启动恢复。普通 write timeout 可以一次 dual reset；reset timeout 直接进入 failed/reacquire-required，不能递归 reset。

同一 deadline 回调只能消费一次 recovery 代次。不要清空 `lastApplied/lastSent` 来恢复同租约，也不要基于 LatencyMonitor 统计窗口发控制动作。M3 的容量限制在编号前调用同样冻结入口，不能另外做重试。

- [ ] **C3.6 保留一个有界 acquire intent。** 在 `_controlAcquireRequestId` 周围保存 socket 对象/ID、故障代次、等待 reset 的 epoch、预算。`requestControl` 遇切换中保存自动 intent；Signal 对当前认证 Viewer 的 pending acquire 返回 `reset-in-progress`，但所有写入仍拒绝。`handleControlState(FREE)` 经 hostOnline、current socket、非 blocked、非主动 release/superseded 校验后，用 `allowTakeover:false` 消费一次 intent。重复 FREE 无额外请求；旧 requestId result 不能恢复已取消 intent。

failed same-lease grant 通过现有 `releaseControl` 路径发起一次 release，保留 intent 等权威 FREE；没有 FREE 就一直 fail-closed，沿 Signal 现有 1/2/4 秒 reset retry 与 blocked UI，不加无限本地轮询。grant 成功清 intent；新故障须由新的明确事件代次建立预算，不能让 visible 回调或新 epoch 本身刷新失败预算造成循环。

- [ ] **C3.7 标记 ACK 所属 scope 并完成绿灯。** 内存 pending 保存发送时 socket、attempt、lease、DC；跨 socket 的旧 Socket pending 不继承，旧 DC ACK 只有仍属已确认 same-lease/attempt 的发送操作时可确认普通已发送项，不能默认确认新 reset。Signal 保持对旧 Viewer ACK 的严格路由，不加 old→new 全局重定向。核对双 reset、草稿与 manual recovery UI。

```sh
node --test web-client/js/keyboard-transport.test.js web-client/js/input-recovery.test.js web-client/js/input-signaling-continuity.test.js signal-server/websocket/signaling.test.js
git diff --check
```

预期全部绿灯，连续重复回调也只消费一次 budget；不能靠先调用 snapshot 才触发 timer。复审用户主动释放不会被重新抢回、没有不确定输入重放、timer/pending 无泄漏，选择本任务 hunks 提交 `fix(input): converge lost acknowledgements through bounded recovery`。

## Task C4：封闭媒体与 legacy relay 的迁移旁路（R10、R11）

**Files**

- Modify: `web-client/js/webrtc.js`
- Modify: `signal-server/websocket/signaling.js`
- Modify: `python-host/host.py`（复用 C2 authority cleanup，清理 reset 对应的旧 relay producer）
- Test: `web-client/js/input-signaling-continuity.test.js`
- Test: `web-client/js/media-activity-runtime.test.js`
- Test: `signal-server/websocket/signaling.test.js`
- Test: `python-host/test_offer_epoch.py`

**Interfaces:** 消费现有 MediaActivityRuntime attempt/generation ACK 和 Signal 当前 Viewer gate；不新增 wire。M 的 frame notice/延迟统计不能当作媒体授权证据。

- [ ] **C4.1 写跨 attempt 帧解锁回归。** 在 continuity fixture 中使用现有 `MediaActivityRuntime.create`，保留真实 `beginConnectionAttempt/handleMediaActivityAck/observeFreshResumeFrame`。设置 attempt A 的 active ACK 已到、等待 fresh frame；调用真正 beginConnectionAttempt 变 B，再发 B 的 active intent，但不 ACK B。下面断言插在上述真实排序之后，`h` 为现有 fixture：

```js
assert.equal(h.WebRTC._mediaResumeFramePending, false);
assert.equal(h.WebRTC._mediaResumeBaseline, null);
h.WebRTC.noteMediaRenderedFrame({
  source: 'video-callback', frameSeq: 1,
  connectionAttemptId: h.WebRTC.currentConnectionAttemptId,
});
assert.notEqual(h.WebRTC.getMediaAppliedPhase(), 'active');
assert.equal(h.Input.getEffectiveInputGate().allowed, false);
```

随后 ACK B/current generation 再新帧才 active；旧 A ACK、旧 generation、新 PC 前旧 rVFC、relay frame 缓存都不能解锁。保留同 B scope 内 frame 先到 ACK 后到的合法快速恢复测试，不能通过一律丢早到帧掩盖问题。

- [ ] **C4.2 写 legacy companion 的真实 pending 用例。** 在 signaling.test 的 legacy relay fixture 中：legacy 主 Viewer A 取得同一 DesktopControlLease，创建其 companion，A 断开并同 session B 重连；暂停 Host rebind ACK，companion 发 stream-start、stream-control，Host 发 relay-frame/ACK。断言 Host 不收到新 start/control、Viewer 不收到未授权 frame/ACK，companion 无输入权。Host rejected/timeout 后检查可信 reset/stop 清理针对实际 producer owner A，不是只向尚未启动的 B 发 stop。成功 ACK 后只允许当前 B owner 一条流。

同时在 Host fake relay 的 `viewer_id` 为 A 时回放 reset/cleanup 事件，断言 A producer 停止；不同 Viewer 自发 stop 仍不得停止当前流。已有 `test_relay_stop_from_stale_viewer_does_not_stop_active_relay` 必须保留。

- [ ] **C4.3 跑红灯。**

```sh
node --test web-client/js/input-signaling-continuity.test.js web-client/js/media-activity-runtime.test.js signal-server/websocket/signaling.test.js
(cd python-host && PYTHONDONTWRITEBYTECODE=1 python3 -m pytest test_offer_epoch.py -q)
```

预期旧 frame pending 残留导致 B 无 ACK 可变 active；legacy pending 可发送 start，失败后的旧 producer 不能可靠停止。Host 清理复用 C2 同一 authority cleanup 方法并重新跑 C2，不新建 companion 专用 controller。

- [ ] **C4.4 使媒体恢复证明按 scope 作废。** `beginConnectionAttempt` 和新控制身份清 pending/baseline/用于恢复的旧 relay frame/fallback timer；active ACK 后的证明包含 attempt/generation/leaseEpoch 与 PC/relay 身份。`observeFreshResumeFrame` 在调用 runtime.noteRenderedFrame 前逐项比当前 scope 和 baseline；同 scope 早到帧只在 ACK 到达后消费一次。媒体 stats 与 `frame_timing` 不能替代 ACK 或真实新帧。

- [ ] **C4.5 共用主 Viewer gate 并按 producer 身份清理。** `hasActiveLegacyRelayOwner` 调用当前 owner socket 的 `isActiveViewerSocket`，不要只检查 map 存在；companion bind/start/control/frame/ACK 均复用。rebind pending 的 owner 索引迁移与真实 producer owner 分开保存操作快照，失败清理使用捕获 owner；该快照只属于已有 rebind 操作并在 settled 清理，不能成为第二租约。保持 legacy v1 单 controller 和 `LEGACY_INPUT_COMPAT_ENABLED` 现有策略。

Host 权威 reset 捕获当前 relay 对象/owner，冻结后 await 该对象 stop，按 C2 revision 与对象相等检查再清共享引用；只有这条可信 reset 可清旧 producer。旧 Viewer/companion 自发 stop 仍严格匹配 owner，新 producer 不被旧 stop completion 影响。

- [ ] **C4.6 绿灯、复审与提交。** 重跑 C4.3 的定向命令和 `git diff --check`。审查同 scope 早帧、用户暂停、attempt 切换、pending 失败、companion 顶替/断线以及清理旧流不误伤新流。选择本任务 hunks 提交 `fix(control): scope media resume and legacy relay authority`。

## 最终覆盖与后续验收

- [ ] 离线集成只在获得实施授权并完成 C1–C4 后运行一次下列定向集合；不使用 `npm test`，不触发 pretest/build，不启动服务。

```sh
node --test signal-server/lib/desktop-control-lease.test.js signal-server/websocket/signaling.test.js web-client/js/keyboard-transport.test.js web-client/js/input-recovery.test.js web-client/js/input-signaling-continuity.test.js web-client/js/media-activity-runtime.test.js
(cd python-host && PYTHONDONTWRITEBYTECODE=1 python3 -m pytest test_offer_epoch.py test_media_suspension.py -q)
```

| Finding | 必要回归证据 |
|---|---|
| R1 | 临近 expiry 的 Host ACK 后完整续期；Viewer 立即 heartbeat |
| R2 | 旧 offer await 期间新 reset/grant 完成，旧完成不得回滚 |
| R3 | keyboard/wheel/command 无 ACK 且 DC open 时 deadline 触发，不重放 |
| R4 | 真实 Viewer→Signal 桥接，不人工补 acquire，reset ACK 后自动一次 |
| R5 | grant→reset 新 epoch，旧 grant ACK 后 reset reject 仍阻断 |
| R6 | 3 秒 reset 过期、4 秒同页重连不会 same-lease 洗白 |
| R7 | 旧 socket ACK 不完成新 reset，双 reset 当前身份均确认 |
| R8 | fresh grant 关闭旧 owner PC，B→C 迁移/ICE 不再沿用 A |
| R9 | 旧 fresh-capture await 完成不能恢复旧 attempt/sequence |
| R10 | 新 attempt frame 在新 ACK 前不能 active；合法早帧保留 |
| R11 | pending legacy companion 无 stream/control/frame/ACK 权限，实际旧 producer 可被清理 |

- [ ] 独立 review：重点找“检查后 await 再无条件写入”、同 epoch 不同操作、按新 map 清旧资源、无限 acquire/reset 循环、异常清新 binding，以及测试只测 helper 而绕过真实 handler 的盲点。更新需求文档只能在后续用户授权的实施任务内单独列明，不把本轮计划当作已落地功能。
- [ ] 维护窗口验收另行授权后执行：同页短断、DC 半开、Host reset failure、不同 Viewer 顶替、媒体暂停/恢复，按 direct/TURN/显式 tunnel 分别记录。每路径至少 3 小时长会话、真实设备/Quartz/IME/公网均在本轮标 **NOT RUN**。加载与回退采用经过验证的三端匹配版本；只重启授权本地服务，不操作 tunnel。

本轮完成记录：只生成 spec/plan；测试、构建、提交、生产加载及上述验收均 **NOT RUN**。
