# 媒体、输入背压与延迟测量 Implementation Plan

> 执行状态更新（2026-10-17）：用户已要求完成开发、验收并保持本地服务可用，已进入实施阶段。下文“本轮仅文档／未来授权／全部 NOT RUN”等初稿状态描述保留为规划历史，不再限制本次已授权工作；实际完成、复核、部署与未运行项以[实施记录](../reports/2026-10-17-remediation-execution.md)为准。tunnel 禁止重建的限制继续有效。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保持控制授权和可靠输入顺序的前提下，消除媒体阻塞及无界排队，提供同钟、同帧、有界且诚实的耗时证据。

**Architecture:** 沿用现有WebRTC/Socket与C控制状态机；把计时、帧关联、输入准入和JPEG工作线程封装为可注入纯模块。M1提供总spec规定的snapshot给W，M3消费C2 authority/quiescence，M2/M4形成正确帧与阶段边界，M5只选择经证据验证的媒体组合。

**Tech Stack:** 现有Python 3.11、asyncio/threading、MSS/NumPy/PyAV/aiortc、浏览器JavaScript、Node test runner和unittest；不增加运行依赖。

**Spec:** [媒体与延迟设计](../specs/2026-10-17-media-latency-design.md)，同时读取[总设计](../specs/2026-10-17-reliability-latency-remediation-design.md)和[控制设计](../specs/2026-10-17-control-recovery-design.md)。

## Global Constraints

以下内容须逐字复制到各执行计划的 Global Constraints：

1. 用户后续已明确授权本轮开发、验收、启动本地 Signal/Host 并保持可用；不得停止、重启或重建 tunnel。生产 Viewer 仍须避开正在使用的会话。
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

## 执行边界与文件结构

本计划依据writing-plans 6.3.0编写；本轮只写文档和review，下列代码、测试、提交和真实验收均未执行。用户已确定superpowers路径，不再次询问规划选项。未来实施先读取dirty diff及最新C/W适配，不恢复或覆盖其他任务改动。

推荐顺序：C2正确性先完成 → M3（N4已升P1） → M1 → M2 → M4 → M5。纯M1测试可与C独立进行，生产共享文件串行。W只消费M1白名单/快照和M3队列摘要，不另造统计。固定文件职责：

| 文件 | 职责 |
|---|---|
| `web-client/js/latency-monitor.js` | 纯collector工厂、白名单、生命周期、快照；兼容classic全局及CommonJS |
| `python-host/input_timing.py`（新增） | InputTiming同钟阶段，不执行输入 |
| `python-host/input_frame_causality.py`（新增） | 成功输入→新capture的有界候选/暂存/提交 |
| `python-host/input_admission_queue.py`（新增） | 输入准入、FIFO、冻结与quiescence，不创建authority |
| `python-host/relay_frame_worker.py`（新增） | 单专属线程、latest request、原生资源归属与关闭 |
| `python-host/host.py`、`python-host/input_handler.py` | 调现有adapter/发送接口处接入以上模块 |
| `python-host/rtp_frame_observer.py`、`python-host/media_stage_metrics.py` | 成功发送边界与有界帧身份；失败仅影响观测 |
| `python-host/media_timing.py`、`python-host/h264_videotoolbox_encoder.py` | 真正消费generator的阶段，不制造端到端和 |
| `python-host/h264_encoder_policy.py` | 有证据的联合选择，保留现有启动fallback |
| `scripts/media_latency_qualification.py`（新增） | 纯资格校验/完整矩阵定义，真实probe沿既有脚本 |

所有Python新测试采用unittest，可用 `python3 -B -m unittest ...`，必须在已有依赖的测试解释器运行；不能因import错误通过而声称行为红灯。禁止整文件运行已有 `python-host/test_latency_timing.py`：其中构造真实ScreenCaptureTrack会访问MSS。新测试使用bare_track、__new__或纯模块，不启动原生采集/输入。Node命令直接 `node --test`，不调用npm test/pretest。

## Task M1：同钟指标、窗口与relay反馈（L1/L3/L4/L6/L7/L10）

**Files:**
- Create: `python-host/input_timing.py`、`python-host/test_input_timing_contract.py`。
- Modify: `web-client/js/latency-monitor.js`、`web-client/js/latency-monitor.test.js`、`web-client/js/webrtc-stats.js`、`web-client/js/webrtc-stats.test.js`。
- Modify: `web-client/js/input.js`、`web-client/js/keyboard-transport.js`、`web-client/js/webrtc.js`（提交/ACK/暂停scope适配）；`web-client/js/diagnostic.js`、`web-client/viewer.html`（指标名与标签，不改W的持久化入口）。
- Modify: `python-host/input_handler.py`（126–199及235–331）、`python-host/host.py`（783–787、1941–1948、2138–2171、2198–2275）；`signal-server/websocket/signaling.js`、`signal-server/websocket/signaling.test.js`（input-ack转发及其测试）。
- Update after verification: `docs/需求文档/WebRemoteDesktop-需求文档.md` 的同钟测量说明，不把真实验收改成已通过。

**Interfaces:** 输出spec §3的 `createLatencyMonitor`、`LatencyMonitor.snapshot({nowMs,scope})` 和冻结 `LATENCY_METRIC_NAMES`；CommonJS `{LatencyMonitor,LATENCY_METRIC_NAMES,createLatencyMonitor}`无启动副作用。输出 `InputTiming(clock_ns)` 的 `start_apply()/finish_apply()/durations()`；durations返回hostQueueMs/hostApplyMs（未知null）。ACK只新增可选timing字段，不改输入v2 envelope或C的状态判断。

- [ ] **M1.1 添加行为红灯：timing不能吃ACK、读快照清过期、null不变0。** 将此测试加入现有latency-monitor.test.js；新增工厂的签名由本任务实现，不能只改测试期待旧错误。

