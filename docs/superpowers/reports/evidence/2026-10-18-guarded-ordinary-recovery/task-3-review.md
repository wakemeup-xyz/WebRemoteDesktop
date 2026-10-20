## Spec Compliance

- ❌ Issues found: the new log primitive can restore complete coverage after a closed/missing interval, and the HTTP primitive's shared ownership slot is not safe across overlapping wrapper completion. Both conflict with fail-closed evidence/ownership requirements. See Important findings below.
- ✅ All four assigned paths are present in the one-commit diff, BASE `7181b7f55beab8a419e92c8e4de52185fd194781` through TIP `710cf04ebac03787c360fc342737e7f591456118`.
- ⚠️ Actual concurrent two-second sample/status ticks, final one-second export, manifest comparison, run classification, and runtime qualification belong to Task 4 and are not claimed here. Source/helper/SUP preservation was reported checked by the controller; this review did not independently recompute hashes. Live business input, visible effect, and physical evidence remain NOT_RUN.

## Strengths

- `signal-server/websocket/signaling.js:585`: expiry observation follows the existing identity-checked removal and is locally caught; the authority call remains single. The added handler tests exercise the registered 8000 ms callback, stale callback silence and throwing observation sink.
- `signal-server/websocket/signaling.js:542`: rebind epoch is observed only in the existing applied-ACK/renewal/grant path; ACK validation and operation order are unchanged in the diff.
- `scripts/ordinary_session_recovery.py:193`: bounded log reads, bounded lines/event accumulation, exact selected schemas, strict private identities, independent Host-disconnect selection, and expiry-bound reset projection provide conservative evidence. Unknown selected fields are not serialized.
- `scripts/ordinary_session_recovery.py:94`: Host replacement, offline/error/gap and disconnect states are sticky; changed status dominates later unavailable/stable observations. Tests preserve good Viewer fields while Host coverage remains incomplete.
- `scripts/ordinary_session_recovery.py:412`: wrapper allowlists and unchanged nested gate/diagnostic validators reject raw attempt/ID/error/URL additions. Missing sample is retained as null rather than fabricated metrics.

## Issues

### Critical (Must Fix)

- None found.

### Important (Should Fix)

1. `scripts/ordinary_session_recovery.py:162` (`ServerRecoveryEvidence.start`): start rejects an open/failed reader, but accepts a previously closed reader. It seeks the current EOF and unconditionally sets coverage to complete while retaining `_events`, `_last_time`, `_reset_epoch`, and possibly a prior `server-log-gap` reason. A concrete sequence is start → read a partial line → close (incomplete) → start: the same snapshot becomes complete again. Even a clean close followed by an appended Host-disconnect and restart silently excludes that interval while preserving the earlier selected timeline/reset binding. Make start one-shot (require `not-started`), and require a new evidence instance for a separate run; add focused tests proving both closed-complete and closed-incomplete instances cannot resume or clear evidence failure.

2. `scripts/ordinary_session_recovery.py:298` (`read_local_host_status`, ownership guard and finally): the request is awaited through the task passed to `lifecycle_stage`, but cleanup reads and clears the mutable global `_status_owner`. The guard admits another invocation as soon as the first child task is done, before its wrapper has necessarily resumed. A second invocation can replace the slot; the first finally can clear the second completed child, after which the second finally calls `.done()` on None, or can otherwise inspect the wrong owner. The existing overlap test only exercises a still-pending first child. Keep a local owned task reference and clear only if the slot still refers to it; preferably reserve the slot until the whole wrapper has settled. Add a deterministic scheduling test that starts a second invocation after the first child completes but before its outer waiter finishes, and assert fixed outcomes plus no ownership loss/raw AttributeError.

### Minor (Nice to Have)

- `scripts/ordinary_session_recovery.py:398` (`_validate_private_sample`, transport numeric loop): framesDecoded/framesDropped are validated as nullable general numbers up to 9999999999999, so fractional values are accepted even though they are counters. Separate duration/byte measurements from integer frame counters and explicitly align each bound with the shared counter contract. The existing test only checks ordinary integer values.

## Assessment

**Task quality:** Needs fixes.

**Reasoning:** The server change is minimal and the evidence privacy/bounds work is substantial, but a closed cursor must not regain continuous coverage, and an ownership primitive must not depend on a mutable slot after yielding. Neither issue requires expanding into the Task 4 runner.

## Checks and evidence

- Read the exact diff once, in two contiguous chunks; no tests rerun, Git commands, source/index changes, runtime requests, browser/native operations, services, build, network, npm or subagents.
- Read the task brief/global/shared contracts, implementation report and task-reviewer template. Accepted the controller's actual recorded results: Node RED 0/3; Python RED absent-module loader error (not individually executed behavioral failures); final Node 29/29; final Python 27/27, 2.519 seconds, exit 0. Expected fixture connection output is identified in the report and is not treated as a runtime check.
- Named risk: strict log schema might reject the actual producer. Focused checks: unchanged `emitControlEvent` at `signal-server/websocket/signaling.js:199`, reset producer at `:1285`, Host-disconnect producer at `:1975`, and `signal-server/lib/observability/logger.js:53` normalization. Their envelope/correlation shapes agree with the selected projection.
- Named risk: HTTP finally/cancellation might conflict with imported lifecycle ownership. Focused check: unchanged `scripts/passive_session_soak.py:780` confirms 0.75 is the total stage budget including 0.075 settlement, not a 0.675 total. The shared-slot completion issue above is in the new wrapper.
- Named risk: new exact wrapper might diverge from the unchanged private sampler. Focused checks: `scripts/passive_session_sampler.js:234` transport projection and `:368` sample return; `scripts/passive_session_soak.py:447`, `:559`, `:666` gate/private-row/diagnostic contracts. Field allowlists match; transport-counter typing remains the minor issue above.
- Review artifact only: `.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-3-review.md`.
