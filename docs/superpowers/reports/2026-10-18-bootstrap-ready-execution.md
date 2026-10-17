# Completed preload reuse: execution and qualification

Times below are Asia/Shanghai on2026-10-18. This record distinguishes approved source, actual loaded state, operational observation, short continuity, and unmeasured input effects.

## Source and rollout

Task1 source8675e85e3b66453fc17ddb778fd3a253f4c0d600 adds one successful bootstrap reuse slot with strict3s lifetime, exact mode/TURN/Auth-generation scope and token/generation response fencing. Four Viewer source/test files changed. Behavioral RED failed on the old duplicate fetch; final affected direct-Node tests30/30 passed. Independent task spec/quality and most-capable whole-increment reviews Approved without findings. Final range418601c20f024a2f52d1593f3835d28dec4f7128..8675e85e3b66453fc17ddb778fd3a253f4c0d600; canonical SHA256 ad77fc3cb1c25658093b005623f5f345163e590e4f7eccab62661b7688717f79. Bounded review record is in the linked evidence directory.

Exact frozen increment: zero runtime baseline mismatches, all three doc merges clean. Temporary build6b2ad956f6a6cdd8 validated; all14 existing primary dist files remained unchanged during it. Guarded apply changed11 paths including4 Viewer source/test paths; primary HEAD/index and the four undeployed W2 watcher paths were preserved. The first reload-wrapper attempt stopped before helper launch because hapi is a tracked160000 gitlink rather than a regular file. The corrected mode-aware guard retained complete623 regular-file checks, exact gitlink index metadata and unsupported-mode rejection; it does not claim submodule-content preservation. Independent scoped review Approved that correction.

At04:13:15 the safe helper restarted only Signal. Helper exit0, elapsed6.058s; newSignal27319 born04:13:16, sameHost94398 born03:29:32. Loaded build6b2ad956f6a6cdd8 and retaineded92d1313adb54f6/07ad960b331ccc4b matched the temporary full asset set and HTML except generated builtAt. Source, regular-file baseline, HEAD/index, tunnel84671, watcher897 and absent quick-URL state matched. Both runtime passwords were reread/reported outside versioned files.

The reload operation remains **INDETERMINATE**: Registry reported observation-unavailable. All5 registered identities later exited, no cleanup signal was sent, complete process-tree exit is unknown. This unexpected coverage is correctly a failed-or-indeterminate result despite healthy service state. At04:14:53 a separate fresh read-only receipt corroborated exact loaded source/assets, current process identities, health and Host online/Viewer0/relay0. It does not promote or rewrite the original operation. Ruling: proceed to independently scoped runtime qualification of the observed loaded build; do not restart a healthy service solely to obtain cleaner process-observation metadata or weaken coverage checks.

## Fresh300s formal result

Run bootstrap-ready-short-20261018a used a fresh normal UI login, one Start and one-use proof on the formal relay path. Metadata window04:15:13.627–04:21:00.227; sample span300.001086s,301 observations. Passive continuity **PASS**: missing/late/failed/identity-change observations all0; all301 input-active/lease/viewport/paint/current-attempt/control/socket gates true. Largest completed rVFC callback gap800.1ms. Frame-age1Hz snapshots P50/P95/max40.8/192.1/634.3ms; these are observation statistics, not input-to-picture latency. Same Signal/Host/build at both boundaries; Host online and Viewer0/relay0 after cleanup.

Single-page click→bootstrap/signaling/first-frame846.6/2812.8/7949.5ms, versus priorc583/ed92 short1678.1/4151.7/9156.8ms. Neither pair is a percentile or controlled causal comparison. Signal still served bootstrap **twice**, so no measured cache hit or causal startup benefit is claimed. The last rolling-window candidate RTT was102ms(P95 246), jitter-buffer133.6ms(P95 161.2), decode1.784ms(P95 1.855); those scopes cannot be substituted for transport one-way or input latency.

Browser close3301ms, manager stop35ms;7 registered identities exited without signals. The supervisor also records observation-unavailable and inherent polling limits; no complete-process-tree-exit claim. The diagnostic ring is partial, with767 dropped events. No Host stack sampling triggered.

## Host/runtime observations

Audit reads only same-inode bounded windows: Host314284bytes/1041lines, Signal human10597/365, canonical Signal JSONL19922/14; full offsets, SHA256, missing Host JSONL and aggregate-window boundary gaps are in runtime-summary.json. Human/structured overlap is not double-counted.

62 lag-window records report a maximum591.335ms; per-window P95 range10.872–133.757ms is not a session distribution. Resource owner alive62/62, cleanupPending false, all resource status ok, memory pressure unknown. System load1 snapshots20.193–174.258 do not establish attribution. Paired capture lifetime maximum wall/CPU/nonCPU779.080/31.093/747.987ms is one capture; nonCPU alone does not identify the reason. Capture output windows3.6–18.6FPS; encoding maximum585.972ms and per-window P95 up to461.796ms remain material performance outliers. Fresh browser callbacks do not prove capture-content freshness.

Teardown observed the existing8s grace, fail-closed reset, retry and applied completion. Host released peer/sender/capture/thread/executor with tasks0. No Host ERROR/CRITICAL-level line occurred in this bounded window; that is not proof of no latency problem.

## Remaining work and evidence boundaries

The production defer-order path can warm up before Auth.init advances generation; the loading-state test harness missed that ordering. Task1a in the updated spec/plan addresses the automatic preload timing while retaining the correct auth fence and3s lifetime. This is a concrete source-order gap; current logs do not isolate its contribution to every repeated request. No10800s run has started for this build. The earlier canceled long run remains INCOMPLETE separately.

All six input metrics have0 usable observations: ACK RTT, post-apply-frame latency, visible-effect latency, Host queue, apply and adapter-await. Active-control, physical-display and visible-effect acceptance remain **NOT RUN**. The user has no time for manual testing; no synthetic native input or fabricated values substitute for those missing measurements. Service remains available while the next scoped fix is implemented offline.

Evidence: [browser-summary.json](evidence/2026-10-18-bootstrap-ready-short/browser-summary.json), [runtime-summary.json](evidence/2026-10-18-bootstrap-ready-short/runtime-summary.json), [review-record.json](evidence/2026-10-18-bootstrap-ready-short/review-record.json).
