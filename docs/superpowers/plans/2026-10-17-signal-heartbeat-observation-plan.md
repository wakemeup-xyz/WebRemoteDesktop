# Signal Heartbeat Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 用户已授权连续执行；沿用总任务 workspace、单 writer 和独立 review，不重复询问执行方式。 Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在信令断线时确定服务端心跳生成、flush 意图和 pong 接收边界，支持后续有证据的修复。

**Architecture:** 已准入主 Viewer 的既有 Engine socket 上附加自有只读监听，关闭时输出一次固定白名单摘要。复用既有 Node runtimeObserver；不增加心跳、定时器、连接或恢复机制。

**Tech Stack:** 现有 Node.js、Socket.IO 4.8.3 / Engine.IO 6.6.9、node:test；不新增依赖。

**Spec:** [Signal 心跳断线观测补充设计](../specs/2026-10-17-signal-heartbeat-observation-design.md)。Task 1 中的精确契约是此 spec 的实施边界。

## Global Constraints

- 不改 auth、admission、proof、lease、resume、recovery、媒体或 input 行为；不改 heartbeat interval/timeout。
- 不重启、停止、重建、重新配置 tunnel；只有主线程可在独立 review 通过后应用已授权本地服务增量。
- 不记录 payload、键码、文本、坐标、token、原始 ID、地址、URL 或 Error 文本。
- 仅定向离线测试；不得 npm test/pretest、真实抓屏/输入、浏览器、网络、server.listen 或服务操作。
- 缺测 null/unavailable，flush 是 transport.send 前的意图，不能称已送达；同机 age 不能称单向延迟。
- 保留任务前 dirty 文件。实施 agent 只提交指定源码/测试；root 管理文档、部署及真实验收。

### Task 1: 只读服务端心跳 observer 与实际准入/清理接入

**Files:**
- Create `signal-server/lib/observability/viewer-heartbeat.js`.
- Create `signal-server/test/viewer-heartbeat.test.js`.
- Modify `signal-server/server.js`, `signal-server/websocket/signaling.js`, `signal-server/websocket/signaling.test.js`.
- 可在既有 server/runtime 测试文件增加不 listen 的实际 shutdown wiring 测试；不得改 runtime.js 的计时行为。

**Interfaces:**
- `createViewerHeartbeatRegistry({ now, wallNow, logger, runtimeSnapshot })` 返回 `{ attach(socket, isMapCurrent), stop() }`；默认 now 使用 performance.now，wallNow 使用 Date.now，仅本机时间关联。
- `setupSignaling` 新可选 `observeViewerHeartbeat(socket, isMapCurrent)`；只在已准入 Viewer 完成 map claim/rebind/supersede、welcome 之前调用，错误不得阻断业务。
- `server.js` 创建 registry，先注册 HTTP close/error 的 registry.stop，再调用现有 bindRuntimeObserver；runtime.close 也先 registry.stop 再 runtimeObserver.stop。

- [ ] **Step 1: 先补真实模块与准入失败反例。** 使用 EventEmitter 构建 Engine/Socket、注入时钟和 logger，实际 registry 保存 packetCreate ping、flush ping、packet pong；随后 close 并等待一个 microtask。断言 last ages、次数、32ring、<=4096bytes、exact own off、close once。示例行为序列如下（测试用实际导出，无复制实现）：

```js
const registry = createViewerHeartbeatRegistry({ now: () => time,
  wallNow: () => 1792200000000, logger: { log: line => lines.push(line) },
  runtimeSnapshot: () => ({status:'unavailable', ageMs:null,eventLoop:{}}) });
registry.attach(viewer, () => current === viewer);
time = 10; engine.emit('packetCreate', {type:'ping',data:secret});
time = 11; engine.emit('flush', [{type:'ping',data:secret}]);
time = 20; engine.emit('packet', {type:'pong',data:secret});
time = 30; engine.emit('close','transport close',secret);
await Promise.resolve();
assert.equal(lines.length, 1);
const data = JSON.parse(lines[0].slice('WRD_SIGNAL_HEARTBEAT '.length));
assert.deepEqual(data.ages,{pingCreatedMs:20,pingInFlushMs:19,pongReceivedMs:10});
assert.ok(!lines[0].includes(secret));
```

