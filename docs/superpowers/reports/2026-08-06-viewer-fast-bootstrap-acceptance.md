# Viewer Fast Bootstrap — Formal optimization note

Date: 2026-08-07  
Tip: `c1627d58c5327fa8b0d2d39ac05210cc8c407a77`

## Progress this pass

| Gate | Before (typical) | Now (`c1627d5` formal cold 20) |
|---|---|---|
| success | 18–19/20 | **20/20** |
| click→signal P95 | often &gt;3s | **2486ms PASS** |
| click→non-black P95 | fail/marginal | **7069ms PASS** |
| HTML P95 | 5–6s FAIL | **5061ms FAIL** |
| nav→core P95 | 5–7s FAIL | **5993ms FAIL** |

Artifact: `artifacts/viewer-bootstrap-formal-opt/viewer-bootstrap-20260807T152123.599204Z.json`  
SHA-256: `fdf1b127f1706a8508c974b4281eb8bcb35eafe5a45225b83b2cb9e9453f4bc9`

## Changes

1. **HTML Cache-Control** `public, max-age=60, must-revalidate` (+ CDN-Cache-Control 60s) so CF *can* HIT when eligible.
2. **cloudflared originRequest** keepAlive pool / timeouts in `~/.cloudflared/config.yml` + setup template; formal connector restarted (credentials-file, http2, single owner).
3. **ontrack IDR**: `requestKeyframe` on first video track (+700ms retry).
4. Cold samples spaced **1s** for Host settle.

## Why HTML/core still fail

Live formal still returns **`cf-cache-status: DYNAMIC`** for `viewer.html` even with public max-age. Named tunnel + default CF cache level **does not store HTML** without a **Cache Rule / Cache Everything** on `link.stockhub.wiki/viewer.html` (or equivalent).

From this network, raw HTML TTFB alone is often **0.6–2.6s+** (curl). Four of twenty acceptance samples had HTML **2.2–6.9s**; those dominate P95 and pull core with them. Hashed JS is already **cf-cache-status: HIT**.

**Code/bundle work cannot remove multi-second document TTFB when every HTML response is origin-proxied through the tunnel.**

## FULL PASS blocker (operational)

To clear HTML ≤2s / core ≤5s P95 on formal:

1. Cloudflare Dashboard → Cache Rules (or Page Rule): **Cache eligible** for  
   `https://link.stockhub.wiki/viewer.html` (and optionally `/` / `index.html`) with edge TTL ≥60s, respecting origin `max-age=60`.
2. Confirm `cf-cache-status: HIT` (or `EXPIRED`→`HIT` after first fill) on repeated `curl -sSI`.
3. Re-run:  
   `VIEWER_ACCESS_PASSWORD=… python3 scripts/viewer_bootstrap_acceptance.py --origin https://link.stockhub.wiki --mode cold --runs 20`

Optional: reduce connector `timeout-heavy` historical noise by rotating log or stabilizing WAN to CF edge (7844 dial timeouts in fixed-domain log).

## Judgment

- **LOCAL / code / review closure: still good**
- **Formal: 20/20 + signal + non-black PASS; HTML/core P95 still FAIL**
- **Not FULL PASS** until CF caches HTML (or path RTT permanently &lt;~1.5s P95)
