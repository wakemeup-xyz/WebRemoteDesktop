# Read-only sampler failure review

Verdict: the run produced NO usable stack evidence. A P2 wrapper timestamp/observation defect explains the apparently late sample finish; the underlying reason sample failed to produce a report within its ten-second budget remains UNKNOWN. Do not infer 109 seconds of sample execution, Host deadlock, permission denial, or successful stack collection from these artifacts.

Scope: read-only inspection of supervisor.py, turn-long-20261017a preflight/supervisor/summary/lifecycle, local Apple sample(1) manual, and repository search for existing Python stack-dump hooks. No tests, process sampling, network, service changes, or implementation edits. Only this requested report was written, mode 0600.

Reviewed supervisor SHA256: 4d96c8b0cbd9ae21056f02741e7193db82e7659e2a0e416583c65af7bfcb0492.

## Evidence and timeline

- Long-run helper requested 10800 seconds, sampled 256 observations across 256.072 seconds, then reported INCOMPLETE/session-changed-or-disconnected with one identity change. Supervisor elapsed 293.950 seconds includes startup and cleanup; it is not 294 seconds of continuous accepted media evidence.
- Trigger observed frameAgeMs=5262.4 at helper elapsed 153.0005 seconds. This already exceeds the pinned helper failure threshold, independently of later sample perturbation.
- sample start epoch: 1792219909.5059378. Owned sample PID 12864 was registered. KILL attempt recorded sent at 1792219919.7576, 10.251662 seconds later.
- Final sample status timeout, exitCode -9, raw outputBytes 0. A precreated empty file is not evidence that sampling attached or captured any stack.
- Recorded finishedEpoch 1792220018.480889 is 108.974951 seconds after start / 98.723289 after KILL. It is a finalization timestamp, not observed child-exit time.

## Prioritized findings

P2 — supervisor.py:184-191,229-231: sample exit timing is misreported. check_sample initially stores finishedEpoch when the timeout fires, immediately changes status to timeout and sends KILL. Subsequent check_sample calls return before poll because status is no longer running. At final cleanup, line 231 unconditionally overwrites finishedEpoch with the current time. This produces exactly the observed late timestamp while the worker continues running. No recorded timestamp establishes when SIGKILL actually completed. The recorded KILL was timely to approximately one polling interval; these artifacts do not show a 99-second timeout-enforcement delay. Prior offline tests asserted KILL time but not preservation of timeout/exit/finalization timestamps, so the earlier PASS missed this reporting defect.

Diagnostic design gap — stdout/stderr are DEVNULL by explicit prior design. This bounds output but discards precisely the permission/attach/progress/error evidence needed to attribute the empty report. It is not proof of a permissions fault or a command syntax fault. The next design should change this contract explicitly rather than silently capturing arbitrary logs.

## What can and cannot explain the empty file

The local /usr/share/man/man1/sample.1 specifies positional duration in seconds and interval in milliseconds; the invocation sample PID 3 10 -file ABSOLUTE_PATH is structurally correct. No -wait or -e is used, and no shell or pipe introduces a prompt/drain wait. The initial Popen/registration completed in approximately 0.13 seconds, so a 109-second Popen/preexec wait is not supported. The manual says the report is produced after the sampling duration: three seconds is a sampling interval, not a guaranteed total execution deadline. Attachment, collection, analysis/reporting, OS scheduling or permission-related behavior are plausible but unproven causes of exceeding ten seconds. File creation/path syntax was valid at least for the supervisor; the 8MiB RLIMIT does not explain a zero-byte output by itself, and final -9 corresponds to the recorded supervisor KILL rather than evidence of an RLIMIT signal.

The polling delay of about 0.25 seconds is compatible with the configured poll interval plus work/scheduling. No evidence here establishes a global scheduling freeze. No recorded sample progress or error output identifies which stage stalled. The wrapper's intentional continuation of the helper after sample timeout accounts for most of the apparent post-KILL delay; final worker cleanup adds its bounded waits.

## Minimal reviewable next design (proposal only)

1. Split immutable timeoutDetectedEpoch/Monotonic, killAttemptEpoch, exitObservedEpoch/Monotonic and finalizedEpoch. Keep timeout as the outcome even after eventual exit. Continue nonblocking poll after timeout and latch the first exit observation once; do not label an observation as exact kernel exit time. Record sample exit code independently of worker completion. Preserve one attempt, same identity checks, owned-only signals and all original artifacts.
2. Retain a small private bounded diagnostic channel for sample stdout/stderr, separate from raw stack output. Specify a strict byte cap, draining/truncation behavior, restrictive permissions and ownership of any drain mechanism before implementation. Avoid PIPE without a continuously drained bounded reader. Persist only allowlisted phase/error classifications and byte counts in shareable summaries; retain raw diagnostic text privately with no automatic publication because it can expose local paths and process details. Distinguish launched/attach-unconfirmed, report-empty, report-present-unvalidated, report-validated, timeout, and exit status. Nonempty output alone does not prove valid stack evidence.
3. Keep the current external cap initially; do not simply raise it or repeatedly retry on the production Host. Add offline fake regressions for timeout then prompt child exit while worker runs much longer, delayed exit observation, normal completion, bounded diagnostic overflow, and no final timestamp overwrite. A later separately authorized harmless-child capability check can validate the local collector and permissions without consuming a production stall attempt; it cannot prove equivalent permission for a differently protected Host.
4. A shorter single capture (for example one second with the existing 10ms interval) is a possible lower-overhead experiment, not a reliability guarantee. The installed manual provides no supported raw/no-symbolization option to assume. Do not invent flags, elevate privileges, or replace with spindump/debugger attachment without a separate reviewed scope.

## Lighter evidence versus actual stacks

Existing bounded timing/event counters can narrow whether capture, encoding, send queues or event-loop scheduling stopped, but cannot reconstruct a historical thread stack. There is no successful stack artifact to recover from this run. Read-only observation also does not mean zero perturbation: the installed sample manual explicitly describes repeated suspension/resumption of target threads.

A future cooperative CPython thread-dump hook could avoid repeated external attachment and symbolization and capture Python frames once on a qualified stall. Repository search found no existing faulthandler/SIGUSR/dump_traceback hook to safely invoke now. Such a design requires an authorized Host code/deployment change, a preopened private bounded output, explicit capability advertisement, one-shot trigger and retention policy, and verification against the installed Python version. Never send an unregistered diagnostic signal: its default action may terminate the Host. Python frames alone also cannot establish native Quartz/codec/C-extension execution; native stacks may still require the external sampler. This alternative is outside the present read-only scope and is not guaranteed to succeed during all native/GIL stalls.

Recommended sequence: repair collector observability and timestamps first, validate offline, then perform an explicitly authorized small capability check before deciding whether any production capture or Host instrumentation is warranted. This review neither starts such work nor grants live execution authorization.
