## Spec Compliance

- ✅ Spec compliant within the correction scope. The `550ec9f..ad0b723` diff changes exactly the four authorized source/test paths and closes both direct-session and server-before-browser observation gaps.
- `signal-server/websocket/signaling.js:528`, `:542`, `:551`: all three existing rebind observation sites pass their existing local server-owned `sessionId`; no lease, admission, reset, ACK, timer or operation order changes appear. Handler tests verify confirmed correlation after applied ACK and cancelled/rejected/timeout outcomes from both failure branches.
- `scripts/ordinary_session_recovery.py:233`: rebind correlation requires exactly viewerId/previousViewerId/browserSessionId and bounded valid identity strings. The new-socket exception requires the directly logged stable session and a known previous socket; foreign session, unknown previous socket and unknown stable session cannot establish a transition.
- `scripts/ordinary_session_recovery.py:243`: the exception is limited to rebind events, including the pending-reset competing-correlation check. It does not mutate or adopt browser socket identities. The existing sessionHash projection receives the actual logged browserSessionId; no inference or projected schema widening is introduced.
- `scripts/test_ordinary_session_recovery.py:512`: positive and negative cases cover server-before-browser selection, direct hashes, known-current selection, each failure reason, foreign/unknown identities, missing/malformed/unknown fields, no implicit socket adoption and privacy canaries.
- ✅ One-shot cursor and local HTTP task/slot fences from the preceding fix are outside the correction hunks and remain unchanged. Their existing tests are included in the recorded affected-suite result.
- ⚠️ Task 4 classifier/integration and live qualification are outside this review. All runtime/businessInput/visibleEffect/physical acceptance remains NOT_RUN.

## Strengths

- The correction uses direct producer evidence and maintains a narrow consumer exception; no new authority or inferred identity is created.
- `signal-server/websocket/viewer-admission.integration.test.js:385`: the cancelled test exercises a same-ID replacement Host object through the actual handler, and all failure cases check REVOKING, no grant, and cleared pending gate.
- `scripts/test_ordinary_session_recovery.py:570`: malformed identity/credential/URL cases assert fixed schema failure and incomplete coverage without persistence of raw canaries.

## Issues

### Critical / Important

- None found in the correction diff.

### Minor

- `.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-3-correlation-python-green.log:1`: the successful Python run contains an asyncio slow-task diagnostic (0.106 seconds), so its output is not pristine. The implementation report accurately preserves and discloses it. No correction defect or widened deadline is shown; retain this caveat and prefer isolated scheduling-sensitive suite execution during the next already-planned validation, without suppressing the diagnostic. No rerun is required for this review.

## Quality Verdict

**Approved.** The implementation is a focused observation/schema correction with actual handler coverage and conservative identity/privacy tests. No new Critical/Important issue or regression of the prior ownership fixes appears in the scoped diff.

## Review Evidence

- Read the correction requirements, amended shared contracts/global constraints, appended correction report, and exact diff once. No broader source review or test rerun.
- Read the actual final Python log: 35 tests in 5.318 seconds, OK, with the single diagnostic above. Read the final Node summary: 32/32 pass, 0 failed/cancelled/skipped/todo, 2618.122531 ms.
- The report records behavioral RED before implementation: Node 28/32 passing with four missing-session assertions; Python 35 methods with 18 assertion/subtest failures and two errors. These are not represented as import-only failures.
- No source/index/HEAD writes, Git commands, network/browser/services/build/npm or subagents. Only this private review report was written.
