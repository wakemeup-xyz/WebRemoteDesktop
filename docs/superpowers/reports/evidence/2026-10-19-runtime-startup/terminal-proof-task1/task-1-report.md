# Task 1 implementation report

Status: DONE

Scope: the two authorized new Python files only; no Git/index/commit commands or operations, no child agents, no operational supervisor import/main, and no real process/network/service/browser/Host/sample/build/run acceptance operations.

## Changes

- `scripts/terminal_scan_proof.py`: public worker-only `instrument_terminal_registry(...)`, detached bounded `terminal_proof_snapshot()`, `TerminalCoverageError`, and independent `validate_terminal_coverage(...)`.
- The adapter inherits actual Registry scan/state/signal/cleanup/result decisions. It wraps the existing process reads and diagnostic contexts rather than duplicating Registry's scan algorithm. Before evidence comes from the same scan's actual resolve/create_time/status, binds to the next specific process proxy and direct children call, and expires on intervening reads or nested attribution.
- A direct injected NoSuchProcess with exact integer `error.pid` may trigger exactly one raw same-PID resolve and, if present, birth/status/birth. These extra reads bypass module35 recording and preserve its pending event. The original exception object is re-raised, and the original note then generates the unchanged raw gap. Proof completion binds gapIndex, role/stage/scan/event, full metadata, registration provenance and both clocks.
- The consumer independently checks exact evidence schemas, finite non-bool numbers, bidirectional event/gap/proof correspondence, final ownership status for every identity, original signals/coverage/diagnostic failure rules, and explicit 32-proof/32768-byte/1-second limits. It returns a separate prospective assessment and retains raw unexpected coverage.
- Proofs preserve actual psutil status strings; only known alive statuses qualify for before, while same-birth terminal requires zombie. Stable reused proof never changes final Registry `reused` into `exited`.
- Existing gap-free state AccessDenied/OSError unknown/skip behavior remains eligible under the existing final ownership gates; no new global state-error veto.
- Overflow/failure is sticky. Oversize proof data is replaced only by a failed bounded envelope, never a successful truncated snapshot. Candidate count remains bounded independently of discarded data.
- `scripts/test_terminal_scan_proof.py`: 43 pure fixture tests plus parameterized negative matrices. The full portable supervisor bytes are SHA-checked before extracting/compiling only Registry and Capacity AST; module35's actual bytes are checked too. Process and all clocks are fake. Real Registry state/scan/result/cleanup methods execute.

Verified immutable input SHA256:

- SUP: `d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b`.
- Actual module35: `00bd2366d770b9e65b272acadf54027c77cde48050b12106a2fd79338059f82b`.

## Meaningful RED

Initial module exposed the required interfaces but delegated to original instrumentation and deliberately had no terminal policy implementation. The fixture loaded the actual SHA-pinned Registry AST and module35; normal source/fixture construction succeeded. The absent positive exercised real state-alive → direct children NoSuchProcess → raw gap and failed because terminal evidence was unavailable. The alive-after negative passed. This was a missing-behavior failure, not an import/syntax/fixture failure.

Command (cwd: the authorized worktree):

```bash
PYTHONDONTWRITEBYTECODE=1 /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B -m unittest discover -s scripts -p 'test_terminal_scan_proof.py' -v
```

Actual initial output:

```text
test_alive_after_rejected_even_if_final_exited ... ok
test_direct_children_absent_keeps_raw_gap ... ERROR
...
terminal_scan_proof.TerminalCoverageError: terminal proof unavailable
Ran 2 tests in 0.051s
FAILED (errors=1)
```

After minimum implementation, those 2 tests were GREEN (`Ran 2 tests in 0.051s`, `OK`). Further matrix expansion exposed two incorrect fixture expectations (changing null parent to null, rejecting allowed wall=0), and a byte-boundary fixture initially generated only 27603 bytes. Those fixture construction/expectation issues were corrected and are **not** claimed as behavioral RED. No required negative cases were removed.

## GREEN

Same exact command as above; final actual output:

```text
Ran 43 tests in 5.221s
OK
```

