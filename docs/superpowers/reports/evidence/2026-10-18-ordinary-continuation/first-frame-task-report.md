# Task 1 report — explicit Viewer first-frame timer state

Status: **DONE**. Source base: `edc25ae9b57e3f9d5a3fb7a92840cf78e124d3ee` (parent `59bca14`). All implementation and validation took place in `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`.

## Changes

- `web-client/js/webrtc.js`: added exactly `_firstFrameTimer: null,` beside `hasPaintedFrame`. No timer method, gate, policy, consumer, or timeout value changed.
- `web-client/js/webrtc.test.js`: added a DOM listener removal stub and a bounded VM fixture that uses `loadWebRTC({realInput:true})`, real production WebRTC and Input sources, deterministic timers/time/stats, and the unchanged `scripts/passive_session_sampler.js` evaluated in the same VM. Added four behavioral regressions.

The fixture never prepopulates `_firstFrameTimer` and never replaces or manufactures Input's effective gate. The fresh source's real Input remains blocked; these tests establish timer observation, not readiness. The startup test drives the real `beginStartupEpisode` and `beginFirstFrameDeadline`, explicitly returns true from `startupPending`, and counts calls through to the real `startStartupMediaBudget`. It confirms the separate 72000 ms media allowance and 8000 ms feedback allowance, only the episode timer being newly scheduled, and the legacy handle remaining null. The legacy test uses the real arm and clear methods and observes true then false. A deliberate property deletion remains unknown/null in the sampler. Every test registers cleanup that stops the sampler and clears fixture timers, including failure paths.

## Exact test evidence

Node executable: `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node`.

1. **RED, before editing production source**

   ```sh
   /Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-name-pattern='explicit first-frame timer' web-client/js/webrtc.test.js
   ```

   Exit **1**. Tests **4**, pass **2**, fail **2**, cancelled/skipped/todo **0**. Node reported duration **204.431475 ms**. The fresh source assertion failed on `Object.hasOwn(...)=false` versus expected true; startup delegation failed on `undefined` versus expected null. No fixture exception occurred. Actual legacy arm/clear and deleted-property negative tests passed. Full output: `task-1-red.log`; captured exit: `task-1-red.exit`.

2. **GREEN, after the one-line production initializer**

   ```sh
   /Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test --test-name-pattern='explicit first-frame timer' web-client/js/webrtc.test.js
   ```

   Exit **0**. Tests **4**, pass **4**, fail/cancelled/skipped/todo **0**. Duration **223.447427 ms**. Full output: `task-1-green.log`; captured exit: `task-1-green.exit`.

3. **Both affected suites, run once**

   ```sh
   /Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test web-client/js/webrtc.test.js scripts/passive-session-sampler.test.js
   ```

   Exit **0**. Tests **348**, pass **348**, fail/cancelled/skipped/todo **0**. Duration **24391.299682 ms**. Full output: `task-1-affected.log`; captured exit: `task-1-affected.exit`.

All six evidence files are beside this report. RED preceded the production edit; tests were unchanged between RED, GREEN, and the affected suite run.

## Self-review and scope checks

- Inspected the exact two-file diff. Product diff: **1 addition, 0 deletions**. Test diff: **96 additions, 0 deletions**. `git diff --check` passed.
- `git diff --exit-code -- scripts/passive_session_sampler.js scripts/passive-session-sampler.test.js scripts/passive_session_soak.py scripts/test_passive_session_soak.py` exited **0**. Final tracked change list contains only the two implementation files in addition to the four pre-existing dirty documents. No sampler, helper, runner, supervisor, W2, tunnel, watch, config, or prior evidence was edited.
- No staging or commits were performed; the index remained empty. The four existing dirty documents and the untracked `signal-server/node_modules` entry were preserved.
- No browser, network, native input, project Python import, process inspection, service/status operation, build, installation, deployment, or configuration operation was run. Fixture fetches use the existing explicit offline response.
- No additional lifecycle defect or scope expansion was found. Independent root-owned review remains required before deployment.

## Limits

Only offline VM behavior is verified. Production loading, real browser startup, business input, native visible effect, physical qualification, long-session continuity, reconnection acceptance, and numeric input-to-picture latency remain **NOT_RUN** by this task. Both failed live attempts and their markers remain unchanged. Root owns staging/commit, independent reviews, fresh deployment, and runtime acceptance.
