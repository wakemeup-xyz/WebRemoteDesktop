# JPEG Relay Recovery Implementation Plan

> **For agentic workers:** 执行使用总任务已启用的 superpowers:subagent-driven-development，逐项实施并独立 review。 Steps use checkbox (`- [ ]`) syntax for tracking. 总任务已安排一个 implementation writer；不重新询问执行方式，不并行修改共享文件或 Git index。

**Goal:** 消除 JPEG 丢失/乱序反馈造成的无限占槽，证明恢复帧来源，关闭稳态停帧输入门禁并提供真实同钟反馈指标。

**Architecture:** 保留现有 Host worker、Signal volatile 转发和 Viewer媒体生命周期。用媒体槽TTL、不可碰撞producer身份和精确ACK释放修复同一链路；通过现有控制/reset与latency collector集成，不新增恢复控制器。

**Tech Stack:** Python asyncio/现有pytest，Node.js/Socket.IO，classic browser JavaScript/现有VM测试；无新依赖。

**Spec:** [M6补充设计](../specs/2026-10-17-jpeg-relay-recovery-addendum.md)。执行前同时读媒体/控制总spec及本仓库AGENTS.md。

## Global Constraints

- 固定 `RELAY_FRAME_SLOT_TTL_MS = 2000`，Host monotonic；精确删除单ACK槽，高水位取max，不做累计ACK。
- JPEG稳态load-age阈值5000ms，Viewer performance.now；first-frame/resume仍用现有恢复预算。
- 保留单worker、一个执行+一个最新请求、现有profile一/二槽及M3缓冲上限；旧JPEG不重传，业务输入不重放。
- 不新增降质触发，不改Quality Lock、网络模式、TURN、URL或分辨率策略；不新增依赖。
- 控制authority、lease、C3 reset屏障只有现有一套。新图不清未完成reset。
- strict frame/ACK/feedback必须验证完整origin；legacy兼容不得作为strict恢复证明。
- 无跨机Date.now差值；缺测null，image load不冒充光学呈现或输入可见效果。
- 只操作已授权本地服务；tunnel不得重启/重建。短测、长测、物理输入独立记录。
- 文档由总任务提交；实施期间单个 writer 独占 Git index，只提交本任务文件/hunks，随后独立 review。

## 文件所有权

| 文件 | 责任 |
|---|---|
| `python-host/host.py` | TunnelRelayStreamer、媒体控制ACK、authority与帧ACK适配 |
| `python-host/test_tunnel_relay.py` | 实际run循环与槽/身份/反馈回归 |
| `signal-server/websocket/signaling.js` | 控制ACK白名单、frame/ACK/feedback授权转发 |
| `signal-server/websocket/signaling.test.js` | 实际事件handler路由测试 |
| `web-client/js/webrtc.js` | origin准入、onload、freshness、telemetry消费 |
| `web-client/js/webrtc.test.js` | 现有loadWebRTC VM与realInput集成测试 |
| `web-client/js/latency-monitor.test.js` | 采样过期/重复/缺测契约补充 |
| `docs/需求文档/WebRemoteDesktop-需求文档.md` | 记录新增行为、兼容边界及验收状态 |
| `docs/superpowers/reports/2026-10-17-remediation-execution.md` | 部署身份、实际测试、失败与NOT RUN |

如需抽取纯scope校验，仅抽局部无副作用helper；不得趁机拆分host/webrtc或引入第二份authority。任务按M6.1→M6.2→M6.3→M6.4串行；相关生产文件在每次提交时保持协议完整。

## M6.1：精确ACK和可证明的槽位退休

**Interfaces:** 在TunnelRelayStreamer增加 `expire_inflight(now_ms: float) -> int`；`ack`保留调用入口、在M6.2收紧scope参数。新增固定TTL和expired/unmatched计数。`last_acked_frame_id`仅统计进度。

