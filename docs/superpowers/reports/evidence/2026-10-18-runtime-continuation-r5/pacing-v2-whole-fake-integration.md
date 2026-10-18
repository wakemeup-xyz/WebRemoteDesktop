# Pacing v2 whole-driver fake integration — offline report

**PASS: five complete injected main-path cases, with zero real-platform boundary violations.** No substantive v2 bug was found in these cases. This is synthetic offline control-flow evidence, not diagnostic execution, native/Browser qualification, actual R4 interface integration, or an approved operational receipt.

External checker directory: `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-pacing-v2-whole-fake-zd7k0ai0` (0700; files0600). REPORT.md was created first. Target package `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-capture-pacing-private-v2-fgbxntxg` remains sealed: manifest SHA `fd58e215e2218e2b33a04932c14ed16f36001e191882280040431766a86283a1`, all16 manifested files rehashed unchanged after testing. Its prior23 pure PASS and scoped review remain separate evidence. This checker makes no source/primary/R3/R4/R5/SUP/index/config changes and uses no subagents.

## What actually ran

The checker statically loads and hash-checks all target package files, parses the exact v2 driver and pacing source, then compiles **every actual driver function, including its entire unmodified main**. Only top-level imports/constants/entrypoint invocation are replaced by explicit bindings; no driver function is replaced. The actual verify_package/load_ops/reference/read/save/PID-file/Host/protected identity/log reader/decision/worker registration/main/cleanup/final classification code executes against injected objects. Actual pacing Trigger/project/BoundedLines execute. The pinned original SUP SampleObservation and sample_limits are AST-extracted and execute against fake process/clock/resource/IO dependencies; no original SUP imports/main or actual Registry runs.

All filesystem state used by main is in memory: hypothetical approval, decision, operational manifest, baseline/runtime records, output nonce/markers, rows, Host EOF log, raw sample and result. **Those records are synthetic fixtures, not files created in the real package or runtime.** The result JSON is wrapped as `offline-whole-driver-fake-integration-NOT-OPERATIONAL-EVIDENCE`; it contains the actual in-memory driver output for reproducibility, never authority to run anything. The hypothetical good baseline exists solely in the fixture and does not refer to the current failed R5 baseline or any real nonce/receipt.

Injected boundaries are: pathlib/os/FDs/stat reads and writes; wall/monotonic clocks/sleep; Popen/poll/wait/status; Registry observation/cleanup; argparse; definition loader; core readiness/source/ownership checks; and ordinary row reader/ObservationGate/completed_result/gates. The fake core verifies local fixture invariants and captures calls, but does **not** validate the actual future operational package or native producer schemas. Synthetic rows and terminal fixtures deliberately supply only fields consumed by this driver and its pacing state. Consequently this closes whole-v2-driver orchestration coverage for these cases, not the separate native producer→real consumer/R4 contract gate.

No result classification is manufactured: actual main produces result.json via its real save function into fake FD-backed memory, and the checker asserts that stored result, return code, actual fake Popen command trace, trigger count and original deadline evidence. Fake clock303s/428s advances immediately; no real waiting or process occurs. The fake Registry does not attempt to reproduce OS ownership semantics or elapsed cleanup scheduling; it rejects unexpectedly live owned cleanup and unknown/signalled children. Original ownership invariants remain a separate reviewed dependency.

## Actual outcomes

| Case | Main exit | Fake elapsed seconds | Actual driver classification | Fake sample count |
|---|---:|---:|---|---:|
| below | 0 | 303.0 | NOT_TRIGGERED | 0 |
| trigger | 0 | 303.0 | INCONCLUSIVE | 1 |
| registration-exit | 2 | 2.0 | INCONCLUSIVE | 0 |
| registration-alive | 2 | 428.0 | INCONCLUSIVE | 0 |
| missing | 2 | 303.0 | INCONCLUSIVE | 0 |

