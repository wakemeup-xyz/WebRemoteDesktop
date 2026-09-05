# Task 8: full automation and documentation sync

Date: 2026-09-06

## Documentation facts

- Copied the reviewed design, repository plan, latency review, and spec/plan review
  into this worktree without changing their conclusions. SHA-256 comparison against
  the main-workspace copies initially matched for all four files; the copied latency
  review then had one Markdown trailing-space marker removed solely to satisfy
  `git diff --check`.
- Updated the product requirements, README, and safe-startup runbook to describe
  the implemented RTP clock, canonical `derivedFps`, recovery identity, and
  aggregate encoder/paint observability.
- The offline relay matrix is `no-offline-winner`; `relay-legacy-v1` remains the
  default, no `relay-balanced-v2` constants were selected, and this documentation
  does not claim that the periodic clarity pulse is fixed.
- Capture remains at target-FPS 2.0x because the alternate cadences did not pass
  the browser paint gate. Real TURN, public-entry, and physical-device evidence
  remains `NOT RUN`, pending Task 9 and the corresponding external access path.
- This task added no passwords, TURN credentials, or candidate address/port data.

## Verification

| Command | Result |
|---|---|
| `/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m pytest -q python-host` | FAIL: 251 passed, 2 failed, 1 deprecation warning. `test_encoder_returns_clock_rtp_timestamps` cannot open local VideoToolbox and its fallback retry still uses that encoder; `test_decoder_refresh_requires_a_healthy_fps_sample` expects a refresh that current gating rejects. |
| `node --test web-client/js/*.test.js` | PASS: 566 passed, 0 failed. |
| `cd signal-server && npm test` | PASS: 339 passed, 0 failed; its pretest runs the Viewer build. |
| `cd signal-server && npm run build:web` | PASS: exit 0. |
| `git ls-files -z '*.sh' | xargs -0 -n 1 bash -n` | PASS: 35 tracked shell scripts parsed. |
| `git ls-files -z '*.mjs' | xargs -0 -n 1 node --check` | PASS: 2 tracked MJS scripts parsed. |
| `git ls-files -z '*.json' | xargs -0 -n 1 python3 -m json.tool` | PASS: 7 tracked JSON files parsed. |
| `git diff --cached --check` | PASS: staged docs tree had no whitespace errors before the documentation commit. |

## Commit

`f19668f docs(turn): sync relay quality acceptance evidence`

This commit contains the reviewed artifacts, operator-facing documentation, the
acceptance-ledger update, and this Task 8 report. Its full Python-suite failure
is intentionally recorded above rather than hidden behind the successful Node
and build checks.

## Concerns

- The two Python failures are not skipped and are not reported as passing. They
  are product-code failures outside Task 8's docs/test scope and require their
  owning implementation task to resolve before the full Python suite is green.
- No service, tunnel, real TURN, public endpoint, or physical device was started,
  restarted, or exercised by this task.