- [ ] **写红灯并运行现有pytest。** 在`test_tunnel_relay.py`加入下列实际方法用例，现有FakeSio可复用；frame meta追加字段在M6.2统一更新。

```python
def test_reordered_ack_releases_its_own_slot(monkeypatch):
    relay = TunnelRelayStreamer(FakeSio())
    monkeypatch.setattr('host.time.monotonic', lambda: 1.0)
    relay.inflight_frames = {
        n: {'sent_at_ms': 900.0, 'generation': relay.production_generation}
        for n in (98, 99)
    }
    relay.ack(99)
    relay.ack(98)
    assert relay.inflight_frames == {}
    assert relay.last_acked_frame_id == 99
    assert relay.ack_event.is_set()

def test_expiry_releases_slots_without_ack():
    relay = TunnelRelayStreamer(FakeSio())
    relay.inflight_frames = {
        1: {'sent_at_ms': 10.0, 'generation': relay.production_generation}
    }
    assert relay.expire_inflight(2009.0) == 0
    assert relay.expire_inflight(2010.0) == 1
    assert relay.pending_frame_count() == 0
    assert relay.ack_event.is_set()
```

Run: `cd python-host && python3 -B -m pytest test_tunnel_relay.py -q`。Expected red：乱序遗留98、expire缺失。只运行既有环境中pytest，不安装依赖或启动Host。

- [ ] **实现最小槽策略。** 用真实monotonic毫秒；每轮准入前及等待超时后调用expiry，ACK入口先expiry再匹配。下面为方法的核心控制流，实际属性名按既有代码接入：

```python
expired = [fid for fid, meta in self.inflight_frames.items()
           if now_ms - meta['sent_at_ms'] >= RELAY_FRAME_SLOT_TTL_MS]
for fid in expired:
    self.inflight_frames.pop(fid, None)
if expired:
    self.expired_frame_count += len(expired)
    self.ack_event.set()
# ACK: scope校验成功后才能pop；不得用低于watermark提前return。
meta = self.inflight_frames.pop(frame_id, None)
if meta is not None:
    self.ack_event.set()
    self.last_acked_frame_id = max(self.last_acked_frame_id, frame_id)
```

TTL退休不调用profile downshift。仍有效ACK才调用现有 `_record_ack_feedback`，过期/未知不能驱动升降档。emit失败立即释放并wake。保留等待yield，不能满窗口busy-loop。

- [ ] **写实际 `_run` 活性测试。** monkeypatch RelayFrameWorker为有计数的fake，submit_latest返回一字节JPEG及width/height/encodeMs；fake emit不发送ACK。通过fake clock推进mono、替换该测试使用的wait_for到受控TimeoutError，四个timeout后必须出现第三次capture/emit；保留真实 `_run`，结束时置enabled false并正常await。断言最大pending<=cap、每帧编号不同、无历史重发、worker实例数1。加emit抛异常、pause中的过期、11秒迟到ACK、profile降为cap1后旧两槽最终退休、循环15分钟假时钟map有界；不可调用MSS/native。

- [ ] **运行并review。** 同上pytest及`test_relay_frame_worker.py`；独立review确认实际循环持续推进，迟到ACK不伪造成功，无隐式降质。先保留变更供M6.2协议一起集成，或由总任务仅提交已独立安全的槽修复：`fix(media): retire stalled JPEG relay slots`。

## M6.2：源scope贯穿Host、Signal、Viewer

**Interfaces:** `relayFrameSchemaVersion:1`、`relayScope:{producerId,productionGeneration,connectionAttemptId,mediaGeneration,leaseEpoch}`。mediaGeneration为非负安全整数（首次0），其余scope数字正安全整数。同scope用于frame、ACK、成功control ACK；原lease `schemaVersion`不改变。Viewer新增局部 `acceptRelayScope(scope)`/`relayScopeMatches(scope)`校验与期望值管理；Host同一校验语义，不能信任仅frameId。ordinary start另有 `relayStartRequestId`（每次start随机ASCII≤64）和 `relayMediaGeneration`，ACK `relayControlKind:'start'` 对应此独立请求，详见spec §4。

