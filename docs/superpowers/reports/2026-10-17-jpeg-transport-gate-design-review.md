# JPEG transport admission gate design review

Read-only review at ed7ba25fda52996021f123fc6c078ebd131a3837 in /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop. Read the prior transport review, actual Host lifecycle, RelayFrameWorker, tests, and installed Engine.IO writer/payload source. No source/index/config/dependency/service/browser/network operations; this mode0600 proposal is the only output. Tests below are proposed, not executed.

## Decision

A bounded, fail-closed queue.join admission wait BEFORE feedback and capture is sufficient to close the demonstrated TTL-reopens-JPEG-admission gap for the current single producer and installed unbounded Engine.IO enqueue path. Instrumentation-first is not required to justify this invariant fix. Instrumentation is still required to identify the initiating cause of the historical 5.2-second outage; do not present this gate as its established fix or close continuity acceptance.

No queue replacement, writer monkeypatch, private unfinished-task mutation, global emit lock, reconnect trigger, queue clearing, artificial task_done, FPS/window/TTL change, or native worker redesign is needed. A stalled transport intentionally stops new capture and producer feedback. It can still block media indefinitely, but the event loop and stop/suspend/reconnect remain responsive.

## Integration and token

Production JPEG emission has exactly one Python source site: TunnelRelayStreamer._run, host.py:1091, event relay-frame with one binary data attachment. Other relay-frame occurrences are ACK registration and tests; relay-frame-feedback at845 has no JPEG. Start paths2207/5083/5183/5239 construct the same streamer class. _run alone submits this streamer's worker request. Preserve current stop/start serialization, task identity, retirement gate and authority callbacks.

At the top of every active iteration, capture an immutable admission token containing current_task, production_generation, a value snapshot of relay_scope, sio, sio.eio, and sio.eio.queue. The existing authority callback additionally proves this is the Host-owned current relay/connection authority; do not regard self.sio identity alone on a detached old streamer as Host-current proof. Fences require:

- enabled, not suspended, viewer present, self.task is token.task and current task;
- existing _production_is_current(token.generation, token.scope), including authority;
- self.sio is token.sio, self.sio.eio is token.eio, token.eio.queue is token.queue;
- Socket.IO connected, EIO state connected, and a present non-done write_loop_task.

A missing queue/join or missing/dead writer fails closed. Do not silently bypass the gate to support old FakeSio tests. Update fakes with an actual asyncio.Queue and controlled live writer task. The queue/writer attributes are installed-library implementation dependencies: document and test them, not public Socket.IO delivery contracts.

Suggested order within _run:

1. Keep the suspended branch and authority-invalid yielding branch. Expire ACK metadata if useful; expiry never grants transport admission.
2. Snapshot token; validate; await wait_for(token.queue.join(), timeout=0.25 seconds). No shield: timeout and outer cancellation must dispose of that join waiter. CancelledError propagates. On timeout, return a not-admitted outcome and continue the outer loop; do not enter the existing ACK timeout handler or change ACK/profile statistics. No timeout fallback emit.
3. Revalidate the entire token after join. For immediately rejected preconditions, sleep a bounded interval (e.g.0.25 seconds) before retry so missing/dead writer cannot busy-spin. A timed-out join itself yielded; no additional sleep is necessary. Revalidation rejects also need yielding if they could repeat without a blocking operation.
4. Only after successful gate, emit due feedback, then revalidate token. Keep ACK-window admission; an ACK wait always returns to the top and reacquires a fresh transport gate. Remove the ACK-timeout branch's direct feedback call (1058); the next loop emits feedback only after the gate. Otherwise repeated retry feedback is an avoidable backlog source. Initial feedback1035 must also move behind the gate and authority check.
5. Before submit_latest revalidate token, then submit using its generation/scope. After awaiting worker result revalidate the whole token, not only production generation. Do not recapture a fresh token for this completed old frame. Discard result on any mismatch. Before installing inflight metadata and immediately before whole sio.emit, revalidate; emit through token.sio. No await between final validation/metadata insertion and beginning emit other than the existing emit itself.
6. Keep existing per-frame cap, metadata cleanup, final reference release and frame pacing. Transport polling returns before allocating a frame, so no JPEG is kept by the blocked producer.

Feedback enqueued after a successful gate may overlap the subsequent capture/one JPEG. This does not defeat the JPEG bound; if it stalls, the next iteration blocks before adding another feedback. Waiting on all queue traffic can starve JPEG under persistent control traffic; accept this conservative liveness tradeoff explicitly. Feedback silence during a transport stall is intentional and cannot be used as evidence of a native capture stall. Bounded in-memory counters/ages may supplement diagnosis later without emitting per-retry traffic.

## Failure and lifecycle semantics

Timeout: blocked, never admission. Repeated timeouts keep yielding and retain at most one join waiter at a time. No shielded task accumulation.

Failed/canceled writer: WebSocket failure leaves unfinished accounting for the failed packet/batch; join can never complete. Dead/missing writer fences block even if queue accounting happens to be zero. Polling task_done happens before checking HTTP status, so join alone is insufficient; post-join writer/state checks reject an already-exited writer. A write failure occurring later during capture is caught by the pre-emit fence. No claim that a healthy writer guarantees remote delivery.

