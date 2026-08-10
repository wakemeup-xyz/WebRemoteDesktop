# Formal Tunnel Hardening Rollout Evidence

**Date:** 2026-08-11  
**Plan:** `docs/superpowers/plans/2026-08-11-formal-tunnel-hardening-plan.md`

## Automated tests

```text
node --test (6 suites) → 18 pass / 0 fail
```

## Operator rollout

| Step | Result |
|------|--------|
| Baseline `probe-fixed-edge.sh` | `classification: ok` (edge 4/4 open) |
| `upgrade-cloudflared.sh` | 2026.3.0 → **2026.7.3**; formal restart EXIT=0 |
| Formal `/health` | HTTP 200 `status=ok` |
| `install-fixed-watch.sh` | LaunchAgent running; state `healthy` / action `none`; no restart while healthy |
| `fixed-tunnel-preflight.sh` | formal-health code=200; formal-owners=1 |

## Webtest (Playwright, formal entry)

- Login `https://link.stockhub.wiki/` → `viewer.html`
- 开始学习助手 → **已连接**
- **20 FPS**, 链路 **本地直连**, RTT ~13–30 ms

## Notes

- preflight may still show `timeout-heavy` from historical log tail; live formal health is 200
- Watcher installed live: `com.webremotedesktop.fixed-watch`
