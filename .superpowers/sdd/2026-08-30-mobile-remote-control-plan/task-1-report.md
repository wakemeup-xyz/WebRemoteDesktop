# Task 1 Report: Freeze contracts and test fixtures

## Files changed

- `web-client/js/touch-input-adapter.test.js`
  - Added deterministic fake-clock touch harness and tests for tap, double-tap,
    drag threshold, 550 ms long-press right-click, two-finger wheel/reset, and
    idempotent pointer cancellation reset.
- `web-client/js/mobile-text-input.test.js`
  - Added textarea event harness and tests for Unicode input diff, CJK
    composition, bounded deletion, Emoji scalar handling, missing beforeinput,
    and blocked lease behavior.
- `web-client/js/input.test.js`
  - Added the contract that desktop pointer binding ignores touch pointers,
    leaving touch delivery to the touch adapter.
- `web-client/css/viewer-layout.test.js`
  - Added static assertions for the mobile text input, touch-action, safe-area,
    keyboard inset, and minimum touch target hooks.

## Test commands and actual output

`node --test web-client/js/touch-input-adapter.test.js`

Failed as expected before the production adapter exists:
`Error: Cannot find module './touch-input-adapter.js'`.

`node --test web-client/js/mobile-text-input.test.js`

Failed as expected before the production adapter exists:
`Error: Cannot find module './mobile-text-input.js'`.

`node --test web-client/css/viewer-layout.test.js`

`tests 17`, `pass 16`, `fail 1`. The new test failed because
`id="mobileTextInput"` is not yet present in `viewer.html`.

`node --test web-client/js/touch-input-adapter.test.js web-client/js/mobile-text-input.test.js web-client/css/viewer-layout.test.js`

`tests 19`, `pass 16`, `fail 3`: the two expected missing-module failures and
the new layout assertion failure; all pre-existing layout tests passed.

`node --test web-client/js/input.test.js`

`tests 17`, `pass 15`, `fail 2`. The new touch-isolation test failed with
`1 !== 0`; an existing `blur resets keyboard state but leaves control ownership`
test also failed because no reset payload was emitted. No production files were
changed to mask either failure.

`git diff --check`

Passed with no whitespace errors.

## Commit

Implementation commit hash: `4bf35c394f580a6859afdf417dc6ce8bc9a77abd`.

## Remaining concerns

- Task 2 must add `touch-input-adapter.js` and make the touch tests pass.
- Task 3 must add `mobile-text-input.js` and make the text tests pass.
- Viewer DOM/CSS still lacks the mobile input and keyboard-inset hooks.
- The pre-existing blur failure in `web-client/js/input.test.js` remains open;
  it is unrelated to the new fixture files.

## Fix round 1

### Files

- `web-client/js/input.test.js`
  - Extends touch isolation through down/move/up, cancel, lost capture, and
    touch-originated wheel on both `remoteVideo` and `relayImage`.
- `web-client/js/touch-input-adapter.test.js`
  - Freezes `unbind`, idempotent `reset`, `getSnapshot`, and explicit
    `clickButton('right')` behavior with the deterministic harness.
- `web-client/css/viewer-layout.test.js`
  - Scopes static requirements to `#mobileTextInput`, `#mobileInputDock`, and
    `#mobileInputDock .control-btn` instead of global CSS occurrences.

### Commands and exact result summaries

`node --test web-client/js/touch-input-adapter.test.js`

Exit 1. `Error: Cannot find module './touch-input-adapter.js'`; `tests 1`,
`pass 0`, `fail 1`.

`node --test web-client/js/touch-input-adapter.test.js web-client/js/mobile-text-input.test.js web-client/css/viewer-layout.test.js`

Exit 1. `tests 19`, `pass 16`, `fail 3`: missing
`./touch-input-adapter.js`, missing `./mobile-text-input.js`, and the expected
missing `id="mobileTextInput"` layout fixture.

`node --test web-client/js/input.test.js`

Exit 1. `tests 17`, `pass 15`, `fail 2`: the existing blur test still fails
without a reset payload; the strengthened touch-isolation test fails with
`10 !== 0`, proving current desktop handlers emit envelopes for the complete
touch paths on both render surfaces.

`git diff --check`

Exit 0 with no output.

### Commits

- `71550a1c40f37ce8c6af5575ee1dde9835de65fd` - strengthened Task 1 red
  fixtures.
- Report evidence update committed separately after this section is added.

### Self-review

All three review findings are represented by deterministic contract tests. The
tests intentionally remain red until later tasks add production adapters,
DOM/CSS, and touch isolation in `Input`; no production module or v2 envelope was
modified in this round.

### Remaining concerns

- Future implementation must honor the exact fixture selectors
  `#mobileInputDock` and `#mobileTextInput`.
- The existing blur test failure remains outside Task 1 scope and should be
  investigated independently rather than masked by the mobile implementation.