Stop/cancel: stop already changes generation, clears enabled, detaches task, cancels and awaits the old coroutine, invalidates/stops its worker. Allow cancellation to propagate out of join and do not touch shared queue accounting. Queued JPEGs remain transport-owned. Native worker retirement behavior remains unchanged.

Suspend/resume: set_suspended changes production generation and invalidates worker without canceling producer. A join timeout within250ms lets the loop observe suspension. If join completes during suspension or after resume, its old generation fails; resume must acquire a new token/gate. Thus the first resumed capture cannot evade retained old JPEG accounting.

Replacement producer on same client/queue: start awaits stop and prevents a new native worker while old retirement remains active. A new task has no previous-frame completion to await, so the gate must run unconditionally on its FIRST iteration. It waits for the predecessor's unfinished JPEG regardless of cleared ACK map/new producer ID. This is why an end-of-frame-only gate is insufficient.

Reconnect: on_disconnect advances authority, detaches and stops old relay. ensure_connected replaces the old client; _build_socket_client uses reconnection=False and a fresh queue. Old-client/queue join completion never authorizes a send under new identity. New connection's first producer gates its new queue normally; it need not drain an orphan old queue. This is a per-current-queue bound, not a total-process bound over arbitrarily retained disconnected clients/tasks. Reuse of a poisoned old queue remains fail-closed, not automatic reset/reconnect.

## Proof and precise limit

Induction for one queue: before the first admitted capture, queue.join has accounted for every previous unfinished JPEG, including an old producer's attachment. Only one current producer can submit/emit; stale workers are fenced. Capturing adds no EIO JPEG. Under installed python-socketio5.16.1/python-engineio4.13.1, the complete envelope+attachment emission reaches unbounded queue.put without a real suspension between its packets. Thus there is no interleaving cancellation/producer handoff in that pair. The following iteration cannot admit until all unfinished tasks, including that attachment, are accounted for. ACK expiry has no bearing. Non-media puts after join wakes can add control traffic, but cannot add another JPEG because all JPEG sends share this serial producer lifecycle. Recheck identities after capture prevents an old successful join from granting admission into another queue.

This proves at most ONE unfinished JPEG event in this EIO queue plus its active writer batch after adoption (assuming no arbitrary backlog predating adoption; the first gate drains such a backlog before new capture). It does NOT prove only one JPEG object is referenced by the writer! Installed writer retains loop local pkt after task_done; polling additionally retains Payload p, whose packets references the prior batch. The previous completed JPEG may remain referenced when the next is admitted. A careful count therefore permits up to TWO distinct JPEG payloads in queue/writer locals: previous completed residual plus current unfinished event. With the existing16MiB per JPEG cap, these original JPEG payloads alone are bounded by32MiB per such writer/queue steady-state, NOT total transport memory. Packet/envelope metadata, polling base64/body copies, aiohttp state, buffers, worker output and native/socket memory are outside that numeric statement. Prefer documenting the count invariant rather than advertising a byte budget. No global/process/end-to-end ceiling or receipt/presentation proof follows.

Queue.join uses an Event, so a non-media put after the zero transition can coexist with a resumed waiter. It is not an exclusive drain-and-reserve primitive. The single-JPEG producer proof, not global queue emptiness, makes this safe. If a future dependency adds real per-packet suspension, bounded queue, or awaited hooks, re-audit atomic envelope+attachment enqueue and lifecycle cancellation; this proposal does not resolve Socket.IO's general concurrent binary emission warning.

## Minimal offline regression set

Use real asyncio.Queue and event-driven fake transport/worker with synthetic byte payloads. AST-load the actual streamer and required constants/helpers without importing Host/native capture modules (or use existing repository native-import isolation). Do not reimplement the gate in tests. No connect, HTTP, browser, MSS/Quartz, dependency install or live monkeypatch is needed.

1. Queue consumer gets an old JPEG but withholds task_done (qsize==0). Across multiple timeout intervals and ACK TTL expiry, assert zero new worker submissions/JPEG emits and no retry feedback accumulation. Release task_done and assert exactly one new capture admitted.
2. Stop/start replacement on same client+queue while old JPEG remains unfinished. Assert first replacement capture blocked. Also suspend then resume during blocked join; generation change rejects the old token, resume gates afresh, and stop promptly cancels waiter without touching accounting.
3. Queue/client/authority/task identity replacement while waiting AND while fake capture is pending. Complete old join/result; assert no stale JPEG to either old or new client. Start current producer on fresh queue and demonstrate progress independent of orphan old unfinished count.
4. Writer fails or is canceled after dequeue without task_done; assert retries do not capture/feedback and cancel stops promptly. Include queue empty/accounted with writer done/missing; it must still block. Include writer death during capture before emit.
5. Healthy two-packet enqueue and successful writer task_done allow next frame; delayed Viewer ACK still enforces existing ACK window separately. ACK TTL cannot bypass transport stall. Assert canceled/timed-out join waiters do not accumulate.
6. Optional focused installed-library disconnected synthetic emit probe verifies one envelope+one attachment and no inter-packet scheduler yield; test double writer holds batches to distinguish queued versus dequeued retention. A source-contract check alone is not full dependency compatibility proof. Test residual writer locals if asserting an exact retained-payload count.

No actual regression or runtime acceptance is claimed in this proposal. Historical continuity remains FAIL/unknown initiating substage until separately authorized validation supplies evidence.
