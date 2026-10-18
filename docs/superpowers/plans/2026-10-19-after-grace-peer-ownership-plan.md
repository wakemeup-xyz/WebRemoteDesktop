# After-grace Peer Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新租约推进 attempt 时退役恢复中既有的无租约 peer，阻止有效新连接带着旧 callback owner 卡在媒体/输入关闭状态。

**Architecture:** 扩展 `handleControlGrant()` 现有退休条件，保留原清理顺序；新实际授权和最终 attempt 建立后，沿现有 reconcile 路径创建 peer。保持 immutable owner fencing 和所有媒体/输入门禁，先用真实源码 VM 复现再修复。

**Tech Stack:** 浏览器 JavaScript、Node `node:test` / `node:vm`，现有 WebRTC/Input/MediaActivity 模块；无新依赖。

**Spec:** `docs/superpowers/specs/2026-10-19-after-grace-peer-ownership-design.md`（执行前完整读取）。

## Global Constraints

- 产品代码只修改 `web-client/js/webrtc.js`；真实源码 VM 回归只修改 `web-client/js/webrtc.test.js`，必要时同类回归落在现有 `web-client/js/input-signaling-continuity.test.js`。
- 保留 M1、ACK、lease/reset、媒体门禁及旧回调拒绝；不改 FPS、codec、quality、网络模式或恢复/准入权限。
- 不改 Host、Signal、tunnel、运行配置、验收 runner/sampler 或 protected checkout。
- 运行目录与 primary HEAD `b6bd0c11fd6055923768ac9f8d457995ac24cde0`、legacy HEAD `41c7b0998859a7e9d088cefcc0f3a1eeab190684` 及 R5 execution HEAD `b032481707f08f35bb91683da1f3a6ac4c22fa24` 分别保持原状，直到新修复受审并由 root 完成具体部署准备；保留已有 index/dirty 状态。
- 本修复默认不新增诊断；若独立 review 认定必要，只允许有界有限退休 reason、数值 generation、枚举 peer state，不记录 leaseId、token、原始输入或坐标，不做通用观测框架。
- `reset-unconfirmed` 覆盖过宽是独立 runner 诊断问题；不在本修复修改该标签、验收判据、原始失败记录或预算，不靠改标签取得 PASS。
- 普通完整序列、native/visible/physical 效果及三小时连续性未重新实测前保持 `NOT_RUN`/未取得资格；外部隔离资源问题尚未解决。

执行工作区为 `/Users/macstudio1/.codex/worktrees/after-grace-recovery/WebRemoteDesktop`，分支 `codex/after-grace-recovery-remediation`，起始基线 `b032481707f08f35bb91683da1f3a6ac4c22fa24`。本计划编写阶段只有两个文档被创建；下述 checkbox 全部表示未来工作，不能从文档存在推断已执行。

---

## Task 1: 无租约 peer 退休与真实恢复链回归

**Files:**
- Modify: `web-client/js/webrtc.js`，`handleControlGrant()`（基线约 4162–4236），只扩展现有退休条件。
- Test: `web-client/js/webrtc.test.js`，复用 `loadWebRTC()`、`makeElement()` 与 `startupJoinFlush()`；平台 fake 参考同文件 `startupJoinScenario()` 的 `FakePeer`。
- Test if needed: `web-client/js/input-signaling-continuity.test.js`，复用已存在的真实 Input 双 reset ACK / retained startup producer 断言。
- Record: 本计划末尾执行记录，写入 RED/GREEN、独立 review 结论及实现 commit，不包含密码或原始运行输入。

**Interfaces:**
- Consumes: 真实 `WebRTC.freezeControl(reason)`、`refresh({reason})`、`handleControlGrant({controller, leaseId, leaseEpoch})`，现有 PC/DOM/socket 平台接口。
- Produces: 同一公开接口；changed lease 后 `WebRTC.pc` 为新 peer，`_peerCallbackOwner` 与当前 `pc/currentConnectionAttemptId/connectionAttemptSequence` 一致；旧 owner 失效。
- 不新增产品 helper/API。测试 helper 命名为 `afterGracePeerFixture()`，返回 `{h, w, input, video, peers, emitted, frames, timers, settle, connect, paint, mediaRequest, ackMedia}`；helper 只组装平台边界与真实产品状态转换。

