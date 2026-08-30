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

Commit hash: `10b54a20c36df9a454efd369743c5970096e070b` (amended after report update).

## Remaining concerns

- Task 2 must add `touch-input-adapter.js` and make the touch tests pass.
- Task 3 must add `mobile-text-input.js` and make the text tests pass.
- Viewer DOM/CSS still lacks the mobile input and keyboard-inset hooks.
- The pre-existing blur failure in `web-client/js/input.test.js` remains open;
  it is unrelated to the new fixture files.