```js
const { createLatencyMonitor, LATENCY_METRIC_NAMES } = require('./latency-monitor.js');
test('frame notice is not ACK; snapshot expires without another input', () => {
  let now = 1000;
  const scope = { connectionAttemptId: 'test-a', generation: 1, leaseEpoch: 7 };
  const m = createLatencyMonitor({ now: () => now });
  m.setScope(scope);
  m.recordInputSend('test-input', { scope, domAtMs: 990, submittedAtMs: now,
    inputType: 'mouse', action: 'down', transport: 'socket' });
  now = 1040;
  m.onFrameTiming({ inputIds: ['test-input'] }, { scope, nowMs: now });
  assert.equal(m.snapshot({ nowMs: now, scope }).metrics.inputAckRttMs.count, 0);
  assert.equal(m.snapshot({ nowMs: now, scope }).metrics.inputToVisibleEffectMs.available, false);
  now = 1120;
  const ack = { inputIds: ['test-input'], status: 'applied', hostAdapterAwaitMs: null };
  m.onInputAck(ack, { scope, nowMs: now });
  m.onInputAck(ack, { scope, nowMs: now });
  const s = m.snapshot({ nowMs: now, scope });
  assert.equal(s.metrics.inputAckRttMs.last, 120);
  assert.equal(s.metrics.inputAckRttMs.count, 1);
  assert.equal(s.metrics.hostAdapterAwaitMs.available, false);
  assert.equal(s.outcomes.acked, 1);
  assert.ok(LATENCY_METRIC_NAMES.includes('inputToFrameNoticeMs'));
  now = 120000;
  const expired = m.snapshot({ nowMs: now, scope });
  assert.equal(expired.metrics.inputAckRttMs.available, false);
  assert.equal(expired.metrics.inputAckRttMs.count, 0);
});
```

- [ ] **M1.2 添加Host同钟红灯，实际hook不能在结果生成时才打点。** 新建纯测试；并在新测试类的第二用例使用fake执行器/适配器、Event暂停真实apply_keyboard路径，验证durations来自线程开始结束而非 `_keyboard_result` 时点。不得调用Quartz。

```py
import unittest
from input_timing import InputTiming

class TestInputTimingContract(unittest.TestCase):
    def test_queue_and_execution_are_measured_before_result_construction(self):
        clock = iter([1_000_000, 41_000_000, 71_000_000])
        timing = InputTiming(clock_ns=lambda: next(clock))
        timing.start_apply()
        timing.finish_apply()
        self.assertEqual(timing.durations(), {"hostQueueMs": 40.0, "hostApplyMs": 30.0})
        # Reading again cannot move timestamps or create another sample.
        self.assertEqual(timing.durations()["hostApplyMs"], 30.0)
```

Run from repository root:

```bash
node --test --test-name-pattern='frame notice is not ACK' web-client/js/latency-monitor.test.js
(cd python-host && python3 -B -m unittest test_input_timing_contract -v)
```

Expected red: missing factory/timing module until added; after scaffolding still require old behavior fails exact120ms/null assertions. An unrelated dependency error is a blocked run, not the behavioral red.

- [ ] **M1.3 实现纯collector及hook。** 复制spec完整白名单；样本5秒、每项256/总4096、pending512/10秒、tombstone1024/30秒、元数据1MiB；scope变化/主动暂停处理如spec。freshFrameAgeMs的p50/p95仅gauge schema占位，UI/报告不得解释为分位数。setScope先将旧pending结算cancelled并保存旧final snapshot至4份/60秒/32KiB队列，再建立新scope；takeClosedScopeSummaries原子drain，返回summaries及淘汰dropped，不修改主snapshot字段。最小数值/去重逻辑如下，应用在所有push入口，不保留Date.now采样路径：

```js
const validDuration = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const sameScope = (a, b) => a && b && a.connectionAttemptId === b.connectionAttemptId
  && a.generation === b.generation && a.leaseEpoch === b.leaseEpoch;
// onInputAck: expire(nowMs) first; find pending by current scope+id.
// No pending: matched tombstone -> duplicate/late classification, never another sample.
// Matching pending: record inputAckRttMs only here, then move it to bounded tombstone.
// onFrameTiming may settle only inputToFrameNoticeMs, never the ACK map.
```

```py
class InputTiming:
    def __init__(self, clock_ns):
        self.clock_ns = clock_ns
        self.queued_ns = clock_ns()
        self.started_ns = self.finished_ns = None
    def start_apply(self):
        self.started_ns = self.clock_ns()
    def finish_apply(self):
        self.finished_ns = self.clock_ns()
    def durations(self):
        def delta(a, b):
            return (b-a)/1_000_000 if a is not None and b is not None and b >= a else None
        return {"hostQueueMs": delta(self.queued_ns, self.started_ns),
                "hostApplyMs": delta(self.started_ns, self.finished_ns)}
```

实际adapter创建InputTiming在入队前；worker闭包进入原生调用前start_apply，finally finish_apply。Host外围perf_counter测adapter-await，ACK兼容hostExecuteMs取该总段而非两个结果生成时间戳之差。Signal显式校验/转发三个nullable阶段，去掉`Number(value || 0)`；C先完成业务ACK身份判断，M只消费匹配结果。frontendDispatch使用DOM trace已存本地起点至真正transport接受；发送失败不创建sent/pending。

- [ ] **M1.4 修复relay和时钟同步并补表驱动测试。** relay ACK只使用同generation的inflight.sent_at_ms；客户端latency_ms不参加选择。以下纯方法提取为 `relay_ack_duration_ms(sent_at_ms, received_at_ms)`，Host只传monotonic时间：

```py
def relay_ack_duration_ms(sent_at_ms, received_at_ms):
    if not isinstance(sent_at_ms, (int, float)) or not isinstance(received_at_ms, (int, float)):
        return None
    import math
    return received_at_ms - sent_at_ms if math.isfinite(sent_at_ms) and math.isfinite(received_at_ms) and received_at_ms >= sent_at_ms else None
```

在test_input_timing_contract补 `self.assertEqual(relay_ack_duration_ms(1000,1200),200)` 和None/反序拒绝；另用__new__ relay+inflight字典调用实际ack，客户端分别传5100和0仍必须得到200，旧generation/未知frame不得降档。clock sync使用可注入timer：pending2秒超时、30秒重试、60秒有效，校验v0/scope；导入模块不自动启动timer。测试如下输入表逐项构造fake-clock断言：

| 操作序列 | 必须断言 |
|---|---|
| send→10秒过期→11秒ACK | timedOut=1、late=1、成功RTT count=0 |
| send→scope切换→旧ACK | 新scope成功count=0；takeClosedScopeSummaries含旧scope cancelled=1，新scope cancelled=0；重复drain为空 |
| media pause五分钟→resume首rVFC | paintInterval无五分钟样本 |
| null/undefined/空串/NaN/Infinity | metrics available=false |
| 同ACK两次+frame notice | RTT和hostAdapter各至多1样本 |
| sync发出无回复→2秒→重试 | 允许第二次发送；旧v0不完成新请求 |
| 513个pending、4097个样本 | 上限保持，增加dropped，不改变Input控制gate |

