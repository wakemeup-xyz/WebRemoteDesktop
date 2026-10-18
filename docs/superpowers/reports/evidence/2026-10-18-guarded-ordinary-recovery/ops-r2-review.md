# Findings

## P1 — Terminal acceptance can certify malformed or contradictory qualification evidence

File: `ordinary-supervisor.py:87-106`, with row acceptance at `24-39` and final classification at `174-180`.

`completed_result()` checks the outer summary keys but does not validate several nested contracts it relies on. `fault.capability` and `fault.status` are never validated; recovery can therefore have `capability="unavailable"` or `status="failed"` and still be certified when the other selected fields say PASS. A recovery run's `continuity` value is not inspected at all, so even a recovery summary rewriting interrupted continuity to PASS is accepted. `lifecycle.diagnostics` is not validated and `lifecycle.python` is checked only for one `cleanupStatus` string: missing stage records, extra keys or contradictory stage failures do not reject completion. Python equality also permits bool values in several integer fields (`schemaVersion`, trigger counts, and the startup projection). The sample validator likewise accepts a null sample without latching an evidence failure, and only checks a small subset of an otherwise arbitrary sample dictionary.

These are direct holes in this package's claimed exact R2 evidence gate, independent of the fact that the final runner has not been delivered. A buggy producer can exit zero and supply contradictory evidence which this wrapper labels `observed-qualification-completed`, allowing the next scenario. The committed spec expressly requires exact nested schemas, bool rejection, no continuity PASS rewrite for induced recovery, validated existing diagnostic/Python lifecycle records, and missing observation to terminate qualification. The future source gate is necessary but does not make these implemented acceptance predicates correct.

Fix: validate the complete nested R2 and inherited diagnostic/lifecycle schemas before completion, including type-strict counters and coherent terminal fault state; require induced recovery to retain interrupted continuity. Latch malformed/missing observations and illegal phase transitions, and forbid completion after such an observation even if a terminal summary says PASS. Reuse precisely pinned pure validators where appropriate without modifying the original helper. Integrate the final runner against these predicates in the later source gate.

## P2 — A baseline row can start or continue Host sampling inside the intentional outage

File: `ordinary-supervisor.py:130-143` and `149-150`.

`consume()` permits sampling using the phase of each queued historical row. It does not establish the runner's current phase before `start_sample()`, and the spawned three-second sample is not coordinated with the runner's subsequent fault. A final baseline row with callbacks > 0, stable active media and frame age 2500 ms satisfies this trigger. That value is below the unchanged helper's 5000 ms continuity stall threshold, so it need not prevent baseline completion. The runner can then enter fault/recovering before the supervisor consumes the row, or while an already-started sample is still running. Multiple rows in one read make the problem more direct: the baseline row is processed before a later fault row in the same batch. The wrapper nevertheless records `no expected-outage sampling`.

This can perturb Host during the recovery stimulus even with a correctly implemented runner, contrary to the binding no-expected-outage sampling constraint. Checking only the historical row phase prevents outage rows from triggering; it does not prevent sampling during the outage.

Fix: provide a reviewed ownership/phase handoff that prevents fault entry while an eligible sample is active and retires all pre-fault trigger eligibility before fault, or explicitly narrow sampling to phases/scenarios that cannot overlap an induced fault. Merely reading the latest row or adding a short freshness threshold leaves the check-to-start and sample-duration race. Any interface addition belongs in the required final runner integration review; do not silently assume the absent runner supplies it.

## P2 — Managed-service exclusion breaks the pinned Registry's queue invariant

File: `operational_common.py:138-147`; inherited `/tmp/wrd-owned-turn-probe-private/supervisor.py:50-70`, especially lines 68-69 and `state()` lines 42-49.

`HelperRegistry._add()` returns without creating an entry for a managed Host/Signal/overlay child (and for an observation-unavailable child). The unchanged base `Registry.scan()` always queues that child's PID after `_add()` returns. On dequeuing a still-live excluded child, `state(pid)` evaluates `self.entries[pid]['birth']` and raises KeyError. The helper exception handler then invokes cleanup, whose first observation scan can hit the same unregistered child and fail before settling the registered helper identities. Thus the explicitly advertised exclusion path converts a normal exclusion into a failed helper/cleanup result and may leave registered work unsettled.

The actual current helper uses launchctl and normally launches services outside its descendant tree; this finding is conditional, not a claim that current services were discovered or signaled. Nevertheless, the defensive branch supplied by this package is incompatible with the exact inherited Registry and cannot fulfill its stated contract when exercised.

Fix: in this new derivative only, make scanning enqueue/traverse exclusively identities actually registered and eligible for ownership, or otherwise implement an exclusion-aware scan/state contract with no signal authority over excluded identities. Preserve the original SUP bytes. Verify that excluded live services, unavailable child observations and registered helper descendants can coexist without KeyError and without preventing bounded owned-child cleanup.

