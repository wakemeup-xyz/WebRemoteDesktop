# Completed Bootstrap Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Execute without further workflow/permission prompts within existing authorization.

**Goal:** Avoid a second config request when Start follows a fresh completed preload.
**Architecture:** One private successful-result slot, exact request/auth scope, absolute short eligibility window; existing admission and startup owner remain authoritative.
**Tech Stack:** Browser JavaScript, direct Node fake/vm tests.
**Spec:** ../specs/2026-10-18-bootstrap-ready-reuse-design.md

## Global Constraints

Worktree /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop. One source/index writer. Preserve four preexisting dirty docs and node_modules symlink. No primary/service/tunnel/browser/native/proof/build/npm/install operations by workers. Node /Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node. Actual input/visible metrics remainNOT RUN. No media/authority/policy changes.

### Task 1: Reuse a fresh completed preload

**Owned files:** web-client/js/bootstrap-controller.js, web-client/js/bootstrap-controller.test.js, web-client/js/webrtc.js (bootstrap factory/fetch success fence only), web-client/js/auth-start-integration.test.js. Do not refactor other WebRTC behavior.
**Consumes:** Auth.getGeneration/getToken/isVerified, existing startViewer pre/post identity guards and episode.controller.cancel; controller.load({mode,turnServerId,force}), retry/cancel.
**Produces:** backwards-compatible controller with now/getScope/cacheMaxAgeMs options and one successful ready reuse slot. Default3000ms, allowed0..3000; strict expiry and no renewal. Actual getScope callback is Auth.getGeneration.

- [x] Write behavioral deterministic RED for completed preload followed by identical Start: fake now100→200, fetch counter stays1, exact ready value returned. Existing implementation performs fetch2.
- [x] Add one private cache slot and request/scope ownership checks. Use current key mode/TURN; read scope before admission, verify it at publication; invalidate on mismatch/force/cancel/failure. Read safe finite monotonic now for completion and hit, never renew on hit. No persistence or public cache metadata. Inspect actual config consumers for mutation.
- [x] Pass generation scope in Viewer bootstrap factory; check token and generation again on successful JSON response before return. Preserve all current auth/admission/proof and startup gate semantics.
- [x] Deterministic tests: exactly3000 expires; hit does not renew;0 disables; invalid/rollback clocks miss; mode/TURN/scope changes refetch; cancel/force refetch; nonready never reused; stale scope completion cannot publish; existing concurrent inflight sharing unaffected. Actual Auth+WebRTC harness integration asserts completed warmup reused by verified Start and fresh admission still performed (normal and proof branches as relevant), old auth result fenced.
- [x] Run direct Node --test on bootstrap-controller.test.js, auth-start-integration.test.js, auth.test.js, auth-startup-budget.test.js if present, and startup-lifecycle.test.js/startup-supervisor tests actually consuming the changed controller. Resolve exact relevant filenames first; run affected set once after changes. No unfiltered npm/pretest or live dist.
- [x] Self-review, owned-only commit and exact report with RED/GREEN commands/counts/exits, source scope, concerns, no production claims. Independent task spec+quality review, original-worker fixes and scoped rereview; then most-capable final whole increment review.

### Task 1a: Align automatic warmup with verified Auth scope

Evidence and contract: production defer-order follow-up in the spec. Only owned files: web-client/js/webrtc.js (boot Auth subscription/warmup boundary) and web-client/js/auth-start-integration.test.js. Leave controller/auth implementation and media/network/proof code unchanged. Preserve four dirty docs and node_modules. One source/index writer, fresh worker, pure tests only.