- [ ] **Step 1：核对执行边界和既有修改。**

```bash
pwd
git status --short
git branch --show-current
git rev-parse HEAD
```

保留他人修改；确认当前分支、基线/已审文档提交关系。只在本隔离 checkout 编辑。阅读 spec、需求对应三节、`handleControlGrant` / `refresh` / `bindPeerCallbacks` / `ownsStartupOwner` / `startStats` / `startVideoFrameTracking`，不读取原始 samples/logs。

- [ ] **Step 2：增加浏览器边界 fixture 与第一条 RED。**

在 `webrtc.test.js` 复用 `loadWebRTC({realInput:true, ...})`，不要沿用把 `createOffer()` 替换为空函数的简化 continuity fixture。用 map 保存 fake timeout/interval 和 video rVFC；时钟为可推进 monotonic 数值；DOM 使用 `makeElement` 并补 `document.hidden=false`、`querySelectorAll`、window 监听接口。mock socket `emit(event,payload)` 保存 `{event,payload}`，`connected=true`。VM 加载真实 `webrtc-stats.js`（参考 continuity 中 `retainedStartupPeerFixture`），并且必须按以下代码加载真实媒体 controller/runtime、初始化实例；`loadWebRTC()` 自身不加载这两个模块。这里采用现有 `webrtc.test.js` 的 `initial visible attempt binds active media without requiring a resume request` 装载方式：controller 导出到 VM window，runtime 导出到 VM globalThis。

```javascript
for (const filename of ['media-activity-controller.js', 'media-activity-runtime.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, filename), 'utf8'), h.context);
}
h.context.MediaActivityController = h.context.MediaActivityController || h.context.window.MediaActivityController;
h.context.MediaActivityRuntime = h.context.MediaActivityRuntime || h.context.window.MediaActivityRuntime;
assert.ok(h.context.MediaActivityController);
assert.ok(h.context.MediaActivityRuntime);
w.initializeMediaActivity();
assert.ok(w.mediaActivityController, 'real controller is required');
assert.ok(w.mediaActivityRuntime, 'absent runtime must not silently allow input');
const mediaRequest = (state = 'active') => {
  const entry = [...emitted].reverse().find(({ event, payload }) =>
    event === 'media-activity-change' && payload.state === state
    && payload.connectionAttemptId === w.currentConnectionAttemptId
    && payload.generation === w._mediaIntent?.generation);
  assert.ok(entry, 'real current-scope media request must have been emitted');
  assert.ok(entry.payload.generation > 0);
  return entry.payload;
};
const ackMedia = request => w.handleMediaActivityAck({
  state: request.state, generation: request.generation,
  connectionAttemptId: request.connectionAttemptId, applied: true,
});
```

不得给 `mediaActivityRuntime`、`getMediaAppliedPhase()` 或 `canEnableDesktopInput()` 填 permissive stub。PC fake 实现以下浏览器接口，全部只记录平台行为：

```javascript
class RecoveryPeer {
  constructor() {
    this.connectionState = this.iceConnectionState = 'new';
    this.signalingState = 'stable'; this.iceGatheringState = 'complete';
    this.transceivers = []; this.decoded = 0; peers.push(this);
  }
  createDataChannel() { return { readyState: 'open', bufferedAmount: 0, send() {}, close() {} }; }
  getTransceivers() { return this.transceivers; }
  addTransceiver() {
    const t = { receiver: { track: { kind: 'video' } }, setCodecPreferences() {} };
    this.transceivers.push(t); return t;
  }
  getReceivers() { return []; }
  async createOffer() { return { type: 'offer', sdp: 'offline-fixture-sdp' }; }
  async setLocalDescription(value) { this.localDescription = value; this.signalingState = 'have-local-offer'; }
  async setRemoteDescription(value) { this.remoteDescription = value; this.signalingState = 'stable'; }
  async getStats() { return new Map([['video', { type: 'inbound-rtp', kind: 'video',
    framesDecoded: this.decoded, framesReceived: this.decoded, frameWidth: 1280, frameHeight: 720 }]]); }
  addEventListener() {} removeEventListener() {}
  close() { this.connectionState = this.iceConnectionState = this.signalingState = 'closed'; }
}
```

