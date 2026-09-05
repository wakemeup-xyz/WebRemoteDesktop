# Terminal / Formal Watch Task5 Acceptance

**Date:** 2026-09-05
**Plan:** `docs/superpowers/plans/2026-09-03-terminal-formal-watch-remediation-plan.md`
**Design:** `docs/superpowers/specs/2026-09-03-terminal-formal-watch-remediation-design.md` §§2.5–2.6, §3
**Related design:** `docs/superpowers/specs/2026-08-30-terminal-shared-session-ux-protocol-design.md`

## Scope

Task5 is the documentation and acceptance-boundary slice for the Terminal shared-session UX and formal named-tunnel watch. README, requirements, runbook, and shared-session design now use one contract:

- `trycloudflare` expiry or `Unauthorized: Tunnel not found` is diagnostic only, never automatic rebuild authorization; quick-tunnel rebuild requires an explicit user request.
- The formal watcher only considers the `wrd-tunnel` named connector for `https://link.stockhub.wiki`; it never restarts or rebuilds trycloudflare, `signal-server`, or Host.
- Page-hidden media suspension waits 5 minutes / 300s; switching to Terminal or manual pause remains immediate.
- On window blur/page hidden, an open desktop input DataChannel takes the reset path; a closed/unavailable channel parks local input state.
- Presenter disconnect freezes input until reset acknowledgement; non-presenter detach only leaves observation. `TerminalPanel` owns runtime session state and the FSM is a deterministic test seam.
- `WRD_TERMINAL_PTY_KILL_WAIT_MS` is documented as supported with a 200ms default for asynchronous node-pty `onExit` confirmation.

The formal public entry remains `https://link.stockhub.wiki`; the existing Core Interactive P95 <= 5s, signaling connected P95 <= 3s, and stable non-black frame P95 <= 8s SLA wording is preserved.

## Automated evidence

| Area | Result | Exact command / evidence |
|---|---|---|
| Terminal Viewer contracts | PASS | `node --test web-client/js/terminal*.test.js` — 122 passed, 0 failed |
| Terminal Signal Server contracts | PASS | `node --test signal-server/test/terminal*.test.js signal-server/lib/terminal/*.test.js signal-server/websocket/terminal.test.js` — 164 passed, 0 failed |
| Formal watch, tunnel, and runtime scripts | PASS | `node --test scripts/*.test.js` — 97 passed, 0 failed |
| Shell syntax | PASS | `bash -n scripts/watch-fixed-domain.sh scripts/lib-fixed-domain.sh scripts/restart-fixed-domain-tunnel.sh scripts/run-safe-quicktunnel.sh` |
| Patch whitespace | PASS | `git diff --check` |

The terminal Signal Server suite includes the 200ms default/config coverage and asynchronous PTY exit cleanup. Script tests use fixtures and isolated temporary state; they do not start a service or tunnel. Expected structured audit output from auth/runtime-probe fixtures is test noise and contains no secrets or raw Terminal IO.

## Runtime acceptance boundary

- NOT RUN: physical macOS Quartz input, keyboard/IME, and real node-pty interaction.
- NOT RUN: real single-browser Terminal flow.
- NOT RUN: independent dual-browser presenter/observer flow, shared input visibility, and detach-without-destroy.
- NOT RUN: Terminal disconnect and re-attach over a live origin.
- NOT RUN: public browser acceptance through `https://link.stockhub.wiki`.
- NOT RUN: live formal watcher, named-tunnel restart, or quick-tunnel/public-path endurance.

No service, Host, Signal Server, Cloudflare connector, quick tunnel, or LaunchAgent was started, stopped, restarted, rebuilt, or rotated for this acceptance. Automated tests do not substitute for the physical-device, browser, or public-path gates above.

**Planned commit message:** `docs: unify tunnel rebuild and terminal lifecycle copy`
