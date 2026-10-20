# Resource collection outside the Host control loop

2026-10-18. Authorized brainstorming + writing-plans; no renewed workflow or maintenance question. Baseline93f3908, live ed92d1313adb54f6. Keep services available and tunnel/watcher untouched.

## Evidence and choice

After the startup/signaling/bounded-logging code was deployed, the fresh300.001s passive window still included a2716.6ms frame gap, correlated with2959.926ms capture wall time,1491.700ms loop lag and load1=154.437. Encoding windows did not show a matching seconds-long encode. The native sample yielded no stack. This does not identify a unique cause. Source independently proves the resource sampler starts subprocesses synchronously before their async first yield on the Host loop; wait_for cannot enforce a return deadline while spawn or cancellation/reaping blocks that loop.

Choose one owned daemon thread/private asyncio loop for the **whole** production collector, including spawn, communicate and existing shielded kill/reap. This removes a concrete recurring control-loop blocking boundary. Keep an inline explicitly injected collector for existing loop-bound fake callers. Moving only communicate/to_thread(Popen) leaves ownership gaps. A helper process adds IPC, descendant ownership and Host RSS semantic changes; defer it. No quality/FPS/codec/bitrate/network/input authority changes. This is risk removal, not a claim that it explains or cures native capture/global scheduling stalls.

## Ownership and boundedness

Import/construction remain passive. Default owner starts lazily once on explicit start/sample; thread.start itself is a one-time control-plane cost, not a hard latency guarantee. Never use the default executor or run_coroutine_threadsafe cancellation as cleanup acknowledgement.

One job slot remains reserved through pending submission, synchronous spawn, child execution, cancellation and actual cleanup completion. Timeout/cancel may finish the caller while the owner remains busy; only independent completion after collector finally/reap releases ownership. No replacement thread/job while unresolved. IDs fence old cancel/results. One immutable scalar completion slot, bounded coalesced notifications and short synchronization without I/O/join under locks. No per-poll callback/future growth. Unexpected owner exit becomes unavailable; do not silently replace it.

Host loop enforces one total<=1s sample deadline, retains cache on timeout, skips missed cadence and rejects late results after expiry/close. Keep registered target PID, actual collection sampledNs, original RSS/peak semantics,5s minimum cadence,10s freshness, actual successful delta intervals; timeout must not update cache or previous sample. Snapshot is cached-only with existing numeric/status semantics. Any additive collector state must be fixed scalars (state/busy/cleanupPending/ownerAlive/job timing), no command stdout, exception objects, inputs or credentials. Do not use receipt-time freshness.

Production close stops admission and cancels once, with one persisted<=1s total observation budget, async bounded polling, no blocking join/default-executor shutdown. Explicitly expose cleanupPending/ownerAlive if expired. Repeated close observes the same shutdown rather than obtaining another budget. Existing run_command guarantees kill+communicate/reap before job completion remain unchanged. A daemon continues late cleanup only while the process is alive; finite process exit cannot prove all late children reaped. Inline injection retains its existing caller-loop execution/cleanup compatibility; document this distinction.

## Tests, review and rollout

First behavioral RED must gate a synchronous fake collector on the actual production default owner seam and prove caller loop heartbeat/deadline survives while the collector is blocked; release every test gate in finally. Test caller timeout versus real cleanup ACK, no overlapping/replacement jobs, late result rejection, cached/stale/rates/PID semantics, cancellation/close overlap, repeated close's fixed budget, owner failure, passive import/constructor and bounded slots. Preserve existing collector cancellation/reap tests and AST-only Host tests; do not import Host/native libraries. Explicit injected collector tests remain inline and cross-loop safe.

Also run one separate bounded compatibility experiment using only the configured Python3.11 and explicit own PID with finite /bin/ps and Darwin vm_stat, no Host/native import or live-service interaction. Observe actual worker loop policy, successful child completion and owned thread retirement; no deliberate unrecoverable stall. Fake boundary tests do not prove native GIL or OS scheduling behavior.

One source/index owner; task spec+quality review, original-worker fix/scoped rereview, most-capable integration review. Root promotes exact reviewed bytes only behind fresh health/Host/zeroViewer/relay and preserved primary HEAD/index/untouched/process guards. Restart Host only through safe helper if production bytes change; report current passwords afterward. New runtime evidence remains separate from old incomplete run. The old browser-close timeout stays INCOMPLETE. No automatic sample-backend change: no documented no-symbolication sample option was established. Actual input/visible effect and three-hour qualification remain open.