同时通过实际 setupSignaling 注册 handler 检查普通/guarded proof 的准入后唯一挂载，以及拒绝/Host/relay 不挂载、attach 抛错仍 welcome。既有普通 generation 与 strict proof 结果保持不变。

- [ ] **Step 2: 运行并记录 RED。** `node --test signal-server/test/viewer-heartbeat.test.js signal-server/websocket/signaling.test.js`；失败必须源于缺失真实 observer/接入断言，不能是语法或依赖错误。

- [ ] **Step 3: 按下列完整契约实现模块和最小 wiring。** 不创建/连接/断开 socket，不修改 send/flush/timeout 方法。exact own on/off，close microtask 合并和 shutdown 同步清理；容量/异常只影响诊断，不能影响业务。

## Verified installed APIs and semantic constraints

Inspected installed engine.io6.6.9 source signal-server/node_modules/engine.io/build/socket.js and Socket.IO4.8.3 socket.js. socket.conn getter returns client.conn, the existing Engine.IO Socket. EventEmitter on/off (or exact removeListener) is supported. Register only own callback references, never removeAllListeners or off(event) without callback.

| Existing Engine event | Installed emission | Allowed observation |
| --- | --- | --- |
| packetCreate(packet) | sendPacket lines356–382, before writeBuffer.push and flush | packet.type exactly ping -> pingCreated; message -> capped count only; all other types ignored |
| packet(packet) | onPacket around85–111, before heartbeat switch | type exactly pong -> pongReceived; message -> capped count only; no data |
| flush(packetsArray) | flush around386–407, before buffer is cleared and before transport.send | inspect at most64 array entries' type ONLY; a ping in this batch -> pingInFlush; no message event/ring entry |
| close(reason, description) | onClose around306–321, after readyState closed; writeBuffer clearing is scheduled with process.nextTick | project fixed reason, capture safe transport/buffer state immediately; ignore description |

Engine packetCreate does not establish handoff; flush is batch handoff INTENT before transport.send, not completed write or remote receipt. No observer is allowed to patch transport.send, Socket sendPacket, flush, timer refresh or callbacks. Server send transport drains have library-specific meanings; do not add a sent/delivery claim. Incoming pong is evidence that a pong reached this server Engine and its handler ran; without a heartbeat nonce it is not a measured RTT or proof of the subsequent ping delivery.

The server schedules ping every25000ms after pong refresh and waits20000ms after sending ping by current defaults. These values are explanatory context only: observer reads no private timeout object, creates no timer and never changes either value. Node runtimeObserver already samples its own scheduling; reuse its snapshot at close instead of a second interval.

## Listener behavior, close order and scope

Attach exactly once per admitted Socket/Engine object. A missing conn/on/off makes coverage unavailable; do not throw into admission or pretend no heartbeat happened. All stored object references are private and lifetime bounded. Do not use Socket.id, Engine.id, request, handshake, address, auth, headers, packet.data, packet.options, URL, error.message/stack/description, or arbitrary error.code in projection. The isMapCurrent predicate may read private identity solely for equality, never return/persist it.

Listeners count only heartbeat events pc/pf/pr and aggregate normal-message counts. No per-message ring entry, no per-message logger call, no copying packet/batch objects. Store only numeric timestamps/counters and fixed enums, not raw emitter arguments. A record belongs to its ORIGINAL admitted object forever; never transfer its ring/counters into a replacement's recorder or pool across owners. At terminal observation and finalization recheck map scope; output current boolean or null when predicate unavailable. An old/replaced object's close remains an old diagnostic, never a current-authority or current-cause claim. No automatic causal verdict is produced.

Observe both Engine close and main Socket disconnect. Socket.IO's own engine listener may trigger namespace disconnect BEFORE this observer's Engine close callback runs. Therefore the first terminal callback captures reason/source, monotonic/wall association and safe state immediately, then queues AT MOST ONE queueMicrotask finalizer. This lets an already-enrolled Engine close callback in the same dispatch add its fixed engine reason before commit. Prefer Engine reason when actually observed; otherwise retain fixed namespace reason with source namespace. Never synthesize an Engine close. Capture buffer length/writable in the terminal callback, not later: Engine onClose clears its buffer in process.nextTick before an arbitrary finalization microtask may read it.

