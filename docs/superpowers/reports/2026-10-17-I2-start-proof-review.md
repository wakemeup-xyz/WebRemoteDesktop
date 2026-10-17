# I2 验收启动证明修订与复审

# I2 production acceptance Start proof repair

Status: DONE

Baseline: `22c18541215b34818db5916d7bd1fd26af51e227`.
Implementation commit: `e2275a59c86970463b240db9ffcc5715b69556cf` — `fix(acceptance): require verified UI Start before passive soak`.

## Implementation

- Replaced the conditional Start skip with mandatory `start_via_ui(page)`, under the `start-ui` stage. The helper waits up to 30 seconds for the real core-installed/auth-verified shell, the shell/core marks, and the visible/enabled `#startBtn`.
- Reads a fixed projection of booleans and relevant mark counts, bounded to a maximum of 1024 marks; no shell mark detail, credentials, session objects, raw attempt/socket/PC IDs or log contents cross the evaluation boundary.
- Requires a fresh page throughout the readiness wait: no existing socket, PC, connection attempt, queued Start, or prior `start-click` mark. Issues exactly one ordinary Playwright locator click, without force or direct application start calls. Requires the shell Start mark count to change from zero to exactly one; a missing/duplicate mark cannot become successful proof and is never retried.
- Readiness polling, individual browser operations, and the click share one deadline. Browser exceptions become fixed privacy-safe reasons: `start-ui-unavailable`, `start-ui-deadline`, `start-ui-not-fresh`, or `start-ui-click-unproven`.
- The summary now always contains `startProof`: either `NOT_VERIFIED` or the verified booleans and literal 0/1 mark counts. Proof failure exits before the media sampling stage. The soak clock still starts only after actual media readiness. Existing strict continuity/three-hour logic, sampler identity, fresh-zero-Viewer/one-use admission flow, normal reset behavior and browser-close cleanup are unchanged.

## TDD and verification evidence

All commands were run from `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`.

1. RED: `python3 -m unittest scripts.test_passive_session_soak.StartUiTest` — exit 1; 5 methods, 18 failing subcases. Expected failure: `AssertionError: unexpectedly None : Start must be a required asynchronous proof step`. Production helper did not yet exist. No import/setup errors.
2. GREEN focused: `python3 -m unittest scripts.test_passive_session_soak.StartUiTest` — exit 0; `Ran 5 tests in 0.111s`, `OK`.
3. Full owned Python module: `python3 -m unittest scripts.test_passive_session_soak` — exit 0; `Ran 18 tests in 0.304s`, `OK`.
4. Related sampler suite: `node --test scripts/passive-session-sampler.test.js` — exit 0; 10 tests, 10 pass, 0 fail, duration 193.359399 ms.
5. `git diff --check` and `git diff --cached --check` — exit 0, no whitespace errors.
6. Exact-path staging and commit: `git add scripts/passive_session_soak.py scripts/test_passive_session_soak.py`; `git commit -m 'fix(acceptance): require verified UI Start before passive soak'` — exit 0; two owned files, 155 insertions, 6 deletions. Git index empty after commit.

The production async helper is exercised through minimal fake Page/locator dependencies with a controllable clock. Tests cover delayed authentication/button readiness followed by exactly one click; missing shell/client/marks/core; permanently hidden/disabled button and unverified auth; prior socket/PC/attempt/queued Start/prior click; absent/duplicate post-click mark; and a private exception canary reduced to a fixed reason. They assert outcomes and click behavior, not source-string presence.

## Files and self-review

Committed only:

- `scripts/passive_session_soak.py`
- `scripts/test_passive_session_soak.py`

This report is the single task report in the plan's ignored SDD workspace. Existing dirty README/runbook/requirements/review-anchor files, the concurrent live-acceptance report, and the `node_modules` symlink were preserved and not staged. No other source or primary-checkout file was modified.

Self-review: inspected the complete owned diff, checked all failure branches precede media sampling, verified the single-click path has no retry or force, verified the proof projection contains only fixed booleans/counts, and checked the soak timing/summary and `finally: await browser.close()` remain intact. No outstanding findings or concerns.

Production browser/UI verification, services, network, native input, tunnel operations and three-hour acceptance: NOT RUN. This task supplies offline proof behavior and does not claim production acceptance. No reviewer was spawned; task review belongs to the controller.


# I2 Start proof scoped review

Result: **PASS**. No actionable Important findings in the reviewed change.

## Scope and evidence

Reviewed exact range `22c18541215b34818db5916d7bd1fd26af51e227..e2275a59c86970463b240db9ffcc5715b69556cf`, limited to `scripts/passive_session_soak.py` and `scripts/test_passive_session_soak.py`. Read the task brief, implementation report and review package; checked the complete diff against the current helper and relevant real Viewer/ShellGuard wiring, plus the I2 plan constraints. The review does not extend approval to unrelated production changes or dirty documents.

## Spec and quality checks

- `start_via_ui` waits asynchronously for shell/client availability, one HTML/core mark, installed core, verified authentication and visible/enabled Start. A missing or unavailable Start reaches a bounded failure instead of silently proceeding.
- Freshness is checked on readiness snapshots before clicking: no socket, peer connection, attempt, queued Start or earlier Start mark. The ordinary Playwright locator click uses default actionability, has no force/direct application invocation and is issued once. Subsequent polling requires exactly one shell Start mark; zero eventually fails and duplicate marks fail without retry. The actual HTML click handler records that shell mark and calls the guarded production start handler.
- One monotonic deadline bounds evaluate, locator checks and the click. Failure reasons are fixed privacy-safe strings. `run` labels the helper as `start-ui`, initializes `startProof` to `NOT_VERIFIED`, and cannot install the sampler or enter media/sampling stages after a proof exception.
- The projection returns fixed booleans and bounded relevant mark counts; it does not export credentials, shell mark details, raw connection identities, logs or native input content. Persisted success proof consists only of fixed booleans and literal 0/1 counts.
- Fresh-zero-Viewer checking, server one-use proof admission, ordinary guarded connection/reset behavior and owned-browser cleanup remain intact. No production/control source was changed. Sampler identity and strict continuity/three-hour requirements are unchanged, and the soak clock still starts only after actual media readiness.
- Added tests invoke the production asynchronous helper with minimal fake Page/locator objects. They cover delayed readiness and one click, unavailable readiness, stale connection/start state, absent/duplicate click proof and exception redaction. They assert behavior and outcomes rather than source strings.

## Validation boundary

Accepted the report's focused Python, full owned Python module and related sampler Node test evidence. Did not rerun supplied tests: inspection produced no concrete counterexample requiring execution. No browser, network, service, tunnel, native input, clipboard or Terminal actions were performed. This PASS concerns the offline Start proof repair only; production execution and three-hour acceptance remain unverified by this review.

Only this review record was written. No code, index, commit or existing dirty document was changed.
