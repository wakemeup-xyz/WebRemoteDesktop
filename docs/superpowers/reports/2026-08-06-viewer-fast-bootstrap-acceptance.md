# Viewer Fast Bootstrap Acceptance Report (Review Remediation)

Date: 2026-08-07
Code baseline: post-`a69a494` + deferred operator tools + parallel Start signaling

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
- `compression` enabled for HTML/JS/CSS.
- Critical desktop core excludes operator tools (STUN port search / TURN self-test / latency / diagnostic); they ship as lazy `desktop-deferred` after core-interactive.
- desktop-core gzip ≈57 KiB (raw ≈210 KiB) after deferred split.

### P1 security/config
- Official registry `npm audit --audit-level=moderate` → 0 vulnerabilities.
- TURN `priority` integer-only on Node/Python with shared fixture parity tests.

### P2 docs/contracts
- ShellGuard deadline 5s.
- Requirements: strict single desktop Viewer.
- README no longer claims direct source `web-client/` hosting.
- fixed-tunnel preflight reports protocol + recent timeout/reconnect classification.

### Perf follow-ups that closed formal gates
- Websocket-only Socket.IO transport (no polling ladder).
- Start opens signaling socket in parallel with bootstrap; PeerConnection waits for ICE config (`_deferPeerUntilConfig`).
- Bootstrap preload key matches Start (`mode` + `selectedTurnServerId`).

## Runtime results (honest harness)

### Local cold 20/20 — PASS
Artifact: `artifacts/viewer-bootstrap-local-deferred/viewer-bootstrap-20260807T023116.370058Z.json`
SHA-256: `50c764ee5ee359f1cda9a06d03927c43da3604112f0dceea27e4634485dfeb42`

| Metric | P95 | Budget | Result |
|---|---:|---:|---|
| HTML response | 10.2 ms | ≤2s | PASS |
| nav → core-interactive | 184.6 ms | ≤5s | PASS |
| click → signal | 97.6 ms | ≤3s | PASS |
| click → stable non-black | 646.7 ms | ≤8s | PASS |

Immediate-start 5/5 also PASS (earlier same session).

### Formal cold 20/20 — PASS
Artifact: `artifacts/viewer-bootstrap-formal-deferred/viewer-bootstrap-20260807T023027.896086Z.json`
SHA-256: `c6d1c73b48f6b3b7225b1533e2a83687e28c2f1907666478047156c441e800a0`

| Metric | P50 | P95 | Budget | Result |
|---|---:|---:|---:|---|
| HTML response | 844 ms | 1618 ms | ≤2s | PASS |
| nav → core-interactive | 1045 ms | 2307 ms | ≤5s | PASS |
| click → signal | 1497 ms | 2087 ms | ≤3s | PASS |
| click → stable non-black | 3006 ms | 4362 ms | ≤8s | PASS |

Attempt accounting: successCount 20 / attemptCount 20; failureCount 0.

Preflight (read-only) at formal re-run: formal-owners 1, token-argv absent, protocol http2, formal-health 200; connector-stability still classified timeout-heavy on historical log tail (operational residual, not acceptance gate fail).

## Judgment

- **AUTOMATED PASS** (signal-server 282; web-asset-build 4; prior scripts/css suites green)
- **LOCAL RUNTIME PASS** (honest canvas + single-attempt)
- **FORMAL PUBLIC PERF: FULL PASS** (honest 20/20 + all P95 budgets)

## Safety

- Quick tunnel / safe URL not mutated during local restarts (`https://contributors-acm-circular-names.trycloudflare.com` preserved).
- No formal connector mutation in this phase; preflight remained read-only.
