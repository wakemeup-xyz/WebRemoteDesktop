- **Enforce event/gap capacity across reentrant clock callbacks, preserve pending tokens, and add regressions** — **ADDRESSED**. Event and gap slots are now appended before external metadata/clock callbacks (`scripts/process_observation_diagnostics.py:221`, `:268`), so reentry observes the reserved slot and uses the existing bounded drop/failure path. The direct-scan event token is committed before callbacks and never reset after them (`:224`), preserving a newer nested token or its invalidation when a newer event is dropped. The event/gap boundary tests check exact capacity, drops, overflow/failure and token behavior (`scripts/test_process_observation_diagnostics.py:462`, `:493`); the retained-newer-token regression checks linkage and business exception identity without overflow (`:523`).

### New Breakage in the Fix Diff

- None found. Reserved records have a finite nullable schema before callbacks; the nesting-aware recording flag is restored in finally (`scripts/process_observation_diagnostics.py:235`, `:275`). A reentrant snapshot sets sticky failure instead of claiming completeness (`:281`), and both pool variants test strict JSON safety, failure, final completion and snapshot detachment (`scripts/test_process_observation_diagnostics.py:553`).

### Out-of-Scope Observations

- None. Actual immutable Registry parity remains NOT RUN and is not established by these fake-base tests.

### Verdict

**Fix round:** All findings addressed, no new Critical/Important breakage.

**Checks performed:** Reviewed only the provided `2ccb4ce..35c6f97` fix package against the existing brief/finding, plus the appended implementation report and named evidence. The boundary RED log shows both original 33-versus-32 failures; the dedicated snapshot RED log shows both captured-failure assertions failing. The focused retained-token GREEN passes, and the final recorded full run reports all 29 tests passing in 0.077s with no additional noise. No tests, imports, git commands, external code checks, process/network/browser/service actions, or checkout/index mutations were performed; only this `/tmp` report was written.