- [ ] **先写首次generation 0真实握手红灯。** 从全新controller/runtime generation0开始，调用真实 `startTunnelRelay/emitRelayStreamControl` 捕获bind及ordinary start；把事件依次经过现有Signal真实注册handlers及Host `on_connection_attempt_bind/on_relay_stream_control` fixture，取得成功start ACK，交回Viewer真实 `handleMediaActivityAck`。ACK前frame不能ready；ACK匹配后第一帧onload必须ready且输入只在其他既有屏障均通过后可用。测试不能先设置positive generation、调用pause/resume、mock scope matcher或手动赋expected scope来绕开首连。跨语言fixture以同一规范请求/ACK字典对接并分别调用真实handler，保留字段一致断言；不要求启动真实网络。

同样覆盖WebRTC→tunnel fallback、同attempt producer restart（request nonce变）、双route同ACK幂等、旧start ACK晚到、暂停后旧gen0 request、socket替换和不匹配lease；sampleScope.mediaGeneration=0合法，负数/bool拒绝。ordinary start payload只加relayMediaGeneration，不能加state/generation而误入Signal正generation媒体控制分支。

- [ ] **从已可输入状态验证pending-start门禁。** 使用 `loadWebRTC({realInput:true})` 建立已painted/attempt-ready且实际业务可发送的当前会话，再调用真实 `startTunnelRelay` 做同attempt restart和WebRTC→tunnel fallback。建立pending start时清旧hasPaintedFrame/attempt-ready、旧scope及load证明，并立即同步关闭effective business gate；仅 `setUiPhase('signaling')` 不足。分别在pending建立后、start ACK前、ACK accepted但合格新onload前调用真实业务输入入口，断言均没有业务消息发出（安全release/reset消息单独识别）。覆盖按住键/鼠标，复用M6.3既有reset屏障和当前reset IDs；新onload先于reset ACK时仍禁止业务，二者均完成后才恢复。不得用只断言Input.isActive或UI phase代替实际发送断言，不新增恢复controller。

- [ ] **添加来源反例。** Host test创建两个实际streamer，模拟相同frameId/productionGeneration但不同producerId；旧ACK不能释放新槽。相同streamer恢复后旧mediaGeneration/productionGeneration帧ACK拒绝。从真实Host媒体control handler获取成功ACK，断言scope来自已验证authority而非客户端自报nonce。

Viewer在现有`loadWebRTC()`fixture、现有tunnel lifecycle测试旁追加以下断言序列；所有帧都调用真实 `handleRelayFrame`：

```js
const oldScope = { producerId: 'producer-a', productionGeneration: 2,
  connectionAttemptId: 'attempt', mediaGeneration: 1, leaseEpoch: 1 };
const newScope = { ...oldScope, productionGeneration: 4, mediaGeneration: 2 };
// 通过真实handleMediaActivityAck接受newScope前，任何frame都不ready。
WebRTC.handleRelayFrame({ relayFrameSchemaVersion: 1, relayScope: oldScope,
  frameId: 99, data: 'AA==' });
assert.equal(WebRTC.tunnelLastFrameId, 0);
// 接受newScope控制ACK后旧帧仍被拒绝；合法frameId1才可设置src。
// 保存其onload，再投递合法frameId2；调用旧onload不得ACK或更新freshness。
// 调用frameId2当前onload只发一个含原scope的ACK。
```

该片段置于已有完整tunnel fixture内，fixture必须建立真实runtime/lease/attempt并通过控制ACK，不mock `relayScopeMatches=true`。原“ACK前frame能直接promote”测试改为明确丢弃早帧、ACK后新frame才能恢复；新旧callback测试分开。legacy fixtures显式选择legacy，不能给缺scope帧隐式补scope。

