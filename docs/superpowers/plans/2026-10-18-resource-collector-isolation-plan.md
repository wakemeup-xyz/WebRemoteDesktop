# Resource collector isolation plan

> Use superpowers:subagent-driven-development. Binding spec: ../specs/2026-10-18-resource-collector-isolation-design.md

## Constraints and ownership

Worktree /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop. Preserve four preexisting dirty docs and node_modules symlink. One source/index writer. Workers have no primary/service/tunnel/browser/proof/native permissions or subagents. Python /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11. Direct unittest only, no npm/pretest/build/install. Root owns reports/evidence/promotion. No media/authority/policy tuning.

## Task 1: Isolate complete production resource jobs

Owned: python-host/runtime_observability.py, python-host/test_runtime_observability.py, one small pure owner module and focused test file if justified. Minimal AST-tested host.py context/lifecycle adaptation only if needed to expose fixed owner state; no other Host behavior.

1. Inspect current collector and callers; behavioral RED with actual default owner seam and GIL-releasing synchronous fake block.
2. Implement single daemon/private loop, one job/cleanup-ACK slot and bounded publication. Preserve inline explicit injection and existing run_command cleanup.
3. Implement Host-side deadline, late-result fencing, cache/cadence semantics and finite production close with explicit uncertainty.
4. Meaningful fake tests for ownership/deadlines/cleanup/cache/identity/privacy; existing affected pure tests; one finite own-PID compatibility experiment. Capture exact exit codes, no shell-tail masking.
5. Self-review, owned-only commit, implementation report. Independent most-capable spec+quality review; original-worker fixes and scoped rereview if needed.

## Task 2: Resolve remaining capture and acceptance-tool gaps

Read-only capture-path review evaluates minimal phase observation without media behavior changes. Decide separately after Task1; do not silently expand its owner scope. Prospective browser-close allocation may use at most5s while reserving3s manager stop inside unchanged8s shared deadline; old timeout cannot become PASS. No sampling-backend replacement without a documented/validated bounded private design. Any implemented follow-on requires exact scope and pure regressions before promotion.

## Task 3: Promote and qualify

Root final most-capable review of exact increment, guarded exact-byte sync preserving primary state and tunnel, safe local Host reload, health/Host/build/password report. Fresh passive short run only when user Viewer absent, one normal UI Start/proof, no heavy work while active. Preserve failures, trace missing evidence and user-session priority. Then pursue long-session and actual-user input acceptance; never call passive gates actual input/visible-effect latency.
