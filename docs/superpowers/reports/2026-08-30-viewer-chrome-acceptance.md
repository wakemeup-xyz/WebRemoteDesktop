# Viewer Chrome Capability Gate Acceptance

Date: 2026-08-30

## Automated evidence

- `node --test web-client/js/chrome-layout.test.js web-client/css/viewer-layout.test.js web-client/js/shell-guard.test.js`: **37 passed**.
- `node --test web-client/js/terminal.test.js`: **89 passed**.
- `node --test --test-name-pattern='bindSettingsModal focuses|bindSettingsModal restores|updateConnectionStatus exposes paint-gate labels|scheduleReconnect keeps uiPhase' web-client/js/webrtc.test.js`: **4 passed** (the harness logs expected `fetch is not defined` fallback warnings).
- Full `node --test web-client/js/webrtc.test.js` executed **182 passing assertions**, but the existing suite leaves long-lived timers and did not emit its final summary before it was stopped; no failing assertion was observed.
- `git diff --check`: **PASS**.
- `PYTHONPATH=. python3 -m pytest -q` in `python-host`: **187 passed, 1 warning**.
- On the merged main branch, `cd signal-server && npm run build:web` and `node --test test/web-asset-build.test.js` both **PASS**. The implementation was initially tested in an isolated worker without `esbuild`; that environment limitation no longer applies here.

The focused Node suite covers the capability matrix, geometry token/fallback, menu keyboard semantics, modal Escape/focus restoration, honest connection placeholder, Terminal authorization hiding, and dynamic Terminal tab/panel ARIA relationships.

## Browser matrix

| Viewport | Geometry/screenshot | Connection states | Terminal/fullscreen |
|---|---|---|---|
| 375x812 | NOT RUN | NOT RUN | NOT RUN |
| 768x1024 | NOT RUN | NOT RUN | NOT RUN |
| 1440x900 | NOT RUN | NOT RUN | NOT RUN |

Browser acceptance was not run in this worktree because no service was started or restarted. Public/tunnel acceptance remains NOT RUN and is intentionally outside this change.

## Baseline test gap

- `node --test web-client/js/input.test.js` remains 15/16 because the existing blur-reset fixture emits no event when its mocked data channel is closed. The same failure reproduces on `origin/main`; this change did not touch that path.

## Known limits

- Static tests do not prove browser layout bounding boxes, actual media paint, or fullscreen API behavior.
- Real Host, public tunnel, and multi-browser control-lease acceptance require the existing local services and remain for the operator acceptance pass.
