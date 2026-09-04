# Final fix wave report — control continuity review findings

## Status

DONE_WITH_NOT_RUN_BOUNDARY

The two Important review findings are addressed in the isolated
`control-continuity` worktree. The optional malformed-falsy `inputType` guard
(M1) is also covered. No service, tunnel, physical device, or public-path
operation was performed.

## I1 — touch reset latch recovery

### Root cause

`TouchInputAdapter.emitReset()` sets its private `resetSent` latch before
calling `sendMouse('reset', ...)`. When transport delivery fails, the method
returns without clearing that latch. `Input.setControlLease()` previously
cleared only the Input-level `_pendingMouseReset` state, so a fresh lease still
left the real touch adapter rejecting every subsequent pointerdown/move/up.

### Implementation

- `web-client/js/touch-input-adapter.js` now exposes a minimal `rearm()` seam;
  it changes only the adapter-owned failed-reset latch.
- `web-client/js/input.js` calls `adapter.rearm()` when a valid lease transition
  clears the authoritative mouse reset barrier, and after an authoritative
  applied/duplicate mouse reset acknowledgement.
- The integration regression uses the actual adapter through Input: a real
  touch drag creates a reset, transport is made unavailable so reset delivery
  fails, a new valid lease is installed, and the next real touch emits the
  expected down/up pair.

## I2 — reliable desktop sequence recovery

### Root cause

Viewer sequence allocation advances when a DataChannel/Socket accepts a
message, while Host commits `last_applied_seq` only after native execution
succeeds. Without an ACK-side reconciliation path, an `execution-failed` ACK
for sequence 1 left Viewer at sequence 1 while Host remained at sequence 0;
the next write became sequence 2 and every later write received
`sequence-gap`.

### Implementation

- `Input` keeps an in-memory pending ledger for accepted reliable mouse and
  command writes, keyed by the existing `inputIds` correlation.
- `acceptMouseAck()` now handles both `inputType: 'mouse'` and
  `inputType: 'command'` desktop ACKs. On `execution-failed` or
  `sequence-gap`, it rewinds only to the Host-reported `appliedSeq`, drops
  uncommitted later pending writes, and returns the original failure with an
  explicit `recovery: 'reconciled'` marker. The failed native action is never
  reported as applied.
- ACKs without a safe authoritative prefix, plus stale/invalid terminal
  statuses, enter an explicit `reacquire-required` recovery state and block
  further reliable writes until a fresh lease transition resets both sides.
- Applied/duplicate ACKs retire correlated pending records. Lease transitions
  clear the ledger and recovery state.
- ACKs with an explicitly present malformed/falsy `inputType` are rejected;
  omitted `inputType` remains accepted only for the existing legacy mouse-reset
  correlation path.

## TDD red evidence

The new regressions were run before the production changes and failed for the
intended reasons:

- `node --test --test-name-pattern='failed touch reset is rearmed|failed desktop execution ACK reconciles' web-client/js/input.test.js`
  - touch case had no post-lease down/up because the adapter latch remained set;
  - desktop ACK case returned `stale` and left the local sequence ahead.
- With the pre-fix truthy-only `inputType` check temporarily restored:
  `node --test --test-name-pattern='explicit falsy inputType' web-client/js/input.test.js`
  failed because an explicit empty/false/zero type incorrectly cleared the
  reset barrier.

## Verification

- Focused Input/Touch regressions: **51 passed, 0 failed**.
- Relevant WebRTC ACK/control cases: **23 passed, 0 failed**.
- Full Viewer JS/CSS suite:
  `node --test web-client/js/*.test.js web-client/css/*.test.js` — **575 passed, 0 failed**.
- Full Host suite:
  `PYTHONPATH=. python3 -m pytest -q` from `python-host/` — **212 passed, 0 failed**.
- Syntax checks:
  `node --check web-client/js/input.js` and
  `node --check web-client/js/touch-input-adapter.js` — passed.
- `git diff --check` — passed.

The Host suite emitted one existing `mss.mss` deprecation warning; no test
failed because of it.

## Scope and concern

Changed implementation/test paths are limited to:

- `web-client/js/touch-input-adapter.js`
- `web-client/js/input.js`
- `web-client/js/input.test.js`
- this final-fix report

Real Android/iOS/iPad browser behavior, physical Quartz execution, and formal
public/tunnel media-path acceptance remain **NOT RUN**. The fix is validated at
the Viewer contract/integration-test and Host-suite levels only.
