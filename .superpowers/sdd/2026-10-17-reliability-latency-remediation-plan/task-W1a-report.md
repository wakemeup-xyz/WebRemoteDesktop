# W1a implementation report

Date: 2026-10-17
Status: implementation and self-review complete; parent task owns independent review and integration approval.

## Scope delivered

- Added `fetchJsonWithin` with an 8000 ms default deadline around the whole fetch + JSON operation. Timeout settles once and aborts the operation even when a fake fetch/body ignores abort. It emits only finite timeout/network/invalid-response errors and clears timer/listener resources. Already cancelled calls do not start fetch. CommonJS helper/login imports have no DOM, timer, or network effects.
- `Auth.verifyToken()` now returns the exact AuthCheck state/reason/status shape from W spec §4.1. Only local missing-token or 401/403 + JSON valid=false + the application's known errors (`Invalid token`, `No token provided`) mean unauthorized. 429/5xx, proxy HTML/JSON failures, network failure, and deadline failures preserve token.
- Verification captures token and generation; superseded results cannot clear new credentials. `Auth.init()` retains Promise<boolean> compatibility, and only verified returns true. Unavailable verification presents a fixed-position, explicit retry control that does not create a Viewer or automatically replay anything.
- Extracted login controller and DOM adapter. Duplicate pending submit reuses one operation; timeout permits an explicit later submit; disposal invalidates old callbacks; only the current controller may store token, navigate, or release its button. pagehide disposal plus persisted pageshow recreation supports browser Back/Forward cache without allowing the old operation to affect a restored page.
- Login source page loads RuntimeConfig/bounded-request/login local scripts. Build markers replace these with one local hash login bundle. The desktop graph places bounded-request before auth; source viewer.html adds that single prerequisite script. Viewer output still contains exactly one core script src.
- Determinism test copies one immutable temporary source snapshot for its paired builds, avoiding false mismatches when other task owners edit deferred sources concurrently. All builds use explicitly temporary outDir; no CLI default build/pretest/npm test ran.

## Ownership / changed files

- New: web-client/js/bounded-request.js and bounded-request.test.js; web-client/js/login.js and login.test.js.
- Modified: web-client/js/auth.js and auth.test.js; web-client/index.html; signal-server/scripts/web-asset-graph.js and build-web-client.js; signal-server/test/web-asset-build.test.js.
- Parent explicitly authorized necessary adapter: exactly one added bounded-request script tag in web-client/viewer.html; all other Viewer markup untouched.
- This report is the only additional file included in this task's commit. Pre-existing README/runbook/requirements/archive edits and sibling tasks' files remain excluded.

## Red / green evidence

1. Added real Auth fixture counterexamples before changing auth implementation. `node --test web-client/js/auth.test.js` initially returned 2 PASS / 1 FAIL: 503 removed the fixture token, while the definitive application 401 regression still passed.
2. Final command:

   `node --test web-client/js/bounded-request.test.js web-client/js/auth.test.js web-client/js/login.test.js signal-server/test/web-asset-build.test.js`

   Result: **30 PASS / 0 FAIL / 0 skipped**, exit 0.
3. Coverage: hanging fetch and hanging JSON, abort ignored, timer cleanup, finite failure reasons, pre-cancelled request, import side effects, 503/429 preservation, explicit application 401/403, unrecognized/malformed proxy responses, missing token, superseded token/generation, visible explicit retry, duplicate login submit, timeout followed by newer success and late old success, disposal, browser cache restore, no automatic password resend, deterministic temporary build, atomic failed-build preservation, built login VM submission, Viewer single script constraint.
4. One earlier combined run encountered a deferred bundle hash difference while M1 edited latency-monitor.js between paired builds; login and desktop hashes matched. This was a test-input mutation, resolved by snapshotting source before comparing builds. The full final suite above passed.
5. `git diff --check`: PASS.

## Caller audit and self-review

- Repository runtime search finds no caller of `Auth.verifyToken()` except `Auth.init()`; tests were migrated from the former boolean return.
- The only direct runtime `Auth.init()` caller remains auth.js's DOMContentLoaded hook; explicit retry also calls it. Both handle the Promise without treating unavailable as verified. No other caller needs migration.
- Existing webrtc.js callers use `Auth.logout()`; its public redirect/removal behavior is unchanged, with generation invalidation added. No webrtc.js/input.js/host.py/signaling.js edits belong to this task.
- Login consumes RuntimeConfig.getApiBase() and preserves existing password wire JSON / Authorization header / wrd_token session-first storage semantics. Legacy local token is still cleared after successful login.
- No password, response body, token, exception detail, or complete URL is logged. UI errors come from finite mapped reasons; raw server errors are not rendered.
- Retry/dispose/controller state changes do not start services, take control, or create a Viewer. No automatic network-mode, TURN, or address switch occurs.

## Validation boundaries / concerns

- NOT RUN: real origin/public auth, real browser/device or production Viewer, long-run tests, optical/media/input acceptance. The built login smoke is an offline VM with a fake fetch, not a live connection.
- No service startup/restart, production dist build, real input, tunnel read/change/restart, dependency install, or runtime configuration change occurred.
- Aborting a browser request does not prove the server did not receive its password request; the implementation never automatically retries it. Fetch implementations that ignore abort can continue internally, but late results have no login effects.
- Independent reviewer and final integration/release remain parent responsibilities. No known W1a blocker after self-review.
