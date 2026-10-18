# Context for bounded process-observation diagnostics

2026-10-18. This is a diagnostic increment within the ongoing authorized stability acceptance. It does not change process ownership or acceptance semantics.

## Observed failure and scope

Both actual guarded baselines remain failed/incomplete. In the second, the immutable supervisor retained `observation-unavailable`; seven recorded owned identities exited without signals, while full process-tree exit remains UNKNOWN. Its 32 diagnostic events all describe one PID's resolution failing with NoSuchProcess; 291 later events were dropped. The proxy records exceptions before the Registry classifies them. The Registry repeatedly resolves exited entries in `state()`, where NoSuchProcess is an expected exited result, and also resolves processes inside the protected scan, where an error creates a sticky gap. The existing event shape cannot distinguish these sites. The specific scan-gap cause remains UNKNOWN.

Do not amend either old result, infer that all retained events came from state(), or excuse the gap as inherent polling uncertainty. The original scan also aborts remaining siblings on an error and can transiently skip an unknown state; modifying those semantics is a separate design, deferred until useful evidence exists.

## Selected design

Add a reusable pure injected module `scripts/process_observation_diagnostics.py`. It imports no psutil and performs no process discovery or action on import. It provides a proxy with the same process calls as the existing diagnostic proxy and an explicit wrapper subclass of an injected immutable Registry type. The wrapper enters bounded stack contexts for `state`, `scan`, and `signal`; each override delegates exactly once to its corresponding super method with identical arguments, return value and exception. A `note` override delegates once and observes the resulting fixed reason. Do not inspect Python stacks/tracebacks or copy/modify Registry logic.

The proxy never adds process-property or method reads. Child PID and birth remain unknown until the original code actually reads them. Existing ledger identity may be attached from in-memory entries, explicitly distinguished from an observation. The supported tuple is ordered `(NoSuchProcessClass, AccessDeniedClass, OSErrorClass)`; classify by these injected classes, never arbitrary exception-name strings. Supported delegated exceptions are rethrown by object identity. Diagnostic/context failure sets a sticky failed flag without replacing business exceptions or control flow. The outer existing diagnostics gate rejects this flag.

Expected `state / NoSuchProcess` resolutions aggregate in three fixed coarse-stage counters and do not consume the 32 exceptional-event slots. Unknown state errors, scan errors and signal errors retain bounded events. NoSuchProcess outside a state context is not assumed benign. Preserve role, coarse stage, explicit context, operation, actually known identity, exception class, numeric errno and monotonic/wall observations; no raw exception message, argv, environment or command line.

Each scan has a bounded monotonic sequence token. Only a delegated exception in that scan's direct context can create a pending event token; nested state exceptions cannot create or replace it. `note('observation-unavailable')` consumes that scan's pending token once. Missing links are explicit unassociated gap records, never nearest-timestamp guesses. Clear pending state on scan entry/exit. Restore context in finally, including reentrancy and exceptions. Preserve overflow and recorder failure visibly; inability to retain a coverage-causing diagnostic vetoes diagnostic completeness, never creates a pass.

Rejected alternatives: enlarging a single floodable pool only delays loss; suppressing every NoSuchProcess erases real scan gaps; accepting observation-unavailable changes the coverage contract; stack inspection adds fragile inference and incidental privacy/overhead risk. Explicit call context preserves the underlying Registry decisions.

## Global constraints

- Implement only `scripts/process_observation_diagnostics.py` and `scripts/test_process_observation_diagnostics.py`; root owns documents, staging, commits and all live operations.
- Keep the immutable supervisor, passive helper, passive sampler, ordinary runner and all existing coverage/no-signal/readiness/continuity gates unchanged.
- Preserve delegated process calls, ownership entries, signal targets, coverage reasons, return values and exception identity; add no process probes or discovery.
- Expected state-exit counters are fixed by stage; exceptional events and gap records each have at most 32 entries, context depth at most 8, integer counters saturate at 2147483647, and unknown identity remains null.
- Keep full process-tree exit UNKNOWN and preserve all old failed results/one-use markers. This increment cannot retroactively classify any old gap or make an otherwise rejected run pass.
- No raw exception text, argv, environment, password, token, input payload or coordinates may be retained.
- Run only pure injected offline tests; workers may not use real process APIs, browser, network, native input, service/status/build/install or runtime configuration operations.
- Preserve four pre-existing dirty documents, node_modules link, primary index, W2, tunnel/watch and prior evidence; quality/authority/retry/deadline policies remain unchanged.

## Verification and integration

Unit tests cover direct versus nested contexts, repeated expected exits beyond 32 followed by a scan error, exact once-consumed pending token, unassociated gaps, child identity remaining unknown, PID incarnation separation, exceptions by object identity, all wrapper delegates exactly once, context restoration on errors/reentrancy, invalid clocks/metadata, counter saturation, exceptional/gap overflow, privacy canaries and absence of process access on import. An independent fake base Registry verifies wrapper delegation; it must not be represented as parity proof of the real immutable Registry.

Before a real run, root's separately reviewed operational package must run a pure producer/consumer parity check against the actual hash-pinned immutable Registry, using fake process schedules and clocks. Compare original and instrumented process-call traces, entries, coverage, signals, return values and exception objects. Include known exit, scan resolve/child error, parent changes, unknown state, reuse and cleanup/result contexts. No actual process constructor may be used. Only then integrate this module into a distinct frozen package, pin its bytes and maintain the old diagnostic veto. A fresh guarded run may yield better evidence; it still rejects every unexplained coverage reason.
