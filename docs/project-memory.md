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
- Signal Server writes diagnostic payloads to `diag-logs/<timestamp>_<viewerId>.json`.
- When debugging frontend issues, inspect the latest file in `diag-logs/` first.

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
- Do not restart `trycloudflare`, `scripts/run-safe-quicktunnel.sh`, or the repo-scoped quick-tunnel `cloudflared` process unless the user explicitly asks for it or the tunnel is already dead and public access must be restored.
- When only `signal-server` or Host needs a restart, preserve the existing quick tunnel and treat `/tmp/wrd-safe-current-url.txt` as the source of truth for the current public URL.
- In repo terminology, `restart services` means local `signal-server` / Host only; it must not be implemented as a tunnel restart while the current quick tunnel is still alive.
- If the viewer enters through a public origin such as trycloudflare and TURN is not configured, the viewer should go straight to tunnel relay instead of attempting STUN-first WebRTC.
- When Cloudflare returns `Unauthorized: Tunnel not found`, the safe quick tunnel script should restart and refresh the safe URL file automatically.
- Before starting a safe quick tunnel, verify the local origin with `http://127.0.0.1:8080/health`.
- A generated trycloudflare URL is not sufficient proof of public reachability; verify process liveness, DNS resolution, and an HTTP response before handing the link to users.
- In short-lived automation shells, background quick-tunnel child processes may be reaped when the parent shell exits; prefer a persistent terminal session or a fixed-domain tunnel for operator-facing handoff.
- Use `scripts/stop-safe-wrd.sh` to stop the repo-scoped safe startup chain; it should only act on `/tmp/wrd-safe-*.pid` files and remove `/tmp/wrd-safe-current-url.txt`.
- Use `scripts/status-safe-wrd.sh` for a read-only snapshot of repo-scoped safe PID files, safe URL state, and local `8080` health/status.
- For step-by-step operator usage, prefer `docs/runbook-safe-startup.md` over ad-hoc terminal sequences.