fixture 的 `settle = startupJoinFlush`；video 设宽高 1280×720、初始 `readyState=0`，`play()` 记录调用并返回可控 Promise，rVFC 将 callback 存入 `frames` 并返回单调 id。`connect(peer,stream)` 调用真实绑定的 `peer.ontrack({track:{kind:'video'},streams:[stream]})`，设置平台 connection/ICE state 为 connected，再调用真实 `onconnectionstatechange`；stream 具有 `getTracks:()=>[]`。`paint()` 只调用当前存于 `frames` 的 rVFC，不直接赋值产品 painted/ready/input。

初始化顺序：`initializeMediaActivity()` → `beginStartupEpisode()` → `startStartupMediaBudget()` → `beginConnectionAttempt('viewer-open')` → 真实 grant（fixture lease epoch 7）→ settle → 当前 peer answer/connection/track。初始 generation 0 active 本来无须 resume ACK，不能将它误认为已测试恢复 ACK；因此必须继续用以下真实理由转换建立正 generation 的 active intent，而不是直接赋值 `_mediaIntent` 或 runtime phase：

```javascript
w.setMediaActivityReason('manual-pause', true);
ackMedia(mediaRequest('suspended'));
assert.equal(w.getMediaAppliedPhase(), 'suspended');
w.setMediaActivityReason('manual-pause', false);
assert.equal(w.getMediaAppliedPhase(), 'resuming');
assert.equal(input.getEffectiveInputGate().allowed, false);
ackMedia(mediaRequest());
assert.equal(w.mediaActivityRuntime.snapshot().lastAck.applied, true);
assert.equal(w.getMediaAppliedPhase(), 'resuming');
assert.equal(input.getEffectiveInputGate().allowed, false);
paint();
assert.equal(w.getMediaAppliedPhase(), 'active');
assert.equal(w.canEnableDesktopInput(), true);
```

经真实 `checkStartupEpisode({painted:true})` 确认 episode complete。若实际初始化/暂停产生键鼠 reset 请求，逐项通过真实 ACK 入口确认后才断言真实 Input gate 可用；不得清空 pending、直接设置 ready/active 或跳过已生成的 reset。匹配媒体 ACK 是本主 fixture 必经步骤，不再是条件选项。加载/组装 fixture 的平台字段缺失必须先修好，才能记录 RED。

第一条测试核心必须是以下实际路径与断言（变量来自上面的 helper）：