- [ ] **M1.5 更新UI与绿灯。** 标签改“输入确认 RTT”；notice标“帧通知”，普通visible无证据显示“未测量”。diagnostic持久化由W维护，本任务只更新renderer/API兼容映射。运行：

```bash
node --test web-client/js/latency-monitor.test.js web-client/js/webrtc-stats.test.js web-client/js/diagnostic.test.js
node --test --test-name-pattern='input ack|input_ack|nullable|timing' signal-server/websocket/signaling.test.js
(cd python-host && python3 -B -m unittest test_input_timing_contract -v)
```

Expected green: fake-clock结果精确、无DOM/网络/抓屏，新增字段在Socket/DC对称；无样本为null。

- [ ] **M1.6 Review与提交。** 对照总snapshot字段逐项检查、W确认白名单与scope累计outcomes；检查旧Host/newViewer兼容及严格输入字段未改变。只stage本任务hunks与新测试，`git diff --cached --check`；提交 `fix(metrics): separate input acknowledgements from frame evidence`。记录实际命令/结果及NOT RUN真实验收。

## Task M2：新鲜帧因果关联与长期trace（L2/L5/L8/L11）

**Files:**
- Create: `python-host/input_frame_causality.py`、`python-host/test_input_frame_causality.py`、`python-host/test_rtp_send_boundary.py`。
- Modify: `python-host/host.py`（capture选择、on_input结果、Host能力）、`python-host/media_stage_metrics.py`、`python-host/rtp_frame_observer.py`。
- Modify: `web-client/js/webrtc.js`、`web-client/js/webrtc.frame-trace.test.js`、`web-client/js/latency-monitor.js`。
- Modify: `signal-server/websocket/runtime-context.js`、`signal-server/websocket/runtime-context.test.js`（新增能力白名单）；`scripts/turn_controlled_scene.py`、`scripts/test_turn_controlled_scene.py`（只消费正确viewerClockMs）。

**Interfaces:** 消费M1 scope/metrics与C身份。提供spec §4 `InputFrameCausality` 的五个方法；Host内观测scope为 `(connectionAttemptId,generation,leaseEpoch)` tuple，FrameKey沿现有dataclass。新增能力inputFrameCorrelationVersion=1与独立input_frame_binding v1；不加输入envelope字段，不变frame_trace_batch v1严格字段。

- [ ] **M2.1 写旧帧、拒绝输入和失败发送红灯。** 新建unittest：

```py
import unittest
from input_frame_causality import InputFrameCausality
from media_stage_metrics import FrameKey

class TestInputFrameCausality(unittest.TestCase):
    def test_input_needs_a_successful_apply_and_later_new_capture(self):
        scope = ("test-a", 1, 7)
        c = InputFrameCausality(now_ns=lambda: 300, max_pending=512)
        c.reset_scope(scope)
        self.assertEqual(c.note_applied(["rejected"], scope=scope, applied_ns=100, status="sequence-gap"), 0)
        self.assertEqual(c.note_applied(["ok"], scope=scope, applied_ns=200, status="applied"), 1)
        old = FrameKey("test-a", 1, "video", 1, 9000)
        fresh = FrameKey("test-a", 1, "video", 2, 12000)
        self.assertEqual(c.reserve_for_capture(old, capture_started_ns=100, reused=False, scope=scope), ())
        self.assertEqual(c.reserve_for_capture(old, capture_started_ns=250, reused=True, scope=scope), ())
        self.assertEqual(c.reserve_for_capture(fresh, capture_started_ns=250, reused=False, scope=scope), ("ok",))
        c.release_capture(fresh)  # codec/send failure must not claim visible success
        self.assertEqual(c.reserve_for_capture(fresh, capture_started_ns=250, reused=False, scope=scope), ("ok",))
        self.assertEqual(c.commit_first_packet(fresh, wire_timestamp=123, ssrc=1, scope=scope), ("ok",))
        self.assertEqual(c.commit_first_packet(fresh, wire_timestamp=123, ssrc=1, scope=scope), ())
```

另在现有webrtc.frame-trace.test.js复用已定义loadCollector/validTrace，添加真正晚到而非同一时刻的测试：

```js
test('late trace keeps original presentation time', () => {
  let now = 100;
  const Collector = loadCollector(() => now);
  const c = new Collector({ now: () => now });
  c.setScope({ attemptId: 'a', generation: 1, streamId: 'video' });
  c.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', ssrc: 7, rtpTimestamp: 44 }, {});
  now = 800;
  c.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1, traces: [validTrace()] });
  assert.equal(c.takeMatched()[0].viewerClockMs, 100);
});
```

Run:

```bash
(cd python-host && python3 -B -m unittest test_input_frame_causality -v)
node --test --test-name-pattern='late trace keeps original' web-client/js/webrtc.frame-trace.test.js
```

Expected red: new helper absent; existingcollector返回800而不是100。依赖错误不算行为红灯。

- [ ] **M2.2 实现候选/保留/提交。** note_applied仅应用成功；捕获线程把grab开始/结束monotonic_ns与captureSeq一起发布。recv在选择截图时保存该元组，不能在worker结束时取全部pending。reserve要求同scope、fresh、capture_started_ns>applied_ns；失败release，首包成功才commit。核心谓词：

```py
def eligible(candidate, *, scope, capture_started_ns, reused):
    return (not reused and candidate.scope == scope and candidate.status == "applied"
            and capture_started_ns > candidate.applied_ns)
```

容量/TTL按spec执行，异常只增加unmatched。增加真实bare_track.recv barrier回归：旧图已选→fake worker挂起→note_applied→恢复，旧图不能含新ID；reuse同样不能消费ID；frame_timing不能完成ACK。至少覆盖success、sequence-gap、execution-failed三种adapter结果，验证只成功进入候选。

- [ ] **M2.3 修正发送observer并检验失败透明。** 新建 `send_with_observation(observer, transport, data, send)` helper供安装wrapper使用。prepare只读header并给token，不bind；await实际send成功才commit；真正发送异常仍传播，observer自身异常不可中断媒体：

