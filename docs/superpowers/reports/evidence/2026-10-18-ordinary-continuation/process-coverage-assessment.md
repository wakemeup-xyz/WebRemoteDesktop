# Second actual baseline: process coverage assessment — 2026-10-18

## Result and scope

The second actual baseline remains **failed-or-indeterminate**. Seven recorded owned identities ended `exited`, with zero signals, while the worker registry retained `observation-unavailable`. Complete process-tree exit remains **UNKNOWN**. These observations neither prove a surviving leak nor establish that all descendants were seen.

The new diagnostics identify a concrete telemetry design problem: the same 32-event pool records normal liveness-resolution exceptions and actual scan failures. Repeated checks of an already exited registry entry can exhaust it. In this run all 32 retained events concern PID 69338; 291 later events were dropped. The events do not include a Registry call-site/context, so the exact exception that caused `observation-unavailable` is still **UNKNOWN**. It would be incorrect to reclassify this completed run as an ordinary child-exit race or a pass.

This is a read-only assessment of existing source and artifacts. No project import, test, process API, service/status operation, network/browser operation, source edit, or old marker/result change was performed. Only this report was written.

## Evidence and bindings

Package root:

`/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-tool-only-continuation-private-r2-lahn2zqn`

Actual attempt, relative to that root:

`sequence-f3664a3798df872c83b9c1bc141da48d/attempts/b6eca7ff6a6c2a17b39275c128867c50/`

Examined `qualification-started.json`, `qualification-result.json`, the package's `diagnostics.py`, `ordinary-continuation-supervisor.py`, `core.py`, `continuation_common.py`, and injected test definitions. Also examined the prior `/tmp/wrd-actual-baseline-cleanup-coverage-assessment-20261018.md` and immutable `/tmp/wrd-owned-turn-probe-private/supervisor.py`.

SHA-256 bindings:

| Artifact | SHA-256 |
|---|---|
| Actual qualification result | `af76a8dbeb32083ec9f8c630d7138362b3cd45d0f60ad16ad75d1a95fa025cd6` |
| Immutable supervisor | `d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b` |
| R2 diagnostics.py | `2ac4d430f5499e11f65b8e51470017d52185e2d2d434f5fb11958db1641c7e17` |
| R2 ordinary-continuation-supervisor.py | `81228b5d4f664fbb9504b592813010773913fddb3ffc1aaa9f68240d6ec952f9` |
| R2 continuation_common.py | `4ae3a613875e79bf0b4358ff4359207b69b30acafa7f31170db00ea9d649d544` |

The package binds actual product source `dfb15434e79da90b803b763c533836e16c080c71` separately from corrective tool source `59bca14209eed299b0e94da58decb8b85e5ce70c`. `core.py:166–170` checks the immutable supervisor's bytes before loading it. No modified original Registry was used.

## Exact observer control flow

In the immutable supervisor:

1. `Registry.scan():52` starts a queue containing **every registered PID**, including exited entries. Entries are not removed.
2. Before the inner scan `try`, `scan():57` calls `state(pid)` and skips anything other than `alive`.
3. `state():42–49` resolves the PID, verifies birth, and reads status. `NoSuchProcess` becomes `exited`. `AccessDenied`/`OSError` becomes `unknown`.
4. For an apparently alive identity, `scan():58–70` resolves the parent again and obtains direct children. It reads each child's birth and parent, rechecks both authority endpoints, and calls `_add()` before queuing the child.
5. A `NoSuchProcess`, `AccessDenied`, or `OSError` anywhere in that protected block adds the sticky reason `observation-unavailable`. The handler is **outside the entire child loop**, so a failing child also aborts observation of the remaining returned siblings for that parent in that scan.
6. A child whose parent ceases to be alive or whose parent PID changes records `parent-chain-unavailable` or `parent-chain-changed` (`62–67`). These are separately unexpected coverage.
7. Cleanup repeatedly performs the same scans during grace/TERM/KILL waits (`89–99`). `result():101` performs another `state()` call on every retained identity. Thus ordinary absence resolutions continue during worker observation, cleanup, and result construction.