```javascript
test('after-grace ownership: changed grant retires unleased refreshed peer', async () => {
  const { w, input, video, peers, settle, connect, paint, mediaRequest, ackMedia } = await afterGracePeerFixture();
  w.freezeControl('signal-disconnect');
  await w.refresh({ reason: 'signal-reconnected' });
  const orphan = w.pc, owner = w._peerCallbackOwner;
  assert.equal(orphan._wrdControlLease, null);
  const oldTrack = orphan.ontrack, oldConnected = orphan.onconnectionstatechange;
  w.handleControlGrant({ controller: true, leaseId: 'offline-next-lease', leaseEpoch: 9 });
  await settle();
  assert.notEqual(w.pc, orphan, 'new attempt must not retain a peer owned by the previous attempt');
  assert.equal(orphan.connectionState, 'closed');
  assert.equal(w.ownsStartupOwner(owner), false);
  assert.equal(w._peerCallbackOwner.peer, w.pc);
  assert.equal(w._peerCallbackOwner.attempt, w.currentConnectionAttemptId);
  assert.equal(w._peerCallbackOwner.sequence, w.connectionAttemptSequence);
  assert.equal(input.getEffectiveInputGate().allowed, false);
  const stream = { getTracks: () => [] };
  connect(w.pc, stream); await settle();
  assert.equal(video.srcObject, stream);
  assert.ok(w._statsSampler); assert.ok(w._videoFrameOwner);
  oldTrack({ track: { kind: 'video' }, streams: [{ getTracks: () => [] }] });
  oldConnected();
  assert.equal(video.srcObject, stream);
  assert.ok(w.mediaActivityController); assert.ok(w.mediaActivityRuntime);
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  assert.equal(w.canEnableDesktopInput(), false);
  const request = mediaRequest();
  ackMedia(request);
  const applied = w.mediaActivityRuntime.snapshot().lastAck;
  assert.equal(applied.applied, true);
  assert.equal(applied.connectionAttemptId, request.connectionAttemptId);
  assert.equal(applied.generation, request.generation);
  assert.equal(w.getMediaAppliedPhase(), 'resuming');
  assert.equal(w.canEnableDesktopInput(), false, 'applied ACK alone is not a fresh frame');
  assert.equal(input.getEffectiveInputGate().allowed, false);
  paint();
  assert.equal(w.isCurrentAttemptMediaReady(), true);
  assert.equal(w.getMediaAppliedPhase(), 'active');
  assert.equal(w.canEnableDesktopInput(), true);
  assert.equal(peers.filter(peer => peer.connectionState !== 'closed').length, 1);
});
```

上述主断言证明实际 media runtime 的 ACK→frame 门禁；测试结束前还必须检查真实 Input：若仍有 reset barrier，断言 input=false，逐项送实际请求匹配的真实 applied ACK（沿既有 `acceptKeyboardAck` / `acceptMouseAck` 或所属 transport 的 `acceptObservedInputAck` 入口），两类 reset 均确认后断言 `input.getEffectiveInputGate().allowed === true`；若本 changed lease 场景没有残留 reset，则直接断言最终 true，并在 within-grace 场景强制覆盖两个真实 reset 逐项 ACK。媒体 ACK、fresh frame 都不得代替 reset ACK。测试不得调用 `markMediaAttemptReady()` / `noteMediaRenderedFrame()` 来代替保存的真实 rVFC；play 调用计数须另外断言新 stream 恰好发生有效 play。

- [ ] **Step 3：执行并保存预期 RED。**

```bash
node --test --test-name-pattern='after-grace ownership' web-client/js/webrtc.test.js
```

基线预期失败在 `assert.notEqual(w.pc, orphan)`；保留该实际输出和源码基线。若未复现，先检查 fixture 是否真实走到无租约 peer 与 changed attempt，不开始盲改源码。

- [ ] **Step 4：扩展现有条件，运行同一条测试取得 GREEN。**

在 `differentPeerLease` 后增加条件，将原 `if (differentPeerLease)` 替换为：

```javascript
const unleasedPeerChangesAttempt = this.pc && mediaLeaseChanged && !peerLease;
if (differentPeerLease || unleasedPeerChangesAttempt) {
  // Existing retirement body stays here, before the new attempt and reconcile.
}
```

保留原退休 body 原位，注释说明新 attempt 不能继承无租约 peer 的旧回调 owner。不要将空 body 当成完整补丁；不要额外调用 refresh/重新 begin attempt，不增加 helper，不改 `ownsStartupOwner`。原分支已先清空 peer/DC 引用再 close；新 peer 必须由后方现有 reconcile 建立。重复 Step 3 的原命令，预期同测试 PASS。

- [ ] **Step 5：补齐反例矩阵并运行。**

以同一 fixture 添加以下命名测试；每项都调用真实方法，复用 Step 2 的 peer/owner/stream/gate 断言：

