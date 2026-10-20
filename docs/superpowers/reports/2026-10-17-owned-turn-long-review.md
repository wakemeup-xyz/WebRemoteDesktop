# Independent owned TURN long supervisor review

Spec compliance verdict: PASS.
Code quality verdict: PASS. No new P0/P1/P2/P3 actionable finding identified in the requested increment. Both prior P3 findings are resolved.

Reviewed the binding long design and plan Global Constraints, task-1 implementation report, prior review, complete private supervisor and tests, and pinned production helper sampling/failure predicates. Verified all four SHA256 values and private directory 0700 / scripts 0600. Independently ran `python3 -B /tmp/wrd-owned-turn-probe-private/test_supervisor.py`: 16 tests PASS in 0.948s.

## Prioritized findings

None. This is an offline implementation review, not live acceptance or authorization to change services/tunnel.

## Contract assessment

- Duration: CLI permits only 300/10800, forwards the selected value unchanged to the hash-pinned helper, and uses duration+300 for supervision (600/11100). Direct execute rejects unsupported values and invalid/nonpositive Host integers. CLI requires an explicit positive Host PID. Origin remains fixed by CLI and mode passed to the helper is relay.
- Host identity: both existing PID files must equal the supplied PID; initial process birth is retained. Before the single sample attempt, a fresh snapshot must match PID, both files and birth. No replacement discovery/restart is introduced. Host sampling targets are separate from owned-child cleanup registries.
- Trigger: short mode remains strictly >2000ms; long mode is >=5000ms. Null, boolean, nonfinite and incomplete rows do not trigger. The pinned helper itself records a failure for frameAgeMs>=5000; the row already captures that failure condition before the supervisor sample can affect future observations. Subsequent stall magnitude can be perturbed. One latched attempt is preserved, including Host-refusal cases.
- Reporting: preflight and final include kind/duration/threshold/comparison; preflight includes the worker deadline. Final sampleTriggered means sample Popen returned, while sampleTrigger preserves the latched observed row even if Host validation refuses capture. Original helper/lifecycle artifacts remain unmodified and authoritative for continuity outcome. The existing preflight diagnosticPerturbed=true is conservative diagnostic metadata, not evidence that a sample actually ran; use final sampleTriggered for that determination.
- Prior P3 fixtures: temporary fixture directories now live under the private root; synthetic fixture files explicitly receive 0600 and runtime sidecars/raw files are created exclusively at 0600. Permission assertions exercise both duration cases.
- Prior P3 regression coverage: fake execute verifies sample argv, DEVNULL, separate session, and limits hook. A fake cleanup lasting 11 seconds verifies sample KILL at 10 seconds while worker cleanup is active. Mocked limits assert hard/soft RLIMIT_FSIZE=8388608 and RLIMIT_CORE=0. These are configuration/control-flow tests, not empirical macOS sample or OS enforcement tests.
- Ownership remains based on direct Popen roots and revalidated parent edges with recorded birth; signals recheck identity and skip reused/unknown identities. Capacity remains bounded. Cleanup/finally paths and the explicit completeProcessTreeExitEstablished=false invariant remain intact. Tests exercise reuse, changed parent, capacity, natural failure/deadline and one directly created harmless sleeping Python child.

## Scope and limitations

No source edits, index changes, browser, network, service actions or real Host sampling occurred. The only real workload process terminated was the test-owned harmless Python sleeper; CLI validation/help subprocesses exit normally. No subagents were spawned. Three-hour continuity, live macOS sample behavior, optical/native-input correctness and complete process-tree exit remain NOT RUN/unproven. Existing polling omissions, startup-before-row coverage limits, ordinary scheduling latency and check-to-signal race remain accepted limitations rather than newly solved guarantees. A future PASS requires the unchanged helper/lifecycle evidence and full-duration continuity checks, not this review or supervisor exit alone.

Reviewed hashes:
- supervisor.py: 4d96c8b0cbd9ae21056f02741e7193db82e7659e2a0e416583c65af7bfcb0492
- test_supervisor.py: 213781bdbaf7ea90489426be7501874e4709d10cb6ea6b8e1452c53763a274a0
- passive_session_soak.py: 2dfc5ee1e669c7f60662eb4b8cd17c1596bc146d3641845cfb12fd55d98592ed
- passive_session_sampler.js: b47bfa435806b1c30a15e6d743f594f70ba17a4b73cbe10e6230ab36e9d53594