- [ ] **运行红灯。** `node --test web-client/js/webrtc.test.js signal-server/websocket/signaling.test.js`；Host同M6.1。Expected red：旧帧推进watermark/ready、Signal丢control ACK字段、旧ACK释放重用ID。

- [ ] **串行修改三层。** Host每次成功start生成UUID nonce；显式media control及ordinary start都绑定真实authority scope。ordinary `on_relay_stream_control`在现有媒体锁下核对active媒体binding与请求的attempt/relayMediaGeneration/lease，再启动并在await后复核owns_relay，返回带requestId/kind/scope的ACK；不是只修改 `_apply_tunnel_media_control`。Signal ordinary请求仍走既有lease授权和已绑定attempt检查，保留requestId/relayMediaGeneration，成功ACK白名单双route保留kind/requestId/scope。Viewer在runtime applyAck之前分派start ACK，完整匹配当前pending socket/lease/attempt/generation/requestId，接纳scope但不mark ready，不把generation0强塞给runtime。旧/重复/失败ACK按spec处理。worker request及frame meta固定同scope，emit前复核。显式media control继续既有runtime accepted规则。strict frame和onload都先匹配，再提交水位/ready/ACK；暂停、停止、attempt/socket/lease变化清理pending-start、scope及object URLs。实现核心顺序：

```js
if (!this.relayScopeMatches(data.relayScope)) return;
const origin = Object.freeze({ ...data.relayScope });
const token = ++this._relayImageRequestToken;
const onload = () => {
  if (token !== this._relayImageRequestToken || !this.relayScopeMatches(origin)) return;
  // 此处才执行既有ready、fresh-frame、ACK；ACK原样echo origin。
};
```

Host `on_relay_frame_ack`复用现有authority/lease验证并将完整scope交给relay ACK；无current权时无反馈/无pop。Signal测试使用真实注册handler：当前Host→当前Viewer成功；旧Host/被顶替Viewer/旧companion失败；双route control ACK字段一致；malformed bool/超长nonce不成为strict scope。新Viewer/旧Host保留未验证门禁并提示，旧Viewer路径显式兼容且TTL有界。

- [ ] **运行绿灯并review。** Host relay/媒体authority相关测试，Viewer `webrtc.test.js media-activity-runtime.test.js input-recovery.test.js`，Signal signaling测试。审查无authority新增来源、无current-scope重写。总任务提交完整三层协议：`fix(media): bind JPEG relay frames to producer scope`。

## M6.3：稳态freshness安全门禁及反馈指标

**Interfaces:** Viewer同scope保存最后合格onload的performance.now和单timer；新增 `relay-frame-feedback`，精确schema见spec §6，Host/Signal/Viewer同一实现提交。使用现有 `LatencyMonitor.recordStage('relayFrameAckRttMs', value, {scope,atMs,sampleKey})`，collector scope仍为既有attempt/generation/leaseEpoch。scope数字generation在collector中来自connectionAttemptSequence，不能假设媒体resume会改变它。

- [ ] **写门禁红灯，核对实际Input。** 使用`loadWebRTC({realInput:true})`及现有fake clocks/timer注入；按住键和鼠标后停load5000ms，断言UI stalled、Input关闭、effective business gate拒绝实际业务发送、已发送keyboard reset和mouse reset。fresh frame先于resetACK到达：业务输入仍拒绝；同scope当前C3拥有的reset applied ACK后业务才可恢复。fresh-frame `setActive(true)`可调用已有 `_maybeAutoRecover`，测试须在该调用后读取当前 `_recoveryCycle` / `_captureKeyboardReset()`及mouse pending的实际reset IDs，并对匹配的当前ID回ACK；旧/被替换ID必须仍拒绝，不能假定第一条reset永远是恢复条件。补已经inactive但按住键/RESET_REQUIRED、reset rejected、reset timeout的真实入口用例，后两者保持blocked/uncertain，禁止测试直接清barrier。重复timer、旧scope timer、suspend期间均不重复reset。仅frame arrival/feedback/业务ACK不能更新load age。

