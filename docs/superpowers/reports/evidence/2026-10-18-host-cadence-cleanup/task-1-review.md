# Task 1 independent review

## Findings first

### Important — R1: cadence bookkeeping is charged to the original grab wall time but excluded from grab CPU time

`python-host/host.py:1484` records `grab_started_ns`, then `host.py:1491` executes `CaptureCadenceObserver.start`, and only `host.py:1494` records `cpu_started_ns`. `capture_cadence.py:145-179` closes the preceding cycle, including `_admit` at `capture_cadence.py:126-140`, which scans up to 59 history buckets for each of ten stages and constructs immutable aggregates. This is real new capture-thread CPU work within the original wall measurement and outside its CPU measurement. The unchanged `runtime_observability.py:98-104` computes non-CPU time as raw wall duration minus measured thread CPU, so it classifies that observer CPU as non-CPU. `capture_cadence.py:164` also labels the same added bookkeeping as `grab` because it subtracts the same start timestamp from grab completion. This violates this task's requirement to preserve the existing grab wall/CPU observation boundaries and the cadence definition that attributes instrumentation/inter-stage work to `other`.

Concrete deterministic reproduction to add as a focused pure AST test: make `cadence.start` advance both a fake monotonic clock and fake thread CPU clock by 7ms, then make the native-grab fake advance both by 10ms. The current call order reports original grab wall 17ms, grab CPU 10ms, and non-CPU 7ms; cadence reports grab 17ms. The true native-grab work is 10ms wall/10ms CPU, and the additional 7ms is instrumentation. This follows directly from the source; no slow native operation, failing clock, malformed object, or scheduling assumption is required. Existing `test_capture_observation.py:582` and `:641` cover interval math and exceptions but use clocks that do not advance for observer bookkeeping and therefore do not detect this distortion.

Move observer bookkeeping outside the original paired grab wall/CPU span and account for it in the appropriate cadence interval component. Preserve the original elapsed endpoint, floating >1ms sleep policy, and retry policy. Add the focused fake-wall/fake-CPU regression so the repaired arrangement verifies both old grab observations and the new paired cadence decomposition.

### Critical

None found in the Task 1 scope.

### Deferred Minor — exception-path timestamp initialization

`python-host/host.py:1519-1522` sets `captured=True` before assigning `publish_exited_ns`; `host.py:1529-1538` assumes that timestamp exists while handling a subsequent exception. With the actual built-in dict and capture lock, the normal production path from `captured=True` to the assignment is only bounded dictionary eviction and a fail-open timestamp read. A focused search of `_capture_bounds_ns` accesses showed clearing under the same capture lock (`host.py:1573-1575`, `:1619-1621`); no ordinary concurrent eviction exception was established. It would require an exceptional allocation failure or a substituted failing mapping to demonstrate the unbound local in this code. Do not elevate this to a production-blocking finding on hypothetical bad objects. Initializing optional publication timestamps to `None` would cheaply make the error path more robust; defer as minor if it is not naturally addressed by the timing repair.

## Spec compliance

**Verdict: Issues found — R1 must be fixed before Task 1 approval.**

- Fixed 60 completion buckets, immutable publication and lock-free single-read snapshot are present in `capture_cadence.py:94-143` and `:235-278`; bounded history filtering avoids catch-up loops after large jumps.
- Paired cycle closure, matching generations, endpoint/subset validation, whole-record rejection and cap handling are present in `capture_cadence.py:145-209`. The stage decomposition is internally paired, and maximum interval uses one whole record rather than independently mixed stage maxima (`:137-142`, `:260-264`). R1 concerns where actual production instrumentation falls within that otherwise consistent decomposition.
- Fresh nested snapshots, unavailable/null measurements, count/sum/max statistics and rate derived from covered nanoseconds are present in `capture_cadence.py:76-87`, `:235-278`. No P95 or claim that the rate measures native-input latency or fresh content was introduced (`:1-6`).
- Capture trace/cache/cadence fields and host reference now precede thread start (`host.py:1387-1424`); the immediate fake Thread.start test exercises the extracted real constructor and loop (`test_capture_observation.py:485-539`).
- Optional observer exceptions are isolated (`host.py:1440-1463`, `:1491-1508`); grab success remains separate from publication/trace failure (`:1505-1541`), and the original elapsed endpoint, >1ms comparison and 5ms retry remain (`:1541-1558`). This does not resolve the measurement distortion in R1.
- The pure `CaptureObservation` implementation remains unchanged; only its unavailable wrapper gains the cadence child (`runtime_observability.py:43-52`), and the track wrapper adds that child with an unavailable fallback (`host.py:1631-1654`).
- Task 2 resource ownership, late-publication stop/generation guards and Task 3 peer-cleanup reporting are intentionally absent. The existing stop-inside-grab publication behavior is preserved by the immediate-start test (`test_capture_observation.py:502-507`, `:533-539`); that preservation is not a Task 1 finding.

## Strengths

- The pure observer is separate from the Host/native code, uses immutable NamedTuples throughout its publication, and exposes only fixed scalar shapes (`capture_cadence.py:34-87`).
- Tests check actual numeric endpoints, one paired max, generation breaks, malformed input exclusion, expiry, caps and copied output (`test_capture_cadence.py:25-282`). The mutation and publication-switching tests specifically exercise the public snapshot contract.
- The extracted-loop tests retain both exact .001 and float-near-.001 pacing behavior (`test_capture_observation.py:597-617`), and retain successful native-grab accounting when later publication/trace work fails (`:619-633`).

## Verification and scope

- Reviewed BASE `d3bdf81b93b9f4d485781785dd67511dc366c024` through TIP `9d25cd97efeacfd0149fc9c31c1a387cd4a683ec`.
- Canonical package: `.superpowers/sdd/2026-10-18-host-cadence-cleanup-plan/review-d3bdf81..9d25cd9.diff`; supplied size 62117 bytes; independently read SHA-256 `072bbac502d7682445a45358b92b13e1b6f2ac1551e4bd671687e251666cdc79` matches.
- Read the entire canonical package once. The first tool response was truncated; only the missing Host/runtime and cadence-test ranges were subsequently read. No changed file was reread to duplicate the diff.
- Named focused outside-diff checks: (1) unchanged CaptureObservation elapsed/CPU/non-CPU calculation at `runtime_observability.py:80-121` to establish R1; (2) `_capture_bounds_ns` access sites to assess whether the uninitialized-timestamp risk has an ordinary production trigger. No broader history, file crawl or git regeneration.
- Read the task brief, implementation report, binding capture spec and task-reviewer rubric. The report records 65 affected pure/AST tests GREEN, exit 0, separate absent-capability and immediate-start behavioral RED evidence, and corrected operational cwd mistakes. These are implementer-reported runs; none were regenerated by this review. The proposed R1 repro is an unrun focused regression recommendation.
- Ran no tests, builds, native imports, Host, browser, network, process sampling, services or deployment/proof operations. Edited only this ignored review artifact; did not touch tracked source, index, four existing dirty docs or node_modules.

## Assessment

**Spec compliance: Needs fixes. Task quality: Needs fixes (R1).**

The observation model and task isolation are well structured, but new real observer CPU is attributed to grab non-CPU time and cadence grab time. Approval after that focused repair remains task-scoped static/pure-test approval; it cannot establish production timing, native-input latency, ordinary recovery, Task 2/3 behavior or long-session qualification.
