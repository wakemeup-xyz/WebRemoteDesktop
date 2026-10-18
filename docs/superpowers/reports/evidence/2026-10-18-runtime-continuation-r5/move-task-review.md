# Independent task review: selected-channel move quarantine

**Findings: none. Spec compliance: Approved. Code quality: Approved.**

Reviewed implementation range: `f4fe76704a44034ea98f35ef99b60ed243480877..c802a68362459b46b84593c7e8921575e0783394` in `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`. HEAD resolved to the latter exact commit. The supplied `review-f4fe767..c802a68.diff` matches `git diff --unified=10` for that range byte-for-byte. The increment changes only `web-client/js/webrtc.js` and `web-client/js/input-recovery.test.js` (+123/-5).

This is a static spec and quality review. I read the task brief first, the worker report, exact review package, active design and plan, relevant requirements, actual Input/WebRTC caller and fixture, and retained RED/GREEN/affected logs. I did not rerun tests or perform runtime, browser, network, native input, process, service, build, install, configuration, staging or deployment actions. The only write by this review is this `/tmp` report; root owns repository review records and anchors.

## Spec compliance — Approved

- `web-client/js/webrtc.js:5068` retains the existing selector. `:5072`–`:5075` rejects the actual selected quarantined object before buffering or send. Missing/closed dedicated channels therefore cannot route moves through quarantined reliable A; alias identity is rejected too. Non-move quarantine remains equivalent because its selected channel is the reliable channel.
- The mouse reset Socket guard at `webrtc.js:5067`, healthy move successful-drop branch at `:5077`, reliable 512-KiB branch at `:5081`, envelope at `:5086`, and quarantine method at `:5093` retain their existing behavior. A healthy independent move channel or replacement reliable B passes the object-identity check even while A remains quarantined. There are no new timers, APIs, recovery policies or replay paths.
- The real high-level caller at `web-client/js/input.js:2547` consumes false and uses the existing connected Socket at `:2580`–`:2612`. With no Socket it returns null at `:2626`; moves do not enter the reliable sequence/pending/deadline path (`:2510` and `:2524`) and do not reach recordLatency on rejection.
- The genuine open-but-silent case (`input-recovery.test.js:1552`) retains actual 3100-ms fake-clock ACK timeout, sequence-gap reset retry, and current mouse/keyboard reset ACKs. It verifies the gate reopened and A remains quarantined before asserting zero DC writes, one unsequenced Socket move and unchanged real ledgers (`:1576`–`:1590`). Existing fresh click/key Socket assertions remain.
- The twelve matrix cases (`input-recovery.test.js:1606`) cover missing/closed/aliased dedicated channel × buffer 0/4097 × Socket available/unavailable. They invoke actual quarantine and reset/ACK recovery, then actual Input.sendInput. No transport-selection method is replaced. They verify accepted Socket writes or null, unchanged reliable/keyboard/budget/deadline state, and actual LatencyMonitor state. Six controls (`:1647`) cover independent move, reliable replacement and healthy reliable fallback at both buffers, including unchanged intentional healthy >4096 drops and no Socket fallback.
- Implementation scope is exactly the two allowed paths. No sampler, runner, supervisor, gate, recovery budget, quality, codec, FPS, resolution, bitrate or network-policy changes occur in this increment.

## Quality and architecture — Approved

The production correction is minimal and centralizes the existing quarantine invariant at the point where channel selection is known. Identity ownership stays with the existing quarantine field; Input remains the sole owner of Socket fallback and acceptance/latency accounting. There is no duplicate transport policy or competing source of truth.

The tests exercise production methods with existing VM channel/socket/clock fixtures. Their gate and ledger assertions prevent false success through blocking all input. The negative transport matrix is paired with healthy controls, and the real timeout case links the focused routing check to the original recovery path. Optional loading of the actual LatencyMonitor isolates the additional test cost to cases needing its real accounting. No actionable correctness, maintenance or regression finding was found.

Docs sync is adequate for this bounded task: tracked active `docs/superpowers/specs/2026-10-18-move-quarantine-fallback-design.md` and matching plan describe the selected-object correction and runtime limits. Existing requirements preserve move dropping and null/no-latency-pending rejection. The correction introduces no API or changed input-loss policy requiring an additional implementation documentation change. Pre-existing dirty README/runbook/requirements/anchor documents and node_modules remain outside the reviewed increment and were not modified by this reviewer.

## Retained verification evidence

I checked log contents and SHA-256 values against the worker report; these are retained run results, not newly executed tests.

| Run | Tests | Pass | Fail | Duration ms |
| --- | ---: | ---: | ---: | ---: |
| Initial RED | 22 | 5 | 17 | 428.540911 |
| Corrected-harness RED | 22 | 9 | 13 | 431.771295 |
| Focused GREEN | 22 | 22 | 0 | 404.558754 |
| Affected suites | 553 | 553 | 0 | 24610.334539 |

The initial RED contains one actual DC-routing failure and sixteen fixture gate failures. The documented harness correction completes real matching dual-reset ACK recovery and compares latency to the post-reset baseline. The corrected RED contains thirteen behavior failures with no remaining harness gate failures: the genuine timeout case plus six buffer-0 cases send one DC write instead of zero (`input-recovery.test.js:1585`, `:1627`); three connected buffer-4097 cases omit the required Socket move (`:1629`); three disconnected buffer-4097 cases return an input ID instead of null (`:1636`). All six healthy controls and three existing silent-reliable keyboard/wheel/command cases pass even before the production correction.

Focused GREEN and affected-suite logs have zero cancelled/skipped/todo cases. The affected command uses the existing `scripts/passive-session-sampler.test.js`, correctly resolving the brief's nonexistent underscore spelling. Synthetic transport/config/ICE recovery diagnostics are consistent with the passing offline fixtures and are not live acceptance evidence.

Verified log hashes:

- Initial RED: `296ca8c264e76092e109d4256606120c95fa904af0a74469799129eec635aa36`
- Corrected RED: `57eb3d17e3afaa2d59f7ed83e6f081e8f04cf9d939c54f5a412e12d0ac044fba`
- GREEN: `77af7e5f15dd7dd87efbdf3a8664957fcfc89a3d8fae00a6f01f762dfed9f994`
- Affected: `6332733545b7cc1204777a257152a063d86c9c5185f9577359f501721bbf8df4`

Verified current source hashes:

- webrtc.js: `3e74b71536ff1bdbe52cc7e0447a887ac4a1e333ab9eb9e574306c62688fcbd9`
- input-recovery.test.js: `3d23b332c5a77fbbfc49cd846247ed1f8af70e59bbcca54d65fdde349b4b1c2c`

## Limits and handoff

Review coverage is complete for this task increment. Approval covers source/spec/quality with retained offline evidence. Native/business/visible/physical acceptance remains **NOT_RUN**. This review does not authorize or establish deployment, long-session acceptance, real input-to-picture latency, or reuse of previous F/R3 artifacts. The new frozen release context and final increment review remain root-owned.
