# Viewer Fast Bootstrap Acceptance Report (Review Remediation)

Date: 2026-08-07
Implementation tip: `9f` see git tip below
Code baseline for remediation: post-`3c2eaea` review fixes through honest harness + delivery/perf hardening

## Remediation summary

### P0 acceptance truth
- `html-shell` is recorded by inline ShellGuard at HTML parse with original `performance.now()` timestamps.
- Desktop bundle only **imports** shell marks; it never invents `html-shell` / `core-interactive` times.
- Acceptance harness reports:
  - `htmlResponseMs` (navigationStart → responseStart)
  - `navToCoreInteractiveMs` (navigationStart → core-interactive mark)
  - `clickToSignalMs`
  - `clickToStableNonBlackMs`
- Each planned sample runs once; failures enter the artifact with `failureStage`.
- Cold contexts disable cache; no `--disable-http2`.
- `nonBlackRatio` is **canvas pixel ratio only**; decoded/playing/bytes are separate `mediaEvidence`.
- `immediate-start` mode covers open-then-click feedback.

### P1 delivery
- Production `createServerApp` fail-fast without valid dist (test env may use source fallback).
- Build keeps previous dist on failed rebuild; atomic publish.
- Critical HTML graph: preload + 1 CSS + 1 JS; no runtime CDN fonts/scripts.
- `compression` enabled for HTML/JS/CSS (gzip ~63 KiB core vs 231 KiB raw).

### P1 security/config
- Official registry `npm audit --audit-level=moderate` → 0 vulnerabilities.
- TURN `priority` integer-only on Node/Python with shared fixture parity tests.

### P2 docs/contracts
- ShellGuard deadline 5s.
- Requirements: strict single desktop Viewer.
- README no longer claims direct source `web-client/` hosting.
- fixed-tunnel preflight reports protocol + recent timeout/reconnect classification.

## Runtime results (honest harness)

### Local cold 20/20 — PASS
Artifact: `artifacts/viewer-bootstrap-local-remediated/viewer-bootstrap-20260806T172034.967084Z.json`
SHA-256: `2a27598068c9451e9d0b5f38f7e62d317234c73cc8bc44d6ee43ef4a7e628579`

| Metric | P95 | Budget | Result |
|---|---:|---:|---|
| HTML response | 15.2 ms | ≤2s | PASS |
| nav → core-interactive | 322.5 ms | ≤5s | PASS |
| click → signal | 173.8 ms | ≤3s | PASS |
| click → stable non-black | 878.3 ms | ≤8s | PASS |

Immediate-start 5/5 also PASS.

### Formal cold 20 — FAIL (honest)
Latest artifact: `artifacts/viewer-bootstrap-formal-remediated/latest.json`
SHA-256: see `latest.sha256`

| Metric | P50 | P95 | Budget | Result |
|---|---:|---:|---:|---|
| HTML response | ~1.0s | **~4.2s** | ≤2s | FAIL |
| nav → core-interactive | ~1.3s | **~6.9s** | ≤5s | FAIL |
| click → signal | ~2.2s | **~4.5s** | ≤3s | FAIL |
| click → stable non-black | ~4.4s | **~8.0s** | ≤8s | marginal/FAIL |

Attempt accounting (latest formal run): successCount < 20 on at least one run; failures retained (no retry rewrite).

## Judgment

- **AUTOMATED PASS**
- **LOCAL RUNTIME PASS** (honest canvas + single-attempt)
- **FORMAL PUBLIC PERF: FAIL / NOT FULL PASS**
  - Remaining risk is formal edge/HTML tail and signaling/media tail over Cloudflare, not inert controls or CDN script graph.
  - Preflight may still classify historical log tail as timeout-heavy while live formal `/health` is 200.

## Safety

- Quick tunnel / safe URL not mutated during local restarts.
- No automatic formal connector mutation in this remediation runtime phase beyond previously authorized HTTP/2 single-owner state.
