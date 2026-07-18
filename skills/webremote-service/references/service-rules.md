# WebRemote Service Rules

## Non-negotiables

- Preserve the existing Cloudflare temporary domain during local restarts.
- Do not restart, stop, or recreate `cloudflared` during local service work.
- Do not call `start-safe-wrd.sh` or `run-safe-quicktunnel.sh` for a plain restart request.
- Treat `/tmp/wrd-safe-current-url.txt` as the source of truth for the current temporary URL.
- Treat `scripts/wrd_entry_health.py` as the source of truth for whether that URL is deliverable. Delivery requires `/health` 2xx JSON with `status=ok`; 3xx, 404, 429, 5xx, and wrong content are unavailable.
- Status is read-only. It must not reconcile PID files or recover/write the current URL from archive/log candidates.
- Only `scripts/run-safe-quicktunnel.sh` may publish the current safe URL, after a fresh canonical health check.
- A plain `restart-local` must not change the URL file. If the URL changes, that is a tunnel rotate, not a local restart.
- Use `status-safe-wrd.sh` output to classify failures:
  - `ok`: URL is reachable
  - `dns-unresolved`: local/public DNS cannot resolve the trycloudflare host
  - `origin-unreachable`: the tunnel host exists but the HTTP origin is not reachable
  - `http-invalid`: the origin returned a non-2xx status
  - `content-invalid`: `/health` did not return the expected JSON body
- `dns-unresolved` alone does not prove the local services are broken.
- Named-tunnel startup must use `config.yml` with `credentials-file`; do not pass `--token` or inherit `TUNNEL_TOKEN`.
- If status detects `--token` in cloudflared argv, print only the fixed security warning. Never print the token, stop cloudflared, or remove its launchd job.
- Host runtime logs rotate in `back-debug.log` with `WRD_LOG_MAX_BYTES` / `WRD_LOG_BACKUP_COUNT` (10 MiB / 3 by default). Launch wrapper output is separate in `/tmp/wrd-host-launch.log` and is trimmed to the newest 1 MiB before append.
- Terminal `socketRtt` / `inputAckRtt` use browser-local pending times. Password-safe echo is enabled only after confirmed remote shell echo. Shared Terminal defaults to 8 sessions and supports idle detached-session reaping.

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
- If Host does not come back online, inspect `/tmp/wrd-host-launch.log` for preflight and `back-debug.log` for Host runtime.
- If the user explicitly asks to "换 URL" or "重建 tunnel", rotate the tunnel first and then re-check `/tmp/wrd-safe-current-url.txt`.