The tests cover absent/zombie and stable-reused proof with final exited; persistent final reused/unknown/alive rejection; process-call parity for empty and successfully registered children; exact additional calls for absent/zombie; same exception object in original Registry's catch; byte-identical original diagnostic/gap/coverage snapshots under constant fake clocks; inherited cleanup/result/deadline code; unsupported/error/PID/operation/registration/provenance/nesting failures; original state unknown skips; both directions of proof/event/gap associations; exact 32/33 proofs, exact 32768/32769 compact UTF-8 bytes, exact 1.0/1.000001 seconds, NaN/bool/missing/backward clocks; sticky producer overflow; diagnostic dropped/overflow/failure; and a historical fourth-attempt-shaped seven-exited/no-proof rejection.

## Self-review

- No change to Registry's scan catch, queueing, _add authority, final status, signal behavior or deadlines. No copying/reimplementation of its traversal. Raw NoSuchProcess pending attribution survives the extra observation.
- Before must come from original same-scan reads and the actual next resolved proxy; nested/intervening operations invalidate freshness. Invalid unused before information alone does not set a global failure.
- Independent consumer does not trust entryUnchanged/outcome alone: it verifies both births, status, clocks, exact PID, final metadata/provenance, complete associations and every final status. Additional synthetic consumer corruption fixtures test this boundary without inventing runtime receipts.
- Whole compact snapshot bytes are checked, including envelope and limits. Overflow cannot be hidden through snapshot clearing because failed/overflow and total candidate count remain sticky.
- Unknown status and same-birth alive after errors fail closed. AccessDenied/OSError in the original state skip path remains unchanged; corresponding new after-observation errors cannot create a proof.
- No raw error text, command line, environment, discovery list, input or coordinates are stored.

## Boundaries and remaining work

Independent root review: NOT_RUN by this implementer; root owns that next step and Git submission.

Task 2/R5 integration, operational supervisor/production runner changes, loading/deployment, old test suites (561/166/19 etc.), real process observations, real services or tunnel changes, browser/Host/sample and real acceptance: **NOT_RUN**.

This is a prospective narrow acceptance policy, not literal equivalence to old acceptance. Old FAIL/raw gaps/old source41/primary/R4 remain untouched. It does not reconstruct missing children or prove a complete process tree; assessment keeps `fullProcessTreeExit='unknown'` and `completeProcessTreeExitEstablished=false`. Finite extra OS-call count does not guarantee hard-real-time completion; the measured one-second bound rejects overruns.

Known implementation coupling: the adapter deliberately consumes the pinned module35 diagnostic context/factory internals. Future module35 schema/internal changes require re-review and fail-closed fixtures. Current module35 SHA is verified by this portable fixture.

## Fix round 1 — ownership envelope exact schema

Status: DONE. Addressed the sole Important P2 in `task-1-review.md`.

Changes: `validate_terminal_coverage` now requires the original Registry's exact five ownership keys (`identities`, `signals`, `allRecordedIdentitiesExited`, `completeProcessTreeExitEstablished`, `coverage`) before reading ownership fields. The schema matrix no longer excludes ownership. A focused real-consumer test retains the valid original-envelope positive and checks rejection of `unexpectedSchemaField` plus each of the five missing-key variants. No policy or operational behavior was broadened.

Meaningful focused RED command:

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=scripts /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -B -m unittest test_terminal_scan_proof.TerminalProofTests.test_ownership_envelope_exact_original_schema test_terminal_scan_proof.TerminalProofTests.test_all_exact_schemas_and_limits_reject_extras_and_bool -v
```

Actual RED (tests changed first, production validation not yet changed):

```text
test_ownership_envelope_exact_original_schema ... (extra='unexpectedSchemaField') ... FAIL
test_all_exact_schemas_and_limits_reject_extras_and_bool ... FAIL
AssertionError: TerminalCoverageError not raised
Ran 2 tests in 0.016s
FAILED (failures=2)
```

The extra ownership field was actually accepted by the previous consumer; this is a behavioral negative failure, not a fixture/import failure. Each missing-key case and the valid original positive were exercised by the focused test.

After adding the exact ownership `_keys` check, the **same command** produced:

```text
test_ownership_envelope_exact_original_schema ... ok
test_all_exact_schemas_and_limits_reject_extras_and_bool ... ok
Ran 2 tests in 0.089s
OK
```

Self-review: the required key set matches actual pinned Registry.result's five-key envelope. The public wrapper still translates malformed/missing-key evidence to TerminalCoverageError; extra keys now fail at `_keys`. Existing valid original ownership is explicitly accepted. Only the two authorized source/test files and this report were changed. Git/index/commit, agents, old suites, Task 2, deployment and all real operations: NOT_RUN in this fix round. Independent root re-review remains pending.
