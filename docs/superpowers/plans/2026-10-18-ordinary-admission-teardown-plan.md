# Ordinary admission teardown implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** finish ordinary-session acceptance cleanup without protocol operations after Playwright stops.

**Architecture:** add one narrow optional callback to the existing owned browser lifecycle; bind the admission observer after construction. Execute it after final export and before browser.close, retaining the original coordinator, deadline and schema.

**Tech Stack:** Python3.11, asyncio, unittest fake page/manager/clock.

**Spec:** docs/superpowers/specs/2026-10-18-ordinary-admission-teardown-design.md

## Global Constraints

- Same total8s cleanup deadline, existing1s export cap,5s close cap and3s stop cap/reservation. No new deadlines, grace, retries or weakened gates.
- Final observation remains admission-monitored; detach failure fails cleanup independently of successful capture.
- Failed R5 is immutable and receives no qualification credit. Source-only tests use injected fakes; no native/network/service actions.
- Existing lifecycle schemas, API-only process evidence, business/native/visible/physical NOT_RUN, privacy and quality controls remain unchanged.
- Preserve four pre-existing dirty documents and node_modules symlink; root owns staging/commits/runtime.

### Task1: Integrate admission teardown with the owned cleanup coordinator

**Files:**
- Modify: scripts/ordinary_session_recovery.py
- Test: scripts/test_ordinary_session_recovery.py

**Interfaces:** consumes _AdmissionObservation.detach(), OwnedBrowserLifecycle.cleanup(export), existing lifecycle_stage and passive.cleanup_allowance. Produces one optional no-argument admission teardown callback on OwnedBrowserLifecycle, called exactly once during cleanup before browser close. Keep snapshot/record/CLI/result interfaces unchanged.

- [x] Step1: Extend the existing fake subscription page/manager so remove_listener raises after manager.stop, records request/response detach, and can inject a detach failure. Add an actual run regression driven by the existing full qualified fake300-second flow; assert export→both listener removals→close→stop, successful cleanup, ownedProcessExitEvidence=not-observed. Add failure/cancellation cases covering first-failure retention and one independent close/stop. Use existing test fixture methods instead of copying the whole qualified-run fixture.

```python
# Required assertions in the actual injected runner path:
self.assertLess(order.index('final-export'), order.index('detach-request'))
self.assertLess(order.index('detach-response'), order.index('browser-close'))
self.assertLess(order.index('browser-close'), order.index('manager-stop'))
self.assertEqual(summary['lifecycle']['ownedProcessExitEvidence'], 'not-observed')
```

- [x] Step2: Run only new covering cases on current source; retain the actual RED command/output. Failure must be the post-stop unsubscribe behavior or wrong ordering, not missing helper/fixture fields.
- [x] Step3: Implement the narrow callback after final export (even when export fails), capped using lifecycle_stage and remaining('export') on the existing deadline; record only cleanup failure through current fields; bind guard.detach when guard exists and remove outer post-stop detach. Independently close and stop in the same existing coordinator.

```python
# Intended bounded shape; reuse existing exception bookkeeping:
if self.detach_admission is not None:
    try:
        await lifecycle_stage(
            _await(self.detach_admission()), remaining('export'),
            settlement=min(.075, remaining('export') / 4))
    except BaseException:
        failed = True
```

- [x] Step4: Run covering cases GREEN, then affected suites once:

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B -m unittest scripts.test_ordinary_session_recovery scripts.test_ordinary_recovery_fault scripts.test_passive_session_soak
```

Retain commands, exit codes, counts, logs and elapsed times. Verify no raw error strings/schema fields, no changed admission authority, no duplicated cleanup or duration relaxation.
- [x] Step5: Worker writes report and exact file list; root reviews diff, stages only the two source/test paths and commits. Task review must independently approve spec and code quality from a diff package. Then dispatch final increment review on the most capable model; resolve findings before new operational context.

## Follow-up execution

After clean source review, root creates a fresh tool-only promotion/qualification context; existing deployed Viewer c802/build bb581 and existing Signal/Host identities remain unchanged. Exact source/tool bytes and previous failures must be pinned. No browser test or restart is performed by this plan. Archive task/review/execution evidence in the repository after source holds permit.