```py
async def send_with_observation(observer, transport, data, send):
    token = None
    try:
        token = observer.prepare_outgoing_rtp(data)
    except Exception:
        pass  # observer implementation increments its bounded failure counter
    try:
        result = await send(transport, data)
    except BaseException:
        try:
            observer.reject_outgoing_rtp(token)
        except Exception:
            pass
        raise
    try:
        observer.commit_outgoing_rtp(token)
    except Exception:
        pass
    return result
```

在test_rtp_send_boundary.py用fake observer计数+async send抛ConnectionError：commit=0、reject=1；成功时commit=1；observer.prepare抛异常时send仍调用一次并成功。再用现有已安装aiortc NEW transport和synthetic RTP包验证真实拒绝发生在加密前而registry覆盖仍0；禁止真实网络。first packet只说明API成功返回，rtpApiAwaitMs不改名整帧发送。

- [ ] **M2.4 实现Viewer join/能力兼容和容量测试。** matchedVisual接收并保存frame.at，identity加入可用SSRC/stream；不足时unmatched。基础输入关联只有pending输入触发，细stage仍需flag。Host不支持能力则post-apply保持unavailable；未知input_frame_binding忽略；现有v1 row strict validator不变。

15分钟fake-clock流式测试追加现有collector文件（测试helper已存在）：

```js
test('fifteen minute trace remains bounded and matches every current frame', () => {
  let now = 0;
  const Collector = loadCollector(() => now);
  const c = new Collector({ now: () => now });
  c.setScope({ attemptId: 'a', generation: 1, streamId: 'video' });
  let matched = 0;
  for (let i = 0; i < 18000; i += 1) {
    now = i * 50;
    const wireTimestamp = (9000 + i * 4500) >>> 0;
    c.observeVideoFrame({ attemptId: 'a', generation: 1, streamId: 'video', ssrc: 7, rtpTimestamp: wireTimestamp }, {});
    c.acceptBatch({ type: 'frame_trace_batch', schemaVersion: 1,
      traces: [validTrace({ captureSeq: i, wireTimestamp, encoderTimestamp: (wireTimestamp - 12345) >>> 0 })] });
    matched += c.takeMatched().length;
    assert.ok(c.seen.size <= 2048);
    assert.ok(c.frames.size <= 256 && c.traces.size <= 256);
  }
  assert.equal(matched, 18000);
});
```

seen TTL30秒、pending2秒、matched128项；容量淘汰是观测dropped，不能永久终止正常流。补错attempt/错generation、RTP回绕、重复同key冲突、关闭能力不积累、晚到2秒外不匹配和无marker不得生成visible evidence。普通生产不能以“下一次rVFC”近似。

- [ ] **M2.5 绿灯、review与提交。**

```bash
(cd python-host && python3 -B -m unittest test_input_frame_causality test_rtp_send_boundary -v)
node --test web-client/js/webrtc.frame-trace.test.js web-client/js/latency-monitor.test.js signal-server/websocket/runtime-context.test.js
python3 -B -m unittest discover -s scripts -p 'test_turn_controlled_scene.py' -v
```

审查observer ABI不符只禁观测、所有新增wire字段已定义白名单、日志不含原ID、C媒体恢复gate未读latency值。确认受控producer真实输入guard/marker未被fixture或overlay替代。只stage该任务hunks，`git diff --cached --check`；提交 `fix(media): correlate applied inputs with fresh presented frames`。

## Task M3：有界输入队列与单JPEG worker（N2、N4/P1）

**Files:**
- Create: `python-host/input_admission_queue.py`、`python-host/test_input_admission_queue.py`、`python-host/relay_frame_worker.py`、`python-host/test_relay_frame_worker.py`。
- Modify: `python-host/host.py`（on_input、DC callback、control reset接入、TunnelRelayStreamer）、`python-host/input_handler.py`（原生完成后sequencer提交fence）。
- Modify: `web-client/js/input.js`、`web-client/js/keyboard-transport.js`、`web-client/js/input.test.js`、`web-client/js/keyboard-transport.test.js`；新增 `web-client/js/input-backpressure.test.js`。
- Update: `docs/需求文档/WebRemoteDesktop-需求文档.md` 的输入背压、过载恢复与媒体线程边界。

**Interfaces:** C2必须先提供 `_capture_authority()`/`_authority_matches(snapshot)`；epoch只在同一认证Signal连接生命周期比较，新连接安全reset后可接受小epoch，revision仍递增，旧任务按revision取消。新增 `InputAdmissionQueue(execute, authority_matches, max_pending=64, max_pending_bytes=262144)`；同步 `submit(data, *, authority, byte_count) -> Future[AdmissionResult]`，内部AdmissionResult为 `{outcome:'applied'|'resync-required'|'cancelled', result:dict|null}`；cancelled只作内部终结，不能映射wire applied。提供 `freeze(scope,reason)`、`reset_after_quiescent(old_scope,apply_reset)`。RelayFrameWorker提供 `submit_latest(request)`、`invalidate(generation)`、`async drain()`、`async stop()`。两类queue的snapshot五字段按spec供W注册，不输出payload。

- [ ] **M3.1 用Event构造FIFO过载、旧authority和reset屏障红灯。** 新建纯unittest，不启动Host；submit是同步准入，不能先create数千个处理task再进入有界队列。

```py
import asyncio
import unittest
from input_admission_queue import InputAdmissionQueue

class TestInputAdmission(unittest.IsolatedAsyncioTestCase):
    async def test_overflow_freezes_and_reset_waits_for_native_completion(self):
        entered, release = asyncio.Event(), asyncio.Event()
        applied, resets = [], []
        current = {"revision": 1}
        async def execute(data, authority):
            entered.set()
            await release.wait()
            applied.append(data["seq"])
            return {"status": "applied"}
        q = InputAdmissionQueue(execute=execute,
            authority_matches=lambda revision: revision == current["revision"],
            max_pending=1, max_pending_bytes=8)
        one = q.submit({"seq": 1}, authority=1, byte_count=4)
        await asyncio.wait_for(entered.wait(), 1)
        two = q.submit({"seq": 2}, authority=1, byte_count=4)
        overflow = q.submit({"seq": 3}, authority=1, byte_count=4)
        self.assertEqual((await overflow).outcome, "resync-required")
        self.assertTrue(q.snapshot()["frozen"])
        current["revision"] = 2  # C invalidates before its reset
        async def reset_native():
            resets.append("released")
            return {"status": "applied"}
        reset_task = asyncio.create_task(q.reset_after_quiescent(1, reset_native))
        await asyncio.sleep(0)
        self.assertFalse(reset_task.done())
        self.assertEqual(resets, [])
        release.set()
        self.assertEqual((await asyncio.wait_for(reset_task, 1))["status"], "applied")
        self.assertEqual((await two).outcome, "cancelled")
        self.assertEqual((await one).outcome, "cancelled")
        self.assertEqual(applied, [1])
        self.assertEqual(resets, ["released"])
```

