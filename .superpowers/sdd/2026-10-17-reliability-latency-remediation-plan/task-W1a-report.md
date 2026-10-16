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

## Independent-review correction: runtime Start / bootstrap integration

The first independent review correctly found an integration gap: the DOMContentLoaded hook ignored the boolean Auth result, Start accepted token presence, and bootstrap's status-only 403 path could still erase preserved credentials. This correction supersedes the initial caller-audit conclusion above; local Auth tests alone did not establish the runtime gate.

- Added current typed Auth state publication, subscriptions, `isVerified`, `getCheck`, `getGeneration`, and `whenReady`. Start can await the already pending initial verification, but unavailable results require an explicit verification retry. Token or generation changes invalidate prior verification immediately.
- ShellGuard disables Start pending/currently unavailable auth and discards a blocked queued click. Verification success enables a future explicit click; it does not replay Start. WebRTC's capability snapshot and ChromeLayout's minimal canConnect condition keep later capability updates from enabling unverified Start.
- Actual Start now checks current verification before opening signaling, then checks the same auth token/generation again before consuming asynchronous bootstrap success. Typed auth-invalid errors only trigger logout while the initiating auth generation is still current.
- Actual bootViewerShell bootstrap adapter parses JSON and emits finite failure codes. It recognizes `/api/viewer-bootstrap`'s existing middleware JSON (`401 {error:'Invalid token'}` or `Missing bearer token`) as application auth-invalid; `/auth/verify`'s distinct valid=false contract remains unchanged. Proxy HTML403/bad JSON/untyped status failures cannot trigger logout. Stale bootstrap errors cannot revoke new credentials.
- Authorized adapters now additionally touch bootstrap-controller.js/test, shell-guard.js/test, ChromeLayout, webrtc.js and one Auth fixture line in webrtc.test.js. New auth-start-integration.test.js runs the real Auth, ShellGuard, bootViewerShell adapter, Start handler, bootstrap controller, and capability computation in one VM; only platform/media/layout side effects use fake adapters. No live Viewer is created.

Red evidence before correction:

- Bootstrap controller regression: untyped proxy403 incorrectly became auth-required (5 PASS / 1 FAIL).
- Offline runtime integration: unavailable auth left Start enabled; a late old bootstrap401 cleared a new token (1 PASS / 2 FAIL). Existing real application Invalid token JSON logout still passed.

Final command after correction:

`node --test web-client/js/auth-start-integration.test.js web-client/js/bounded-request.test.js web-client/js/login.test.js web-client/js/auth.test.js web-client/js/bootstrap-controller.test.js web-client/js/shell-guard.test.js web-client/js/chrome-layout.test.js web-client/js/webrtc.test.js signal-server/test/web-asset-build.test.js`

Result: **308 PASS / 0 FAIL / 0 skipped**, exit 0. Covers unavailable verify → blocked Shell/direct Start → explicit verify retry without automatic Start → explicit Start + proxy bootstrap403 preservation; actual application bootstrap401 logout; stale bootstrap401/new-token isolation; stale successful bootstrap/new-unverified-generation isolation; original WebRTC and layout regressions; and only temporary-output builds. `git diff --check`: PASS.

Live origin/public/browser/device/production Viewer/input and long-run acceptance remain NOT RUN. No services, tunnel, native input, runtime config or production dist changed. Parent owns the follow-up independent review.
