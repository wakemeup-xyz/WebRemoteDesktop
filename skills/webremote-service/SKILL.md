---
name: webremote-service
description: Safely start, restart, and diagnose this repository's WebRemoteDesktop local services. Use this skill whenever the user asks to start services, restart services, check service status, recover port 8080, restart Host, restart signal-server, debug slow startup, or asks why startup is slow. This skill is mandatory when Cloudflare quick tunnel, trycloudflare URLs, cloudflared, or /tmp/wrd-safe-current-url.txt may be involved, because local restarts must preserve the existing Cloudflare temporary domain and must not restart cloudflared.
---

# WebRemoteDesktop Service Control

Use this project-local skill for service lifecycle work in `/Users/macstudio1/AI/Claude/WebRemoteDesktop`.

## Workflow

1. Read `README.md` and `docs/runbook-safe-startup.md`.
2. Read [service-rules.md](references/service-rules.md) before issuing any restart command.
3. Interpret `重启服务` as local-only restart: `signal-server` plus Host.
4. Use `skills/webremote-service/scripts/wrd_service.py` for status and restart commands.

## Safety Rules

- Never restart, stop, or recreate `cloudflared`.
- Never call `scripts/start-safe-wrd.sh`, `scripts/run-safe-quicktunnel.sh`, `scripts/stop-safe-wrd.sh`, or `scripts/start-fixed-domain.sh` unless the user explicitly asks to manage tunnel.
- Preserve `/tmp/wrd-safe-current-url.txt`. If it exists before restart, it must contain the same URL after restart.
- Use `http://127.0.0.1:8080` as the local entrypoint. Do not start Vite or use port `5173`.
- Restart Host only through `scripts/restart-host.sh`.
- Treat `restart-local` as local-only: `signal-server` plus Host. It must not rotate the temporary URL.
- Treat URL rotation as a separate tunnel action. Use an explicit tunnel-rotate flow only when the user asks to "换 URL", "重建 tunnel", or similar.
- If `status-safe-wrd.sh` reports `dns-unresolved`, that is a resolver problem, not proof that `signal-server` or Host is down.
- If `status-safe-wrd.sh` reports `origin-unreachable`, that is tunnel reachability failure, not a local service restart task.
- If a local restart changes `/tmp/wrd-safe-current-url.txt`, stop and report it as an unexpected tunnel churn.

## Commands

```bash
python skills/webremote-service/scripts/wrd_service.py status
python skills/webremote-service/scripts/wrd_service.py restart-local
python skills/webremote-service/scripts/wrd_service.py restart-signal
python skills/webremote-service/scripts/wrd_service.py restart-host
```

Use `restart-local` for the usual `重启服务` request.

## Why This Skill Exists

The repo runs in short-lived shells and one-shot command environments. Ordinary `nohup npm start &` can be reaped after the command exits, so the helper uses launchctl-backed startup for the signal server and the repo's Host restart script. That keeps restarts predictable and prevents accidental tunnel churn.

The key lesson from this repo is that "restart" has two distinct meanings:

- local restart: recover `signal-server` / Host without changing the public URL
- tunnel rotate: deliberately tear down and recreate the quick tunnel so the URL changes

Do not infer one from the other.

If a restart fails, report the exact failing step and include the relevant log tail from `/tmp/signal-server.log` or `back-debug.log`.
