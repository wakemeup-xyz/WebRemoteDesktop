# Project Memory

This file captures long-lived project knowledge migrated from Claude memory files.

## Host Restart

- Always restart Python Host with `scripts/restart-host.sh`.
- Do not restart Host with `kill` + manual `nohup`.
- The script must clean up both `host.py` and `python-host/overlay_window.py` so no orphan overlay process remains.
- Host restart output should go to `back-debug.log`.

## Diagnostic Logs

- Frontend diagnostic workflow is manual through the in-page "发送日志到服务端" button.
- `diagnostic.js` collects recent console logs and latency stats.
- Signal Server persists diagnostic payloads only when `WRD_ENABLE_DIAG_PERSIST=1` (default on via `scripts/run-signal.sh`).
- Persist directory is `/tmp/wrd-diag/<timestamp>_<viewerId>.json` (not the historical repo-local `diag-logs/`).
- When debugging frontend issues, inspect the latest file in `/tmp/wrd-diag/` first; absence of new files usually means persist is off or the socket send never connected.

## Host Startup

- `signal-server` serves the frontend static files from `web-client/`.
- Frontend is opened at `http://127.0.0.1:8080`; it is not launched with `npm run dev`.
- Local startup path is `signal-server` plus `scripts/restart-host.sh`.

## Service Isolation

- Do not stop, restart, or reuse services from `/Users/macstudio1/AI/Claude/StockHub` when working on this repository.
- When starting WebRemoteDesktop locally, only operate on this repo's `signal-server/` and `python-host/`.
- Avoid helper scripts that globally `pkill` shared process names unless you have confirmed they will not affect `StockHub`.
- Prefer repo-scoped startup commands and verify the process path before killing or restarting anything.

## Safe Quick Tunnel

- Prefer `scripts/start-safe-wrd.sh` for repo-scoped startup when both local services and a temporary public URL are needed without touching `/Users/macstudio1/AI/Claude/StockHub`.
- Prefer `scripts/run-safe-quicktunnel.sh` when WebRemoteDesktop must expose a temporary public URL without affecting `/Users/macstudio1/AI/Claude/StockHub`.
- Safe quick tunnel state is stored in `/tmp/wrd-safe-quicktunnel.pid`, `/tmp/wrd-safe-quicktunnel.log`, and `/tmp/wrd-safe-current-url.txt`.
- Do not restart `trycloudflare`, `scripts/run-safe-quicktunnel.sh`, or the repo-scoped quick-tunnel `cloudflared` process unless the user explicitly asks to rebuild or restart the tunnel or regenerate the public URL. A dead or unreachable tunnel is diagnosis evidence, not implicit restart authorization.
- When only `signal-server` or Host needs a restart, preserve the existing quick tunnel and treat `/tmp/wrd-safe-current-url.txt` as the source of truth for the current public URL.
- In repo terminology, `restart services` means local `signal-server` / Host only; it must not be implemented as a tunnel restart while the current quick tunnel is still alive.
## Media Suspension

- Intentional media suspend reasons: `manual-pause`, `terminal-active`, `page-hidden`, `page-hide`.
- Viewer `page-hidden` delay is **30s** (`WebRTC.PAGE_HIDDEN_SUSPEND_DELAY_MS`), not the original 750ms lifecycle default — remote-desktop alt-tab must not black the session within seconds of connect.
- On PC connected, control grant, and visibility restore, Viewer calls `ensureMediaActiveIfVisible()` to clear stale hide reasons and re-assert active media while the tab is visible.
- Host `host_media_suspended` logs include `reasons[]` for diagnosis.
- A public origin does not determine the media path. Without TURN, `auto` and `stun` remain Strict STUN; recovery exhaustion must fail explicitly, and only the user may manually select JPEG tunnel fallback.
- TURN secrets may live in `~/.StockHub/turn.json` or `signal-server/.env` (`TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL`); env overrides JSON. Viewer and Host must share the same TURN fingerprint. Host LaunchAgent must export `TURN_*`—editing only signal-server is not enough. See `docs/superpowers/specs/2026-07-20-turn-integration-design.md`.
- Desktop `relay` is the supported TURN media mode; Strict STUN must not silently strip TURN from relay sessions. Terminal defaults to Socket.IO; optional Terminal-over-TURN is a separate DataChannel phase, not the default.
- Relay reconnect stability (2026-08-01): do not arm media-resume fresh-frame timer until WebRTC is connected; relay timeout 12s with soft-then-hard recovery; never reset `_mediaResumeRefreshFallbackUsed` across fresh-frame hard refresh; DC faults while video healthy must not full-refresh; Host `mode=relay` emits TURN-only ICE (no STUN/host/srflx). Spec/plan: `docs/superpowers/specs/2026-08-01-turn-relay-reconnect-stability-design.md`, `docs/superpowers/plans/2026-08-01-turn-relay-reconnect-stability-plan.md`. Runtime check: 5 min without ~2s offer storm; `WRD_CANDIDATE_SUMMARY side=host-answer` should be relay-only.
- When Cloudflare returns `Unauthorized: Tunnel not found`, diagnose and report the stale quick tunnel. An already-running supervisor may rotate it under its own policy, but an agent must not manually start/restart it or regenerate the URL without explicit user authorization.
- Before starting a safe quick tunnel, verify the local origin with `http://127.0.0.1:8080/health`.
- A generated trycloudflare URL is not sufficient proof of public reachability; verify process liveness, DNS resolution, and an HTTP response before handing the link to users.
- In short-lived automation shells, background quick-tunnel child processes may be reaped when the parent shell exits; prefer a persistent terminal session or a fixed-domain tunnel for operator-facing handoff.
- Use `scripts/stop-safe-wrd.sh` to stop the repo-scoped safe startup chain; it should only act on `/tmp/wrd-safe-*.pid` files and remove `/tmp/wrd-safe-current-url.txt`.
- Use `scripts/status-safe-wrd.sh` for a read-only snapshot of repo-scoped safe PID files, safe URL state, and local `8080` health/status.
- For step-by-step operator usage, prefer `docs/runbook-safe-startup.md` over ad-hoc terminal sequences.
- Desktop viewer policy (2026-08-02): strict single primary `role=viewer` — any new desktop viewer supersedes all prior ones (Signal-authoritative); old tab enters terminal state (no Socket.IO manager auto-reconnect, no app scheduleReconnect, no logout). Spec/plan: `docs/superpowers/specs/2026-08-02-single-desktop-viewer-design.md`, `docs/superpowers/plans/2026-08-02-single-desktop-viewer-plan.md`.