- Below threshold:12 validated Host projections,11 newer usable-window intervals, pacing excess99ms, no diagnostic failure, NOT_TRIGGERED. No native sample command is requested.
- Trigger: first valid fresh newer100ms closed interval at fake11s after baseline begins at1s requests exactly one `/usr/bin/sample 1 3 10 -file /fixture/pacing/experiment-…/host-sample.txt` through fake Popen. The child completes after3 fake seconds. Actual original SUP sample preexec limits record8MiB FSIZE and CORE0, and actual SampleObservation records finished. Result stays INCONCLUSIVE and qualificationCreditSeconds=0 because capture attribution remains unknown. This command string was never sent to a real subprocess API.
- Registration eventually exits: fake worker creation succeeds and Registry.add_root raises PermissionError. Actual v2 retains the exact Popen until exit at2s, records the original428s deadline/error, returns exit2/INCONCLUSIVE with worker-registration-failed; no signal/sample or replacement lookup occurs.
- Registration remains alive: same injected registration failure, exact child observed until428s, created-worker-unresolved-at-deadline/unresolvedChild=true/timedOut retained; exit2/INCONCLUSIVE. No signal is sent to the unregistered child and no deadline is extended. It is a fake live object only.
- Missing coverage: no Host events, healthy synthetic rows throughout, exit2/INCONCLUSIVE with host-coverage-missing-seed. Healthy fake services do not erase coverage failure.

All paths retain actual driver qualificationCreditSeconds=0 and fullProcessTreeExit=unknown. Their complete bounded outputs are in run-final.json. No input, clipboard, coordinate, password, environment, real process arguments, live Host log or actual network data was read.

## Boundary enforcement

After read-only source preload/AST compilation, the checker arms a Python audit hook around each actual main run. It rejects real open/import, subprocess, socket, ctypes/native loading, process signals/spawn/discovery-adjacent filesystem traversal and resource-limit calls. Driver imports inside functions use an explicit fake import dispatcher for continuation_common/psutil/scripts; every other import is rejected. Module loading is an injected definition loader, not an actual filesystem import. Driver globals bind fake platform APIs, so real file descriptor, clock sleep, process/status and sample functions are never supplied.

Seven explicit `sys.audit` synthetic selfcheck events were rejected: open, subprocess.Popen, socket.connect, ctypes.dlopen, import, os.kill, resource.setrlimit. These are emitted events only, not attempted real operations. Expected selfcheck denials are recorded separately, then cleared before main runs; actual main executions encountered zero forbidden-boundary events. This is a test harness for the pinned reviewed code, not a claim of a security sandbox against malicious Python or comprehensive OS syscall interception.

## Commands and hashes

Both commands ran only in the new checker directory, using `-B`:

1. `python3 -B checker.py > run-1.json 2> run-1.stderr` — exit0,5 cases PASS; tool wall observation0.294280467s. This version preceded the added audit-event selfchecks; first output retained unchanged.
2. `python3 -B checker.py > run-final.json 2> run-final.stderr` — exit0,5 cases PASS plus7 audit selfchecks; tool wall observation0.333291738s. Both stderr files are empty. No failed execution was hidden or retried; the second run was justified by adding the boundary selfchecks, with no target-package modification.

- `checker.py`: SHA256 `5e9ff2cb54cef150bae6757d8880e47af5a5f4ca885c4e0a919c8990e5d8a16b`
- `run-1.json`: SHA256 `b3a85c1ca298f1f0e766fbbfab8904d1c10e30a7a03983358baedaa53173d925`
- `run-1.stderr`: SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- `run-final.json`: SHA256 `988d63d0e517037b4a7f11a96cf4e91c722b9ca715dd0634f29efcb0444d93fe`
- `run-final.stderr`: SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

Target driver SHA256: `bd7f26f537a88177cd803640ad34385af70ce38c3d392a05ae05254ab8cd9071`. Target pacing SHA256: `37033af442fd327dd8d126651a80b020c4a8bb1e405f8d04007d0dc688e8a2c9`. Original SUP SHA256 remains `d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b`. Static/provenance record includes command results and unchanged package verification.

## Handback limits

Ready for independent review of this external checker and fixture assumptions. No execution approval follows. Root still owns actual future operation-package interface/pin integration and the current runner fix/source review. Current R5 cleanup-incomplete is not a qualifying baseline; a genuinely fresh successful uninstrumented baseline and new reviewed runtime/decision are still required before any diagnostic experiment. No new tool-promotion or continuation package has been started by this worker. No actual diagnostic, browser, network, native sample, process/status, service, build, config or source/index action occurred.

## Sealed checker bundle

Manifest: `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-pacing-v2-whole-fake-zd7k0ai0/SHA256SUMS.json`

SHA256: `d4592777839578be028ebf54d07593a50cd666a9c8f8301e0b527cabeef63abf`
