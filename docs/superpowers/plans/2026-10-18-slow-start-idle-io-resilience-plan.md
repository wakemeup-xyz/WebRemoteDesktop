# Slow startup and idle I/O resilience implementation plan

> Use superpowers:subagent-driven-development. Binding spec: ../specs/2026-10-18-slow-start-idle-io-resilience-design.md

## Global Constraints

Worktree /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop. One source/index writer, preserve4preexisting dirty docs and node_modules symlink. No worker services/network/browser/native imports/live builds/npm/pretest/install/proof acquisition/primary/supervisor/tunnel actions; no subagents. Node /Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node; Python /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11. No codec/FPS/bitrate/quality/network/TURN/auth/admission/lease/reset/proof-policy changes. Scope exact design budgets/identity/privacy/logging contracts. Root manages requirement hunk and docs. Tasks serially acquire source/index ownership; independent task spec+quality review, original-worker fix/scoped review, final most-capable integration review.

### Task 1: Owned slow-start supervision

Owned frontend files: web-client/js/webrtc.js, its meaningful fake-VM tests, a small pure startup-supervisor module/tests if warranted, and the precise existing build entry/test dependency wiring required for that module. No unrelated build changes; no dist. Inspect actual source paths before editing. Root requirement update is not worker-owned.

1. RED actual Viewer+Input delayed-answer (>8s) regression with valid current lease/socket and fresh frame. Preserve evidence that current terminal UI can leave real Input inactive; do not assert historical runtime attribution.
2. Implement one explicit-Start episode enrolled before awaited work; firstinit8s soft/72s active media budget, per-current-PC12s paint cap, existing DC budgets unchanged; automatic retries share remainder. Keep real gate fail-closed, established recovery/tunnel unchanged.
3. Fence older Start/bootstrap/offer/socket/PC/attempt/lease callbacks and all hard terminal paths. Provide slow retry/cancel UI without hidden parallel Start. Pause/resume uses remaining active budgets; no failure diagnostics while intentionally hidden/paused. Invalid clocks cannot extend budget. No broad terminal resurrection.
4. Meaningful targeted tests for all binding startup cases, existing DC watcher and established recovery/paint tests. Direct Node invocation only; inspect test boundaries, no browser/native. Fix any broken integration, don't just change expectations.
5. Self-review, explicit owned paths commit, report .superpowers/sdd/2026-10-18-slow-start-idle-io-resilience-plan/task-1-report.md with RED/GREEN/limits. Task review before next source owner.

### Task 2: Accurate offline rejection and reset completion

Owned Signal signaling.js, relevant pure FakeSocket tests and observability fixed-event schema only if required. No lease manager algorithm or ACK schema change.

1. RED nullHost v2 input/offer false protocol errors; implement viewer-version versus Host-availability versus present-oldHost matrix with existing authority checks.
2. Add exact positive current-reset applied→FREE completion log once; stale/wrongHost/duplicate/rejected/grant ACK must not claim success. Document failed-closed as entry/safety, not proof of failed execution.
3. Offline FakeSocket lifecycle regression: disconnect, in-flight reset rejected unavailable, replacementHost, freshgrant, oldlease rejected/newreset forwarded with no replay. Preserve existing retry/expiry ordering.
4. Direct meaningful Node tests, self-review, explicit paths commit and Task2 report. No real connections or service actions. Independent task review.

### Task 3: Single bounded Host log writer

Owned python-host/observability.py, test_observability.py, a focused pure sink module/test if needed, and minimal host.py exit integration tested by AST. No resource collector conversion in this task.

1. RED blocked fake sink producer responsiveness; implement64queued+1inflight,65536B immutable text admission, saturated fixed counters and no raw-record fallback. Writer owns all file I/O/rotation/close; no producer/state lock during sink work.
2. Preserve configure/logger/structured APIs/rotation/env, idempotence and fixed refusal while oldwriteralive. Bounded watermark flush1s and shared stop1s, out-of-band signal/poll<=50ms, full queue and abandoned counters. Handle automatic logging.shutdown internal-handler acquire/flush/close without global private registry mutation.
3. Minimal explicit Host stop after lifecycle/fatal logs, preserving native/runtime behavior. Never import host.py in test. Test rotation, blockederror/privacy, bytes/capacity, counters, finite flush/stop, duplicateconfigure, blockedreconfigure, automaticshutdown and testworker cleanup.
4. Inspect pure Python suite boundaries; run affected tests only, self-review, explicit owned paths commit and Task3 report. Task review.

### Task 4: Integrate, deploy and qualify

1. Root verifies requirement-only staged hunk, no preexisting doc dirt staged; updates design/plan/report for final behavior. Most-capable final range review, original-worker scoped corrections, no needless suite repeats.
2. Fresh health/Hostonline/Viewer0/relay0, exact source freeze/backup/primary HEAD+index+untouched guards. Preserve four watcher scripts and cloudflared/watcher/quick identities. Validate one temporary build from the frozen full Viewer source, then let normal Signal startup regenerate assets from those same verified inputs; no startup build bypass. Local-only service helper restart. Re-read/report passwords, verify loaded source/assets/Hostonline.
3. Fresh reviewed passive300s, then safe actual-input/visible-effect preflight and3h continuity attempts within authorized guard; no fake isolation flags, reused proof or business desktop input. Keep gates/ACK/post-input frame/real visible effect distinct. No parallel heavy work during probes.
4. Analyze all failures and logs, fix encountered correctness issues with scoped review, maintain services. If idle stalls remain, independently spec ResourceSampler whole-spawn isolation/attribution; don't claim the file sink removes every source or system wait.

## Execution gate (2026-10-18, before rollout)

Task1 c5b18b1: independent scoped review Approved after two findings. Task2 24a6ace: independent spec/quality review Approved. Task3 ba198af +8e9fc0f: scoped review PASS after completed-prefix flush race repair; behavioral two/three-prefix RED→GREEN and16 related pure checks passed. Final integration review at081c6d0 found one Important retained-initial-PC/socket ownership gap. Fix380b250 has228 affected offline passes; scoped final re-review PASS; authorized source rollout gate open. Exact freeze/reload, fresh300s,3h and true input→visible qualification remain required. Existing product runtime is still f4202b7/build07ad960b331ccc4b; offline success is not deployment.

## Actual rollout and open qualification (02:52 CST)

Task4 source rollout complete at93f3908/builded92d1313adb54f6: local-only reload26.648s, Signal51710/Host51808, health+Hostonline; credentials reread/reported, primary/tunnel/watcher/quick state preserved. Fresh300run301observations valid but finalINCOMPLETE duebrowser.close timeout, maxframegap2716.6ms. Owned7identitiesnaturalexit, fulltreeunknown; sample symbolication timedout/output0. Continue bounded evidence and cleanup/sampling preflight before next qualification;3h/nativeeffect notpassed.
