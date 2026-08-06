# Viewer Fast Bootstrap Acceptance Report

Date: 2026-08-06  
Commit: `a2b0d49`  
Baseline design/plan: `3902407`

## Connector migration (authorized)

- Stopped legacy system token LaunchDaemon path (`com.cloudflare.cloudflared` / `--token` argv)
- Kept safe quick tunnel untouched
- Formal named connector now single owner with `--protocol http2`
- Read-only preflight final result:
  - `local-health: ok`
  - `credentials-file: present`
  - `formal-owners: 1`
  - `token-argv: absent`
  - `formal-health: 200`
  - exit `0`

## Local runtime

Evidence: `artifacts/viewer-bootstrap-local/viewer-bootstrap-20260806T024354.477179Z.json`  
SHA-256: `f0963b851cd6882b42da268a3e079e9f6bb668a47cc9c146266fed50aa822a15`  
Samples: cold 20 + warm 20

| Metric | P50 | P95 | Budget | Result |
|---|---:|---:|---:|---|
| Core Interactive | 0.6 ms | 2.0 ms | ≤ 5 s | PASS |
| Click → Signal | 32.4 ms | 121.8 ms | ≤ 3 s | PASS |
| Click → Active | 609.3 ms | 1294.5 ms | ≤ 8 s | PASS |

Fault injection: bootstrap-delay / terminal-abort / cdn-block PASS.

## Formal public runtime

Evidence: `artifacts/viewer-bootstrap-formal/viewer-bootstrap-20260806T140843.102549Z.json`  
SHA-256: `c38888eaf9f3eb63dde4e6a15c251eac0fe610a0bce6fe1a114ecbb60c34bf17`  
Samples: cold 20 + warm 20 (40 total; 4 transient failures retried)

### Cold (formal entry SLO)

| Metric | P50 | P95 | Budget | Result |
|---|---:|---:|---:|---|
| Core Interactive | 7.1 ms | 7.4 ms | ≤ 5 s | PASS |
| Click → Signal | 2142.2 ms | 3823.6 ms | ≤ 3 s | **FAIL** |
| Click → Active | 6110.2 ms | 8126.8 ms | ≤ 8 s | **FAIL** (marginal) |

### Warm

| Metric | P50 | P95 | Budget | Result |
|---|---:|---:|---:|---|
| Core Interactive | 0.9 ms | 1.1 ms | ≤ 2 s | PASS |
| Click → Signal | 2163.3 ms | 2905.7 ms | ≤ 3 s | PASS |
| Click → Active | 5528.8 ms | 7933.3 ms | ≤ 8 s | PASS |

## Judgment

- **AUTOMATED PASS**: code/tasks 1-11 complete
- **LOCAL RUNTIME PASS**
- **FORMAL CONNECTOR HYGIENE PASS** (token removed, single HTTP/2 owner)
- **FORMAL PUBLIC PERF PARTIAL**: full 20/20 sample counts achieved; core interactive meets budget; cold click-to-signal and click-to-active P95 still miss formal budgets due to edge/media path variance

## Remaining performance gap

Formal cold tail is dominated by post-click signaling/media, not HTML/core bootstrap:

- Core interactive is already far under budget
- Signal connected P95 ~3.8 s (budget 3 s)
- Stable active/non-black P95 ~8.1 s (budget 8 s)

Recommended next hardening (separate task): reduce formal offer/ICE/first-frame tail, keep HTTP/2 connector, and re-run the same 20-cold matrix.
