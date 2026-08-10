# Formal Tunnel Hardening Design

**Date:** 2026-08-11  
**Status:** Approved for planning  
**Scope:** Upgrade `cloudflared`, read-only edge/outage probes, and bounded formal-connector watch/restart for `https://link.stockhub.wiki`

## Problem

On 2026-08-09 the formal entry returned HTTP **530** with body **error code: 1033** while local origin `http://127.0.0.1:8080` stayed healthy and Host remained online.

Root cause (investigation evidence in `/tmp/wrd-fixed-domain.log`):

1. Named tunnel process `cloudflared … run wrd-tunnel` kept running.
2. All edge connections dropped (~17:16 UTC).
3. Reconnect attempts failed with `dial tcp 198.41.x.x:7844: i/o timeout` for ~11 minutes.
4. Cloudflare edge therefore had no healthy connector for the hostname → 530/1033.
5. Connections self-registered again ~17:28 UTC without a manual restart.

Contributing factors:

- Intermittent outbound path to Cloudflare tunnel edge TCP **7844**
- Running `cloudflared` **2026.3.0** while stable available is **2026.7.3**
- No dedicated formal-connector health watcher (only one-shot `fixed-tunnel-preflight.sh`)
- Full `start-fixed-domain.sh` also restarts local services; too wide for connector-only recovery

## Goals

1. Upgrade formal connector binary to **cloudflared ≥ 2026.7.3** and load it into the running formal tunnel.
2. Provide a **read-only** probe that classifies origin vs edge vs formal-entry failures, especially TCP 7844 reachability.
3. Add a **bounded** formal-connector watcher that:
   - alerts via macOS notification + log when formal entry is down while origin is up
   - may restart **only** the formal named tunnel within rate limits
4. Preserve existing runbook boundaries for quick tunnel and “重启服务”.

## Non-goals

- Automatic rebuild/restart of trycloudflare / safe quick tunnel
- Automatic restart of signal-server or python-host from the watcher
- Changing Cloudflare DNS, tunnel ID, or credentials material
- Moving edge geography (Asia PoP / VPS reverse egress)
- Webhook / remote paging integrations
- Making `fixed-tunnel-preflight.sh` mutate processes

## Hard boundaries

| Action | Allowed actor |
|--------|----------------|
| Restart formal named tunnel only | `restart-fixed-domain-tunnel.sh`, `watch-fixed-domain.sh` (bounded) |
| Restart signal-server / Host | Existing local restart paths only; **not** watcher |
| Restart safe quick tunnel | Explicit user authorization only |
| Read-only formal checks | `fixed-tunnel-preflight.sh`, `probe-fixed-edge.sh` |
| Print tunnel tokens / secrets | **Never** |

Formal connector identity:

- Tunnel name: `wrd-tunnel`
- Config: `~/.cloudflared/config.yml` with `credentials-file` (no `--token` / `TUNNEL_TOKEN`)
- Launch label: `com.webremotedesktop.fixed-domain`
- Log: `/tmp/wrd-fixed-domain.log`
- Protocol default: `http2` (`WRD_FIXED_TUNNEL_PROTOCOL` may override to `quic`)

User phrase **「重启服务」** continues to mean local `signal-server` / Host only. It does **not** authorize formal tunnel restart except via the dedicated scripts or the bounded watcher defined here.

## Architecture

```text
brew cloudflared binary
        │
        ▼
formal connector (com.webremotedesktop.fixed-domain)
  cloudflared tunnel --config config.yml --protocol http2 run wrd-tunnel
        │
        │ TCP 7844 to CF edge
        ▼
Cloudflare edge → https://link.stockhub.wiki → origin http://127.0.0.1:8080

probe-fixed-edge.sh (read-only)
  - TCP 7844 samples
  - local /health
  - formal /health

watch-fixed-domain.sh (LaunchAgent fixed-watch)
  - if origin down → log only
  - if origin ok && formal down ≥ 180s → notify + bounded restart formal only
```

## Components

### 1. `scripts/restart-fixed-domain-tunnel.sh`

**Purpose:** Smallest safe restart of the formal connector.

**Behavior:**