Once finalized: set closed guard before logging; remove EXACT own packetCreate/packet/flush/close and namespace disconnect callbacks; clear ring and all socket/engine/predicate/getter references from registry state; remove recorder from registry. Already-copied/in-flight callbacks can update only while not finalized; after finalization they are harmless. Logger/projection failure cannot interrupt authority cleanup and must not enqueue a retry. Repeated Engine close, namespace disconnect, server shutdown and queued finalizer yield at most one record.

Registry has one normal active main Viewer plus briefly closing recorders; cap retained recorders at8. Overflow must not reject or alter Viewer admission: finalize/dispose oldest diagnostic-only recorder with fixed coverage capacity and current=false, with no timer. Keep at most8 owned recorders and32 events each; every terminal path unregisters and removes references. Unit tests must exercise synchronous supersession/rebind before old emitter callbacks finish. Do not disable an enrolled old terminal callback merely because the product replaced the map first.

On server shutdown registry.stop() is synchronous/idempotent: finalize remaining recorders with source shutdown and fixed server-shutdown reason, capture existing runtime snapshot before it is stopped, detach all own callbacks, clear registry references, and let the original runtime shutdown continue. A queued finalizer after shutdown must no-op. HTTP close fallback only calls this stop, never server.close/io.close/engine.close itself. No timer, promise loop or background retry can outlive disposal.

## Exact minimal safe schema and budget

One log call maximum per admitted recorder closure, fixed prefix WRD_SIGNAL_HEARTBEAT followed by ONE compact ASCII JSON object on the same line. Use logger.log if provided; no raw Error logging on fallback. Do not pass emitter objects to logger. Safe projection must reject unknown keys and finite/type violations. Absolute maximum JSON payload4096bytes (prefix is fixed21ASCII bytes including trailing space and may be budgeted separately; tests also assert whole line<=4120bytes). A format failure emits at most one much smaller fixed unavailable record, never a raw dump.

Proposed object keys ONLY:

- v=1,event=viewer-heartbeat-close,wallMs finite integer0..9999999999999 or null,durationMs integer0..999999999 or null.
- source engine/namespace/shutdown; reason compact enum ping,transport-close,transport-error,server-disconnect,client-disconnect,server-shutdown,parse,forced,unknown. Normalize existing reason vocabulary explicitly; unknown stays unknown. current true/false/null. proof true/false (fixed classification from post-admission flag, no proof token).
- coverage object with state partial/unavailable/capacity,engine boolean,flushScanLimited boolean,valueInvalid boolean,counterClipped boolean. Observation starts AFTER admission, so no complete-startup promise.
- ages object pingCreatedMs,pingInFlushMs,pongReceivedMs: nonnegative monotonic difference between terminal capture time and last observed corresponding event, integer0..999999999 or null. Null for never seen/invalid/overflow. Do not use wall-clock subtraction. These are ages, not latencies between peers. If close time precedes event time, mark valueInvalid and null.
- counts object pingCreated,pingInFlush,pongReceived,messageIn,messageCreated,flush: saturating integer0..999999999; counterClipped marks saturation. Count a ping once per packet and record one pf per batch containing any ping, with explicit count semantics; no per-message ring growth.
- transport object name websocket/polling/webtransport/unknown; writable boolean/null from exact boolean read; bufferLength integer0..1000000/null from Array.isArray(engine.writeBuffer) and safe integer length. state opening/open/closing/closed/unknown from exact readyState whitelist. Oversized/invalid values become null and set valueInvalid; no coercion of strings or truthy objects. Never traverse writeBuffer contents. Guard getters/exceptions locally and use null/unknown.
- node object ONLY status ok/unavailable/error,ageMs integer0..999999999/null,count integer0..120/null,lastMs/maxMs/p95Ms integers0..999999999/null,missed integer0..999999999/null from runtimeObserver.snapshot().eventLoop and ageMs. Snapshot getter throwing/unavailable produces null metrics and unavailable/error; do not dump snapshot, RSS, process fields or arbitrary keys. Existing snapshot.available may depend on RSS, so do not equate it with proof that every Node timer ran; retain age/count and coverage. One current snapshot cannot reconstruct unobserved prior scheduling.
- ringDropped saturating0..999999999 and ring of AT MOST32 projected heartbeat records. Event EXACT keys {t,n,k}, t0..999999999 integer since attachment,n1..999999999,k pc/pf/pr. No object IDs or labels, payload, direction, URL, arbitrary strings, message event or redundant transport field. Each same-engine ring is already privately scoped. A record never changes scope when old owner closes.