The R2 proxy is intentionally call-equivalent rather than context-aware:

- `diagnostics.py:30–33` logs every supported exception from the injected process factory as `operation: resolve`, with `birthEpoch: null`, and rethrows the same exception.
- `ProcessProxy._call():42–48` logs delegated method exceptions and rethrows them. It has no knowledge whether a call is a benign `state()` liveness check, an ownership-edge check, a scan failure, or a signal operation.
- `Diagnostics.record():19` counts every further event as dropped once 32 events have been appended. There is no separate reserve for coverage-causing exceptions, deduplication, or aggregate per-site counter.
- `ordinary-continuation-supervisor.py:79–84` scans both registries every loop; lines `87–104` assign the coarse `cleanup` and `result` stages. `stage` identifies the broad supervisor phase, not the Registry call-site.

This explains how a stable, already exited renderer entry can pollute diagnostics without being an error: `state()` intentionally consumes its `NoSuchProcess`, while the proxy has already appended an event. The same `resolve` event shape can also originate from the second resolution inside the protected scan. Therefore the retained event shape alone does **not** identify which resolution reached the coverage catch.

## What this actual run recorded

- All 32 retained worker events are `worker-loop / resolve / NoSuchProcess / pid 69338 / birthEpoch null / errno null`.
- First event: diagnostic monotonic offset `8.169061877997592`, wall epoch `1792327095.5184278`.
- Last retained event: offset `19.104874794837087`, wall epoch `1792327106.454457`.
- Diagnostics report `dropped: 291`, `failed: false`. `failed: false` means the bounded diagnostic recorder did not itself fail; it does not mean complete exception coverage or healthy scanning.
- PID 69338 is a registered child of 69333, with birth `1792327091.991729`, first registered at `1792327092.322709`, last registered at `1792327095.480692`, and final status `exited`. This known ledger birth exists even though the process-factory event shape has `birthEpoch: null`.
- All seven worker identities end `exited`; `signals` is empty. No Host sample was triggered; its registry is empty and has no unexpected reason. An empty registry adds no browser-tree coverage.
- Worker exit is 1, supervisor `errorClass` is `RuntimeError`, and timeout is false. Fifty rows were consumed before the sticky observation failure. The terminal classification is `failed-or-indeterminate`.
- The new validation-stage evidence establishes `rows: passed`, then `worker: failed`. `coverage`, `signals`, `diagnostics`, final source/runtime integrity, sticky observation and terminal evidence are **not-evaluated**. The final exception is not proof that the coverage gate ran. Nevertheless the retained unexpected coverage would independently reject this result under the unchanged gate.
- `fullProcessTreeExit: unknown` and `completeProcessTreeExitEstablished: false` are retained. Neither successful browser/manager close nor seven final absent identities upgrades them.

The exact operation, phase, identity, exception class and errno responsible for `observation-unavailable` cannot be recovered from this artifact. Possible causes still include a disappearing parent or child, access denial, or another OS error. The actual result also does not prove a connection, transport, Host, or machine-load cause for this coverage gap.

## Additional static limitations that the prospective design must address

### Transient `state() == unknown` is not sticky coverage today

At immutable `state():49`, AccessDenied/OSError returns `unknown`; `scan():57` simply skips that identity before entering its coverage catch. If the condition disappears before later signaling/result observation, it need never add any unexpected coverage. R2 logs a diagnostic event, but its validation only tests `not diagnostic.failed` (`ordinary-continuation-supervisor.py:112`), rather than treating a recorded access/error event as a coverage failure. This is a static blind spot, **not evidence that it occurred in this run**.

### A normal exiting child can abort sibling discovery

Moving `observation-unavailable` to an allowed set or swallowing every NoSuchProcess would hide that the original scan abandoned the remaining siblings. A prospective classifier must first isolate errors per child and keep processing remaining children under freshly verified parent authority. A known child's exit must never grant ownership to itself, a PID replacement, its unobserved descendants, or its siblings.

## Recommended prospective architecture

Use two explicit reviewable increments. Leave the immutable supervisor and both completed packages/results unchanged. A new package and fresh one-use sequence must pin whichever new derivative is reviewed.

