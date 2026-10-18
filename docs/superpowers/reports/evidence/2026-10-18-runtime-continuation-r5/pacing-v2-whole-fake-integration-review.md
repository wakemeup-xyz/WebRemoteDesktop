# Independent static review — pacing v2 whole-driver fake checker

**Findings: none within the stated offline scope. Verdict: Approved as evidence for the five complete injected driver paths and seven audit-event denial selfchecks.** This does not approve diagnostic execution, real operational interfaces, native IO or qualification. The approved admission-teardown task review is unchanged.

## Exact reviewed artifacts

Bundle: `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-pacing-v2-whole-fake-zd7k0ai0`.

- Manifest SHA-256 verified: `d4592777839578be028ebf54d07593a50cd666a9c8f8301e0b527cabeef63abf`; all7 manifested payloads match. Directory0700, all8 files including manifest0600.
- Handback report SHA-256: `27ce8300c3251cd798a3e9ba257d94512df2320f73ea33dea810f50d2092607c`.
- checker.py: `5e9ff2cb54cef150bae6757d8880e47af5a5f4ca885c4e0a919c8990e5d8a16b`.
- run-final.json: `988d63d0e517037b4a7f11a96cf4e91c722b9ca715dd0634f29efcb0444d93fe`.
- Target v2 manifest remains `fd58e215e2218e2b33a04932c14ed16f36001e191882280040431766a86283a1`; I rehashed all16 payloads unchanged. Target driver/pacing digests match recorded values `bd7f26f537a88177cd803640ad34385af70ce38c3d392a05ae05254ab8cd9071` / `37033af442fd327dd8d126651a80b020c4a8bb1e405f8d04007d0dc688e8a2c9`.
- Original SUP remains `d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b`.

Read checker, reports/provenance, retained results and exact target source as static text/AST/hash data. No checker, tests, target entrypoint or original SUP was imported or executed by this reviewer.

## Actual driver execution and result integrity

checker.py:9–17 hashes/preloads target files and compiles all16 actual driver FunctionDefs, including entire unmodified main. There are no AsyncFunctionDefs omitted from this target. It compiles the pacing source with only import statements removed, and extracts only the pinned original SUP SampleObservation/sample_limits definitions. No driver function body is replaced or rewritten.

At checker.py:186–190, the execution scope supplies explicit fake platform/constants/import boundaries, loads pacing definitions, then all driver definitions, then calls the actual main. The in-memory result is parsed from the bytes produced by the driver's actual save function at its real result.json path. checker.py:191–199 asserts that result and return code; it does not assign the driver's classification or overwrite its failure fields. The external `allPassed`/case PASS labels are emitted only after these assertions succeed.

Synthetic state is explicit: core/context/readiness/source checks, original Registry, ordinary Rows/ObservationGate/completed_result/_gates and the module loader are injected at checker.py:155–188. The fake completed_result returns a fixture terminal object; fake ordinary gates validate only the subset needed by this driver path. Baseline rows, approval/decision/manifest/nonce/sample records all live in the fake filesystem (checker.py:137–153). They are deliberately insufficient as native producer/consumer or real R5 evidence and are visibly labelled synthetic. No operational receipt is created in the actual target package.

The fake registry rejects unexpectedly live owned cleanup and does not grant unknown PID authority. Registration failure occurs after the actual fake Popen returns, through add_root raising PermissionError. Original worker registration logic then observes the exact fake child to exit/original deadline. It is not simulated by directly writing an expected registration result. The original SampleObservation and sample_limits definitions run against fake dependencies for the triggered path; actual original Registry behavior remains outside this checker.

## Retained cases and checks

The final result contains five cases with the actual stored driver outputs:

| Case | Main exit | Fake elapsed | Classification | Samples | Relevant evidence |
| --- | ---: | ---: | --- | ---: | --- |
| below |0 |303s |NOT_TRIGGERED |0 |12 projections,11 newer/usable intervals at99ms excess, no failure |
| trigger |0 |303s |INCONCLUSIVE |1 |2 projections,1 usable100ms interval, sample finished;8MiB FSIZE/CORE0 fake limits |
| registration-exit |2 |2s |INCONCLUSIVE |0 |PermissionError retained, child exit observed, original deadline428s |
| registration-alive |2 |428s |INCONCLUSIVE |0 |unresolvedChild/timedOut retained at original deadline, no sample |
| missing |2 |303s |INCONCLUSIVE |0 |host-coverage-missing-seed retained despite healthy synthetic session |

The sample command shape is asserted in fake Popen at checker.py:123–127, including one sample PID,3/10 arguments, private output path and new session. Duplicate fake child creation is rejected. The sample's elapsed3s and raw bytes are synthetic; they do not establish real native attachment, OS limits, symbols or thread attribution. Every actual driver result retains qualificationCreditSeconds=0, fullProcessTreeExit=unknown, unknown capture native TID and unestablished GIL/kernel attribution.

The retained first run precedes audit selfchecks and remains separate; the final run adds them. Both output logs and empty stderr hashes match the manifest. The reported two runs are not hidden retries of target runtime and do not modify v2. I did not rerun either command.

## Boundary enforcement assessment

checker.py:19–22 installs an audit hook that records and rejects real open/import, subprocess/socket/ctypes families, process spawn/signals, traversal-adjacent filesystem operations and resource-limit events while armed. Driver globals bind fake os/pathlib/Popen/clock/process/resource objects, and the import dispatcher at:173–178 permits only explicit fake continuation_common/psutil/scripts. The definition loader is fake; no operational module is imported to obtain it.

Seven `sys.audit` selfchecks at checker.py:201–211 deliberately emit denied event names: open, subprocess.Popen, socket.connect, ctypes.dlopen, import, os.kill and resource.setrlimit. They test that this hook refuses those events; they are not actual file/process/network/native/signal/limit operations. Expected denials are separated and cleared before the main cases. Each main case runs while armed (:215–218), and final `assert not DENIED` (:219) prevents a caught target exception from silently concealing a real forbidden-boundary event. Retained final evidence reports exactly those seven expected denials and zero run boundary violations.

These protections are credible for the pinned known code and disclosed injected paths. They are not a malicious-code sandbox or exhaustive syscall monitor; safe_builtins intentionally retains ordinary Python facilities, and event selfchecks do not prove every underlying platform API's interception. The report states those limits accurately. Fixture construction/preload happen outside the armed main boundary but are visibly limited to source reads, definition compilation and in-memory setup in this exact checker.

## Claim boundaries and remaining work

The report does not manufacture an actual successful baseline or claim the failed R5 attempt qualified. It calls the payload `offline-whole-driver-fake-integration-NOT-OPERATIONAL-EVIDENCE`, explicitly discloses synthetic ordinary/core/Registry validation and separates real interface/native checks. Historical R4 naming in preparation prose/provenance is a gate label, not a claim that R5 interfaces were executed by this checker. This result must not be substituted for actual R5/future-package pin/definition compatibility or fresh deployment/readiness evidence.

This closes **whole-v2-main synthetic orchestration coverage for these five cases**, including worker registration and missing-coverage fixes. It does not establish all failure branches, real read/no-follow/FD races, native PID/ownership/cleanup timing, actual sample permission/timeout/attach behavior, original Registry parity, actual strict ordinary producer/consumer integration, or the current runner correction's runtime outcome. Those remain separate evidence/gates; this checker intentionally mocks them. The earlier23 pure tests, independent static R5 interface assessment and admission-teardown task approval retain their distinct scope.

No runtime approval follows. Root still needs exact current reviewed source/tool/operations binding, actual successful uninstrumented fresh baseline, and new valid runtime/decision/execution-review records before a diagnostic. No qualification time, native/business/visible/physical effect or causal GIL/kernel conclusion follows from this offline PASS.

Only this review file was written. No test rerun, operational import, source/package edit, process/status/health/network/browser/native/build/service operation or subagent was used.
