# Terminal Shared Session Acceptance

Date: 2026-08-30

## Automated

- PASS: `cd signal-server && npm test` (317 tests on merged main)
- PASS: `node --test web-client/js/terminal.test.js web-client/js/terminal-session-fsm.test.js web-client/js/terminal-input-gate.test.js` (97 tests)
- PASS: `git diff --check`

Coverage includes lifecycle snapshot separation, caller presenter flags, canonical/legacy event compatibility and telemetry, detached observer handling, close authorization, exited-process input gating, and shared-session UI text/control state.

## Real Runtime

- NOT RUN: local single-browser flow
- NOT RUN: independent dual-browser presenter/observer flow
- NOT RUN: shared input visibility and detach-without-destroy verification
- NOT RUN: Terminal disconnect/re-attach recovery

No service, host, or tunnel was started or restarted for this change. Automated tests do not substitute for these runtime checks.
