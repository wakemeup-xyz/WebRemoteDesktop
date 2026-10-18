# Task 1 fix round 1 scoped rereview

## Findings first

- **R1 — ADDRESSED.** In `python-host/host.py:1490-1491`, the grab phase is recorded before the original grab wall start. Successful grab CPU and wall endpoints are both captured at `host.py:1510-1511`, and the original CaptureObservation is settled before cadence aggregation at `host.py:1515-1517`. The native-error branch makes the same ordering explicit at `host.py:1502-1508`, then re-raises into the existing error handling. Thus the new aggregation is outside both paired native-grab measurements. Its wall time falls after `grab_finished_ns` and before the unchanged post-publication endpoint, so it is accurately included in postGrab instead of grab/non-CPU. The original captured start timestamp is passed to the delayed aggregate, preserving exact interval closure time. No newer observer phase is recorded between that timestamp and the delayed `start`, so the existing monotonic validation does not reject it.
- **Deferred Minor — ADDRESSED.** `python-host/host.py:1484-1486` initializes `grab_completed`, `captured`, and all three optional publication timestamps before the grab bracket. The existing `difference` helper accepts None, so a publication exception cannot read an unbound publication-time local in the supplemental finish path. This is a robustness repair, without a new claim that the previously hypothetical error was observed in production.
- **New Critical/Important/Minor findings from this fix diff: none.**

## Spec and quality verdict

**Spec compliance: Approved. Task quality: Approved.**

The new focused test at `python-host/test_capture_observation.py:588-601` makes cadence aggregation consume 7ms of both fake wall and thread CPU and native grab consume 10ms of each. It checks original last/max grab wall/CPU/non-CPU `(10,10,0)`, the entire closed cadence pair `50 = 10 + 7 + 33 + 0` milliseconds, no invalid timing, and 33ms requested pacing. This directly covers R1 rather than just statement order.

The failed-grab test at `test_capture_observation.py:603-616` checks that the preceding valid interval still closes against the captured next start, the failed interval is excluded, native success/failure counts stay `(2,1)`, original 5ms error retry remains, and subsequent successful grab CPU/wall pairing is undistorted. The costed fake clock changes in the helper are pure and add no native or actual-thread dependency.

The fix adds neither a sleep nor a new retry condition. It leaves the previously reviewed elapsed endpoint, floating >1ms comparison and 5ms error retry in place; aggregation remains before the original elapsed endpoint, so its real work appropriately reduces the existing pacing remainder. The two existing success/error operational paths retain their original propagation and observation separation. Task 2/3 and production qualification remain outside this gate.

## Exact review scope and verification

- Fix BASE: `9d25cd97efeacfd0149fc9c31c1a387cd4a683ec`.
- Fix TIP: `d3eaa28304b934c728b5b396e3a07b6eae066b19`.
- Read the appended Fix round 1 section in `.superpowers/sdd/2026-10-18-host-cadence-cleanup-plan/task-1-report.md` and the whole canonical fix package `.superpowers/sdd/2026-10-18-host-cadence-cleanup-plan/review-9d25cd9..d3eaa28.diff` without truncation. Assessed R1 and Deferred Minor against the original review already held in context. No changed source reread, broader history, git regeneration or outside-diff source search was needed for this round.
- Independently checked canonical package size **10830 bytes** and SHA-256 **`3d033752f5115b9d29eebea1c2ca064dae9ff2398a9e53cf630d826f865d5b68`**, matching the supplied package identity. A focused canonical-diff parser supplied current line anchors; it did not regenerate or broaden the diff.
- The implementer report records the actual focused RED (1 test, exit 1, `(17,10,7)`), focused GREEN (2 tests, exit 0), and affected GREEN (67 tests, exit 0). These are reported test executions, not reruns by this reviewer. No new gap or doubt warrants regenerating them.
- Ran no tests, native imports, build, Host, browser, network, process sampling, service, deployment/proof operation or subagent. Wrote only this ignored review artifact, preserving the original review and all tracked/index state.

Approval is limited to Task 1 after this repair and its static/pure-test evidence. It does not establish production capture timing, native-input latency, ordinary recovery, resource-owner behavior, peer-cleanup completion or long-session qualification.
