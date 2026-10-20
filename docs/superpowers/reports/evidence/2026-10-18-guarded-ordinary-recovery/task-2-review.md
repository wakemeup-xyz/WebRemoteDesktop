# Task 2 independent spec and quality review

## Spec Compliance

- ✅ Spec compliant for Task 2. Reviewed exactly `2cc162a282cde5846232026db8265b67592aa798..7181b7f55beab8a419e92c8e4de52185fd194781`: one commit, three paths, 306 insertions and 15 deletions. The supplied review package was read once. All three brief-listed paths have corresponding implementation/test changes.
- ✅ `web-client/js/webrtc.js:2864` implements the required exact URL selector: absence returns null; a single exact enum succeeds; empty, unknown, duplicate and unreadable selection fails with fixed code/message. `web-client/js/webrtc.js:2874` captures it before proof/auth/admission work, and `:2876` rejects guarded/proof conflicts while preserving the existing proof-only branch.
- ✅ `web-client/js/webrtc.js:2890` preserves the ordinary request body and adds only the fixed conditional `initialPolicy`. `:2892` retains episode, sequence, token, auth-generation and verified-state checks, adds selector/proof revalidation, and prevents publication on stale or malformed results. Failure adds no fallback or automatic ticket request.
- ✅ The product diff is confined to the parser and admission boundary. No welcome, reconnect, reset/rebind, media/input, acquisition-intent or watchdog implementation is modified. No client epoch, occupancy or generation authority is added.
- ⚠️ Cross-task requirements remain outside this task gate: guarded server issue/consume atomicity, proof coexistence, pending-human priority and retained-owner protection are Task 1 responsibilities. Its approval at `2cc162a` and root's eight ephemeral API checks were supplied as predecessor evidence, not independently repeated here. Full guarded ownership recovery through current Host/reset/rebind/media gates and final whole-increment review remain integration checks; this review does not mark them complete.
- ⚠️ The runner's fresh authenticated shell, second navigation, selector/auth readiness checks, exactly one actionable Start/API observation and cleanup are later-task responsibilities (`docs/superpowers/specs/2026-10-18-guarded-ordinary-recovery-design.md:79`). This Viewer change provides their adapter contract; it does not implement or qualify the runner.

## Strengths

- `web-client/js/auth-start-integration.test.js:346` extends the existing VM fixture around actual product behavior rather than copying admission logic. The added scenarios cover invalid selectors, malformed proof conflicts, exact ordinary/guarded bodies, late policy/proof/auth/episode changes, newer request preservation, denial, timeout with late completion, duplicate Start, welcome-to-resume behavior, manual reconnect and socket denial.
- `web-client/js/auth-start-integration.test.js:96` retains real bootstrap-failure cleanup for the guarded fixture. The fake boundary is Socket.IO construction/media, while product Start, parser, bounded request, admission decisions and socket listeners execute normally.
- `web-client/js/input-recovery.test.js:1803` adds actual local-draft and input/control-gate checks for guarded denial and selector removal; it verifies retained admission, blocked input, no replay/reset writes and no control-acquire emission.
- `web-client/js/webrtc.js:2864` keeps the new interface small and the failure text fixed, without exposing URLs or request data in diagnostics.

## Issues

- Critical: none found.
- Important: none found.
- Minor: none found.

## Focused checks and evidence

- State check identified HEAD `7181b7f55beab8a419e92c8e4de52185fd194781`, the four pre-existing dirty documentation paths and untracked `signal-server/node_modules`. No source, index, branch, service or runtime writes were performed. This private review file is the sole write.
- Named unchanged-code risk: an explicit caller or automatic reconnect could bypass the admission contract or remint a ticket. One focused call-site inspection found the two explicit callers at `web-client/js/webrtc.js:2721` and `:7450`, both awaiting this method and checking startup ownership before continuing. Socket auth construction at `:3003` carries existing ticket/resume identity; the welcome listener at `:3825` replaces consumed-ticket auth with server resume identity. The added real listener tests cover repeated connect without new admission. No bypass or new automatic remint was found. No broader source crawl was performed.
- Inspected persisted RED evidence: `task-2-red.log:37` records 36 tests, 21 pass, 15 fail, duration 1402.961867 ms; failures match missing selector/conflict/policy/race behavior. The predecessor and exit 1 are recorded in the implementer report.
- Inspected persisted final evidence: `task-2-final.log:94` records 93 tests, 93 pass, zero failures/cancelled/skipped/todo, duration 9213.067194 ms; exit 0 is recorded in the report. No warning, uncaught-error or failed-test noise was found in the final log. No tests, builds, npm, network/API, browser, native, proof or service operations were rerun.
- Existing Host reset-ACK `58fd` and Viewer intent/watchdog `3046` increments are outside the three-path diff and were not re-reviewed or treated as freshly qualified.

## Assessment

**Task quality: Approved.** The change is a small admission-boundary extension with meaningful real-method regression coverage and preserved ordinary/proof/resume behavior. No task-scoped correction is required.

**Deployment and acceptance:** Source-only, **NOT DEPLOYED**. Production loading and acceptance are **NOT_RUN**, including fresh baseline300, within-grace recovery, after-grace recovery and fresh continuity10800. Business input, visible effects and physical input remain **NOT_RUN**. Offline approval is not runtime or long-session acceptance.
