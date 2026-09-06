# TURN quality and latency final delivery review

**Date:** 2026-09-06
**Reviewed implementation range:** `000547f..6c0c652` (37 commits)
**Review mode:** source, test, versioned offline evidence, repository hygiene, and cross-review of post-merge local relay collector artifacts plus matching Signal/Host logs. No public endpoint or physical device was operated in this review.

## Completion verdict

**NOT COMPLETE — do not present this as a completed TURN quality/latency delivery.**

The implementation and complete automated suites are passing, but the product acceptance gate is not closed for two independent reasons:

1. The offline relay matrix selected `no-offline-winner`; there is no eligible `relay-balanced-v2` parameter set. `relay-legacy-v1` remains the default and the approximately one-second clarity pulse is therefore not closed.
2. The post-merge collector produced complete scheduled local selected-relay sampling windows: 720p for 600.006s / 601 samples and 1080p for 300.008s / 301 samples. It also produced one superseded 720p run, which is excluded. The complete runs did not authenticate static text or Host-side input, inject finite loss, use the formal public entry, or use a physical device. Complete sampling duration does not establish uninterrupted presentation.

**Superseded by the 2026-09-06 live-session re-review:** a P1 collector measurement defect is now confirmed: sampled paint age was treated as maximum inter-frame gap. The current human Viewer session also shows 720p FPS median 9 and repeated freezes. See [the performance regression review](2026-09-06-turn-performance-regression-review.md). Historical automated checks remain historical evidence; they do not establish current performance.

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
| §9 capture optimization | DEFERRED; admission guard PASS | Versioned Task 7 evidence keeps `selection.captureMultiplier={applied:false,value:2.0}`. | No capture cost reduction was shipped; only the guard against unvalidated changes passed. |
| §11.1 automation and build | PASS | Python 253 passed; Viewer 566 passed; Signal `npm test` 339 passed with its Viewer build; tracked shell/MJS/JSON syntax checks passed. | These are code and build results only. |
| §11.2 offline pulse and quality | FAIL | `relay-balanced-v2` has no offline winner. | The matrix does not authorize a periodic-IDR or on-demand replacement. |
| §11.3 selected relay | PASS for complete local runs | The complete 720p/1080p artifacts hold selected UDP relay plus connected socket and PC for every sample; the first 720p artifact was superseded and excluded. | Local selected-relay transport is proven for the two complete windows only. |
| §11.3 720p / 1080p media continuity | INCOMPLETE; sampled transport/FPS evidence retained | 720p: 601 samples / 600.006s at 1152x720, derived-FPS p50 19, jitter p95 23.0ms, maximum sampled paint age 138ms. 1080p: 301 samples / 300.008s at 1728x1080, derived-FPS p50 19, jitter p95 17.3ms, maximum sampled paint age 105ms. | Paint age does not bound inter-frame gaps. Loss/drop counters were zero; 720p observed one freeze and seven NACK increments, 1080p five NACK increments. Neither continuous presentation nor scene quality is established. |
| §11.3 pause, resume, and refresh | PASS for complete local runs | Both runs observed suspended then active state with a fresh frame; refresh changed the attempt and restored a healthy selected relay with a fresh frame. | Local headless Viewer evidence only. |
| §11.3 static text, scroll/drag/keyboard, and finite loss | NOT RUN | Collector markers deliberately leave unauthenticated producer content/input and non-isolated loss injection unexecuted. | There is no Host-side input ack/effect or controlled finite-loss recovery evidence. |
| §11.4 formal public path and physical device | NOT RUN | No external operator or physical device was used. | The formal entry remains `https://link.stockhub.wiki`; local or unit evidence cannot stand in for this gate. |
| §12 documentation and runbook | PASS | Requirements document, README, safe-startup runbook, acceptance ledger, matrix and Task 9 record are in scope. | They retain the legacy default, no-offline-winner limit, formal-entry rule, and no-tunnel-rebuild boundary. |

## Architecture and safety review

The three intended deep seams are present: `RtpFrameClock` owns PTS conversion and monotonicity, `H264SessionPolicy` owns complete media-policy resolution, and the Viewer’s canonical stats are consumed by a single recovery controller. Policy and recovery messages require the current connection attempt, sequence, and generation; delayed or correlation-free telemetry does not mutate a later session. Encoder requests retain a causal token until an observed IDR, and decoder reopen is bounded to one per admitted episode after two later stalled samples.

The proof boundary accepts only a current selected local relay candidate and emits candidate type, protocol, and RTT. It does not serialize candidate address or port. This review also replaced IP-shaped endpoint test fixtures with non-address redaction markers; the test continues to exercise endpoint stripping without committing address-like values.

The post-merge local collector was admitted only after the server reported no
active human Viewer. Its first 720p run was superseded by a second Viewer at
13:42:41 local time, and the artifact's 43 subsequent no-media samples correctly
make it non-acceptance evidence. The later 720p and 1080p runs remained a single
selected-relay connection throughout their sample windows. The review does not
write any endpoint, credential, token, or raw screenshot into version control.

Host encoder summaries show `relay-legacy-v1` still runs `keyint=20` at 20 FPS
and emits five periodic IDRs per five seconds. That confirms the known
approximately one-second IDR driver remains active. Since controlled static text
and IDR-boundary image measurements were not run, the sampled paint ages prove
neither uninterrupted paint cadence nor removal of the visible clarity pulse.

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

Do not change the default policy or report the pulse as fixed. Repeat the local
720p/1080p presentation-continuity windows after correcting the collector;
the prior sampled transport evidence cannot waive that requirement.
The remaining valid gates are controlled static text at the IDR boundary,
scroll/drag/keyboard with Host-side acknowledgements and effects, finite isolated
TURN loss and bounded recovery, the formal public entry, and physical-device
media/input observations. `relay-balanced-v2` remains unavailable until an
eligible offline candidate exists. Until those gates are evidenced, this delivery
remains **NOT COMPLETE**.