Run: `(cd python-host && python3 -B -m unittest test_input_admission_queue -v)`。Expected red:新模块缺失；初步实现若reset先回或旧seq2执行，以上行为断言必须失败。

- [ ] **M3.2 实现有界准入与C交接。** 固定queue一个drain task；容量在保存payload前检查，64项/256KiB仅waiting，inflight另1项≤64KiB；move最新1项≤1KiB独立，不能饥饿可靠队列。DC在on_message同步解析/准入后才安排获准项处理，Socket入口同样先准入；拒绝/冻结消息不能另外创建无界处理或ACK任务。

```py
# submit admission condition, before retaining an envelope:
if frozen or len(pending) >= max_pending or pending_bytes + byte_count > max_pending_bytes:
    freeze(authority, "input-overload")
    return completed_future(AdmissionResult("resync-required", None))
# Exactly one drain loop checks authority_matches(item.authority) immediately
# before execute and before committing sequence/ACK/candidate-frame effects.
```

`completed_future(value)`在本模块定义为当前loop.create_future()+set_result；AdmissionResult用标准库dataclass。容量满通知现有C恢复，reject一次当前请求并保持阻断；后续冻结请求走有界拒绝路径。原生执行不能被async cancel假装终止；reset_after_quiescent清旧waiting并终结cancelled、等待inflight、执行apply_reset，超时/失败返回rejected且保持冻结。C最后CAS再ACK。键盘与desktop序号仍各由原有sequencer拥有，队列不预占已应用序号，不重放任何不确定业务消息。

补真实adapter桥接：使用fake native的threading.Event阻塞执行，C增revision并reset，新grant不能越过旧inflight；释放后原生release最后执行，旧任务不能更新新seq或发送新scope ACK。校验拒绝项resync-required、旧pending cancelled、真正native异常execution-failed分类不同。

- [ ] **M3.3 Viewer编号前背压与容量测试。** move最新1、wheel合并1、16ms最小flush间隔；可靠待办及已提交未ACK项合计最多32/128KiB，单项64KiB。容量拒绝必须发生在seq commit/transport前；resync-required调用C既有恢复，绝不本地改写appliedSeq。以下行为表在input-backpressure.test.js使用现有input.test.js的VM fixture方式，无真实DOM/网络：

```js
// The new small pure helper exported from input.js for tests is:
// createInputBudget({maxEntries=32,maxBytes=131072}) -> {reserve,release,snapshot}.
// reserve(id, bytes) reserves once; release(id) is idempotent.
const assert = require('node:assert/strict');
const test = require('node:test');
const { createInputBudget } = require('./input.js');
test('budget refuses before assigning any reliable wire sequence', () => {
  const b = createInputBudget({ maxEntries: 2, maxBytes: 8 });
  assert.equal(b.reserve('a', 4), true);
  assert.equal(b.reserve('b', 4), true);
  assert.equal(b.reserve('c', 1), false);
  b.release('a'); b.release('a');
  assert.equal(b.snapshot().pendingBytes, 4);
  assert.equal(b.reserve('c', 4), true);
});
```

实现纯helper为Map(id→byteCount)+总字节，input.js CommonJS导入不能访问DOM；预算不保存payload。另必须通过真实 `_sendInput` VM桥接断言被拒绝时 `_desktopWriteSequence`、transport发送数与pending均不增；wheel100次/同tick只提交合并后的1次，ACK慢时保持已提交上限，up/reset不能越序绕过队列，只能走权威安全reset。keyboard transport共用同scope budget，不能各32导致总64。

- [ ] **M3.4 JPEG移到专属worker，验证loop仍可运行。** Worker线程拥有MSS，不把创建于主线程的对象搬过去；一个inflight+一个latest pending。下面测试中的process只读线程标识和Event，不抓屏：

```py
import asyncio
import threading
import unittest
from relay_frame_worker import RelayFrameWorker

class TestRelayWorker(unittest.IsolatedAsyncioTestCase):
    async def test_worker_is_off_loop_and_pending_is_latest_only(self):
        loop = asyncio.get_running_loop()
        entered, release = asyncio.Event(), threading.Event()
        loop_thread = threading.get_ident()
        processed = []
        def process(request):
            self.assertNotEqual(threading.get_ident(), loop_thread)
            loop.call_soon_threadsafe(entered.set)
            if request["id"] == 1:
                if not release.wait(2): raise TimeoutError("test barrier")
            processed.append(request["id"])
            return b"fake-jpeg"
        w = RelayFrameWorker(process, max_pending=1)
        try:
            w.submit_latest({"id": 1, "generation": 1})
            await asyncio.wait_for(entered.wait(), 1)
            w.submit_latest({"id": 2, "generation": 1})
            w.submit_latest({"id": 3, "generation": 1})
            self.assertEqual(w.snapshot()["pendingCount"], 1)
            self.assertEqual(w.snapshot()["droppedCount"], 1)
            # Event-loop continuation while worker 1 is blocked is the assertion.
            release.set()
            await w.drain()  # testable await: no running/pending work remains
            self.assertEqual(processed, [1, 3])
        finally:
            release.set()
            await w.stop()
```

`drain()`按spec等待当前pending/inflight完成，不负责停止准入；实际production关闭用stop。返回结果在Host loop核验generation/suspend，过期丢弃；传入/输出和buffer上限按spec。stop 2秒未完成保持stopping、不启动第二线程，不误关正在使用的MSS。测试补旧generation处理完不能emit、pending被invalidate清空、停止后submit拒绝；测试cleanup保证fake线程释放。

- [ ] **M3.5 绿灯、资源边界review与提交。**

```bash
(cd python-host && python3 -B -m unittest test_input_admission_queue test_relay_frame_worker -v)
node --test web-client/js/input-backpressure.test.js web-client/js/input-recovery.test.js web-client/js/keyboard-transport.test.js
```

