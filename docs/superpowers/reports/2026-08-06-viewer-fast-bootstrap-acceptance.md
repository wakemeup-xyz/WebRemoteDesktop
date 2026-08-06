# Viewer Fast Bootstrap Acceptance Report (Review Remediation)

Date: 2026-08-07
Implementation tip: pending runtime restart
Code baseline for remediation: post-`3c2eaea` review fixes

## Remediation summary

### P0 acceptance truth
- `html-shell` is recorded by inline ShellGuard at HTML parse with original `performance.now()` timestamps.
- Desktop bundle only **imports** shell marks; it never invents `html-shell` / `core-interactive` times.
- Acceptance harness reports:
  - `htmlResponseMs` (navigationStart → responseStart)
  - `navToCoreInteractiveMs` (navigationStart → core-interactive mark)
  - `clickToSignalMs`
  - `clickToStableNonBlackMs`
- Each planned sample runs once; failures are recorded with `failureStage` and counts.
- Cold contexts disable cache; no `--disable-http2`.
- `nonBlackRatio` is **canvas pixel ratio only**; decoded/playing/bytes are separate `mediaEvidence`.
- `immediate-start` mode covers open-then-click feedback.

### P1 delivery
- Production `createServerApp` fail-fast without valid dist (test env may use source fallback).
- Build keeps previous dist on failed rebuild; atomic publish.
- Critical HTML graph: 1 CSS + 1 JS, no runtime CDN fonts/scripts.

### P1 security/config
- Official registry `npm audit --audit-level=moderate` → 0 vulnerabilities after lockfile refresh.
- TURN `priority` is integer-only on Node and Python with shared fixture parity tests.

### P2 docs/contracts
- ShellGuard deadline restored to 5s.
- Requirements: strict single desktop Viewer (new supersedes old).
- README no longer claims direct source `web-client/` hosting.
- fixed-tunnel preflight reports protocol + recent timeout/reconnect classification.

## Runtime status

**CODE COMPLETE / AUTOMATED pending full suite in this session.**
**RUNTIME PENDING**: do not restart tunnels; user must manually restart signal-server + Host before local/formal acceptance re-run with the remediated harness.

Formal FULL PASS requires 20/20 cold successes under the honest gates above.
