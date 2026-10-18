# Task 2 implementation report

Status: DONE. No commits created; staging and commits remain root-owned.

Worktree: `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`.
Predecessor product source: `2cc162a282cde5846232026db8265b67592aa798`.
Read: task-2 brief, binding global constraints, binding design's Viewer adapter/fresh UI startup section, and the supplied SDD implementer template. The root instruction overrides the template's commit step.

## Implementation

`WebRTC.readInitialAdmissionPolicy()` reads all `wrdAdmission` occurrences. No occurrence returns null. Exactly one `vacant-only-v1` returns that enum. Unknown, empty, duplicate, or unreadable location throws the fixed `invalid-initial-policy` error and fixed display text. Parsing is the first action of `requestExplicitViewerAdmission`, before proof, authentication and API work.

A present proof marker, including malformed JSON, conflicts with a selected initial policy and rejects before fetch or Socket.IO. Proof-only keeps the prior path and authentication shape. Ordinary API requests retain the exact existing session body when the selector is absent; the guarded selector adds only conditional `initialPolicy: 'vacant-only-v1'`. No client context, epoch, generation or handshake policy becomes authority.

After the bounded admission request resolves, the existing episode, request-sequence, token, auth-generation and verified-state fences also re-read the selector and proof marker before publishing `_viewerAdmission`. Selector removal/change or a newly present proof cannot publish or create a late socket. No retry, fallback, remint or automatic reclaim was added. Existing explicit Start and manual reconnect use this same method. Accepted ordinary welcome still replaces explicit Socket.IO authentication with the server's resume generation; automatic reconnect does not request an initial ticket.

No changes were made to input/media/reset/rebind/control grants, lease or grace policy, current socket/episode fences, welcome processing, existing acquire-intent correction, watchdog correction or server/proof behavior.

## Tests and TDD evidence

All commands below ran directly in the worktree with absolute Node executable `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node`. Tests use pure VM/fake DOM/fetch/socket boundaries; there was no network, browser, native, service, build, npm or installation operation. The fixtures execute real product parser, admission, Start handler, manual reconnect, bounded request, welcome/resume listeners and input gates. Guarded integration cases retain real bootstrap-failure cleanup. Platform socket construction is a fake `io` with the real product listeners; media initialization remains the existing fixture boundary. No product admission or recovery decision is copied into a fake method.

### RED on predecessor product

Command:

```
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test web-client/js/auth-start-integration.test.js
```

Output persisted in `task-2-red.log` beside this report. Exit 1; duration 1402.961867 ms. 36 tests, 21 passed, 15 failed, zero cancelled/skipped/todo. The product file was unchanged when this command ran.

Expected behavioral failures:

- Four unknown/empty/duplicate selector cases reached an admission/socket instead of failing before those boundaries.
- The unreadable-location test found the required parser absent.
- Three guarded/proof combinations reached the old proof-only connection instead of rejecting the combination.
- The valid guarded request omitted `initialPolicy`.
- Four late selector removal/change/duplicate/proof-addition cases overwrote the retained admission with the late ticket.
- HTTP denial and timeout requests lacked the required guarded policy.

Existing auth-generation, logout/login, episode cancellation and sequence-fence cases already passed. These are regression guards rather than claimed new corrections.

### Focused GREEN after product implementation

Command:

```
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test web-client/js/auth-start-integration.test.js
```

`task-2-green-focused.log`: exit 0; 36/36 passed, zero failures/cancellations/skips/todo; 1043.276174 ms.

Command:

```
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-name-pattern='guarded admission' web-client/js/input-recovery.test.js
```

`task-2-green-input-focused.log`: exit 0; 2/2 passed, zero failures/cancellations/skips/todo; 826.410028 ms. Actual Input draft/gate tests retain blocked text, the retained admission and closed control/input gates after denial or late selector removal. Neither response sends input/reset/replay/acquire.

Command:

```
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-name-pattern='explicit manual reconnect|Socket.IO admission denial|guarded timeout' web-client/js/auth-start-integration.test.js
```

`task-2-green-races-focused.log`: exit 0; 4/4 passed, zero failures/cancellations/skips/todo; 564.294128 ms. Covers both real manual policy paths, real admission-rejection listener stopping the owner, and an HTTP operation settling successfully after the real bounded timeout without late ticket publication.

After retaining the real bootstrap-failure cleanup in guarded fixtures, command:

```
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-name-pattern='invalid initial selector|proof marker plus|late guarded|guarded HTTP|guarded timeout' web-client/js/auth-start-integration.test.js
```

`task-2-green-failure-focused.log`: exit 0; 16/16 passed, zero failures/cancellations/skips/todo; 1623.964864 ms.

### Final verification, once after final source/test edits

Command:

```
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test web-client/js/auth-start-integration.test.js web-client/js/input-recovery.test.js
```

Complete output: `task-2-final.log` beside this report.

```
ℹ tests 93
ℹ suites 0
ℹ pass 93
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9213.067194
```

Exit 0. This includes all 39 auth-start integration tests and all 54 input-recovery tests. Final coverage includes duplicate UI Start (one admission/socket), failed HTTP, timeout plus late successful HTTP completion, selector races, proof races, auth logout/login and same-token generation change, episode cancellation, newer request response preservation, proof-only preservation, exact absent/guarded bodies, real manual reconnect, ordinary welcome-to-resume update, repeated real socket-connect handlers with no ticket issuance, rejection stopping ownership, and retained input draft/gates.

`git diff --check -- web-client/js/webrtc.js web-client/js/auth-start-integration.test.js web-client/js/input-recovery.test.js` passed, exit 0, no output.

## Changed paths and ownership

Only these source/test files were edited:

- `web-client/js/webrtc.js`: 20 additions, 3 removals.
- `web-client/js/auth-start-integration.test.js`: 245 additions, 11 removals; extends the existing pure VM fixture and real behavior scenarios.
- `web-client/js/input-recovery.test.js`: 41 additions, 1 removal; exposes its existing VM context and adds two admission/draft/gate regressions.

Private artifacts created only in this `.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/` directory: this report and the six named test logs. The four pre-existing dirty documents and untracked node_modules remain present and were not written or staged. No other source paths were edited. `git diff --cached --name-only` produced no output. No stage/commit operation was performed; no primary checkout, W2, tunnel/watch or runtime state was touched.

## Self-review and limitations

Self-review checked the complete three-file diff against the brief, selector contract, proof conflict, response publication ordering and existing ownership guards. The new public method is only the required parser; `requestExplicitViewerAdmission` retains its signature. Product changes are confined to the admission boundary. Tests do not assert an invented client generation/context authority, do not bypass the real request decision and do not force a successful grant. Guarded failure cases exercise real cleanup. Existing normal human and proof Start cases still pass, and the full existing input-recovery suite remains green.

No implementation concerns identified. These are offline behavioral results only: deployment, production loading, live ordinary admission/recovery, long-session continuity, business input, visible effects and physical input were not run or claimed. Existing server and Host contracts were prerequisites and were not retested or modified here.

Source/index ownership is explicitly handed back to root with this report. Root owns review, staging, commits and any authorized subsequent runtime work.