确认没有每消息create_task/to_thread、底层executor另藏无界queue、第二worker或多份大payload；内存预算标明payload与native/VM开销区别；与C复核reset/新grant真正quiescent。W注册三个queue摘要，不接触payload。只stage任务hunks，`git diff --cached --check`；提交 `fix(input): bound admission and isolate relay capture work`。

## Task M4：真实编码阶段、暂停与reuse（L12/N13）

**Files:** Modify `python-host/media_timing.py`、`python-host/host.py`（1257–1425、1560–1635）、`python-host/h264_videotoolbox_encoder.py`（719–907、1022–1069）、`python-host/media_stage_metrics.py`；Create `python-host/test_media_stage_boundaries.py`；Modify `web-client/js/latency-monitor.test.js`、`docs/需求文档/WebRemoteDesktop-需求文档.md` 的capture边界。

**Interfaces:** 消费M2 FrameKey与M1阶段白名单；提供纯 `materialize_and_packetize(produce, packetize, now_ns)` 返回 `(packets, durations)`，durations为encoderMs/packetizeMs/encodeTotalMs，全部本机毫秒。阶段总项不供UI直接求和。

- [ ] **M4.1 用真实lazy generator语义写红灯。** 不调用codec、不sleep；fake clock只在实际迭代时推进：

```py
import unittest
from media_timing import materialize_and_packetize

class TestStageBoundaries(unittest.TestCase):
    def test_generator_work_is_encode_not_packetize(self):
        now = [0]
        def produce():
            now[0] += 40_000_000
            yield b"nal"
        def packetize(nals):
            result = list(nals)
            now[0] += 3_000_000
            return result
        packets, d = materialize_and_packetize(produce, packetize, lambda: now[0])
        self.assertEqual(packets, [b"nal"])
        self.assertEqual(d, {"encoderMs": 40.0, "packetizeMs": 3.0, "encodeTotalMs": 43.0})
```

Run: `(cd python-host && python3 -B -m unittest test_media_stage_boundaries -v)`。Expected red: helper缺失，或保留lazy调用会把40ms记到packetize。

- [ ] **M4.2 消费generator后再计packetize，并接入实际encode。**

```py
def materialize_and_packetize(produce, packetize, now_ns):
    start = now_ns()
    nals = list(produce())
    encoded = now_ns()
    packets = packetize(nals)
    done = now_ns()
    return packets, {"encoderMs": (encoded-start)/1e6,
                     "packetizeMs": (done-encoded)/1e6,
                     "encodeTotalMs": (done-start)/1e6}
```

H264VideoToolboxEncoder.encode必须调用该helper（或相同真实边界），不是只让纯helper测试通过。增加actual encoder对象+fake codec回归，产生tiny NAL，检查StageMetrics中的encode有工作量且packetize不含40ms；不调用真实硬件。将内部reformat仍归到所包围的encode总工作，独立reformat没有hook时保持null。

- [ ] **M4.3 修正capture/reuse/暂停计数。** capture thread记录grab界限，recv/worker记录queue、prepare、convert、build；使用不可变frame身份绑定。发送capture_stats前保存interval_reuse，日志及DC使用同一快照，然后清零：

```py
interval_reuse = self._total_reuse
interval_frames = self.frame_count
# log and wire both use interval_reuse/interval_frames
self._total_reuse = 0
self.frame_count = 0
```

在新unittest用bare_track+fake DC：模拟3输出中2reuse，日志快照和JSON均为2/3；下窗口从0开始。暂停计时独立exclude/label，不把5分钟等待带进active recv_total。保持CaptureExperiment(1.0,1)，测试factory实际传值，不仅断言静态字符串。旧截图不能提升captureSeq，worker queue与build/prepare/convert总项不可重复相加；新freshFrameAge读取Viewer同钟证明，缺关联null。

- [ ] **M4.4 绿灯、review与提交。**

```bash
(cd python-host && python3 -B -m unittest test_media_stage_boundaries test_media_timing -v)
node --test web-client/js/latency-monitor.test.js
```

审查普通WRD_ENCODER_SAMPLE wall total未意外改成CPU time；正常生产工厂1×只作为当前实现，不宣称所有历史process已加载。需求文档去除过时2×事实，保留旧实验未验收背景。只stage任务hunks，`git diff --cached --check`；提交 `fix(metrics): measure encoding and capture boundaries accurately`。

## Task M5：联合媒体资格与分层验收（N3）

**Files:** Create `scripts/media_latency_qualification.py`、`scripts/test_media_latency_qualification.py`、`python-host/test_media_policy_selection.py`；Modify `python-host/h264_encoder_policy.py`、`python-host/host.py`（既有media apply适配）、`scripts/eval-turn-encoder-quality.py`、`scripts/test_eval_turn_encoder_quality.py`；Update `docs/需求文档/WebRemoteDesktop-需求文档.md`。

**Interfaces:** `select_measured_media_policy(current, intent, qualification, *, context) -> MeasuredPolicyDecision(policy,changed,reason)`；`QualificationContext`、`validate_policy_qualification(evidence, *, context, intent, candidate) -> list[str]`与selector位于 `python-host/h264_encoder_policy.py`，只做纯计算。`validate_joint_qualification(evidence) -> list[str]`、`build_joint_matrix() -> tuple[dict,...]`在新 `scripts/media_latency_qualification.py`，验证逐帧原始证据再生成spec §7.1的摘要；Host不能import scripts或信任Viewer发来的资格。schema字段/scene最低数/门槛以spec §7.1为唯一契约。

- [ ] **M5.1 写未验证15/12FPS不得自动换codec的红灯。**

```py
import unittest
from dataclasses import replace
from h264_encoder_policy import (
    MediaSessionIntent, QualificationContext, resolve_h264_policy,
    select_measured_media_policy,
)

class TestMeasuredPolicy(unittest.TestCase):
    def test_missing_qualification_keeps_current_codec_and_resolution(self):
        intent = MediaSessionIntent("test-a", 1, "relay", 1280, 720, 20, 3_200_000)
        current = resolve_h264_policy(intent, "relay-peak-sliced-v1")
        ctx = QualificationContext("fixture-rev", (("codec", "fixture-v1"),),
                                   "fixture-machine", "relay-peak-sliced-v1")
        for fps in (15, 12):
            d = select_measured_media_policy(
                current, replace(intent, target_fps=fps), {}, context=ctx)
            self.assertFalse(d.changed)
            self.assertEqual(d.policy, current)
            self.assertEqual(d.reason, "qualification-missing")
            self.assertEqual(intent.target_fps, 20)
```