### Increment A: make diagnostics useful without changing any acceptance outcome

Retain the original Registry implementation and all current gate definitions. Add a narrow context-aware subclass/wrapper around calls to `state()`, `scan()`, and `signal()`; context must be stack-based and restored in `finally`, so nested state checks remain distinguishable. It may attach known ledger PID/birth and a monotonic scan sequence **from existing in-memory data**, without any additional process probe.

The minimum implementation is an explicitly constructed `ContextRegistry(immutable.Registry)`, injected with the existing diagnostic object. Its overrides only enter a fixed context and call the corresponding `super()` method once with unchanged arguments/return/exception. `scan()` opens a new scan token; `state(pid)` temporarily opens a nested `state` context carrying only `entries[pid]`'s already stored PID/birth; `signal(kind)` opens a fixed signal context. The existing coarse supervisor phase remains a separate field. A `note(reason)` override can attach a gap token before/after delegating the exact same `super().note(reason)` call. Do not replace the immutable class, monkeypatch its globals, copy/modify its scan, introspect live process objects for metadata, or change method control flow in this increment.

Linking the gap needs an explicit one-consumer token protocol: reset pending scan-error state when a scan begins; only an exception recorded in the active **scan** context creates a pending token; a nested **state** exception cannot create or replace it; `note('observation-unavailable')` consumes that scan's pending token exactly once. After consumption it cannot be reused by another parent iteration. If a supported error arose from an unwrapped property/operation, record `scan-gap-without-delegated-event` rather than attributing a stale event. Diagnostic-link failures must preserve the original exception/coverage behavior and must never create a pass. The recorder must not raise a substitute exception from context enter/exit or note-link handling.

Use these explicit wrappers rather than `inspect.stack()`, `sys._getframe()`, traceback inspection, or matching function/line-name strings in the proxy. Stack inspection would add implementation coupling, allocation/observer overhead, privacy exposure through incidental frames/locals, and fragile classification if code moves. It also does not by itself prove a particular caught exception reached `Registry.note()`. Explicit context is bounded, pure, testable, and can preserve the original process-call trace exactly. If the root chooses the smallest telemetry-only increment now, defer the entire semantic derivative below until an actual scan-error token provides concrete evidence.

- Aggregate expected `state / NoSuchProcess` events separately by already registered PID/birth and phase. Keep bounded counts, first/last times, and final state; do not consume the exceptional-scan event pool for repeated expected absence.
- Maintain a separate bounded reserve for `scan`/ownership/unknown-state/signal exceptions. Store fixed operation and context enums, known parent and child identities where actually established, exception class, numeric errno, first/last time, occurrence count, and overflow status. A missing child identity remains null; it must not be invented from a PID lookup or cached unrelated object.
- Record a fixed marker when `Registry.note('observation-unavailable')` is reached, linked to the immediately active exception-context token. Never infer that link later from equal timestamps or the most recent unrelated event.
- If an exact child identity cannot be obtained with the original calls, retain that limitation. Merely wrapping `scan()` cannot expose its local `child` variable. Adding a new child PID-property read or exact-known-identity verification is a separate, explicit derivative change requiring review and call-trace tests.
- Keep overflow visible. Deduplication must not silently collapse identities, PID incarnations, operations, exception classes, errno, or relevant stages. Failure to retain/validate a coverage-causing event must veto diagnostic completeness; routine expected-exit aggregation may have an explicit saturated count without claiming a full event history.
- Do not suppress exceptions, change ownership, change signals, remove sticky reasons, or add `observation-unavailable` to `INHERENT`. This increment improves the next diagnosis; it does not make an otherwise rejected run pass.

### Increment B: a separately specified fail-closed scan with a narrow exit-race category

A versioned Registry derivative can distinguish **some** proven child exit races prospectively. It cannot classify every NoSuchProcess safely and cannot do so from these old artifacts. This is a semantic coverage-contract change, so it must be designed, pinned and independently reviewed openly; it must not masquerade as a proxy-only patch.

The narrow admissible case should require all of the following, established within the same scan:

