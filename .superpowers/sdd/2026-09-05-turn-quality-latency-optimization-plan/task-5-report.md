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

## Review-fix round 1

### Red phase

The review tests first failed because the runner returned partial success when
Playwright was absent, the Signal module had no proof-admission primitive, the
paint schema assertion lacked attempt identity, and neither delayed IDR nor
codec recreation retained a causal keyframe reason.

### Admission and proof schema

Signal now owns a monotonic `viewerEpoch` and one-time proof admissions.
`POST /api/proof-admission` returns a token and epoch only while no desktop
Viewer is present. The proof Viewer passes that admission in Socket.IO auth;
Signal atomically checks the token, epoch, and empty Viewer map before adding
the socket. A normal Viewer increments the epoch and invalidates outstanding
proof admissions, so a human arriving between precheck and proof join remains
connected while the proof is rejected. A later normal Viewer keeps the existing
user-priority supersede behavior, and the proof's live socket/PC snapshot then
fails.

Every proof result is structured. Playwright/Chromium absence, pre-browser
failures, browser launch failures, timeouts, and CLI parsing failures produce
`ok:false` and `proofComplete:false` and exit non-zero. `--output` writes the
structured result through a same-directory temporary file, file `fsync`, and
atomic rename. Candidate evidence contains only selected-pair `type`,
`protocol`, and `rttMs`; DOM candidate text is not emitted. Success requires a
single current snapshot with DOM `已连接`, Socket.IO connected, RTCPeerConnection
`connected`, FPS above zero, and a selected local relay pair.

Encoder aggregates reset on policy identity replacement. Actual confirmed IDR
output records its causal reason and bytes, including a request received during
an existing wait and a successful recreation IDR; unmeasured end-to-end timing
fields remain null. Paint start/stop/attempt transitions clear both active and
last windows, and a logged paint aggregate carries its attempt ID.

### Verification

- RED: targeted Python and Node suites failed for the new causal-IDR, proof
  helper, Signal admission, and paint identity expectations.
- GREEN: `python -m pytest python-host/test_h264_idr.py -q` — 31 passed.
- GREEN: `node --test scripts/prove-turn-relay.test.mjs signal-server/websocket/signaling.test.js web-client/js/webrtc.test.js` — 281 passed.
- GREEN: `cd signal-server && npm run build:web`.
- GREEN: proof CLI invalid-duration/no-network output test verifies non-zero and
  `ok:false, proofComplete:false`; atomic write and rename error fixtures pass.
- GREEN: `git diff --check`.

### Commit and self-check

This round is committed as `fix(observability): harden relay proof admission`.
No service, browser, tunnel, or live Viewer was started. The only outstanding
limitation is the intentionally absent real TURN/browser run; cross-machine
values remain `NOT RUN` and any future cross-machine value must be marked
`estimate`.