Run: `(cd python-host && python3 -B -m unittest test_media_policy_selection -v)`。Expected red: selector缺失；旧逻辑直接降FPS转software不能作为该测试green。

- [ ] **M5.2 实现typed资格、纯校验和保守应用。** 最小实现片段如下；它实际检查身份、完整tuple、scene样本及质量/资源门槛。校验输入是离线工具从原始逐帧证据生成的Host本地文件；不能让外部调用者提交自报摘要绕过离线校验。

```py
import math
from dataclasses import asdict, dataclass
from collections.abc import Mapping

@dataclass(frozen=True)
class QualificationContext:
    code_revision: str
    codec_versions: tuple[tuple[str, str], ...]
    machine_digest: str
    policy_version: str
    quality_locked: bool = False

@dataclass(frozen=True)
class MeasuredPolicyDecision:
    policy: H264SessionPolicy
    changed: bool
    reason: str

SCENE_MIN = {"static-text": 65, "health-static": 1201,
             "scrolling-text": 300, "post-scroll-static": 300,
             "safety-net": 1226}
INPUT_CONTRACT = {
    "id": "production-screen-bgra-v1", "pixelFormat": "bgra",
    "referenceFormat": "rgb24",
    "colorConversionCost": "inside-direct-encoder-unless-a-candidate-records-it-separately",
}

def _finite(value, *, lower=0, upper=float("inf")):
    return type(value) in (int, float) and math.isfinite(value) and lower <= value <= upper

def _count(value, minimum=0):
    return type(value) is int and value >= minimum

def _qualification_tuple(intent, candidate):
    policy = asdict(candidate)
    policy.pop("connection_attempt_id")
    policy.pop("generation")
    return {"path": intent.path, "width": intent.width, "height": intent.height,
            "requestedBitrateBps": intent.requested_bitrate_bps, "policy": policy}

def validate_policy_qualification(evidence, *, context, intent, candidate):
    if not isinstance(evidence, Mapping) or not evidence:
        return ["qualification-missing"]
    if evidence.get("schemaVersion") != 1 or evidence.get("status") != "qualified":
        return ["qualification-not-qualified"]
    expected_identity = {"codeRevision": context.code_revision,
                         "codecVersions": dict(context.codec_versions),
                         "machineDigest": context.machine_digest}
    if evidence.get("identity") != expected_identity:
        return ["qualification-identity-mismatch"]
    if evidence.get("tuple") != _qualification_tuple(intent, candidate):
        return ["qualification-tuple-mismatch"]
    if evidence.get("inputContract") != INPUT_CONTRACT:
        return ["qualification-input-contract"]
    if intent.height not in (720, 1080):
        return ["qualification-resolution-uncovered"]
    budget = 25 if intent.height == 720 else 45
    rows = evidence.get("scenes")
    if (not isinstance(rows, list) or len(rows) != len(SCENE_MIN)
            or any(not isinstance(r, Mapping) for r in rows)
            or {r.get("name") for r in rows} != set(SCENE_MIN)):
        return ["qualification-scenes-incomplete"]
    for row in rows:
        n = row.get("sampleCount")
        if (not _count(n, SCENE_MIN[row["name"]]) or row.get("validFrameCount") != n
                or not all(type(row.get(k)) is int and row[k] == 0 for k in
                           ("timeoutCount", "droppedCount", "earlyPeriodicIdrCount", "contractViolationCount"))):
            return ["qualification-scene-samples"]
        if not _finite(row.get("encodeP95Ms"), upper=budget):
            return ["qualification-encode-budget"]
        if (not _count(row.get("criticalIdrCount"), 1)
                or not _finite(row.get("criticalIdrMinPsnr"), lower=28)):
            return ["qualification-idr-psnr"]
        for prefix in ("initialSafety", "periodic"):
            count = row.get(prefix + "IdrCount")
            value = row.get(prefix + "MaxChangeMae")
            if (not _count(count) or count > n
                    or (count > 0 and not _finite(value, upper=3))
                    or (count == 0 and value is not None)):
                return ["qualification-idr-change"]
    rt = evidence.get("runtime")
    if (not isinstance(rt, Mapping) or rt.get("status") != "passed"
            or rt.get("path") != intent.path
            or not _finite(rt.get("durationMs"), lower=10_800_000)
            or not _count(rt.get("inputSampleCount"), 100)
            or not _count(rt.get("loopSampleCount"), 1)):
        return ["qualification-runtime-incomplete"]
    if (not _finite(rt.get("loopP95Ms"), upper=50 if intent.path == "relay" else float("inf"))
            or not _finite(rt.get("inputAckP95Ms"), upper=150 if intent.path == "relay" else float("inf"))):
        return ["qualification-runtime-budget"]
    res = rt.get("resources")
    if (not isinstance(res, Mapping) or res.get("condition") != "normal"
            or res.get("samplerComplete") is not True or not _count(res.get("sampleCount"), 1)
            or not all(type(res.get(k)) is int and res[k] == 0 for k in
                       ("unknownCount", "pressureWarningCount"))):
        return ["qualification-resources-unavailable"]
    return []

def select_measured_media_policy(current, intent, qualification, *, context):
    if context.quality_locked:
        return MeasuredPolicyDecision(current, False, "quality-locked")
    if not qualification:
        return MeasuredPolicyDecision(current, False, "qualification-missing")
    try:
        candidate = resolve_h264_policy(intent, context.policy_version)
        errors = validate_policy_qualification(
            qualification, context=context, intent=intent, candidate=candidate)
    except (KeyError, TypeError, ValueError):
        return MeasuredPolicyDecision(current, False, "qualification-malformed")
    if errors:
        return MeasuredPolicyDecision(current, False, errors[0])
    changed = candidate.fingerprint() != current.fingerprint()
    return MeasuredPolicyDecision(candidate if changed else current, changed,
                                  "qualified" if changed else "already-current")
```

这是新增自适应路径的选择器；不接到既有启动fallback或用户显式设置入口。Host适配先调用纯selector，changed=false时禁止修改 `_media_session_intent`、capture尺寸/FPS或generation；changed=true再请求既有coordinator，应用结果才决定业务ACK。frozen current/intent不能原地改写；并发应用仍遵循C authority和M3 quiescence边界。若只拟改变FPS而policy fingerprint未变，报告already-current，不假装媒体已改。

