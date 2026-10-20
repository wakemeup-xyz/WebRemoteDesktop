# Task 1 report — selected-channel move quarantine

Status: **DONE**. Self-review: no unresolved implementation concern. Independent review, staging, commit and release belong to root.

Workspace: `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`  
Branch: `codex/reliability-latency-remediation`  
Starting HEAD, unchanged by worker: `f4fe76704a44034ea98f35ef99b60ed243480877`.

## Implementation

- `web-client/js/webrtc.js`: remove the non-move-only quarantine check; reject the actual selected channel if it is the quarantined object, before either buffer branch or send. Reset guard, selector, 4096-byte intentional move drop, 512-KiB reliable backpressure, envelope and caller are unchanged.
- `web-client/js/input-recovery.test.js`: retain the real open-but-silent scenario's 3100-ms fake-clock ACK deadline, sequence-gap reset retry and matching mouse/keyboard reset ACKs. After the gate reopens and quarantine identity is verified, a closed dedicated move channel must yield one Socket move, zero DC sends and no reliable sequence/pending changes.
- Add twelve quarantined cases: missing/closed/aliased dedicated channel × reliable buffer 0/4097 × Socket connected/unavailable. Neighboring cases invoke the actual quarantine method and real reset/ACK recovery. Unavailable Socket must return null, with unchanged actual reliable/keyboard/budget/deadline state and unchanged real LatencyMonitor snapshot; connected Socket records exactly one new latency send.
- Add six healthy controls: independent dedicated move channel, replacement reliable B after quarantine A, and healthy reliable fallback, each at 0/4097. These observe actual selected-channel sends or the existing intentional successful drop without Socket fallback. Moves stay unsequenced and do not add reliable pending work.
- The VM fixture optionally loads the actual `latency-monitor.js`; no Input/WebRTC/validator/transport method is replaced. Only channel/socket/clock fixtures are used.

## Commands and results

All test commands ran from the workspace above with the assigned Node executable. Full stdout/stderr is retained in sibling logs. No test skip/cancel/todo was reported.

Focused command (run once initially, once after harness correction on unchanged production, then once after production correction):

```sh
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-name-pattern='quarantined|silent reliable|move fallback' web-client/js/input-recovery.test.js
```

| Run | Exit | Tests | Pass | Fail | Duration ms | Log |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Initial RED | 1 | 22 | 5 | 17 | 428.540911 | `task-1-red.log` |
| Final RED, corrected harness | 1 | 22 | 9 | 13 | 431.771295 | `task-1-red-final.log` |
| GREEN | 0 | 22 | 22 | 0 | 404.558754 | `task-1-green.log` |

The initial run already exposed the core genuine recovery failure: actual DC sends 1, expected 0. Sixteen neighboring cases initially stopped at their gate assertion because the real quarantine method also marks the keyboard adapter unavailable. This was a harness setup defect, not accepted as routing evidence. The only correction before final RED was to complete actual matching dual-reset ACK recovery in those cases and compare latency against its existing post-reset baseline. Production remained unchanged for both RED runs.

Final RED behavior failures:

- Core genuine timeout/recovery case and all six buffer-0 matrix cases: DC sends `1 !== 0` (core assertion line 1585; matrix line 1627).
- Three connected buffer-4097 matrix cases: Socket writes `0 !== 1` (line 1629), because quarantined DC was incorrectly treated as an intentional successful drop.
- Three disconnected buffer-4097 cases: an input ID was returned instead of `null` (line 1636).
- All six healthy controls and the three existing silent reliable keyboard/wheel/command cases passed on unchanged production. No harness failure remained in final RED.

Affected suites command, run exactly once after focused GREEN:

```sh
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test web-client/js/input-recovery.test.js web-client/js/webrtc.test.js web-client/js/input.test.js web-client/js/input-backpressure.test.js scripts/passive-session-sampler.test.js
```

Result: **exit 0; 553 tests, 553 pass, 0 fail, 0 cancelled/skipped/todo; 24610.334539 ms**. Log: `task-1-affected.log`. The brief's underscore sampler spelling does not exist; `rg --files scripts` identified the actual existing `scripts/passive-session-sampler.test.js` used above.

Expected diagnostic noise in the affected log includes synthetic `[INPUT-DC] DataChannel error: {}`, degraded-DC recovery, simulated WebRTC config `HTTP 500` with built-in STUN fallback, and ICE/PC recovery scheduling. These accompany passing fixture cases; there was no live network or service action.

## Evidence hashes

SHA-256 of exact full logs:

| Log | Lines | SHA-256 |
| --- | ---: | --- |
| `task-1-red.log` | 387 | `296ca8c264e76092e109d4256606120c95fa904af0a74469799129eec635aa36` |
| `task-1-red-final.log` | 309 | `57eb3d17e3afaa2d59f7ed83e6f081e8f04cf9d939c54f5a412e12d0ac044fba` |
| `task-1-green.log` | 30 | `77af7e5f15dd7dd87efbdf3a8664957fcfc89a3d8fae00a6f01f762dfed9f994` |
| `task-1-affected.log` | 3761 | `6332733545b7cc1204777a257152a063d86c9c5185f9577359f501721bbf8df4` |

Final source SHA-256:

- `web-client/js/webrtc.js`: `3e74b71536ff1bdbe52cc7e0447a887ac4a1e333ab9eb9e574306c62688fcbd9`
- `web-client/js/input-recovery.test.js`: `3d23b332c5a77fbbfc49cd846247ed1f8af70e59bbcca54d65fdde349b4b1c2c`

## Scope and self-review

`git diff --check` passes. Worker source diff is limited to the two allowed paths: production +2/-3 lines, tests +121/-2 lines. No staging or commit occurred; the index remained empty. No thresholds, quality/codec/transport policy, timers, admission gates, reset semantics, input loss rules or sampler predicates were changed.

All four pre-existing dirty documents had identical before/after SHA-256:

- `README.md`: `d86ce4cf5d4d762826e60311632d2e83f6f224a25b5da88c9c2854044c8a2a78`
- `docs/archive/worklogs/review-anchors.md`: `1d97bef4734d9e8874cc90d069ce5bb1ee4bfb4f19e2ec47eceb81a19d4376eb`
- `docs/runbook-safe-startup.md`: `3ed7f2bf5d4fdc962e361eab4c0c56da063d089f9622abc06fe5c00dc962721f`
- `docs/需求文档/WebRemoteDesktop-需求文档.md`: `b98a660582f0560bf29ce62d28708a8ff4606193adbbbdccbda6ccb8d1cd6137`

`signal-server/node_modules` remained the pre-existing symlink to `/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/node_modules`, with the same Oct 17 03:41 metadata shown before and after. All other writes were this report and its four private sibling test logs.

The selected-object check handles alias identity directly and permits a healthy B even while A remains quarantined. It precedes both buffer branches, so a quarantine cannot be bypassed by the move drop return. There is no new replay or recovery behavior. Existing genuine recovery still verifies fresh click and key Socket writes after the new move assertion.

Limit: tests use real production methods in an offline VM with fake channels/socket/clock. Native/business/visible/physical acceptance remains **NOT_RUN**. No browser, native input, process inspection, service, build, install, config, tunnel, old private package or deployment operation occurred. Independent spec/quality review and any new frozen release context remain root-owned.
