# Guarded ordinary recovery R2 scoped re-review

2026-10-18. **Approved for the reviewed design/plan scope.** All three findings in the R1 review are addressed. No new blocking regression was found in the R1→R2 contract changes. This is a static design verdict, not source-code approval, rollout authorization or runtime acceptance.

## Findings and disposition

No open findings from this scoped re-review.

1. **R1 P2, routed wrapper misidentified as native — addressed.** Design `2026-10-18-guarded-ordinary-recovery-design.md:155-169` now separates the route-free original-constructor/original-close within-grace stimulus from the explicitly Playwright-routed after-grace stimulus. The latter's entire baseline and recovery share the declared routing; wrapper closure/forwarding effects are acknowledged, and no private upstream access is introduced. Immutable scope/instrumentation mappings and `nativeAfterGraceQualification:'NOT_RUN'` appear in the exact result/sample contracts (`:182-194`) and acceptance wording (`:200-206`). Plan Task5 (`2026-10-18-guarded-ordinary-recovery-plan.md:303-315`) implements and tests the distinction. Baseline and fresh10800 remain route-free. The narrowed after-grace PASS qualifies ordinary server/application functional recovery under the routed stimulus; it does not assert native after-grace behavior, natural WS1006 reproduction or uninstrumented transport performance. This matches root's binding ruling.

2. **R1 P2, missing Host replacement producer — addressed.** Design `:127-141` defines the fixed loopback status producer and private Host-ID equality observer, pins public-origin/local-instance correspondence to root's deployment evidence, opens the selected log cursor first, and consumes existing role=host disconnect events as sticky alarms. Missing status, changed/offline Host, observation gaps, malformed evidence and incomplete ownership teardown cannot become PASS. The output additions (`:180-194`) carry bounded Host observation and the one new selected event enum consistently; raw Host IDs remain private. Plan Task3 interfaces/tests (`:232-246`) and Task4 integration (`:272-284`) provide the producer/consumer handoff and pure replacement-during-outage cases. The fixed 127.0.0.1:8080 reader, HTTP framing/body/header limits, one outstanding owned async operation, concurrent status/page sample under2 seconds and final export under1 second are coherent with the preserved cleanup contract. No server endpoint/control authority is added.

3. **R1 P3, Task6 out-of-scope test write — addressed.** The guard-owned actual-handler within/after-grace regression addition is now in Task1 (`plan:194`), whose file list already owns `signal-server/websocket/viewer-admission.integration.test.js`. Task6 (`:317-324`) only runs/reviews that regression and returns required fixes to root/the owning implementer. The serial exclusive-path rule is preserved.

## Requested lifecycle API consistency check

The call `lifecycle_stage(read_local_host_status(),0.75,settlement=0.075)` in design `:133` and the mirrored plan correctly means a **750 ms total stage budget including cancellation settlement**, not825 ms. I read the unchanged helper at `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop/scripts/passive_session_soak.py:780-807`: the first wait is `timeout-settlement` (675 ms here), and the settlement deadline uses `min(settlement, timeout-elapsed)`. Reducing the argument to0.675 would unnecessarily reduce the total stage budget. No spec correction is required for this call. As the helper itself states, noncooperative cancellation is an implementation gate failure; the bound does not prove an arbitrary backend/process has exited.

## Additional changed-contract checks

The formal/quick origin split (`design:95-112`, `plan:42-65,333-344`) is consistent with root's supplied authorization and ruling: the quick URL comes only from the existing URL file; the configured authorized formal origin requires preserved configuration and fresh root verification/pinned evidence; a missing quick file does not block that formal path. The runner does not discover substitute origins, fabricate the quick URL file, change fixed-domain configuration or regenerate tunnel. I did not independently access the formal URL or verify its current availability.

The new scope, Host observation and manifest fields are reflected in the exact schemas and intended validation tests. The revision does not change guarded admission ordering, pinned human-owner priority, default human issuance, ordinary resume authority, proof nonresumability, Host ACK barriers, production deadlines or input replay policy. The existing source/implementation reviews and operational gates remain required; this scoped approval does not replace them.

## Artifacts and limits

Read `R2-revision-review.md` first, the complete381-line R1→R2 diff and the affected actual R2 spec/plan sections in context, then performed the requested narrow helper API check. All four `SHA256SUMS` entries verified against the actual files, including the two supplied pins:

- R2 design: `09e7fb03127b2a6e3c6397738582ce11abb046e81fe09f6fff4df4ae1c1ab833`.
- R2 plan: `5d79d7e5a51f348b5af8d00c3a28049f8ea494039a5d0382b96c1cbf628a8c0a`.
- R1→R2 diff: `8415f4048dd662913b6881adf08eeedad27d010cc140c707b3bca04785b57bbb`.
- R2 revision report: `a06be29470e5ab26306f41cdd62e1d79ac7acaf0f07c3e03937408b3a59ccbb0`.

The R1 review is preserved. No source/module execution or import, test, build, browser, network, service, proof, native input, tunnel, tracked-file or index operation occurred. No subagent was used. Only this private R2 review report was written. Runtime capability success, actual source loading, recovery timing, long continuity, physical/visible effects and process exit remain unproved by this review.