| 测试名后缀 | 具体驱动与断言 |
|---|---|
| `pending startup preserves allowance` | 首次不 paint；记录 episode、remaining、feedbackRemaining；freeze/refresh/grant；episode 相同且余额不增，最终 peer owner 当前 |
| `current frame waits for matching media ACK` | 从实际 current request baseline 起先调用当前 rVFC：paint/current-attempt 可变 true，但 runtime 仍 resuming 且 Input=false；送旧 attempt/generation ACK 后仍关闭；再送当前匹配 ACK，允许真实 early-frame replay 使 runtime active。不得强制要求 ACK 后再来第二帧，也不得接受旧 baseline 的 early frame |
| `old media proof cannot complete new request` | 保存退休前的 request ACK 和 rVFC；新 grant/connect 后调用旧 ACK/旧 frame，runtime 仍 resuming/Input=false；当前 ACK 仅取得 applied，必须再有当前 baseline 的真实 rVFC 才 active。两种顺序与 ACK 前后门禁均有断言 |
| `connected and track before changed grant` | 无租约 peer 的 track/connection 在 grant 前运行，保存 hooks/frame/stats；新 grant 后旧流不能被视作新 frame，新 peer 仍需自己的 track/frame |
| `retired producers cannot revive` | 保存旧 track/connection/ICE、DC open/close/message、watchdog callback、stats onSample/onError、rVFC、metadata/playing、8s fallback、play resolve/reject；退休后逐个执行。每次断言新 pc/srcObject、paint/gate、sampler/frame owner 与 timers 不被旧 producer 改变；promise 日志本身不算控制效果 |
| `duplicate grant preserves healthy peer` | 当前已 connected/painted peer 重复原 lease grant；peer/attempt/sequence/active producer 不变，无额外 peer/健康 peer offer；原 frame gate 保持 |
| `within grace rebind preserves peer and ACK barrier` | 信令 freeze 后同租约恢复，调用真实 recovery connected；复用 peer/attempt；逐个确认 mouse 与 keyboard reset，任一未确认仍 input=false |
| `first grant keeps unleased startup peer` | 无旧 `_mediaControlLease` 的首 grant，既有无租约 peer 不因新条件退休 |
| `different leased peer still retires` | 带旧 lease peer + 新 grant，保留既有退休、新 owner/新 fresh frame 约束 |

实际 queued callback 捕获方式参照 `retainedStartupPeerFixture()`；不能仅断言事件属性已设 null，因为浏览器已经排队的闭包仍可调用。对没有生成的 producer 先驱动真实入口生成它，不能把缺失记录作 PASS。

```bash
node --test --test-name-pattern='after-grace ownership' web-client/js/webrtc.test.js
node --test web-client/js/webrtc.test.js web-client/js/input-signaling-continuity.test.js web-client/js/media-activity-lifecycle.test.js web-client/js/datachannel-watchdog.test.js web-client/js/desktop-session-state-owner.test.js web-client/js/latency-monitor.test.js
git diff --check
```

结果只声明离线源码 VM 回归。失败时修复本任务导致的回归后重跑必要测试；不把原有失败隐藏为 skip，不改质量/预算/ACK 门槛。

- [ ] **Step 6：独立 task review。**

root 先按 Step 7 的精确文件规则创建候选 commit 和 immutable review package，再派 reviewer；候选 commit 只为审查保留明确版本，不代表 review、部署或运行资格已通过。实现者不操作 index/commit。

交给未编写实现的 reviewer 检查 spec 符合性，再检查实现安全性、源码真实执行、RED 原因与全部回调反例。重点看：changed lease 判定是否最小；first/same lease 行为是否保留；close 重入是否失效；最终 attempt 才绑定 producer；回调 guard、M1、ACK、media contract 是否未被绕开。reviewer 只读，不执行服务/网络/浏览器。把 findings、修复及 targeted rerun 写在执行记录。未解决 P0/P1/P2 或 spec 偏离阻止代码准入。

- [ ] **Step 7：root 提交与记录精确文件集。**

只有 root 暂存实际变更的上述源码、回归及两个设计/计划文档；先核对 staged diff。按 Step 6 在 review 前生成候选 commit，review 修正再单独提交，review 通过后记录最终 commit SHA 与实际测试计数。示例 commit：`fix(viewer): recreate unleased peer on control attempt change`。不包含生成的 dist、运行日志、manifest、凭据或其他 worker 文件。

## Final review：交付代码与证据的一致性

