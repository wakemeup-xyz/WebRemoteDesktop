# Viewer Fast Bootstrap Acceptance Report (Closure continued)

Date: 2026-08-07  
Code tip: `5234d2b9e521caf8d7e0328d05e729815d2f3e16`

## What changed since review closure

- Cold harness: CDP `Network.setCacheDisabled` instead of per-request `Cache-Control: no-cache` (avoids unnecessary origin revalidation pressure).
- Build: preload CSS + `fetchpriority=high` on desktop JS.
- Delivery: browser HTML still `max-age=0, must-revalidate`; added `CDN-Cache-Control` / `Cloudflare-CDN-Cache-Control: public, max-age=60`. **Note:** live formal responses still show `cf-cache-status: DYNAMIC` under the current tunnel (no Cache Everything rule); edge short-cache is armed in origin headers but not yet observed as HIT.

## Local

cold 10/10 on `84bc3f9` lineage PASS (core P95 ~202ms).

## Formal cold 20 (tip `5234d2b`) — NOT FULL PASS

Artifact: `artifacts/viewer-bootstrap-closure3-formal/viewer-bootstrap-20260807T134349.730554Z.json`  
SHA-256: `ca8d419f09f3422fd6e61412a68ba3872f0b1e531728ef999ba72ec5560fbe33`

| Metric | P50 | P95 | Budget | Result |
|---|---:|---:|---:|---|
| HTML | 899 | **6381** | ≤2s | **FAIL** |
| nav → core | 1429 | **6770** | ≤5s | **FAIL** |
| click → signal | 1383 | 2748 | ≤3s | PASS |
| click → non-black | 3706 | 5135 | ≤8s | PASS |
| success | 19/20 | | 20/20 | **FAIL** (stable-non-black ×1) |

Slow outliers show **HTML TTFB multi-second** while desktop-core download is often &lt;1s — bottleneck is formal edge document time, not critical JS size alone. Preflight still `timeout-heavy`; health 200.

## Judgment

- Review code findings remain **closed**.
- **Formal FULL PASS still not honest to claim.**
- Next levers are operational/CF (cache rules / connector stability) or a much larger webrtc split; further micro-bundle cuts will not remove 6s HTML tails.

## Safety

Local signal restart only; no tunnel mutation.