- [x] Add deterministic production interactive/defer-before-DOMContentLoaded ordering to the existing actual Auth/controller/boot/Start harness. Establish behavioral RED: current code eagerly requests bootstrap with unverified generation, then requires a second request after verification; desired behavior waits and shares one current verified warmup.
- [x] Gate one automatic page preload on the first current verified Auth state, using the existing subscription plus immediate current-state check after controller construction. Keep mode/TURN current, no duplicate auth initialization, no request under unavailable/unauthorized state, no new timer/storage/diagnostic/protocol field. Preserve strict3s reuse and all Start admission/identity/deadline behavior.
- [x] Cover loading and interactive production ordering, delayed/pending and already-verified states, repeated verified notification, unavailable/unauthorized, normal/proof Start and fresh ordinary admission. Run affected direct Node controller/Auth/integration tests; no npm/pretest/build/live actions.
- [x] Self-review, owned-only commit/report; independent task spec+quality review and original-worker fixes if required; mandatory most-capable whole-increment source review before promotion.

### Task 2: Guarded rollout and fresh qualification

Root only: preserve current c583250 product/ed92 build as source baseline (post-run docs418601c synced). Freeze exact reviewed target, verify full source and preexisting primary dirt; temporary output build only. Fresh health/Hostonline/Viewer0/relay0 before apply/reload. Safe helper restart-signal only, never tunnel or Host. Verify new Signal identity/build/retained assets, unchanged Host94398 birth03:29:32 and primaryHEAD/index/tunnel/watcher. Report current passwords outside versioned docs. Existing private supervisor/helper/sampler hashes unchanged. Fresh one-Start/proof300s short run and10800s long run with no concurrent heavy work. Preserve intentionally canceled prior long run asINCOMPLETE, not FAIL/PASS. Record actual timing/window/missing/control evidence and updated docs.

Task2 first iteration:8675e85/6b2ad956f6a6cdd8 is loaded, Signal27319 and sameHost94398. The reload helper exited0 and source/assets/health matched, but unexpected Registry observation makes that operation INDETERMINATE; preserve it. Separate fresh loaded-state verification and300s continuity PASS do not rewrite that operation. No10800s run started for this build. Task1a is justified by the confirmed production-order gap; qualify its reviewed build with fresh runs. Reuse the actual current primary state as the next promotion baseline; never rerun stale PID/build-pinned wrappers or apply twice.


### Task 2 final execution state — 2026-10-18

Completed source/review gates: Task1 `8675e85` affected30/30 GREEN and independent task/final approvals; Task1a `53ed5d7` affected35/35 GREEN with actual production-order behavioral RED on BASE, independent task and most-capable final source approvals. Conditional test filenames were checked; nonexistent suggested files were not invented or run. Current source `53ed5d72e331b808245b7d650a6c4ff7b2969c85` / build `79bf9a5afea0458e`, Signal45287/Host94398. Reviewed Signal-only promotion completed04:40; same Host/tunnel/watcher and primary HEAD/index preserved. The first iteration's INDETERMINATE reload and canceled older run remain historical records.

- [x] Fresh normal UI/one-use proof 300s qualification: 301 samples / 300.000051s PASS, maxrVFCgap383.3ms.
- [x] Separate fresh10800s qualification with no concurrent heavy work: 10801 samples / 10800.000087s PASS, missing/late/failed/identity-change0, maxgap766.58ms. Preserve SUP observation-unavailable and full-tree UNKNOWN.
- [x] Independent streaming browser-math, exact rotated-log windows and narrow capture-freshness source review; current service/public assets checked; bounded evidence and historical overview updated. These are actual passive scope, not native input acceptance.

[Current execution and evidence](../reports/2026-10-18-verified-warmup-execution.md). Native business input/visible/physical remain NOT RUN, ordinary-user recovery unqualified. Current capture ~8.17 completions/s vs ~19.46 output FPS and59.062% reuse remain performance limitations; no source-proven duplicate sleep/queue defect was found, so do not silently change policy. Follow-up same-clock cadence summaries, invocation-scoped cleanup completion, isolated input-visible qualification, and more than one startup observation are future diagnostic tasks, outside the completed bounded bootstrap implementation and passive qualification.
