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

- [ ] Write behavioral deterministic RED for completed preload followed by identical Start: fake now100→200, fetch counter stays1, exact ready value returned. Existing implementation performs fetch2.
- [ ] Add one private cache slot and request/scope ownership checks. Use current key mode/TURN; read scope before admission, verify it at publication; invalidate on mismatch/force/cancel/failure. Read safe finite monotonic now for completion and hit, never renew on hit. No persistence or public cache metadata. Inspect actual config consumers for mutation.
- [ ] Pass generation scope in Viewer bootstrap factory; check token and generation again on successful JSON response before return. Preserve all current auth/admission/proof and startup gate semantics.
- [ ] Deterministic tests: exactly3000 expires; hit does not renew;0 disables; invalid/rollback clocks miss; mode/TURN/scope changes refetch; cancel/force refetch; nonready never reused; stale scope completion cannot publish; existing concurrent inflight sharing unaffected. Actual Auth+WebRTC harness integration asserts completed warmup reused by verified Start and fresh admission still performed (normal and proof branches as relevant), old auth result fenced.
- [ ] Run direct Node --test on bootstrap-controller.test.js, auth-start-integration.test.js, auth.test.js, auth-startup-budget.test.js if present, and startup-lifecycle.test.js/startup-supervisor tests actually consuming the changed controller. Resolve exact relevant filenames first; run affected set once after changes. No unfiltered npm/pretest or live dist.
- [ ] Self-review, owned-only commit and exact report with RED/GREEN commands/counts/exits, source scope, concerns, no production claims. Independent task spec+quality review, original-worker fixes and scoped rereview; then most-capable final whole increment review.

### Task 1a: Align automatic warmup with verified Auth scope

Evidence and contract: production defer-order follow-up in the spec. Only owned files: web-client/js/webrtc.js (boot Auth subscription/warmup boundary) and web-client/js/auth-start-integration.test.js. Leave controller/auth implementation and media/network/proof code unchanged. Preserve four dirty docs and node_modules. One source/index writer, fresh worker, pure tests only.

- [ ] Add deterministic production interactive/defer-before-DOMContentLoaded ordering to the existing actual Auth/controller/boot/Start harness. Establish behavioral RED: current code eagerly requests bootstrap with unverified generation, then requires a second request after verification; desired behavior waits and shares one current verified warmup.
- [ ] Gate one automatic page preload on the first current verified Auth state, using the existing subscription plus immediate current-state check after controller construction. Keep mode/TURN current, no duplicate auth initialization, no request under unavailable/unauthorized state, no new timer/storage/diagnostic/protocol field. Preserve strict3s reuse and all Start admission/identity/deadline behavior.
- [ ] Cover loading and interactive production ordering, delayed/pending and already-verified states, repeated verified notification, unavailable/unauthorized, normal/proof Start and fresh ordinary admission. Run affected direct Node controller/Auth/integration tests; no npm/pretest/build/live actions.
- [ ] Self-review, owned-only commit/report; independent task spec+quality review and original-worker fixes if required; mandatory most-capable whole-increment source review before promotion.

### Task 2: Guarded rollout and fresh qualification

Root only: preserve current c583250 product/ed92 build as source baseline (post-run docs418601c synced). Freeze exact reviewed target, verify full source and preexisting primary dirt; temporary output build only. Fresh health/Hostonline/Viewer0/relay0 before apply/reload. Safe helper restart-signal only, never tunnel or Host. Verify new Signal identity/build/retained assets, unchanged Host94398 birth03:29:32 and primaryHEAD/index/tunnel/watcher. Report current passwords outside versioned docs. Existing private supervisor/helper/sampler hashes unchanged. Fresh one-Start/proof300s short run and10800s long run with no concurrent heavy work. Preserve intentionally canceled prior long run asINCOMPLETE, not FAIL/PASS. Record actual timing/window/missing/control evidence and updated docs.

Task2 first iteration:8675e85/6b2ad956f6a6cdd8 is loaded, Signal27319 and sameHost94398. The reload helper exited0 and source/assets/health matched, but unexpected Registry observation makes that operation INDETERMINATE; preserve it. Separate fresh loaded-state verification and300s continuity PASS do not rewrite that operation. No10800s run started for this build. Task1a is justified by the confirmed production-order gap; qualify its reviewed build with fresh runs. Reuse the actual current primary state as the next promotion baseline; never rerun stale PID/build-pinned wrappers or apply twice.