1. Require `CLOUDFLARED_CONFIG` (default `~/.cloudflared/config.yml`) contains `credentials-file`.
2. `unset TUNNEL_TOKEN`.
3. Stop existing formal owner:
   - `launchctl remove com.webremotedesktop.fixed-domain` (and equivalent bootout if needed)
   - stop matching `cloudflared … --config <config> … run wrd-tunnel` process only
4. Start via `launchctl submit -l com.webremotedesktop.fixed-domain` with:
   - current `cloudflared` binary
   - `--config "$CLOUDFLARED_CONFIG"`
   - `--protocol "${WRD_FIXED_TUNNEL_PROTOCOL:-http2}"`
   - `run wrd-tunnel`
   - append logs to `/tmp/wrd-fixed-domain.log`
5. Wait until deliverable:
   - preferred: `https://link.stockhub.wiki/health` returns 2xx and JSON `status=ok`
   - helper signal: `cloudflared tunnel info wrd-tunnel` shows active connections
6. Exit non-zero on timeout; do not loop unbounded.

**Must not:** `pkill`/`kill` `server.js`, `host.py`, safe quicktunnel, or StockHub processes.

### 2. `scripts/upgrade-cloudflared.sh`

**Purpose:** Install/link cloudflared ≥ **2026.7.3** and switch the formal connector onto that binary.

**Behavior:**

1. Resolve `cloudflared` path (default Homebrew).
2. If version already ≥ 2026.7.3, skip brew upgrade.
3. Otherwise run `brew upgrade cloudflared` (or install if missing).
4. Re-check `cloudflared --version`.
5. Call `restart-fixed-domain-tunnel.sh` once.
6. Print version + formal health summary.

**On brew failure:** do not tear down a healthy connector just to “force” upgrade; exit with clear error.

### 3. `scripts/probe-fixed-edge.sh`

**Purpose:** Read-only classification of outage layer.

**Inputs (env overrides allowed):**

- `ORIGIN_HEALTH` default `http://127.0.0.1:8080/health`
- `FORMAL_HEALTH` default `https://link.stockhub.wiki/health`
- Edge IP list: static small defaults (recent CF edge samples) and/or optional parse of recent successful register lines from `/tmp/wrd-fixed-domain.log`
- TCP connect timeout ~3s per IP

**Outputs:**

- Human summary on stdout
- Optional machine JSON at `/tmp/wrd-fixed-edge-probe.json`
- Classification enum (exactly one primary):
  - `ok` — origin and formal healthy; edge samples mostly open
  - `origin-down` — local health failed
  - `formal-down-local-ok` — local ok, formal not deliverable (530/1033/timeout/invalid JSON)
  - `edge-blocked` — local ok, majority of `:7844` probes fail (may co-exist with formal-down)
  - `edge-degraded` — formal still 200 but majority `:7844` samples fail (warn only)

**Must not** mutate processes, PID files, or URL files.

### 4. `scripts/watch-fixed-domain.sh` + LaunchAgent

**Purpose:** Periodic formal entry supervision with bounded self-heal.

**Defaults:**

| Parameter | Default | Env override |
|-----------|---------|--------------|
| Interval | 60s | `WRD_FIXED_WATCH_INTERVAL_SEC` |
| Failure threshold | 180s continuous formal failure while origin ok | `WRD_FIXED_WATCH_FAIL_SEC` |
| Restart cap | 2 per rolling 60 minutes | `WRD_FIXED_WATCH_MAX_RESTARTS` / `WRD_FIXED_WATCH_WINDOW_SEC` |
| Cooldown after restart | 300s | `WRD_FIXED_WATCH_COOLDOWN_SEC` |
| State file | `/tmp/wrd-fixed-watch-state.json` | `WRD_FIXED_WATCH_STATE` |
| Log file | `/tmp/wrd-fixed-watch.log` | `WRD_FIXED_WATCH_LOG` |

**State machine (each tick):**

1. Probe origin health.
2. Probe formal health (2xx + JSON `status=ok` required for healthy).
3. If origin unhealthy:
   - clear or freeze formal-failure accumulation per implementation note below
   - **do not** restart tunnel
   - log `origin-down`
4. If origin healthy and formal healthy:
   - clear failure window
   - log only on transition to healthy (avoid spam)
