# Process-observation context implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve actionable scan-error diagnostics while expected exited-state resolutions remain visible as bounded counters.

**Architecture:** A pure injected process proxy and an explicit contextual subclass decorate the unchanged Registry. They preserve original calls and decisions and produce bounded diagnostic evidence for a separately reviewed operational package.

**Tech Stack:** Python standard library, contextlib, unittest, injected fake process/Registry/clock objects.

**Spec:** `docs/superpowers/specs/2026-10-18-process-observation-context-design.md`

## Global Constraints

- Implement only `scripts/process_observation_diagnostics.py` and `scripts/test_process_observation_diagnostics.py`; root owns documents, staging, commits and all live operations.
- Keep the immutable supervisor, passive helper, passive sampler, ordinary runner and all existing coverage/no-signal/readiness/continuity gates unchanged.
- Preserve delegated process calls, ownership entries, signal targets, coverage reasons, return values and exception identity; add no process probes or discovery.
- Expected state-exit counters are fixed by stage; exceptional events and gap records each have at most 32 entries, context depth at most 8, integer counters saturate at 2147483647, and unknown identity remains null.
- Keep full process-tree exit UNKNOWN and preserve all old failed results/one-use markers. This increment cannot retroactively classify any old gap or make an otherwise rejected run pass.
- No raw exception text, argv, environment, password, token, input payload or coordinates may be retained.
- Run only pure injected offline tests; workers may not use real process APIs, browser, network, native input, service/status/build/install or runtime configuration operations.
- Preserve four pre-existing dirty documents, node_modules link, primary index, W2, tunnel/watch and prior evidence; quality/authority/retry/deadline policies remain unchanged.

---

### Task 1: Pure context-aware diagnostics and delegation wrapper

**Files:** Create `scripts/process_observation_diagnostics.py` and `scripts/test_process_observation_diagnostics.py`.

**Interfaces:**
- `Diagnostics(factory, supported, role, *, monotonic, wall, limit=32)`: injected factory, ordered `(NoSuchProcessClass, AccessDeniedClass, OSErrorClass)` tuple, worker/sample role, existing three stages worker-loop/cleanup/result. Classify with the injected classes, never arbitrary exception-name strings. Supplies `process(pid)`, `set_stage(stage)`, sticky `failed`, and a detached JSON-safe bounded `snapshot()`.
- `instrument_registry(registry_type, diagnostic)`: return an instance of a generated subclass constructed with `process=diagnostic.process`. Inherited Registry initialization/logic stays unchanged; override state/scan/signal/note only for explicit context and exact single super delegation. Do not replace immutable globals.
- Proxy supports only existing reads/calls: pid, create_time, status, children(recursive=False), ppid, terminate, kill. Reading pid is delegated only when the original Registry reads it. Successful create_time may cache the returned birth; no additional observation.
- Snapshot uses schemaVersion2, explicit diagnostic-only scope, existing `events`, `dropped`, `failed`, expected-state-exit fixed stage counters, and bounded gap records linked by scan/event sequence or explicitly unassociated. Root integrates the exact validated shape later; no acceptance gate is replaced.

- [ ] **Step 1: Add failing pure tests.** Use fake exceptions and a small delegating fake base Registry, not a copied full Registry. Verify no factory calls from import/construction; exact method/call/return trace and exception object identity. A concrete core regression is:

```python
for _ in range(40):
    registry.state(known_pid)  # fake factory raises the same NoSuchProcess instance
registry.scan()              # fake base catches a direct scan exception and notes a gap
snapshot = diagnostic.snapshot()
assert sum(snapshot['expectedStateExitCounts'].values()) == 40
assert snapshot['events'][-1]['context'] == 'scan'
assert snapshot['gaps'][-1]['eventId'] == snapshot['events'][-1]['eventId']
```

Also add nested state-inside-scan exclusion, pending token consumed once, no-token gap unassociated, context restoration/reentrancy, unknown child PID, PID birth separation, invalid clocks/metadata, no raw canaries, bounded overflow and saturation. Fake supported exceptions carry sensitive message canaries to ensure only class/errno persist.

- [ ] **Step 2: Run RED.** `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B -m unittest discover -s scripts -p test_process_observation_diagnostics.py -v`. Preserve actual command/output/exit before module implementation; expected failure is absent implementation/API.

- [ ] **Step 3: Implement the injected module.** Use a contextmanager with finally restoration and a generated subclass. The essential delegation pattern is:

```python
def state(self, pid):
    with diagnostic.context('state', registry=self, pid=pid):
        return super().state(pid)
```

Use equivalent scan/signal scopes, and delegate note exactly once before diagnostic linkage. The recorder catches its own failures, sets failed, and never raises a substitute exception into Registry. Classify expected NoSuchProcess only in an explicit state context, never by exception text or temporal proximity. The pending scan-error token is created only in direct scan context and consumed exactly once by the matching observation-unavailable note. All existing business exceptions and Registry coverage remain unchanged.

- [ ] **Step 4: Run GREEN and inspect limits.** Re-run the exact pure suite once; preserve count/exit/log. Test serialized snapshot size under full bounded pools and all overflow flags; don't expand existing operational file caps. Read own exact two-file diff and ensure no psutil import/extra access/discovery or raw exception formatting. Do not run unrelated suites.

- [ ] **Step 5: Report and review.** Write detailed report in this plan's SDD workspace with actual RED/GREEN, scope, APIs/schema, remaining real-Registry parity requirement and self-review. No staging/commits by worker. Root commits exact paths and obtains fresh task and most-capable final increment reviews.

Root's next operational task must pin and test this exact module against the real immutable Registry using injected schedules before any fresh live attempt. It then prepares new product assets, a new source/deployment record and a new one-use scenario chain. No prior failed marker is reused and no prior result is upgraded.
