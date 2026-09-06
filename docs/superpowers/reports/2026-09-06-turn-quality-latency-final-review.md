# TURN quality and latency final delivery review

**Date:** 2026-09-06
**Reviewed implementation range:** `000547f..e20d824` (29 commits)
**Review mode:** source, test, versioned offline evidence, and repository-hygiene review only. No service, browser, tunnel, `.env`, public endpoint, or physical device was operated in this review.

## Completion verdict

**NOT COMPLETE — do not present this as a completed TURN quality/latency delivery.**

The implementation and complete automated suites are passing, but the product acceptance gate is not closed for two independent reasons:

1. The offline relay matrix selected `no-offline-winner`; there is no eligible `relay-balanced-v2` parameter set. `relay-legacy-v1` remains the default and the approximately one-second clarity pulse is therefore not closed.
2. Task 9 observed an active human Viewer. The strict single-Viewer contract prohibited a headless proof, so controlled 720p/1080p TURN, paint, input, finite-loss, public-path, and physical-device gates were not run. A later empty snapshot cannot retroactively make that interrupted window valid evidence.

There is no verified P0/P1 implementation failure in the reviewed code or automated checks. The acceptance failure and the unexecuted runtime gates still block product completion.

## Spec checklist

| Spec item | Status | Fresh or versioned evidence | Delivery conclusion |
|---|---|---|---|
| §5 RTP clock | PASS | Full Python suite; fresh `scripts/test-turn-media-timeline.py` completed 3 tests through the encoder boundary; `RtpFrameClock` owns monotonic 90kHz PTS and `VIDEO_TIME_BASE`. | 20FPS timeline, monotonicity, pause/resume and new-track contracts have automated coverage. |
| §6 policy depth and apply truth | PASS | Full Python suite includes policy, profile, IDR and Quality Lock tests. | `H264SessionPolicy` centralizes codec/GOP/bitrate/VBV intent, is attempt-scoped, rejects stale generation, and records unconfirmed hot apply as `applied=false`. |
| §6.4 healthy-scene v2 behaviour | FAIL | Versioned matrix selection is `no-offline-winner`; no v2 constants are selected. | The default stays `relay-legacy-v1`; the requested removal of the roughly one-second quality pulse is not proven or delivered. |
| §6.5 offline candidate gate | FAIL | Matrix records the candidates and their failed image-quality gates; no candidate can cross into runtime validation. | Encode budgets alone do not qualify a candidate. |
| §7 bounded recovery | PASS | Full Python/Viewer/Signal suites cover canonical receive/decode semantics, exact attempt/generation admission, causal IDR acknowledgement, two later stalled samples, and one reopen per episode. | No new recovery state machine, ICE restart, resolution change, or tunnel action was introduced. |
| §8 canonical stats | PASS | Viewer suite (566 pass) and Signal suite (339 pass). | `derivedFps`, `receivedDelta`, and `decodedDelta` are the health contract; browser-reported FPS remains diagnostic-only. |
| §8 observability | PASS | Proof tests (7 pass) and automated suites cover five-second encoder/paint aggregates, causal IDR fields, selected-pair relay proof, and endpoint redaction. | Unmeasured `encoderMs`, `rtpSendMs`, and `endToEndVideoMs` remain `null`. |
| §9 capture optimization | PASS | Versioned Task 7 evidence keeps `selection.captureMultiplier={applied:false,value:2.0}`. | No offline capture experiment was promoted to production without the paint gate. |
| §11.1 automation and build | PASS | Python 253 passed; Viewer 566 passed; Signal `npm test` 339 passed with its Viewer build; tracked shell/MJS/JSON syntax checks passed. | These are code and build results only. |
| §11.2 offline pulse and quality | FAIL | `relay-balanced-v2` has no offline winner. | The matrix does not authorize a periodic-IDR or on-demand replacement. |
| §11.3 selected relay, 720p/1080p, paint, input, loss | NOT RUN | Task 9 stopped before headless proof after finding an active human Viewer. | No controlled selected-pair, duration, buffer, paint, geometry, input-ack, pause/refresh, or finite-loss evidence exists. |
| §11.4 formal public path and physical device | NOT RUN | No external operator or physical device was used. | The formal entry remains `https://link.stockhub.wiki`; local or unit evidence cannot stand in for this gate. |
| §12 documentation and runbook | PASS | Requirements document, README, safe-startup runbook, acceptance ledger, matrix and Task 9 record are in scope. | They retain the legacy default, no-offline-winner limit, formal-entry rule, and no-tunnel-rebuild boundary. |

## Architecture and safety review

The three intended deep seams are present: `RtpFrameClock` owns PTS conversion and monotonicity, `H264SessionPolicy` owns complete media-policy resolution, and the Viewer’s canonical stats are consumed by a single recovery controller. Policy and recovery messages require the current connection attempt, sequence, and generation; delayed or correlation-free telemetry does not mutate a later session. Encoder requests retain a causal token until an observed IDR, and decoder reopen is bounded to one per admitted episode after two later stalled samples.

The proof boundary accepts only a current selected local relay candidate and emits candidate type, protocol, and RTT. It does not serialize candidate address or port. This review also replaced IP-shaped endpoint test fixtures with non-address redaction markers; the test continues to exercise endpoint stripping without committing address-like values.

No runtime action occurred in this task. In particular, it did not start or restart the signal service or Host, open Chromium, read or modify `.env`, expose credentials, touch the safe-URL file, or operate a Cloudflare tunnel. The Task 9 active-human-Viewer stop condition remains authoritative.

## Scope and hygiene audit

`git diff --stat 000547f..e20d824` reports 45 implementation/documentation files, 34,112 additions and 654 deletions. `git diff --check 000547f..e20d824` passed; the final working-tree whitespace check also passed.

The reviewed range contains no committed `.playwright-mcp/`, logs, screenshots, database files, runtime `.env`, or temporary `trycloudflare` URL. The only scoped environment file is `signal-server/.env.example`, whose values remain placeholders. Candidate proof output is redacted; no real candidate endpoint or credential was found in the delivery artifacts.

## Post-review safety fix

The post-review fix closes the documented configuration bypass without changing
the matrix result: `WRD_RELAY_ENCODER_POLICY=relay-balanced-v2` now fails before
Host resource construction because v2 did not pass the offline gate; legacy is
the only admitted production policy. Pure resolver/evaluator paths retain the
candidate data for future selection work. A single explicit production-admission
constant is the only code gate that may later open v2, and it must be changed
only with versioned evidence of an eligible offline candidate and all required
runtime gates. The RTP clock also now retains an injected callable whenever it
is non-`None`, including a callable with a false boolean value.

## Next valid gate

Do not change the default policy or report the pulse as fixed. A future operator-scheduled window must first have no active human Viewer and must have an eligible offline candidate. It must then load the reviewed bundle under the runbook, prove a selected relay pair, run 720p for 10 minutes and explicit 1080p for 5 minutes, exercise static text, motion, pause/resume, refresh, finite loss, mouse/keyboard input, and record formal-public plus physical-device observations. Until then, every listed runtime/public/device row remains `NOT RUN`.