- [ ] 由独立最终 reviewer 核对最终 commit 相对基线的完整范围，以及 task review 修复后的 diff；确认没有用 test-only producer 替代真实生命周期，没有引入 owner 迁移框架或额外重试预算。
- [ ] 将 spec 行为 1–6、七项回归矩阵、原失败不覆盖、源码/部署/运行分层逐项映射到证据；无新改动时不重复运行已通过全套。
- [ ] 记录“代码准入通过/不通过”及尚未部署、尚未新的普通完整序列资格、native/visible/physical NOT_RUN；将受审 commit 交回 root。review 记录纳入本仓库版本管理，不仅留在聊天或临时文件。

## Root 后续阶段：部署准备与全新运行资格（本实现任务不执行）

1. root 读取服务 skill、README、runbook，准备受审修复的新组件 pin 与新 manifest；保留 baseline/within 成功及本次 after 失败完整历史，核对新构建、实际交付资源和源码身份。R4 旧固定 pin 包不可直接复用；R5 b032 记录不得覆写成新版本。
2. runtime/primary/legacy 以及 Signal/Host/tunnel 状态在 root 具体部署准备前不动。运行阶段不能凭此文档自行取得 restart/tunnel/native 额外授权；按既有用户授权边界由 root 执行。
3. 运行资格重新生成独立序列，严格 baseline → within-grace → after-grace → continuity，每个场景仍须 root 独立决策和 fresh strict-idle。保留 lsof 5s 上限、root decision/known-quiescence 60s freshness、60s 恢复截止、30s 恢复稳定窗、300s/390s/390s/10800s 预算与原 worker deadline/cleanup；保留服务端 reset/regrant 关系、覆盖、帧新鲜度、当前媒体/input gates、身份和 cleanup 判据，任一失败关闭序列并保留证据。
4. `reset-unconfirmed` 诊断标签的宽泛性另列问题；即使确认 reset 已成功，也不能把缺少 fresh callback/current media/input 的运行改判 PASS。外部隔离资源、native/visible/physical 验收仍按各自门槛单独处理。

## 文档自审与执行记录

- 2026-10-19：设计与计划自审完成。方案已比较；实现只改既有分支；矩阵覆盖新 attempt、旧 producer、same lease、首 grant；计划保留独立 task/final review 和后续部署/全新资格分层。未实施、未运行测试/build、未操作服务/网络/浏览器/native，未变更 index/HEAD。
- 2026-10-19：按独立设计/计划 review 的 Important 修正文档：强制同 VM 装载并初始化真实媒体 controller/runtime；通过真实 manual-pause 理由转换建立正 generation intent，匹配实际 emitted request 的 `handleMediaActivityAck()`，覆盖 ACK→frame、frame→ACK 与旧 scope 拒绝；独立保留双 reset ACK。仅静态核对现有装载测试与源码 API，未执行 VM 测试；修订等待 root 窄复审，不表示实现准入。
- 执行状态：Task 1、Final review 与 Root 后续阶段均未执行。本条作为当前事实基线；执行者随后追加真实时间、commit、RED/GREEN 和 review 证据，不提前勾选。

- 2026-10-19 实施更新：Task 1 候选 `cc833d82a2e0700135a92dc53fac7bfad0912dbf`。真实 VM RED 在旧实现以 `assert.notEqual(w.pc, orphan)` 失败（175.565082ms）；最小分支修复后同例 GREEN（188.307589ms），ownership 10/10（304.791350ms），最终受影响六文件 459/459（24420.546633ms）。保留历史失败和 continuity fixture 修订记录，详见同目录 reports/evidence/2026-10-19-after-grace-peer-ownership/task-1-implementation.md。
- 2026-10-19 独立 Task 1 review：spec compliance ✅、quality Approved，无 Critical/Important。重复 grant 的既有媒体重确认不扩大本修复；root 同步当前文档状态。审查记录 task-1-review.md 纳入版本管理。Task 1 complete；Final review 待完成，实际部署/新序列、native/visible/physical 仍 NOT_RUN。
