# WebRemote Service Rules

## Non-negotiables

- Preserve the existing Cloudflare temporary domain during local restarts.
- Do not restart, stop, or recreate `cloudflared` during local service work.
- Do not call `start-safe-wrd.sh` or `run-safe-quicktunnel.sh` for a plain restart request.
- Treat `/tmp/wrd-safe-current-url.txt` as the source of truth for the current temporary URL.

## Local Restart Order

1. Check `README.md` and `docs/runbook-safe-startup.md`.
2. Restart `signal-server`.
3. Restart Host through `scripts/restart-host.sh`.
4. Verify `http://127.0.0.1:8080/health`.
5. Verify `http://127.0.0.1:8080/api/status`.
6. Confirm the safe URL did not change.

## Failure Handling

- If the safe URL changes, stop and report it.
- If the local health check fails, inspect `/tmp/signal-server.log`.
- If Host does not come back online, inspect `back-debug.log`.
