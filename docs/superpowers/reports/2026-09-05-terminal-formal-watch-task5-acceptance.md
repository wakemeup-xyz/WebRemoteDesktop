# Terminal / Formal Watch Task5 Acceptance

**Date:** 2026-09-05
**Plan:** `docs/superpowers/plans/2026-09-03-terminal-formal-watch-remediation-plan.md`
**Design:** `docs/superpowers/specs/2026-09-03-terminal-formal-watch-remediation-design.md` §§2.5–2.6, §3
**Related design:** `docs/superpowers/specs/2026-08-30-terminal-shared-session-ux-protocol-design.md`

## Scope and closure

Task5 closes the documentation and acceptance-boundary contract for the Terminal shared-session UX and formal named-tunnel watch. The final review follow-up also reconciles safe quick-tunnel code, tests, and launchd behavior with the repository operations contract.

- The same prohibition sentence is present in `README.md`, `docs/runbook-safe-startup.md`, and `docs/需求文档/WebRemoteDesktop-需求文档.md`: an inaccessible quick tunnel or `Unauthorized: Tunnel not found` is diagnostic only; ordinary startup/recovery cannot kill, stop, restart, or rebuild it; rebuild requires an explicit user request.
- `start-safe-wrd.sh` only starts/reuses local Signal and Host and checks an existing quick tunnel. It reports a missing or inaccessible quick tunnel without invoking a tunnel lifecycle helper.
- Ordinary startup now detects a loaded legacy quick-tunnel LaunchAgent and only issues `disable` plus `bootout`; the migration leaves `/tmp/wrd-safe-current-url.txt` untouched and never calls explicit start/restart/rotate actions.
- `run-safe-quicktunnel.sh` performs one explicit connector start (when directly invoked by the explicit lifecycle path), verifies before publishing, then only observes the connector. It does not kill the process, delete the current URL, or loop into replacement on an inaccessible URL, `Unauthorized`, or connector exit.
- The safe-tunnel LaunchAgent is not `RunAtLoad`/`KeepAlive`; the explicit `restart-safe-tunnel.sh` path still owns rotate/cleanup/start semantics.
- `WRD_TERMINAL_PTY_KILL_WAIT_MS=200` is included in `signal-server/.env.example` and remains the bounded default for asynchronous node-pty `onExit` confirmation.
- Page-hidden media suspension waits 5 minutes / 300s; switching to Terminal or manual pause remains immediate. Open desktop input DataChannel uses reset on blur/hidden and closed/unavailable DataChannel parks local input state.
- Presenter disconnect freezes input until reset acknowledgement; non-presenter detach only leaves observation. `TerminalPanel` owns runtime session state and the FSM is a deterministic test seam.

The formal public entry remains `https://link.stockhub.wiki`; the existing Core Interactive P95 <= 5s, signaling connected P95 <= 3s, and stable non-black frame P95 <= 8s SLA wording is preserved.

## Automated evidence

| Area | Result | Exact command / evidence |
|---|---|---|
| Terminal Viewer contracts | PASS | `node --test web-client/js/terminal*.test.js` — 122 passed, 0 failed |
| Terminal Signal Server contracts | PASS | `node --test signal-server/test/terminal*.test.js signal-server/lib/terminal/*.test.js signal-server/websocket/terminal.test.js` — 164 passed, 0 failed |
| Formal watch, tunnel, and runtime scripts | PASS | `node --test scripts/*.test.js` — 104 passed, 0 failed |
| Safe tunnel fixture behavior | PASS | `node --test scripts/tunnel-safety-fixture.test.js` — 5 passed, 0 failed; fake LaunchAgent records loaded-job `print/disable/bootout`, explicit `bootstrap/enable/kickstart`, and diagnostic-only run-safe states with URL preservation |
| Shell syntax | PASS | `bash -n scripts/run-safe-quicktunnel.sh scripts/start-safe-wrd.sh scripts/restart-safe-tunnel.sh scripts/lib-safe-wrd.sh scripts/lib-safe-startup.sh scripts/lib-tunnel-launchctl.sh` — exit 0 |
| Patch whitespace | PASS | `git diff --check` — no output |

The script suite includes executable fixtures proving that inaccessible/Unauthorized/exited quick tunnels remain diagnostic-only, ordinary startup migrates a loaded legacy auto job without starting or deleting URL state, safe startup does not invoke tunnel start/rotate helpers, the LaunchAgent cannot auto-run, and the three active documents contain the same prohibition sentence. The Signal suite includes the 200ms default/config coverage and asynchronous PTY exit cleanup. Tests use fake command fixtures or in-process harnesses; no live service, Host, Cloudflare connector, LaunchAgent, or tunnel was operated.

## Runtime acceptance boundary

The following remain `NOT RUN` because this task had no operator-supplied live origin, physical device, or authorization for tunnel/service operations:

- `NOT RUN`: real single-browser Terminal flow.
- `NOT RUN`: independent dual-browser presenter/observer flow, shared input visibility, and detach-without-destroy.
- `NOT RUN`: Terminal disconnect and re-attach over a live origin.
- `NOT RUN`: physical macOS Quartz input, keyboard/IME, and real node-pty interaction.
- `NOT RUN`: public browser acceptance through `https://link.stockhub.wiki`.
- `NOT RUN`: live formal watcher, named-tunnel restart, quick-tunnel/public-path reachability, and endurance.

Automated tests do not substitute for the browser, physical-device, formal watcher, or public-path gates above. No service, Host, Signal Server, Cloudflare connector, quick tunnel, or LaunchAgent was started, stopped, restarted, rebuilt, or rotated for this acceptance.

**Commit message:** `fix(tunnel): safely migrate legacy quick-tunnel job`