Sample bound calculation with every integer at its max,32 events, maximum fixed enum lengths gives roughly2.1KiB compact JSON; reference calculation found2024bytes with representative maximums and2031bytes using longer source/transport/coverage values. Tests must enumerate all longest enum/source/null/false/numeric combinations to calculate actual worst case. Independent hard cap: each ring event<=48bytes, so array<=1569bytes(32*48+33), and non-ring envelope<=2527bytes, giving4096 total. Do not add arbitrary optional fields because space seems available. On any cap/projection violation preserve only fixed minimal failure metadata and coverage capacity; never silently truncate JSON or write an unbounded terminal report.

Flush scan is bounded to64 packet entries and reads type only. If the batch is not an Array, has unsafe length, has more than64 entries, or a type getter fails, set flushScanLimited/valueInvalid as appropriate. Never claim an absent pf proves no ping was handed off when the scan was incomplete. Aggregate flush count is bounded; do not retain the batch reference or message count per batch in ring. Normal events may be very frequent, but their work is constant and output frequency remains close-once.

## Minimal classification the evidence enables

No runtime auto-classification/fix. Reviewer analysis can later compare:

- Last pong received then no later pingCreated, with contemporaneous fresh Node metrics: evidence narrows toward the server per-socket heartbeat generation/scheduling boundary, still needing complete post-pong coverage. Global lag/metrics absent prevents ruling out scheduling starvation.
- Ping created but not seen in any COMPLETE flush scan: queue/writable boundary is unconfirmed; captured writable/buffer length helps. A buffer drained after close cannot be used to reconstruct earlier state.
- Ping in flush, absent incoming client ping: handoff-intent observed and downstream delivery unobserved; transport.send success and exact network hop remain unknown.
- Last client pongCreated but no server pongReceived: upstream delivery is unconfirmed, not proven client queueing failure. Opposite direction's message counts can constrain a full outage without proving heartbeat delivery.

Capture wall association plus observer duration and monotonic event ages, never subtract server/browser timestamps to advertise one-way network latency. Old/replaced scope records cannot be promoted to the active attempt's root cause. Existing proof remains one-use; nothing in observation authorizes retry admission or input.

## Red-green offline tests (no server/listen/network)

First add failing tests around the actual new module/injected post-admission callback. Then implement minimal module/wiring. Do not run npm test: its pretest rebuilds served dist. No production browser or test server is needed.