`build_joint_matrix`产生20/15/12 × 720/1080（逐个确切宽高，含原等高宽高比）×候选codec的固定配置。原始validator必须复用既有 `_evaluate_resolution_gates` / `validate_full_matrix` 的质量/成本/bitstream/codec实例与options门禁；新增matrix版只调整明确的FPS/PTS及GOP期望，不削弱检查。PTS增量为90000/fps；pulse用0.8–1.5秒，不能复制20FPS下16–30帧判定。scene摘要的critical IDR为on-demand、需要检查的initial和safety-net，initialSafety不含on-demand；零periodic样本时MAE为null。原始帧IDR期望集合、PSNR/MAE、输入哈希和配置不一致必须增加contractViolationCount并拒绝产物，不能由生产selector接受一个`passed:true`。

在 `python-host/test_media_policy_selection.py` 增加完整fixture工厂与如下纯测试（helper返回spec §7.1全部字段；每scene按SCENE_MIN填数，正常资源/runtime完整；仅模拟，不编码）：

```py
from copy import deepcopy

def test_mutating_each_gate_keeps_current(self):
    base = qualified_fixture(self.intent, self.candidate, self.context)
    cases = (
        (lambda e: e["identity"].update(codeRevision="other"), "qualification-identity-mismatch"),
        (lambda e: e["tuple"]["policy"].update(slice_threads=4), "qualification-tuple-mismatch"),
        (lambda e: e["scenes"][0].update(sampleCount=1), "qualification-scene-samples"),
        (lambda e: e["scenes"][0].update(encodeP95Ms=26), "qualification-encode-budget"),
        (lambda e: e["scenes"][0].update(criticalIdrMinPsnr=27.9), "qualification-idr-psnr"),
        (lambda e: e["scenes"][0].update(periodicIdrCount=1, periodicMaxChangeMae=3.1), "qualification-idr-change"),
        (lambda e: e["runtime"]["resources"].update(condition="unknown"), "qualification-resources-unavailable"),
        (lambda e: e["runtime"].update(status="NOT RUN"), "qualification-runtime-incomplete"),
    )
    for mutate, reason in cases:
        evidence = deepcopy(base)
        mutate(evidence)
        d = select_measured_media_policy(self.current, self.intent, evidence, context=self.context)
        self.assertFalse(d.changed)
        self.assertEqual(d.policy, self.current)
        self.assertEqual(d.reason, reason)
```

fixture工厂必须按schema构造完整字典，并由独立raw validator fixture产生一份通过样本后再用于此表；不能以mock validator=True或自报summary来替代raw门禁测试。另测缺任一字段、NaN/bool伪数、场景重复、timeout/drop、Quality Lock、合法fixture返回candidate；Host fake coordinator覆盖拒绝时apply调用0次/intent与capture不变、合法时只调用1次、coordinator拒绝不ACK applied。原始validator另有一帧PTS、inputHash、IDR、codec实例、options的逐项篡改拒绝测试。所有测试都是纯数据/fake依赖，不运行设备。

- [ ] **M5.3 绿灯、独立review与代码提交；真实资格可以仍为NOT RUN。**

```bash
(cd python-host && python3 -B -m unittest test_media_policy_selection -v)
python3 -B -m unittest discover -s scripts -p 'test_media_latency_qualification.py' -v
```

上述只验证选择/校验，不编码、不抓屏。审查失败不重试、不修改capture intent、不影响原启动fallback/用户显式设置；只stage本任务hunks，`git diff --cached --check`，独立review通过后提交 `feat(media): gate adaptive policies on joint latency evidence`。即使真实资格尚未取得，此代码任务仍可完成，扩展策略保持disabled，以下维护窗口验收单独标NOT RUN。实现已有eval脚本的 `--matrix latency-joint-v1` 新选项及纯CLI解析测试，实际运行必须等维护窗口；命令记录为后续：

```bash
python3 scripts/eval-turn-encoder-quality.py --matrix latency-joint-v1 --output /tmp/wrd-latency-joint-evidence.json
```

该命令在维护窗口也只能针对用户授权的隔离场景，不能与人工Viewer竞争；实施者先检查既有probe的输入guard/捕获行为。20/15/12FPS同条件比较codec/质量/CPU/调度，720p/1080p编码P95≤25/45ms，完整loop窗口来自W（不能用warning行P95）；候选不合格就保留current与显式建议。

- [ ] **M5.4 后续获维护窗口后完成真实资格记录；不阻塞M5.3代码提交。** 使用既有受控producer、真实输入guard和实际RTP+rVFC+marker记录inputToVisibleEffect；普通任意应用只报告post-apply新帧，光学时延另测。分别记录normal resources/可控慢worker/现场压力、真实direct/TURN/Socket/JPEG路径，缺测和失败都计分母。规定TURN目标loop P95≤50ms、业务ACK P95≤150ms；150–200ms稳态visible只是目标，不强行宣布达标。短时通过后各路径至少3小时连续会话，资源与queue无持续增长；没有运行就写NOT RUN。

实际资格产物须再次独立review并记录代码/环境身份；报告中的未验收项不能因纯测试通过而关闭。未获实际资格继续保持disabled，不要求在本轮未授权的生产会话中凑齐3小时。

## 覆盖、自查与交接

| 证据/问题 | 行为门禁 |
|---|---|
| L1/L3/L6/L7/L10 | M1标签、实际worker时间、读时过期、null/duplicate、sync超时与scope |
| L4 | M1同Host relay反馈，不受client wall偏差影响 |
| L2 | M2拒绝输入/先截图后输入/reuse均不能认作后续可见；ACK与notice独立 |
| L5/L8/L11 | M2晚到保持原100ms、18000帧有界、发送失败覆盖0 |
| N2/N4(P1) | M3单线程latest、64项/256KiB、32项/128KiB、quiescence后reset |
| L12/N13 | M4 lazy codec归encode、reuse日志wire一致、pause总段不误用 |
| N3 | M5同条件资格，失败保留current而非无证据转软件 |

文档自查：接口与总spec一致；C authority只有一套；W只消费snapshot/队列五字段；strict input envelope无新增字段；M2独立能力/消息明确版本与兼容；M3失败不虚报reset成功；各任务都包含实际行为测试片段、红绿命令和review提交；真实服务、设备、光学及3小时验收为NOT RUN。本轮不执行代码、测试或commit。未来执行路径由总计划统一安排，不在本子计划重复询问用户。
