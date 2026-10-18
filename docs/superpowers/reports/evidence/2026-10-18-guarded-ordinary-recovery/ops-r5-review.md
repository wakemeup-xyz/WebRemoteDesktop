# Findings and disposition

No new actionable finding was identified in the authorized R4→R5 integration-fix scope.

## A — Final strict-idle false negative during post-close ordinary grace: ADDRESSED

`operational_common.py:60-70` retains strict idle as the default and separates validated occupancy from healthy Host status. Counts must be exact integers in0..9007199254740991; missing, null, boolean, negative or oversized counts reject before any occupancy classification. Non-object/invalid JSON responses, unhealthy health response and offline/missing Host-online evidence still fail. The bound is a representation bound, not a product-capacity claim.

`current_gate` at207-209 preserves the same context/source/freeze/review, exact asset, service-identity and preservation fences, forwarding only the named require_idle option. `qualification_integrity` at212-214 is the sole explicit require_idle=False caller. Its sole operational use is the ordinary supervisor's final ended-interval validation at140. Both ordinary scenario preflights at76 and82 remain default-strict, as do reload, readiness, docs and the unchanged other health consumers.

`ordinary-supervisor.py:135-144` keeps worker exit, timeout, first error, cleanup, recorded ownership, source pins and manifest integrity/expiry as completion requirements. A successful final integrity observation records bounded counts/time as idle-observed or occupied-unattributed. The record always says nextRunAdmission=NOT_ESTABLISHED, strictFreshPreflightRequired=true, serverMapDrainEstablished=false and automaticNextRun=false, including for zero counts. Nonzero occupancy is never attributed to own grace, a human or leaked cleanup. Invalid/unavailable final integrity throws and fails completion; it is not forgiven as grace. A later terminal-evidence failure can retain the valid final observation but still fails qualification.

This implements root's Option A without a new wait, product timer change, deadline extension, retry or admission authority. The independent strict currentReadiness diagnostic retains its existing best-effort role. The previously reviewed sticky interval evidence and actual guarded-admission source remain later/unchanged requirements; a completed past interval does not establish permission for another run or complete server-map teardown.

## B — Normal private Node exit could leave registered descendants unsettled: ADDRESSED

`build-private-two-time-template.py:29-56` now has one finally cleanup invocation with grace0, TERM observation2s and KILL observation1s for normal exit, timeout and operation exceptions. The former normal-exit quarter-second observation and separate timeout/exception cleanup calls are removed. Work deadline is start+180s and polling sleep is capped to its remaining allowance.

The pinned Registry's existing state/signal/cleanup contract was reread statically. Cleanup operates on registered birth-fenced identities and can observe direct descendants of still-verified owned parents; it does not grant ownership through vanished parents or add global process discovery. The unchanged private builder is the scoped child. No new managed-service or tunnel action is introduced.

The first operation error and timedOut flag are not overwritten by cleanup. cleanupErrorClass and ownershipErrorClass remain separate. The new intervened field is false only for an empty signal list; any nonempty signal-attempt list or missing/malformed list prevents success. Exit0, generated assets or later exited identities cannot override those failures. The unchanged two-endpoint caller stops on failed child evidence and does not retry. Full unobserved process-tree exit remains unknown.

The nominal180s work plus3s cleanup observation allowances are accurately disclosed as configured waits, with scheduling/syscall/scan overhead outside a hard wall-clock guarantee. A registration/cleanup failure remains a failure; the patch does not invent ownership or repeat cleanup to conceal it. No actual surviving descendant or live incident was observed in this review.

# Narrow verdict

Approved for these two static R5 integration fixes. Both accepted root findings are ADDRESSED; no new breakage was identified in the changed control flow or explanatory contract. This does not reopen the previously reviewed R4 evidence schemas or prior fix dispositions.

This is not execution authorization, qualification evidence, or a new unrestricted audit. Actual final runner CLI/count/schema/source integration, exact reviewed TIP/path receipt, asset-template review and execution/runtime receipts remain required. None was invented or created. The retained private-r3-combined-operations scope string is only a schema label: any future execution receipt must pin this exact R5 manifest and corresponding independent review, not a predecessor manifest.

# Independent integrity and static evidence

R5 package: `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-combined-recovery-operations-private-r5-6tsv3vak`.

- REPORT.md SHA256: `c8ab10320c51cefe1031de79057e38d53d7e477090b40551cd34497f670ae41d`.
- SHA256SUMS.json SHA256: `e6667fcb51a7cf8500ab694e8eda79fdb51871e92fe2336fbd915181c9af63e1`.
- r4-to-r5-focused.diff SHA256: `272a3c59ddcfb48f791c3cad3e6713d528bd46cb6d73bc2260953e2e1c8b2bed`.
- Root assessment SHA256: `c5e33de4459c95e04157aa217ac0b857e196b20e04265e63e224116000806222`.
- Independently hashed all42 manifest-listed files: every entry matches. No unlisted package item besides SHA256SUMS.json exists.
- All ten Python source files passed independent ast.parse. No package module/function was executed.
- Exactly three executable files differ from R4: build-private-two-time-template.py, operational_common.py and ordinary-supervisor.py. All eight other executable files, including qualification_evidence.py and its browserClose=closed predicate, remain byte-identical.
- All original R4 manifest entries still match their recorded digests. The R4 manifest remains the historical `5f40c1b787ec0081170378ffcc1ed3c5ca2fb201b4aee0fa5d0666200c1befce` artifact.

Read R5 report, root assessment, focused code/explanatory diff and changed control flow; searched all R5 current_gate/qualification_integrity/require_idle callsites, and reread the necessary original Registry contract. No previously approved schema was reopened.

Performed only static file reads/searches, hashing, byte comparisons, AST parsing and this new report write. No package imports/functions, executable mocks/tests, Registry execution, build, process/status inspection, network/browser/native/service/tunnel action, primary/source/repository/index writes, dependency traversal or subagents. No live availability, deployment, asset, recovery or continuity claim is made.
