# Task 4 independent review — ad0b723..b6570f7

## Spec compliance

- ❌ Issues found: the final no-fault observation does not preserve the strict continuity identity/progress contract; see Important I1 below.
- ✅ The reviewed package includes both assigned implementation/test files and the narrow versioned current-freshness/adapter-construction amendment. Recovery intentionally retains lifetime outage metrics while using current freshness and observed progress (`scripts/ordinary_session_recovery.py:669`, `:774`); this agrees with commit 1422671 and is not a defect.
- ⚠️ Cannot verify from this diff: concrete Task 5 fault provenance/capability/install/handler behavior; the adapter is intentionally pending and missing-module behavior fails before browser creation (`scripts/ordinary_session_recovery.py:1124`, `:1296`). Real deployed source/origin attestation, actual browser startup field availability and cross-task parent-consumer acceptance of startup rows remain root-owned integration gates. The private consumer is not evidence that those source obligations have been met.
- ⚠️ Predecessor producer/cursor/HTTP code and strict helper/sampler/SUP hashes are outside the changed hunks. This package does not modify their implementations; root should retain its separate source/hash gate. This review does not claim production or long-session qualification.

## Strengths

- Manifest validation is bounded, exact-key, duplicate-rejecting, type-strict and pinned before optional imports. Rechecks preserve file identity/hash and time validity, while persisted source evidence explicitly stays root-attested (`scripts/ordinary_session_recovery.py:503`, `:518`, `:535`, `:1272`).
- The owned lifecycle handles partial startup, reserves manager-stop time, disarms before capture and keeps independent browser/manager teardown without asserting process exit (`scripts/ordinary_session_recovery.py:586`, `:626`, `:1346`). The cancellation and close-failure tests exercise observable ownership outcomes (`scripts/test_ordinary_session_recovery.py:780`, `:1069`, `:1113`).
- Startup uses one actual UI click with ongoing owned page/status observations, strict selector/auth/object checks and bounded admission event counts; no runner admission request or fake product event is introduced (`scripts/ordinary_session_recovery.py:869`, `:922`, `:966`, `:1008`, `:1032`, `:1321`).
- Recovery classification binds actual server event order and current identity, distinguishes matched generic rebind failure from incomplete coverage, and keeps continuity interrupted. Sticky Host/log alarms are drained even on rejected samples (`scripts/ordinary_session_recovery.py:733`, `:798`, `:827`, `:1244`; `scripts/test_ordinary_session_recovery.py:959`, `:1260`).
- Evidence projections and exact validators exclude raw auth/Host/session/error/URL material and enforce bounded files and immutable scope labels (`scripts/ordinary_session_recovery.py:1047`, `:1062`, `:1280`).

## Issues

### Critical

None found.

### Important

**I1 — Final no-fault export can retain PASS after continuity identity or counter regression.** `scripts/ordinary_session_recovery.py:1225–1236`, `:1263–1265`, `:840`.

The final branch compares session/admission/socket hashes, then checks `_gates()` using a newly constructed one-sample ContinuitySummary. Unlike the recovery branch, it never compares the final sample's PC/attempt/generation/lease/path identity against the qualified no-fault identity, nor its counters against the preceding sample. Final rows intentionally skip `model.observe()`, and the returned continuity result therefore remains the earlier PASS. A final ready sample with the same socket/session/admission and build but a different `leaseEpoch` or `pathIdentity` passes every final check and can exit 0; a counter regression similarly escapes the historical comparison. The unchanged reducer explicitly rejects these changes (`scripts/passive_session_soak.py:278–287`, `:309–326`), so replacing that check with a fresh probe weakens the binding no-fault contract at the final required observation.

Preserve the original qualified duration, but validate the final no-fault identity and counters against the existing continuity state (or apply a final validation-only reducer observation without extending qualified time). Any mismatch must veto PASS and preserve the first failure. Add a focused fake-run test with a fully qualified baseline followed only in final export by a changed lease/path or regressed frame counter, plus an unchanged final-sample success control. Existing final tests check Host change/build/failure cleanup but do not cover a completed no-fault PASS through this boundary.

### Minor

None recorded.

## Assessment

**Spec compliance:** Needs fixes.

**Task quality:** Needs fixes.

The implementation has careful privacy and cancellation ownership, with meaningful boundary tests. I1 nevertheless permits a misleading successful qualification at a mandatory terminal observation and should be fixed before accepting this task.

## Review evidence and bounds

- Read the brief, integration context, exact shared contracts, global constraints, completion report and superpowers 6.3.0 task-reviewer contract.
- Reviewed the canonical 134667-byte package `review-ad0b723..b6570f7.diff` (1422671 and b6570f7), in bounded passes; repeated only output that the tool had truncated. Changed implementation/tests were judged from that package; an initial declaration-only outline was also read.
- Named focused outside-diff checks: (1) final-export equivalence risk — read unchanged `ContinuitySummary` identity/counter/result logic; (2) lifecycle deadline/atomic-write ownership risk — read unchanged `cleanup_allowance`, `lifecycle_stage`, and `atomic_evidence`; (3) browser-projection field compatibility risk — searched existing proof storage and admission-generation definitions in Viewer source. These checks do not establish full browser integration.
- Read `.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-4-final-after-import-audit.log`: 132 tests, 16.210 s, OK, pristine output. The report records exit 0 after the last edit. No tests were rerun.
- No source/index/git mutations, optional runtime imports, browser/network/service/status/build/npm operations or subagents. Only this requested private review report was written.
