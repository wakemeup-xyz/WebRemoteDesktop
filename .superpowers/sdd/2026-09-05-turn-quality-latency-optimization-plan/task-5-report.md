# Task 5 report: encoder and paint observability

## Red phase

The new encoder aggregation test initially failed with missing
`H264VideoToolboxEncoder._record_encoder_sample`. The new Viewer and diagnostic
tests initially failed because no five-second paint aggregate or diagnostic
field existed. The new proof-tool tests initially failed because the CLI had no
parameter parser or exported selected-pair redaction helper.

## Delivered schema

`WRD_ENCODER_SAMPLE` is emitted once per five-second local encode window. It
contains `connectionAttemptId`, `generation`, `policyId`, `size`, `codec`,
target/effective bitrate, target FPS, encode count/avg/p95/max, total bytes,
IDR count/avg/max, and forced/periodic/PLI keyframe counts. Session identity is
carried by `H264SessionPolicy` so it stays bound to the encoder's policy.

`requestVideoFrameCallback` now aggregates `intervalMs.p50/p95/max`,
`maxGapMs`, `presentedFramesDelta`, video dimensions, and current CSS geometry
plus geometry-change count. It logs a single `WRD_PAINT_SAMPLE` per window and
adds the latest aggregate to `connection-diagnostic.traceSummary.paintObservation`.

The timing contract was preserved: `encoderMs`, `rtpSendMs`, and
`endToEndVideoMs` remain `null` where no direct measurement exists. No
cross-machine value is introduced or labeled as measured.

`prove-turn-relay.mjs` accepts `--duration-seconds` (1..600) and `--output`.
It checks `/api/status` and refuses to open headless Chromium while a Viewer is
active. Its browser snapshot reads the current `fpsDisplay`, `candidateDisplay`,
and `connectionStatus` DOM fields. Success requires FPS above zero and the
actual selected pair's local type to be `relay`; `networkMode=relay` is not
proof. Candidate output is restricted to type, protocol, and RTT, with no
address or port fields.

## Verification

- RED: targeted Python/Node tests failed for the missing methods and exports.
- GREEN: `python3 -m pytest -q python-host/test_h264_idr.py` — 29 passed.
- GREEN: `node --test web-client/js/diagnostic.test.js web-client/js/webrtc.test.js scripts/prove-turn-relay.test.mjs` — 229 passed.
- GREEN: `cd signal-server && npm run build:web`.
- GREEN: `node scripts/prove-turn-relay.mjs --help`; invalid zero duration exits non-zero without network access.
- GREEN: `node --check scripts/prove-turn-relay.mjs`; `git diff --check`.

## Commit

Conventional commit: `feat(observability): add encoder and paint aggregates`.

## Self-check and concerns

The proof runner and its guards are covered only through no-network fixture and
parameter tests in this task. No local service, real browser, TURN allocation,
or manual Viewer session was started. Real cross-machine end-to-end validation
therefore remains `NOT RUN`; any later estimate must be explicitly labeled
`estimate`.