1. The parent is an existing owned identity; the direct-child list was successfully obtained under the original parent PID/birth checks.
2. The child is already a registered owned identity, and its current birth was successfully read and matches that ledger identity before the failing call. An unknown child, missing birth, stale PID-only match, or mismatched birth is ineligible.
3. The exact failing child operation and identity are known; the exception is specifically NoSuchProcess. AccessDenied, general OSError, parent enumeration/resolution failure, or a parent authority change remains unexpected. Do not use exception text or only a type-name string as proof.
4. A bounded verification, if required by the design, addresses only that already known PID/birth. It never enumerates replacements, guesses ownership, reads argv/environment, or signals. Missing/ambiguous verification remains unexpected. PID reuse must never attach the replacement to the old ledger.
5. The branch records a permanent `verified-owned-child-exit-during-scan` event with the successful birth observation, precise failed operation and exit evidence; it does not register a new identity or retry it as a new process.
6. The scanner continues the other returned siblings, retaining all original per-edge parent/child rechecks. Failure to complete required sibling/parent observation, event capacity exhaustion, or any additional unclassified error remains sticky unexpected coverage.

The existing inherent limitation that polling may miss fast orphaned descendants must remain explicit, and full process-tree exit must remain UNKNOWN. A verified recorded child's exit is only a recorded-identity fact. It is not evidence that the child had no unseen descendants.

The output should retain both a raw event ledger and a fixed, schema-versioned classification. Acceptance must require every observed gap either to satisfy the exact new proof predicate or to fail; it must not delete reasons after the run, clear the original Registry's coverage array, treat an unclassified event as benign, or grandfather old failures. Existing worker, row, source/runtime, no-signal, lifecycle and terminal gates remain mandatory. If maintaining the existing literal coverage contract is a hard requirement, stop after Increment A and continue rejecting all scan gaps; accepting a new category requires explicit review of that contract change.

Also make every transient `state() == unknown` a sticky unexpected observation in the new derivative. This strengthens the current blind spot instead of permitting an access failure to disappear before final checks.

## Proposed pure tests before any new live attempt

No tests were executed for this assessment. The implementation should use fake process objects/clocks and reject real process constructors/discovery/signals by default.

For Increment A:

- Preserve original and instrumented call traces, ownership entries, exceptions **by object identity**, signals and coverage across existing success/error schedules.
- Repeated known exited-state resolution, including more than 32 checks, must leave reserve for a later actual scan error. Distinguish both `resolve` call-sites deterministically rather than guessing from PID.
- Correctly restore nested state/scan/signal context after success, exception, re-entrant calls and recorder failure.
- Cover factory resolution, child method, parent method, cleanup and result events. Retain exact known birth from ledger without extra process access; never synthesize an unknown child's identity.
- Verify deduplication keys, count/clock bounds, reserved-capacity overflow and redaction. Overflow or recorder failure must never produce a qualification pass.
- Confirm all old one-use markers, source/manifest pins, strict coverage and no-signal gates remain unchanged.

For Increment B, in addition:

- A previously registered child with matching current birth exits at each eligible read; siblings are still inspected and authority checks remain identical before every new edge.
- Reject unknown child before first birth, unknown child after first birth but without prior ownership, mismatched birth, PID reuse, parent exit/reuse, changed PPID, failed enumeration, unrelated NoSuchProcess, AccessDenied, OSError, and ambiguous/saturated verification.
- One classified child exit followed by any unknown state, sibling failure, parent failure, event overflow or unclassified exception must fail the entire coverage condition.
- A transient state AccessDenied/OSError followed by a healthy/finally-exited identity remains a sticky failure.
- Never gain authority through a vanished ancestor, register a replacement, broaden signal targets, clear old failures, or assert a complete tree. Verify cleanup still observes only exact owned identities and any signal attempt remains disqualifying for passive qualification.
- Run a full producer/consumer test on the new versioned schema and unchanged remaining gates. Keep every prior failed result rejected as a negative fixture.

Only after independent review should a separately prepared actual attempt run. A cleaner new run cannot retroactively repair either completed baseline. Fixing this observer also does not qualify remote-control reliability, transport/input latency, native visible effect, or physical display latency.
