# Viewer Fast Bootstrap Acceptance Report (Closure Review Fix)

Date: 2026-08-07  
Code tip: `4ffc5c075e9c3d84b0243471dffc20de18821f00`

## Review findings addressed

1. **Diagnostic inert control** — `diagnostic-core.js` is on the critical path (log capture + button shell). `#diagBtn` is **not** `data-core-control`. It stays disabled while deferred panel loads; on deferred failure it becomes an explicit **诊断重试** control (`deferred-abort` fault verified).
2. **Honest stable-non-black** — harness records first canvas `nonBlackRatio > 0.05` as `stable-non-black` mark; `clickToStableNonBlackMs` is start-click → that mark; 8s deadline is from Start click (no longer `active` + extra 8s).
3. **Transports** — desktop Socket.IO is WebSocket-first with polling fallback (`['websocket','polling']`) and connect `timeout: 5000`. Unit tests cover transport preference and options.
4. **Docs** — design, plan, and requirements updated for deferred diagnostic policy, WS+polling, and non-black contract.

## Automated

- signal-server: 282 pass
- web-client webrtc+diagnostic tests: pass after fix
- harness unit tests: pass
- Python TURN parity: 4 pass
- `npm audit --audit-level=moderate`: 0 (prior tip; unchanged deps this commit)
- `git diff --check`: clean on commit

## Local runtime (commitSha = `4ffc5c0…`)

| Mode | Result | SHA-256 |
|---|---|---|
| cold 20/20 | **PASS** all P95 budgets | `740bf2663aa3fea4c117c1829274f4b35d9680ec863f7a58f308e0515b756fab` |
| warm 20/20 | **PASS** | `42ae0843bb29cb2360b7887140bed1fa24570d521dbcd3b2f37835b61acb82f9` |
| immediate-start 5/5 | **PASS** | `a4788b02c5492be5e35e58fbc8c471cf6b8f51ad1e01f16c43530c2e7de0fe3e` |
| deferred-abort ×1 | **PASS** (diag retry state) | `04d36544c8491210c4c64b4a8d47a7959667b10cec43ee0ece949f77369e6c13` |

Local cold P95: HTML 10.6ms / core 220.5ms / signal 106.5ms / non-black 876.5ms.

## Formal runtime (commitSha = `4ffc5c0…`) — NOT FULL PASS

Latest cold artifact: `artifacts/viewer-bootstrap-closure-formal/viewer-bootstrap-20260807T131630.033803Z.json`  
SHA-256: `a26d897ed2c2220b70ff75a44a36232d6ad50d16bf9690b0022112567ef30882`

| Metric | P50 | P95 | Budget | Result |
|---|---:|---:|---:|---|
| HTML response | 1001 | 1787 | ≤2s | PASS (this run) |
| nav → core | 1408 | 3598 | ≤5s | PASS |
| click → signal | 1607 | **4918** | ≤3s | **FAIL** |
| click → stable non-black | 3867 | 7748 | ≤8s | PASS (successes) |
| attempt success | 19/20 | | 20/20 | **FAIL** (`stable-non-black` ×1) |

Earlier formal cold in the same session also 19/20 with heavier HTML tail (P95 HTML 6211 on first run). Warm formal 19/20 with one navigation failure.

Preflight (read-only): owners=1, credentials-file, http2, health 200; historical log still `timeout-heavy`.

## Judgment

- **CODE / REVIEW CLOSURE: PASS** (findings 1–4 fixed; local evidence complete; artifact commitSha matches tip)
- **LOCAL FULL PASS**
- **FORMAL PUBLIC PERF: FAIL / NOT FULL PASS** under honest single-attempt + canvas non-black gates  
  Residual risk: Cloudflare edge / signaling / media tail variance; connector log timeout-heavy classification. Not an inert-control or CDN-graph defect.

## Safety

- Local restart only via `wrd_service.py restart-local`; safe URL unchanged across restart (`https://outside-photographer-stuart-review.trycloudflare.com`).
- No formal connector mutation; preflight remained read-only.