- [ ] **接入现有reset。** 首次stale先设置media-stalled，调用下列既有入口，保留pending屏障；不只调用默认sync，因为有lease时默认不reset键盘。

```js
const wasActive = Input.isActive;
Input.setActive(false, { resetKeyboard: true, reason: 'relay-frame-stale' });
const keyboard = Input.keyboardController?.getSnapshot?.() || {};
if (!wasActive && (keyboard.pressedKeyCount > 0 || keyboard.state === 'RESET_REQUIRED')) {
  Input.resetKeyboard('relay-frame-stale');
}
this.syncDesktopInputGate();
```

每scope最多一个timer；onload重置deadline，callback复核scope和age；scope结束clear。恢复只更新media state，不能清 `_pendingMouseReset`、keyboard reset或uncertain。验证释放消息在业务门禁关闭时仍走现有安全通路，失败保留C3 blocked。JPEG FPS切到合格load窗口；保留独立load age名称。

- [ ] **写反馈红灯。** Host fake时间有ACK时最多每秒一反馈；无ACK背压期间仍有pendingAge/expired摘要，样本null；TTL临界1999ms可采、2000ms退休/无采样。两个同间隔合格样本只发最后一个且coalescedCount=1，null心跳不增加，完整origin变化后全部计数/序列归零重新从1，Signal白名单必须包含coalescedCount。跨scope/重复seq/null不能recordStage；Viewer与Host wall clock差±86400000ms不影响UI/RTT/质量。断言反馈样本只有Host monotonic实际数值，五秒过期显示未测量，报告明确TTL右截断及最新合并的双重筛选。

使用实际createLatencyMonitor并由Viewer真实反馈handler调用：同collector scope不变，先采纳producer A/sample1=100ms，再采纳producer B/sample1=200ms且间隔<5秒，snapshot count必须2、last200；同B重复sample1不增加，晚到A/sample2被拒绝，resume换mediaGeneration也允许其sample1。新origin但尚无新样本时当前UI为未测量，collector旧合法样本仍保留至原窗口到期；另record一条inputAckRttMs确认没有为清relay重置整个collector。验证最长128字符attempt/64字符producer的规范origin仍生成合法≤128 ASCII sampleKey，不可截断形成碰撞；原scope摘要异步计算晚到不得污染新scope。

- [ ] **接通反馈而不增加排队。** Host `_run`共同tick路径每秒最多emit一次，保留最近一个未发有效样本和递增seq；不保留逐帧历史/创建逐帧task。计数是完整relayScope下累计expiredCount/unmatchedAckCount/timeoutCount/coalescedCount，origin变化归零，计数饱和；样本seq溢出停止该观测而非重复。Signal严格白名单scope/数值/上述完整计数并仅路由owner。Viewer当前socket回调先校验origin及seq，再recordStage，使用Viewer接收时performance.now作采样时点。每origin接受时以Web Crypto预计算并缓存下列digest；异步完成需复核socket、pending origin token，没有Web Crypto则本metric不可用，不能退回短seq键。规范数组顺序固定，不对字符串字段截断。

```js
const canonicalOrigin = JSON.stringify([origin.producerId, origin.productionGeneration,
  origin.connectionAttemptId, origin.mediaGeneration, origin.leaseEpoch]);
const digestBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalOrigin));
const originDigest = Array.from(new Uint8Array(digestBytes), b => b.toString(16).padStart(2, '0')).join('');
// await后先重新核对当前origin/socket，再保存digest；不要改变collector scope。
```

```js
if (sample && Number.isFinite(sample.relayFrameAckRttMs)
    && sample.relayFrameAckRttMs >= 0 && sample.sampleSequence > lastSampleSequence) {
  monitor.recordStage('relayFrameAckRttMs', sample.relayFrameAckRttMs,
    { scope: collectorScope, atMs: receivedAtMs,
      sampleKey: `relay:${originDigest}:${sample.sampleSequence}` });
}
```

