# New fix-round finding

## P1 — Successful inherited browser-close lifecycle is rejected for every scenario

File: `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-combined-recovery-operations-private-r3-q_fejdzt/qualification_evidence.py:159` (loop at 156–160).

The new lifecycle validator requires `stage['status']=='ok'` for managerStart, managerLaunch, browserClose and managerStop alike. The pinned original helper records successful browserClose as `closed`, not `ok`: `/Users/macstudio1/AI/Claude/WebRemoteDesktop/scripts/passive_session_soak.py:943-957`, specifically line947, assigns `record['status'] = 'closed' if key == 'browserClose' else 'ok'`. The committed design explicitly retains that existing Python lifecycle contract, and the R3 validator itself lists `closed` in its enum before immediately rejecting it through the generic successful-stage predicate.

Therefore a conforming runner with successful startup, browser close and manager stop cannot pass terminal validation. It becomes failed-or-indeterminate after an otherwise valid scenario and prevents subsequent scenario invocation. This is a deterministic compatibility regression introduced by the P1 fix, not uncertainty about absent future runner implementation. Changing the producer to emit a different successful close status would silently change the inherited contract.

Fix: require `closed` specifically for browserClose and `ok` for the manager stages; retain exact keys, integer clocks, ordering, failure-clock rejection and all unsuccessful-stage exclusions. Keep the original helper/SUP/sampler unchanged. Include this distinction in the later final producer/consumer integration gate.

# Disposition of the three original R2 findings

1. **P1 exact/coherent evidence — ADDRESSED, with the new P1 regression above.** `qualification_evidence.py` now validates the complete nested sampler, transport, metrics, Host/identity/server events, summary, fault, continuity, startup and lifecycle shapes; counters reject bool. Pinned inherited gate/diagnostic validators are loaded from verified source bytes at operation time. Null/malformed observations and wrapper/parser failures latch through ObservationGate and cannot be cleared by terminal PASS. Fault capability/status and recovery/no-fault coherence are checked; induced recovery continuity must stay INCOMPLETE. The original permissive predicates are removed. The new all-stages-ok rule is a separate over-restriction introduced while fixing that finding and must be corrected before approval.

2. **P2 Host sampling overlapping expected outage — ADDRESSED.** `ordinary-supervisor.py:85-86` disables sampling for both complete recovery scenarios; `103` prevents dispatch, and `94` separately guards sampler entry. Thus queued baseline rows and a previously started sample cannot overlap either induced recovery fault because those scenarios never start a Host sample. Contract/report disclose the root-approved cost: unexpected stalls in those recovery runs receive no additional Host sample. Only no-fault baseline and continuity retain sampling. No future phase-handoff interface is assumed.

3. **P2 Registry exclusion queue invariant — ADDRESSED.** `operational_common.py:151-182` supplies a derivative scan that queues only successfully registered, birth-matching, eligible live identities. `state()` guards membership before base access. Excluded/unreadable children do not enter the queue, and individual observation failures continue to eligible siblings rather than reproducing the prior KeyError path. Registered identities that now identify as managed services return unknown and remain ineligible for inherited signal operations. The original SUP is unchanged. No stronger full-tree completeness claim is introduced.

# Scope verdict

**Changes requested for the new P1 regression.** This is a scoped R2→R3 fix-round re-review of the three accepted findings and breakage introduced by their fixes, not a fresh unrestricted audit or execution approval. No other actionable regression was identified in that scope.

The root rulings are honored: sampling is disabled for whole recovery scenarios, and observed one-second phases need only be forward-reachable through the selected scenario graph. The wrapper does not require every transient fault/recovering state to have its own row, does not add an invented producer interface, and does not independently prove every internal state transition. Exact producer state transitions, actual row/count semantics, complete final runner CLI/schema integration and source provenance remain mandatory later gates. Final runner/TIP, execution receipt and runtime inputs are intentionally absent and are not findings.

All changed executable code was read: full new qualification_evidence.py, changed ordinary-supervisor.py, and changed operational_common.py with the original Registry's scan/state/signal contract. The focused diff and updated report/contract/boundaries/self-review were read. New sampler schemas were compared statically with the unchanged sampler and its private_row conversion, and new lifecycle checks with the unchanged helper's actual status producer and validator. No old rollout logic was reopened beyond verifying unchanged bytes and tracing dependencies necessary for these fixes.

# Independent integrity and static evidence

R3 directory: `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-combined-recovery-operations-private-r3-q_fejdzt`.

- REPORT.md SHA256: `7d12e6699ce79472d76fa51497d3cf4f56e0d50e1b9eb39713e2f143bc931fb6`.
- SHA256SUMS.json SHA256: `4e2091a05c0a079a3076a05d9fbb03e04a057c43f3be4a2d77457114fc15ce26`.
- Focused diff SHA256: `47833660b685f09ef0ecc2a27fb9df4e44d60b5fc1c97565809fb9daf5fbb326`.
- Independently hashed all 28 manifest-listed files before code review: all match. No unlisted package item besides SHA256SUMS.json exists.
- All ten R3 Python source files independently pass ast.parse. No package import or function was executed.
- Executable differences are exactly the new qualification_evidence.py plus changes to operational_common.py and ordinary-supervisor.py. The eight remaining executable files are byte-identical to R2, including private-builder-entry.js.
- Original R2 manifest still hashes to `f9aae6e170e60f988afc97e525e12a5c5db56db867bbf175745008abae701c69`; every original R2 manifest entry still matches.
- Original SUP still hashes to `d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b`.
- Original passive helper still hashes to `b0a15095651c9147eb451b27eb815ec4ea4cc984f2d293d3617c4cee89a15426`.
- Original passive sampler still hashes to `f862b739cbe7eb543ccab304203c71c62a43014530fa2da9a7655cba293665d3`.

Only static reads/searches, hashing, AST parsing and this new report write were performed. No package imports/functions, executable mocks/tests, builds, Registry/helper/status, process inspection, network/browser/native/service/tunnel, repository/index writes, dependency traversal or subagents. No live deployment, artifact, recovery, continuity or availability result is claimed.
