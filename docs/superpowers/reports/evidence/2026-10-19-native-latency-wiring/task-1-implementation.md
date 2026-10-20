# Task 1 implementation report

Date: 2026-10-19. Status: DONE, pending independent spec/quality review by root.

## Scope and implementation

Worktree: `/Users/macstudio1/.codex/worktrees/controlled-latency-wiring/WebRemoteDesktop`.
Root supplied branch `codex/controlled-latency-wiring`, task base `b8e864e0951c11563a66fe3151505e5a13cdbb59`.
No index, commit, checkout, service, build, browser, network, native input, runtime log or process operation was performed.

Owned source/test diff:

- `web-client/js/latency-monitor.js`: one private controlled slot; five specified APIs; private source references; exact scalar evidence projection; immutable 10000ms deadline; safe saturated counters; sticky identity/clock/conflict/budget/observer errors; ID-bound clear/finalize; every matching read freshly fences scope, lease, canonical stream, PC and applicable selected-send/reliable-ACK/socket object+ID. A completed finalized row can still be downgraded by a changed fence.
- `web-client/js/latency-monitor.test.js`: original 24 tests retained; 105 offline controlled tests added, using deterministic clocks and in-memory transport objects.
- This report is the only additional task-owned document.

The controlled APIs use their own processing-time validation and retain raw event clocks separately; they never call M1's `clock()` with stored event clocks. Controlled calls never add pending/tombstone entries, change outcomes, add metric names or samples, install timers/listeners, or initiate sends. `onPostApplyFrame` copies the independently validated matched/fresh/after-applied M2 projection before preserving the existing product path and return value. ACK can arrive after the video's presentation callback; send remains the ordering lower bound for both.

Finite actions use the actual controlled workload, confirmed with root: mouse `{wheel,down,move,up}`, keyboard `{text}`. Source: `scripts/turn_controlled_scene_lab_runner.py:290` through its `_input_spec` branches ending at line 324; `prepare_lab_input` calls `Input.prepareLabInput` at line 330. `web-client/js/input.js:2437` prepares the reservation but `_canSendInput` at line 2459 only applies product gates and does not enumerate actions. Product keyboard aliases, key/batch, click/dblclick, reset and command are therefore not admitted by the slot. Root will record this clarification in the shared ledger/spec.

## RED and iteration

Node executable for every test below: `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node`.

Initial RED command, before source implementation:

```sh
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-name-pattern='native latency:' web-client/js/latency-monitor.test.js
```

Actual result: exit 1, tests 1, pass 0, fail 1, duration 140.928355ms. Failure: `TypeError: m.beginControlledInputEvidence is not a function`, test at `latency-monitor.test.js:435`, assertion call line 446.

After implementing the slot, that initial regression passed. During expanded tests, one run produced 83 pass / 3 fail: two source-fence tests exposed repeated read-side increments of the invalid-observation counter; the implementation now increments rejected observations while read fences only invalidate evidence. The third failure was a maximum-ID fixture's old ACK lease, corrected to use the same reserved maximum lease. An additional self-review fixed overflowing begin deadlines before assignment, validated PC shape, and ensured explicit terminalReason retains precedence at first finalization exactly on the expiry boundary. No product ledger or timer changes were used to fix any failure.

## GREEN and compatibility

Final focused command (same as RED): exit 0, tests 105, pass 105, fail 0, duration **185.666471ms**.

Final compatibility command:

```sh
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test web-client/js/latency-monitor.test.js
```

Actual result: exit 0, tests **129**, pass **129**, fail **0**, duration **560.321946ms**. This includes all original 24 tests.

`git diff --check -- web-client/js/latency-monitor.js web-client/js/latency-monitor.test.js` passed during self-review; root owns final index and commit verification.

Coverage includes zero time, no accepted send, repeated begin/send, unrelated ID isolation including wrong-ID finalization/clear, exact duplicate and conflicting ACKs, rejected/duplicate/future-sequence ACKs, all identity/source fences, unordered former-reliable-channel rejection, completed-slot channel/socket/PC rotation, unused-branch rotation, invalid/nonfinite/negative/future/backwards clocks, ACK/frame before send, video before ACK, missing M2 freshness/provenance fields, 9999ms versus 10000ms expiration, late valid M2, immutable deadline across polling, missing-stage/explicit/sticky reason precedence, scope reset/replacement, observer exceptions, bounded printable IDs, maximum escaped ASCII metadata, counter saturation, projection copies/privacy, and no controlled impact on pending/outcomes/metric samples/timers.

## Self-review and limits

- There is one slot, one send/ACK/postApply projection and two fixed counters. No maps, timer or listener were added for controlled evidence.
- The serialized projection enforces <=8192 bytes (all retained strings are bounded ASCII, so JSON character count is byte count). Under current exact fixed fields and <=128-character IDs, valid metadata cannot reach that cap. Tests exercise maximum escaped legal identifiers and reject a >8192-character ID before occupying the slot. They do not fabricate an enlarged schema or serialize raw payload/source objects to force the defensive metadata-cap branch.
- Counter saturation is tested by seeding only private initial counter values in a VM copy of the source, avoiding a public test/mutation API and avoiding billions of observations.
- Reservation provenance is supplied by the caller's existing prepared Lab reservation; this pure monitor neither accesses InputTrace nor acquires product input authority. Task 2 remains responsible for genuine accepted-send/ACK-entry hooks and fresh live snapshots.
- All numerical fixtures are synthetic offline tests. Native/visible/physical acceptance remains **NOT_RUN**. No runtime collection or performance acceptance is claimed.
- No unresolved implementation concern identified in this self-review. Independent spec and quality review is still required before Task 2.
