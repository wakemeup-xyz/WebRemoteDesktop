# Viewer Fast Bootstrap Acceptance Report (Closure Review Fix)

Date: 2026-08-07  
Code tip: `8c116f457c0ec272102bb6748d77130ea8ec1ed6`

## Review findings addressed

1. **Diagnostic inert control** — `diagnostic-core.js` on critical path; `#diagBtn` not `data-core-control`; disabled until ready; failure → **诊断重试**.
2. **Port-search inert control (residual)** — `#portSearchBtn` also removed from `data-core-control`; loading/retry via `_operatorToolsState` with deferred bundle.
3. **Honest stable-non-black** — first canvas ratio > 0.05 → `stable-non-black`; 8s from Start click.
4. **Transports** — WS-first + polling; `timeout` ≤5s; unit plan tests for WS-blocked→polling success and dual-fail within budget.
5. **Docs** — design/plan/requirements updated.

## Automated

- web-client webrtc tests: 124 pass (includes transport plan cases)
- prior signal-server 282 / TURN parity / audit 0 remain green on lineage

## Local runtime (commitSha = `8c116f4…`)

| Mode | Result | Notes |
|---|---|---|
| cold 10/10 smoke | **PASS** | signal P95 119ms, non-black P95 1406ms |
| deferred-abort ×1 | **PASS** | diag + port-search retry/loading states |

Earlier full local cold/warm/immediate on `4ffc5c0` also PASS.

## Formal cold (commitSha = `8c116f4…`) — NOT FULL PASS

Artifact: `artifacts/viewer-bootstrap-closure2-formal/viewer-bootstrap-20260807T133134.204850Z.json`  
SHA-256: `63a1181bdc7282fb4ece7ae5069156210eca74613b85abfd9512f1eb163b1ea6`

| Metric | P50 | P95 | Budget | Result |
|---|---:|---:|---:|---|
| HTML | 1226 | 1859 | ≤2s | PASS |
| nav → core | 1978 | **5313** | ≤5s | **FAIL** |
| click → signal | 1994 | 2515 | ≤3s | PASS |
| click → non-black | 4588 | 6029 | ≤8s | PASS |
| success | 19/20 | | 20/20 | **FAIL** (html-or-navigation ×1) |

Signal budget now met under honest harness; remaining formal risk is edge HTML/core tail + rare navigation miss.

## Judgment

- **CODE / REVIEW CLOSURE: PASS** (findings + residuals for inert operator tools + transport tests)
- **LOCAL PASS**
- **FORMAL PUBLIC PERF: still FAIL** (19/20, core P95 over budget) — do not claim FULL PASS

## Safety

Local restart only; safe URL preserved; no formal connector mutation.