1. Real module + EventEmitter fake Engine/Socket: pingCreate,pongReceive,ping-containing flush ages/counts at fake monotonic times, null before first event, safe buffer/writable/state projection, exact one close JSON line and exact own listener cleanup. Tests check product listener counts/calls unchanged and no send/close/connect/timer methods called by observer.
2. Installed library behavior test: import installed Engine Socket prototype and use Object.create with fake EventEmitter server, fake transport.send and required buffers/state; execute ACTUAL sendPacket/flush/onPacket rather than duplicate their order. No constructor/onOpen/schedulePing, no timers/listen. Show packetCreate fires before queue push, flush before transport.send, false writable retains queue without pf, and incoming pong is seen through actual onPacket (use safe fake refresh marker/null timeout only for the library's own calls). Assert observer never invokes refresh or mutates those references. The test should fail if field/event signature assumptions differ from installed version. Actual library data may flow to fake transport but diagnostic logger must never contain it.
3. Actual setupSignaling handler test with existing fake IO/Socket fixture and injected registry: only an accepted ordinary Viewer/proof Viewer gets attachment; rejected token/proof/resume, Host and relay-viewer do not. Verify ordinary generation/one-use proof/supersession/lease outcomes match existing tests. Missing engine does not reject or change welcome.
4. Product listener registered first replaces current map during namespace disconnect or Engine close: record remains old scope/current=false, never merged/promoted into replacement. Engine/namespace close in either order, repeated close, shutdown followed by queued finalizer, callback after exact off and stop all log once and release references. Cap8 recorder/flood tests have no retained listener growth; no global interval created.
5. Privacy canaries in packet.data/options, batch data, socket/engine IDs, handshake/auth, URL, error.message/description/stack and unknown reason; use throwing getters on prohibited fields. Logger JSON contains only fixed projection and no canary. Unknown reasons/nonnumeric values/getter errors/NaN/infinity/huge arrays become fixed null/unknown/coverage flags. A flush batch>64 is explicitly incomplete, not proof of no ping.
6. Ring32 overwrite, millions of message events simulated with a bounded loop (or enough to demonstrate constant ring), saturating counters and max-width serialization: no per-message log/ring growth; one record<=4096bytes and whole line<=4120bytes. Exhaustive schema enum-bound tests, not source-text checks alone.
7. Existing runtimeObserver fake-clock test: pass its REAL snapshot getter into module, advance the existing observer's injected timer, close record includes only whitelisted age/count/lag/missed; injected arbitrary snapshot keys are absent. New module never starts/stops that observer or creates its own timer.
8. Logger throw/JSON projection error/observer-attach error cannot change admission, disconnect grace or server-close behavior; no retry. Actual runtime.close and HTTP close fallback injected tests must prove registry stopped before runtimeObserver.stop and after stop zero registered observer callbacks remain. Do not start an HTTP listener for wiring validation.

Proposed commands from repository root, after red-green tests exist:

    node --test signal-server/test/viewer-heartbeat.test.js
    node --test signal-server/websocket/signaling.test.js signal-server/test/runtime-observability.test.js
    node --check signal-server/lib/observability/viewer-heartbeat.js
    node --check signal-server/websocket/signaling.js
    node --check signal-server/server.js
    git diff --check

Only broaden tests if a failure/new concern warrants it. Use no-network wiring fakes rather than unrelated tests that bind a port. Implementation report must separate offline pass, production loaded and real-session acceptance. Local reload may be separately authorized by parent/user, but this design task performs none. Tunnel is untouched. A future real proof still fails on first discontinuity; no causality or recovery success is inferred until corresponding server/client evidence is actually captured.


- [ ] **Step 4: 运行 GREEN 与检查。** 运行本 Task 精确契约的定向命令及新增无 listen 的 server close 测试；证明 installed Engine prototype 的实际 sendPacket/flush/onPacket 顺序（fake transport、无 constructor/onOpen/timer）、namespace 先 close 与旧 scope false、getter privacy canary、ring/bytes cap、实际 runtime snapshot、logger throw，以及 HTTP close/error 和 runtime.close 三路先 diagnostic stop 后 runtime stop。不得用源码字符串检查代替真实 wiring 调用。
- [ ] **Step 5: 自审并只提交任务文件。** `git diff --check`，读取完整 diff，`git add` 精确源码/测试路径后 `git commit -m "feat(observability): trace admitted viewer heartbeat closure"`。报告 RED/GREEN、commit、局限和生产 NOT RUN；归还 index。独立 review 通过前不能部署。

### Task 2: 主线程复审、部署与新证据验收

**Files:** 本计划、spec、实施记录、真实验收报告及脱敏 review 归档。

- [ ] 对 Task 1 完整 commit 范围作独立 spec compliance + quality review；必要修改由原 implementer 修复后 scoped review。
- [ ] 基于当前主目录已同步 9e57bf4 的增量检查，保留 primary HEAD/index/dirty、四个 deferred watcher 文件、cloudflared 与 quick URL 状态。新鲜 local Host online/zeroViewer 后才应用；只用 webremote-service helper 重启本地服务并核验 build/health/Host。
- [ ] 用已有 strict one-use proof runner 进行一次 300 秒 TURN 连续性测试，首次断线仍 INCOMPLETE；保存 browser first-close、server close 摘要及同窗口 connector 日志。禁止 remint 重连、抢占人类 Viewer、native input 或改 tunnel。
- [ ] 按实际边界判定下一步：心跳未生成、未完整 flush、flush 意图后客户端未收到、客户端 pong 未到服务端分别保持证据层级；不得凭一次短测推导三小时或可见效果验收通过。
- [ ] 同步报告和方案；需要改变 tunnel 时必须遵守用户的直接授权边界，先给具体证据与具体操作，不能自行变更。
