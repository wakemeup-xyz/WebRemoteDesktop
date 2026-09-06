# Task 9 report: runtime preflight and honest acceptance record

**Date:** 2026-09-06
**Baseline:** `de8edb0`
**Scope:** read-only runtime preflight and acceptance documentation only.

## Decision and boundaries

Root preflight observed an active local Chrome Viewer (`viewerCount=1`). Under
the single-Viewer rule, no headless proof was started. The task therefore did
not restart the local signal service or Host, alter `.env`, read or report
passwords, or start, stop, restart, rebuild, or otherwise operate a tunnel.

A subsequent read-only `/api/status` snapshot had `viewerCount=0`; that later
snapshot does not negate the already-observed active-human-Viewer stop
condition or authorize a takeover-prone proof run.

## Read-only observations

| Check | Result | Interpretation |
|---|---|---|
| `wrd_service.py status` | HTTP health OK; Host online; safe URL reachable | Existing process state only. The helper had no signal PID while HTTP health succeeded. |
| `GET /health` | `status: ok` | Local origin was healthy at the observation time. |
| `GET /api/status` | `hostOnline: true` | Host was online; later snapshot showed `viewerCount: 0`. |
| `/tmp/wrd-safe-current-url.txt` | Present and readable; not modified | The temporary URL itself is omitted. No restart occurred, so there is no before/after stability assertion. |

These observations are **pre-existing runtime observed**. They do not prove
that the long-running service has loaded this worktree's code, `de8edb0`, or
any branch policy.

## Acceptance record

| Item | Status | Why it is not a result |
|---|---|---|
| Selected candidate pair is relay | NOT RUN | No Viewer proof was launched after the active-human-Viewer preflight. |
| 720p: 10-minute relay run | NOT RUN | No controlled browser/relay session was allowed. |
| 1080p: 5-minute relay run | NOT RUN | No controlled browser/relay session was allowed. |
| Paint, static-text pulse, geometry, buffer, pause/resume, refresh | NOT RUN | No interactive browser evidence was collected. |
| Mouse/keyboard, Host event-loop lag, input acknowledgement | NOT RUN | No input path was exercised. |
| Finite-loss recovery | NOT RUN | No loss was injected or observed. |
| Legacy-vs-v2 A/B | NOT RUN | Task 6 selected `no-offline-winner`; `relay-balanced-v2` has no selected constants or runtime-validation candidate. |
| Formal public path and physical device | NOT RUN | No external operator, public-entry, or device evidence was collected. |

No unexecuted row is reported as `FAIL`. The status is `NOT RUN`, not an
assertion about product behavior.

## Concerns and next valid gate

1. The helper's missing signal PID conflicts with a healthy local HTTP origin.
   It needs a later read-only ownership review; it was not treated as restart
   authority in this task.
2. The current service revision and encoder policy are unknown because the
   task deliberately did not restart services or read `.env`.
3. The one-second quality/clarity pulse remains unclosed. `no-offline-winner`
   means no v2 A/B should be presented as an attempted or successful fix.
4. A future runtime run needs an operator-scheduled idle Viewer window and an
   eligible runtime-validation candidate. It must then follow the plan's
   restart, policy, relay-pair, 720p/1080p, interaction, finite-loss, and
   public/device gates without exposing credentials or a temporary URL.