# Verdict and scope

Changes requested for the full operational package. Do not turn this review into an execution approval receipt for the present bytes. The previous prep R1 review is not full wrapper approval. This verdict is static and identifies no observed runtime incident.

The final reviewed source TIP/receipt, actual asset template review, execution receipt, fresh runtime manifest and final runner are intentionally absent. Their absence is a declared future input gate, not itself a finding. The later final source/CLI/schema integration review remains mandatory. No candidate TIP, receipt or runtime evidence was invented.

All ten executable source files were read in full: `prep_common.py`, `operational_common.py`, `freeze-reviewed-combined-preparation.py`, `build-private-two-time-template.py`, `private-builder-entry.js`, `apply-reviewed-combined.py`, `restart-reviewed-combined-local.py`, `check-reviewed-combined-readiness.py`, `sync-reviewed-terminal-docs-only.py`, and `ordinary-supervisor.py`. All nine Python files independently passed `ast.parse`; the JavaScript was statically inspected. This was not a rerun of the author's static-check script.

The source/application/build/reload/readiness/docs flows were traced together. Their principal guards, apart from the findings above, retain the frozen 915 regular-file union, HEAD/index pins, eight exact exceptions, baseline modes including Host0700, old14 assets before restart, explicit private-child022 prediction and exact startup file/directory modes, bounded two-time window, exact timestamp templating, one-use markers, per-file publication, both reload/readiness bindings for docs, and narrow sole-observation-unavailable reconciliation. Normal health or helper exit zero alone does not promote lifecycle completion. Root-attested source identity is not a direct measurement of loaded runtime code. Full process-tree exit remains unknown.

Read the webremote-service SKILL and rules, relevant README/runbook startup contracts, actual `wrd_service.py`, `restart-host.sh`, `lib-host-launchctl.sh`, `lib-safe-wrd.sh`, `run-host-launchctl.sh`, the Host plist, original Registry/SampleObservation, inherited passive continuity/privacy validators, and the production builder publication/retention implementation. The helper actually restarts Signal via launchctl submit and Host via restart-host.sh/launchctl; the wrapper does not need or receive tunnel authority. This review did not inspect private runtime configuration or credentials.

The committed specification was read from the reliability-latency source worktree, where its SHA256 is `09e7fb03127b2a6e3c6397738582ce11abb046e81fe09f6fff4df4ae1c1ab833`. The corresponding plan and root's explicit preservation/mode rulings were used. The specification is intentionally absent from the primary checkout. Primary remains the historical baseline for this review, not a newly inspected live status assertion.

# Independent integrity evidence

Package: `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-combined-recovery-operations-private-r2-hxynckto`.

Before code review, independently hashed SHA256SUMS.json and every one of its 21 listed files. All matched; the package directory had no unlisted item other than SHA256SUMS.json. Manifest SHA256: `f9aae6e170e60f988afc97e525e12a5c5db56db867bbf175745008abae701c69`. Focused diff SHA256: `05e65d70a8574fdc28e1b1c05c0237dd832c396349f00c31e344e960d9fcf1cd`.

Baseline manifest SHA256: `6c9958c52d3a64856243b669478b56fb6b4d20bb4832b6872562c3720caea8c4`. Independently counted its 915 regular entries and 14 dist entries; recorded category counts are 629 indexed and 286 BASE-unindexed. Its HEAD/index are exactly `b6bd0c11fd6055923768ac9f8d457995ac24cde0` / `73b61eb5c361d2b72ac2db66a302b533bea9014b0d345dcafabd57c9075e98c8`. This is manifest verification, not a new primary/index scan.

Inherited files independently hashed while reading:

- Original SUP: `d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b`.
- Original passive helper: `b0a15095651c9147eb451b27eb815ec4ea4cc984f2d293d3617c4cee89a15426`.
- Original passive sampler: `f862b739cbe7eb543ccab304203c71c62a43014530fa2da9a7655cba293665d3`.
- Primary service helper: `a7d80bbf841c1bd03663d8fa7b3a71e0861786ebf0385f55312d0d1a81b6eb04`.
- Host restart script: `a8af0986c6cb8f5e724eeecf72d97f88d28e5c92add756d2d429cca80fe03c87`.
- Existing builder: `f43e5530802252f9b722a215f041c051440b47d0aee39a002656d1f1247ec60a`.

Performed only static file reads/searches, independent hashes, Python AST parsing and this new report write. No package import/function execution, mocks, tests, build, helper/status, process inspection, browser/network/native/service/proof/tunnel actions, index access/mutation, repository writes, dependency traversal, or subagents occurred. No all-clear on deployment, availability, actual assets, recovery or continuity is claimed.
