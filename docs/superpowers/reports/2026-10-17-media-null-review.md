# Independent review — nullable media latency

Date: 2026-10-17. Reviewed commit: `9e57bf470ceb8a8e47c15802c401e28665a64c62` (`fix(media): preserve nullable latency through consumers`).

## Verdict

**PASS — no actionable correctness, specification, authority, or quality findings in the reviewed change.** No severity-rated findings or required revisions.

This is source/offline-test review acceptance. It does not establish production loading, a refreshed Viewer, live media quality, long-session performance, optical latency, or resolution of the separately reported public Signal ping timeout.

## Scope and evidence

Read `task-media-null-brief.md`, `task-media-null-report.md`, the review-package inventory for `review-70789fa..9e57bf4.diff`, the exact commit diff for all five production and seven test files, and surrounding consumer/recovery code. Used the exact `9e57bf4` diff to distinguish this task from the separately reviewed I2 R1 changes in the combined package. Checked the governing strict-number contract in `docs/superpowers/specs/2026-10-17-media-latency-design.md:71`.

No tests were rerun, as required. Reported green results are implementation evidence supplied by the task report: Viewer 359/359, Signal in-memory socket suite 109/109, offline diagnostic subset 25/25, Python 51/51, and whitespace check. The seven real-listen HTTP/admin diagnostic cases remain **NOT RUN** under the offline constraint. No source, index, primary checkout, runtime, browser, network, native capture/input, dependency, build, or service changes were made during this review; the only write is this review record.

## Contract and behavior review

- `web-client/js/webrtc.js:5976` and `:5980` strictly normalize only the two latency scalars. `null`, missing/undefined, strings, booleans, objects, nonfinite numbers and negatives remain unavailable; numeric zero and positive fractions remain numbers. Existing FPS/counter fallback behavior is outside this change and remains as before.
- `web-client/js/webrtc.js:6001`, `:6026`, `:6036`, `:6056`, `:6093`, `:6147`, `:6157`, `:6161`, `:6172`, and `:1995` carry that result through the selected-pair cache, independent RTT/buffer UI, guidance, console, actual receiver/controller call, outgoing stats and paint cache. Explicit null checks preserve valid zero; the pair fallback uses null. LatencyMonitor receives the original sample with only the two normalized fields overwritten, preserving its existing observation lifecycle and unrelated counter semantics.
- `web-client/js/link-quality-controller.js:210` independently enforces the same contract for direct callers. Known-only comparisons retain measured congestion evidence. The new hold boundary at `:250` clears good/degraded/critical streaks when latency is incomplete and there is no measured stall, latency problem or packet loss, so unknown samples cannot upgrade or act on old thresholds. The good branch at `:291` requires both latency values. Measured stall/loss/high-latency paths still reach the original classification and recovery thresholds; path presets, Quality Lock, thresholds, and all-valid-number comparisons retain their previous behavior.
- `web-client/js/diagnostic.js:415` retains null or a strict valid buffer value without coercion. Existing Signal diagnostic redaction may omit this optional unavailable field; the new test checks that actual zero survives and unrelated trace values remain present.
- `signal-server/websocket/signaling.js:1513` retains role, active-viewer and recovery-identity admission before normalization. The two normalized values follow `...data`; authoritative recovery fields and socket viewer identity still override payload fields afterward. No new fallback or authority path was introduced.
- `python-host/host.py:3870` rejects bool and nonfinite/negative floats, preserves nonnegative int/float, and feeds both existing log records fixed `null` for unavailable values. Recovery-identity admission, FPS/count parsing, stall counting and decoder observer order at `:3905–3937` are unchanged, and neither latency value becomes a recovery decision input.

## Test-quality review

The new Viewer test invokes real `processStatsSnapshot`, real `handleReceiverStats` and the real controller, while recording the emitted payload and inspecting DOM/cache/monitor values. It covers each unknown form, mixed known/unknown fields, measured zero and fractions, default/provided pair RTT, and connected phase retention. Controller tests establish a near-upgrade streak, seed old bad counters, then prove repeated unknown samples clear those counters without actions across direct/relay and Quality Lock on/off. Separate cases retain known congestion and compare actual decoder-stall decisions with and without latency observations.

Diagnostic tests exercise the actual builder, redactor and ingest functions. Signal tests invoke the registered stats handler with a current bound viewer and check normalization, authoritative identity, aliases, stale attempt, wrong role and disconnect rejection. Python tests call the real async handler for legacy/bound identities, exercise unavailable/zero/fractional logs and parameterize the causal IDR recovery sequence with unknown latency. Native capture/input constructors are explicitly forbidden by autouse barriers. These tests inspect externally meaningful behavior rather than only testing a duplicated normalizer.

## Remaining acceptance boundaries

The seven excluded HTTP/admin tests and all live/production acceptance remain unclaimed. Old Viewer-generated numeric zero is inherently indistinguishable from an actual zero at downstream boundaries; refreshing the Viewer is required for complete end-to-end availability semantics. The report correctly treats public Signal ping timeout/TURN jitter as separate work and does not claim this observation correction fixes either.
