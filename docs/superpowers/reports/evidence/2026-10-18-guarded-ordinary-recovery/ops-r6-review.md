# Independent R6 startup-consumer scoped review

2026-10-18. Static review only.

## Findings and verdict

No new actionable finding in the R5→R6 change. The rejected-valid-startup/early-owner-establishment integration defect is **ADDRESSED** within the requested scope. **APPROVED for this narrow static increment**, conditional on the already-required final source integration gate; this is neither permission to execute nor evidence of qualification.

The three changed methods are `ObservationGate.__init__`, `ObservationGate.observe`, and `ObservationGate.finish` in `qualification_evidence.py`. Prior R5 approvals are not reopened. The outstanding source fix reported by root is outside this consumer change and is not approved by this report.

## Control-flow review

- At lines 86–100, the mandatory initial startup phase precedes the scenario's first qualified baseline/continuity phase. Repeated startup rows remain a prefix. Forward reachability cannot return to startup, skip the first qualified phase, move backward, accept a wrong-scenario phase, or accept any row after terminal. Startup followed immediately by terminal cannot establish an owner or satisfy finish. Skipping transient recovery rows remains the previously accepted sampled-observation limitation; source review must establish the actual state graph.
- At lines 102–116, nullable startup session/admission fields accumulate equality observations without establishing authority. Null does not erase an earlier value; a contradictory nonnull value rejects. The first qualified row requires complete session/admission/socket hashes and agrees with all previously observed startup session/admission values. The session/admission pair then remains nonnull and immutable. Socket identity remains separately nullable thereafter, preserving the existing source-confirmed recovery behavior rather than substituting an old socket.
- Every startup row still passes the unchanged exact row and nested validators before these branches. A missing sample, wrong build, malformed identity, incomplete Host evidence, Host identity change/disconnect, event gap/order violation, clock reversal/gap, or capacity violation cannot be forgiven by startup. Exceptions retain the first rejection latch. Partial accumulator changes before a later rejection cannot clear that latch or create a successful finish.
- The startup bound uses the existing elapsed anchor and 120-second allowance. The unchanged finite numeric validator, global bounds, and adjacent-row gap check remain in force. No new wait, clock reset, deadline extension, sampling action, or mutation was introduced.
- Lines 120–133 keep separate phase windows. Startup rows/time do not count toward baseline 300 seconds, continuity 10800 seconds, or recovered stability 30 seconds. Finish requires actual startup, an established owner, the expected terminal phase, and the existing qualified count/duration checks. A successful summary cannot supply missing observations.

## Actual-producer comparison and remaining boundary

Read the R6 requirements, full Task4 report including its completion section, and final-operations integration checklist. Statically inspected the relevant actual runner code from immutable commit `b6570f7af1637dd08495f83a0a4925c6c0e1d723`, including phase graph, startup readiness transition, identity projection, observation loop, persisted tick ordering, and final tick behavior.

That producer enters startup before observation; its initial tick completes before creating the UI Start action. It persists each wrapper before model observation, so the readiness-triggering row can still be labeled startup. Nullable identity fields reflect their actual independent availability. The wrapper elapsed clock is assigned once; model qualification uses a separate anchor. These facts support the R6 prefix and owner-establishment correction.

This review does **not** certify the final producer/consumer sample-count boundary. The transition-triggering startup row remains startup in consumer accounting, while the producer begins qualification internally on it; the final exported tick also has distinct counting behavior. No inferred relabeling or count relaxation was added. The exact corrected final runner, CLI/import/schema/count behavior, source allowlist and final TIP must still pass root's final integration gate. The inspected producer is not final approved source; root reported active source-only fixes for terminal no-fault identity/counter comparison and finite elapsed validation. No execution receipt, runtime manifest, actual reviewed asset template, or frozen final candidate is supplied by this review.

## Independent integrity and coverage

Package: `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-combined-recovery-operations-private-r6-7f39_qy0`.

Independently verified all 49 manifest-listed entries before code review; each digest matched, with no unlisted package item other than the manifest itself. Independently parsed all 10 Python files with `ast.parse`. Compared all 11 package code files against R5: only `qualification_evidence.py` changed; the other 10 are byte-identical. AST comparison independently confirms only the three named methods changed. Read the full focused executable diff and explanatory changes, plus surrounding inherited validators/windows/events sufficient to assess the increment. R5 manifest-listed contents remain unchanged.

Verified SHA256 values:

- R6 `REPORT.md`: `70c8bc0c2f2f1c56d428516b78000cf5813b5bacec7a0a7400829a11a5390aff`
- R6 `SHA256SUMS.json`: `4b0ea13281c859ef38ac6ddb62a3bf3f642b3fba14abc61ef6993c0fda0d30b8`
- R6 `r5-to-r6-focused.diff`: `b5f943cfe5d6020785ec5b683027c79be73f14403eaa5c1c62b28ef3f5c17e0d`
- R6 `qualification_evidence.py`: `ea398d2260c405a6115808c3c5f3f975974974e62bc6cb88be61c414e0c941b4`
- R5 manifest: `e6667fcb51a7cf8500ab694e8eda79fdb51871e92fe2336fbd915181c9af63e1`
- Original SUP: `d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b`
- Original passive helper: `b0a15095651c9147eb451b27eb815ec4ea4cc984f2d293d3617c4cee89a15426`
- Original sampler: `f862b739cbe7eb543ccab304203c71c62a43014530fa2da9a7655cba293665d3`

The unchanged executable comparison preserves R5 final integrity versus fresh strict admission, the private-build finally cleanup, whole-recovery Host-sampling exclusion, managed-service exclusions, strict lifecycle and terminal schemas, preservation/mode fences, and source/build gates. Those mechanisms were not rerun or newly certified at runtime.

Only static reads, hashes, AST inspection, and this report write occurred. No reviewed package imports/functions, executable tests/mocks, Registry, builds, process/status/network/browser/native/service/tunnel operations, or repository/source/primary/index writes occurred. No subagents were spawned. All runtime qualification and process-tree completion remain unobserved.