receivedAtMs在当前socket feedback入口捕获performance.now，不能在摘要await之后补成now。所有值先strict类型/范围检查，null不得Number(null)变0。collector保留同collector scope内先前origin合法样本至原5秒过期；UI当前origin last单独清缓存，新origin无样本时显示未测量。删除handleRelayFrame所有跨钟差值和网络延迟文案，使用“JPEG反馈往返”及缺测状态；p50/p95只能标作“TTL内且每间隔最新反馈样本”，不是总体分布。五秒样本age是反馈收到年龄，不是图像freshness。backpressure日志/反馈不能只在有新capture时输出；Host摘要年龄无来源保持null。没有有效RTT时不以0驱动profile。

- [ ] **运行绿灯和review。** Host `test_tunnel_relay.py test_relay_frame_worker.py`；Node `webrtc.test.js latency-monitor.test.js input-recovery.test.js`以及Signal signaling。重点review真实Input release/reset与ACK故障，不接受只断言DOM颜色。提交 `fix(media): gate stalled JPEG input and report scoped feedback RTT`。

## M6.4：文档、部署与真实验收闭环

- [ ] **同步需求与实施记录。** 新增M6行为、兼容边界、2000/5000ms参数、图片load与真实visible区别、RTT合并采样边界；保留原公网JPEG FAIL和TURN长测INCOMPLETE。记录已跑测试命令/结果，不提前打勾生产通过。`git diff --check`后总任务review并提交。
- [ ] **核验运行前提。** 按webremote-service技能重读README/runbook；复核当前URL事实来源、现有tunnel身份和单Viewer保护。只执行总任务已授权本地部署，使用服务helper/Host重启脚本；不重建tunnel。核对本地健康、Host在线、生产commit与build，并按仓库规则回报运行密码，不写版本文档。
- [ ] **独立核验I2工具proof时序。** 若总任务采用I2验收工具修订，先真实UI登录并等待core/auth ready，但不Start、不建立Socket、不领普通ticket；随后fresh status确认zeroViewer，用当前Auth内存token一次领取默认TTL30秒的proof，立即真实Start。不得重发或清除已消费proof、绕过zeroViewer或改产品权限。当前bootShell只preload GET bootstrap和installStart、不自动连接，须以最终源码再核验；这项独立于M6产品修复，不能据可能过期就断言先前TURN首次未ready的原因。
- [ ] **重跑同一公网JPEG真实生命周期。** 使用总任务现有严格collector，记录实际helper与代码身份；不能仅放宽阈值使旧FAIL通过。验证pause ACK+停产/gate关闭、resume scope ACK+新图+reset屏障后恢复，随后完整60秒active可见窗口，无>5000ms合格load gap；保留每样本scope/progress/反馈可用性和失败分母。网络注入丢包只在既有明确授权的隔离fixture做，本计划不要求修改生产网络。
- [ ] **检查资源/策略与失败真相。** TTL恢复期间最多cap槽、单worker，expired有计数，不能靠改变用户模式/质量/分辨率取得通过。反馈RTT至少一有效样本且不由壁钟构成；实际缺样写null。任何首次媒体未ready、admission conflict、提前退出、缺60秒均记FAIL/INCOMPLETE，不能补人工成功摘要。
- [ ] **长会话与物理项独立收尾。** 按总计划继续各路径≥3小时，记录实际起止、缺口、资源与frame gap，不能把93.816秒TURN短测或新JPEG短测替代。物理键鼠/真实内容因果未运行仍NOT RUN。全部真实检查和独立review后由总任务决定是否可以称“可用”；只完成代码不得关闭验收。

## 文档自查

spec §1证据保留→M6.4；§3槽活性→M6.1；§4身份及legacy→M6.2；§5安全门禁→M6.3；§6同钟与有界观测→M6.3；§7真实验证→M6.4。三个生产共享文件由同一writer串行修改；先验证真实handler再做公网测试；未采样的初始延迟hop、光学时延保持未知。
