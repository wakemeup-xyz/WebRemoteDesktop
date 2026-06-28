# WebRemote Service Rules

## Non-negotiables

- Preserve the existing Cloudflare temporary domain during local restarts.
- Do not restart, stop, or recreate `cloudflared` during local service work.
- Do not call `start-safe-wrd.sh` or `run-safe-quicktunnel.sh` for a plain restart request.
- Treat `/tmp/wrd-safe-current-url.txt` as the source of truth for the current temporary URL.
- A plain `restart-local` must not change the URL file. If the URL changes, that is a tunnel rotate, not a local restart.
- Use `status-safe-wrd.sh` output to classify failures:
  - `ok`: URL is reachable
  - `dns-unresolved`: local/public DNS cannot resolve the trycloudflare host
  - `origin-unreachable`: the tunnel host exists but the HTTP origin is not reachable
- `dns-unresolved` alone does not prove the local services are broken.

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
- If the user explicitly asks to "换 URL" or "重建 tunnel", rotate the tunnel first and then re-check `/tmp/wrd-safe-current-url.txt`.
