# Task 6 report: relay-balanced-v2 parameter matrix

## Scope and boundary

This task evaluated only the deterministic offline encoder probe. It did not
start a Host or service, open a browser, allocate TURN, inject packet loss, or
send input. The implementation keeps `relay-legacy-v1` as the default and does
not change the runtime `relay-balanced-v2` constants because no candidate met
the offline gates.

## Red phase

- The selection test first failed with `AttributeError` because the evaluator
  had no `select_relay_candidate` boundary.
- The matrix evidence test then failed with argparse exit code 2 because
  `--matrix relay` was unsupported and the old `--policy` argument was still
  required.

## Fixed conservative matrix

The evaluator records the whole ordered path, but evaluates only until a gate
failure or first offline winner. A later row is not run after a failure, so it
cannot silently compound an already-rejected setting.

| Order | Candidate | Change from previous row | Result |
|---:|---|---|---|
| 1 | `gop-2s-current-bitrate-vbv100` | GOP only: 20 to 40 frames; 1152x720 1.8Mbps, 1728x1080 2.5Mbps, VBV 100ms | FAIL |
| 2 | `gop-2s-current-bitrate-vbv150` | VBV to 150ms | NOT RUN: row 1 failed |
| 3 | `gop-2s-cap-bitrate-vbv150` | bitrate to 3.2/5Mbps | NOT RUN: row 1 failed |
| 4 | `gop-2s-cap-bitrate-vbv200` | VBV to 200ms | NOT RUN: row 1 failed |
| 5 | `gop-4s-cap-bitrate-vbv200` | GOP to 80 frames | NOT RUN: row 1 failed |
| 6 | `gop-10s-cap-bitrate-vbv200` | GOP to 200 frames | NOT RUN: row 1 failed |
| 7 | `on-demand-cap-bitrate-vbv200` | remove periodic GOP | NOT RUN: also requires real finite-loss recovery |

The evaluated first row had no periodic IDR in the 0.8-1.5-second pulse window
and met both local encode budgets. It failed both required image-quality gates:

| Resolution | Pulse gate | Periodic IDR `changeMAE` | On-demand IDR PSNR | Encode p95 |
|---|---|---:|---:|---:|
| 1152x720 | PASS, periodic IDR frame 40 | FAIL, 17.372 (limit 3.0) | FAIL, 17.540dB (minimum 28dB) | PASS, 6.794ms (limit 25ms) |
| 1728x1080 | PASS, periodic IDR frame 40 | FAIL, 11.496 (limit 3.0) | FAIL, 19.298dB (minimum 28dB) | PASS, 13.666ms (limit 45ms) |

## Selection and evidence

The selection is `stopped-at-legacy`; there is no runtime-validation candidate.
The default remains `relay-legacy-v1`. The complete JSON, including every frame,
encoder configuration, machine metadata, per-resolution gate result, skipped-row
reason, and explicit runtime `NOT RUN` gates is versioned at:

`docs/superpowers/reports/evidence/2026-09-05-turn-quality/relay-balanced-v2-matrix.json`

The evaluator has one direct encoder force at frame 5 solely to measure
on-demand-IDR PSNR. It explicitly does not claim a network loss, Viewer buffer,
selected relay pair, Host event-loop, or remote-input-ack result.

## Verification

- `/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 scripts/eval-turn-encoder-quality.py --matrix relay --output /tmp/wrd-relay-matrix.json` — completed; selection `stopped-at-legacy`.
- `/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m pytest -q python-host/test_h264_encoder_policy.py python-host/test_h264_idr.py` — 42 passed.
- `/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m unittest scripts/test-turn-media-timeline.py -q` — 3 passed.
- `git diff --check` — passed.

## Commit

`feat(media): evaluate relay encoder quality matrix` (this commit)

## Concerns

The offline matrix is intentionally insufficient for the Viewer buffer/decode,
Host event-loop/input-ack, and finite-loss recovery gates. They remain `NOT RUN`
until Task 9 records a real selected relay path. The first candidate's failure
also means this task does not claim to have fixed periodic relay image quality.

## Fix round 1/5: independent matrix and on-demand model

The earlier stop-after-first-failure implementation was replaced. Each candidate
now carries a complete declared baseline and a single declared changed variable,
then runs independently even if an earlier candidate failed. The regenerated
matrix has seven evaluated rows, each with both 1152x720 and 1728x1080 results:

| Candidate | Parameters | 720p gates | 1080p gates |
|---|---|---|---|
| `gop-2s-current-bitrate-vbv100` | 40 frames, 1.8/2.5Mbps, 100ms | pulse/encode PASS; periodic-quality/on-demand-PSNR FAIL | same |
| `gop-2s-current-bitrate-vbv150` | 40 frames, 1.8/2.5Mbps, 150ms | pulse/encode PASS; periodic-quality/on-demand-PSNR FAIL | same |
| `gop-2s-cap-bitrate-vbv150` | 40 frames, 3.2/5Mbps, 150ms | pulse/encode PASS; periodic-quality/on-demand-PSNR FAIL | same |
| `gop-2s-cap-bitrate-vbv200` | 40 frames, 3.2/5Mbps, 200ms | pulse/encode PASS; periodic-quality/on-demand-PSNR FAIL | same |
| `gop-4s-cap-bitrate-vbv200` | 80 frames, 3.2/5Mbps, 200ms | pulse/encode PASS; periodic-quality/on-demand-PSNR FAIL | same |
| `gop-10s-cap-bitrate-vbv200` | 200 frames, 3.2/5Mbps, 200ms | pulse/encode PASS; periodic-quality/on-demand-PSNR FAIL | same |
| `on-demand-cap-bitrate-vbv200` | no periodic IDR, 3.2/5Mbps, 200ms | logical no-periodic/encode PASS; forced-IDR PSNR FAIL | same |

For on-demand-only, `periodic_idr_due()` deterministically returns false for all
1,200 frames in the 60-second health window. The encoder itself treats a zero
periodic GOP as on-demand-only and uses a 1,201-frame x264 keyint safety value;
the actual sample is intentionally only 65 frames per resolution and contains
one direct force at frame 5. It measures forced-IDR PSNR, encode time, IDR byte
average/max, P-frame byte average/max, and IDR-to-P average burst ratio. It does
not simulate loss or treat byte size as playback buffering.

Selection now has three explicit states: `no-offline-winner`,
`runtime-validation-candidate`, and `validated`. This matrix is
`no-offline-winner`, so no v2 constants were installed. A later offline winner
would remain `runtime-validation-candidate` with the legacy default until all
real relay gates pass; only then may it become `validated` and promote v2.

The updated evidence is
`docs/superpowers/reports/evidence/2026-09-05-turn-quality/relay-balanced-v2-matrix.json`.
The Task 9 Viewer-buffer, Host event-loop/input-ack, and finite-loss gates remain
`NOT RUN`/`PENDING` as appropriate.

### Fix-round verification

- RED: selection-state assertions first failed because the evaluator emitted no
  `state`; matrix assertions then failed because rows were skipped and there was
  no `frameBytes` summary.
- GREEN: `/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m
  pytest -q python-host/test_h264_encoder_policy.py python-host/test_h264_idr.py`
  — 43 passed; `/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3
  -m unittest scripts/test-turn-media-timeline.py -q` — 3 passed; the exact
  matrix command and `git diff --check` were also rerun before commit.

### Fix-round commit

`fix(media): evaluate independent relay encoder candidates` (this commit)
