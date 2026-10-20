# Signaling timeout fallback implementation plan

> Use superpowers:subagent-driven-development. Binding spec: ../specs/2026-10-17-signaling-timeout-fallback-design.md

## Global Constraints

Only worktree /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop. One source/index writer; preserve preexisting README/runbook/requirements/review-anchor dirt and node_modules symlink. Workers/reviewers no subagents, services/browser/network/native/tunnel/watcher/live dist build/npm pretest/install. Controller handles docs/deploy/live. Node /Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node. Use actual bundled library with no-network fakes; no private library error invocation or parallel Viewer sockets. Existing lease/input/quality/media/receipt policies unchanged. Explicitly separate 5s per Engine-open attempt from total recovery elapsed.

### Task 1: Correct silent WS retry preference and retain safe signaling failure evidence

Files: web-client/js/webrtc.js, runtime-diagnostic.js, diagnostic-core.js (diagnostic.js only if shared builder integration needs it), focused tests; signal-server/lib/diagnostic.js and focused diagnostic tests. No new production module/assets/dependency. Worker reads binding exactcontract.

1. RED actual browser-bundle Manager silent WS timeout/retry behavior with no-network transport/VM fakes. Inspect actual production bundle path/version; don't replace integration with helper-only model.
2. Add current-owner/session-scoped polling preference selected only by exact opening WS Manager timeout when polling allowed; update next retry options, preserve through automatic peer/socket recovery, clear explicit Start/successful reclaim/manualdisconnect/supersede; never generic init/reuseSocket/media-attempt; bind an independent user-session owner. No second socket/new retry timer/private Engine hook/changedauth. Follow every negative/lifecycle case in spec.
3. Add immutable safe last-connect-error summary and existing cooldown auto-diagnostic capture before recovery. Exact10field shared whitelist across core/full/storage/server persistence; fixed reason signal-connect-error, <1KiB/128KiB limits, null unknown/overflow clocks, preserve existing marks/resources storage+clipping policy and watchdog/receipts. Diagnostic sync throws or rejected promises cannot affect recovery; no raw error text.
4. Run focused meaningful tests incl actualbundle timeout fallback, existing hard error coverage if pure/offline, state lifecycle and persistence. No production network, no broad repeats without reason. Self-review, explicitpathcommit, detailed report counts/commands/limitations; root docs not staged.

### Task 2: Controller review, guarded deployment and repeat diagnosis

1. Independent preflight, task and most-capablefinal review; fix actionable findings with original implementer and scoped re-review. Decide any ambiguous policy before implementation, record ruling/cost.
2. Freeze actualprimarybaseline85322bb (including the preceding docs-only sync), privatebuild/apply, freshHostonlineViewer0/relay0. RestartSignalonly viahelper, verifyHost89291/tunnel84671/watcher897 unchanged, source/assets/manifest, health and runtime credentials. Preserve W2 fourundeployedwatcher files.
3. Normal guarded formal login+oneStart+passive session with one-use proof, no forcedtakeover/native businessinput; no tests/builds/reloads duringprobe. Inspect realstartup errors/safeclassification ifpresent; do notmanufacturelivefailure solely for coverage.
4. Update report/spec/plan/review/evidence and primarydocs; servicesonline. BroaderHostpressure/nativeinput/3hremain separatelyqualified.

## Execution status, October18

Task1 and both independent review gates completed; d27dbb2 product/f4202b7 test-only cleanup loaded as build07ad960b331ccc4b. Task2 guarded loading/source+asset checks complete; helper health timed out34.292s then independent status/health recovered. Signal42509, Host89291 unchanged. Formal300s target run ended INCOMPLETE after134.962s/133samples, Host ping timeout and lease invalidation; no precleanup Viewer signaling close/error observed. Docs/evidence preserve this failure. Initial gateboolean lacked reasons and helper overwrote startupSummary: follow-up evidence-only spec/plan2026-10-18-passive-gate-evidence-design.md/plans now owns that work. Full service/input/3h acceptance remains incomplete.