5. If origin healthy and formal unhealthy:
   - start/continue failure window timestamp
   - if elapsed ≥ threshold AND cooldown clear AND restart budget remains:
     - macOS notification (osascript)
     - append structured line to watch log
     - call `restart-fixed-domain-tunnel.sh`
     - record restart timestamp in state; decrement budget
   - if budget exhausted: notify/log `restart-budget-exhausted`; no further restarts until window rolls

**Implementation note for origin-down:** Do not attribute formal failures to tunnel while origin is down. Prefer resetting the formal failure accumulator when origin is down so a local outage cannot immediately trigger tunnel restarts when origin returns.

**Notifications:** best-effort `osascript` display notification. Notification failure must not block restart attempt or non-zero handling of restart script.

**Install:**

- `launchd/com.webremotedesktop.fixed-watch.plist`
- `scripts/install-fixed-watch.sh` (copy plist, bootstrap/kickstart), mirror awake-keeper style
- Optional `scripts/uninstall-fixed-watch.sh` or documented bootout commands

### 5. Docs

Update:

- `docs/runbook-safe-startup.md` — formal upgrade, probe, watch, bounded restart semantics
- `README.md` — short operator pointers
- Keep explicit: watcher never manages quick tunnel; preflight remains read-only

## Error handling

| Condition | Action |
|-----------|--------|
| Origin down | Log only; no tunnel restart |
| Formal 530/1033/timeout while origin ok | Accumulate failure time; restart after threshold if budget allows |
| Edge `:7844` all fail but formal still 200 | Probe warns `edge-degraded`; no restart |
| Restart attempted, formal still down | Count restart; enforce cooldown; retry only if budget remains |
| Restart budget exhausted | Notify + log; operator intervention required |
| `brew upgrade` fails | Abort upgrade path; leave existing connector alone if still running |
| `osascript` notify fails | Log warn; continue |
| Multiple formal owners detected | Watcher should refuse restart and notify (safe fail); operator runs preflight |
| Token argv present on formal process | Refuse managed restart; align with security warning policy |

## Testing

### Automated (fixture / source contract)

1. `restart-fixed-domain-tunnel.sh` source does not reference killing `server.js` / `host.py` / safe quicktunnel scripts.
2. Restart script requires credentials-file and unsets `TUNNEL_TOKEN`.
3. `upgrade-cloudflared.sh` gates on semantic version ≥ 2026.7.3 and invokes restart script once on success path.
4. `probe-fixed-edge.sh` classification with fixtures:
   - origin fail → `origin-down`
   - origin ok + formal 530 → `formal-down-local-ok`
   - origin ok + formal ok + all 7844 closed → `edge-degraded` (or documented equivalent)
5. `watch-fixed-domain.sh` pure decision helper or fixture mode:
   - origin-down ⇒ no restart
   - formal-down &lt; threshold ⇒ no restart
   - formal-down ≥ threshold & budget &gt; 0 ⇒ restart once
   - budget 0 ⇒ no restart
6. Existing `fixed-tunnel-preflight` tests still pass (still read-only).

### Manual acceptance

1. Run upgrade script → `cloudflared --version` ≥ 2026.7.3 → formal `/health` 200.
2. Run probe → coherent classification while services healthy.
3. Install fixed-watch → state file appears; no restart loop while healthy.
4. Optional failure injection only with operator consent (e.g. temporary fixture mode), never by breaking production DNS in automation.

## Rollout order

1. Land scripts + tests + docs.
2. Run `upgrade-cloudflared.sh` (explicit connector bounce).
3. Run `probe-fixed-edge.sh` and keep a short report snippet in runbook or `/tmp`.
4. `install-fixed-watch.sh` enable LaunchAgent.
5. Observe one healthy hour: zero restarts, watch log quiet except heartbeats if any.

## Success criteria

- Formal entry uses cloudflared ≥ 2026.7.3
- Operator can classify 530-class incidents with one probe command
- When origin is healthy and formal stays down ≥ 3 minutes, system notifies and performs at most two formal-only restarts per hour
- No automation path restarts quick tunnel or local app processes as part of this design

## Open parameters (fixed by this spec)

These are not TBDs; defaults above are normative unless env overrides are set at install time:

- Fail threshold: **180s**
- Interval: **60s**
- Max restarts: **2 / 3600s**
- Cooldown: **300s**
- Alert: **macOS notification + `/tmp/wrd-fixed-watch.log`**
