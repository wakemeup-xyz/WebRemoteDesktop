# TURN preset refinement: corrected offline execution

## Result

The one authorized, corrected offline matrix execution produced
`no-offline-winner`.  The fresh ultrafast control failed the required cost
gate at both resolutions, so the fail-closed evaluator did not run the sole
superfast candidate.  Production remains on `relay-legacy-v1`; all runtime
gates remain `NOT RUN`.

The control was measured with the corrected source that validates actual
codec-construction records, frame-derived P95 and IDR bytes, continuous PTS,
and shared input identity.  This is separate from the earlier
`relay-preset-refinement.json` artifact, which is retained only as an invalid
historical artifact for its pre-correction source and must not be used for
selection.

## Maintenance clearance and command

Immediately before the run, read-only local status showed the Host and signal
server healthy and `/api/status` reported `viewerCount: 0`,
`relayViewerCount: 0`, and `viewers: []` (viewer epoch 41).  There was no
existing encoder-probe or matrix process.  No service, Viewer, or tunnel was
stopped, restarted, or changed.

```bash
nice -n 15 /Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 \
  scripts/eval-turn-encoder-quality.py --matrix relay-preset-refinement \
  --output /tmp/wrd-next-preset-corrected.json
```

The process completed at `2026-09-07T00:49:38+0800`.  Its last observed
elapsed time was 46 minutes 13 seconds.  The raw deterministic result alone
was copied byte-for-byte to
`docs/superpowers/reports/evidence/2026-09-06-turn-next/relay-preset-refinement-corrected.json`.
The separately versioned
`docs/superpowers/reports/evidence/2026-09-06-turn-next/relay-preset-refinement-corrected.sidecar.json`
is post-run metadata and does not amend or replace that raw JSON.

## Bound evidence

| Item | SHA-256 / value |
| --- | --- |
| Corrected evidence file | `0b6cbd31fa2f856262609f2863def073d54f49a7aefa3b2145f279531732dc62` |
| Post-run sidecar | `relay-preset-refinement-corrected.sidecar.json` (bound to the corrected-evidence SHA above) |
| Execution source revision | `5a2e97bfd35dc79c95ca08eeac0112e47f1be91b` |
| Input digest | `a83d190307d46b7c6482044561449c01d95825196ee2af84d4a74590f30e4434` |
| Ultrafast actual config digest | `9d47c98b0b6342cc2099737ed753c56795303d1125b89b126b00cb83787c2eb8` |
| Superfast declared config digest (not executed) | `9bb53b21f49471e12a3ff4a5c1fdf81cbbe94ee0e3130a1fbb64649b0b2fbdf9` |
| `encoder_probe.py` | `ce39667c59a9f4161dffc845a2d139cae157e382d35ad67d7595b49ab545adc5` |
| `h264_videotoolbox_encoder.py` | `a9dbf26a24730f9b27bbe2db368148eae6268a93372e72dbac764b6a0dd8445d` |
| `eval-turn-encoder-quality.py` | `9dd55e074d6e03986eba74541052854d9c642adaf0ae84a65c890a7029fac73e` |
| `turn_encoder_experiments.py` | `7b7d9c8d1c17c7662d0937cdd05932dab6b41179005872a63d8b301d5677340f` |

The executed control used libx264, `ultrafast`, Baseline, 20 FPS, fixed
3.2 Mbps/5.0 Mbps caps, VBV 200 ms, and no periodic IDR.  The candidate was
the sole authorized `superfast` configuration with those same settings; it
has no actual codec-construction record because the control cost failure
stopped the run before candidate execution. The sidecar records the complete
declared superfast configuration/digest, exact base-stop errors, and the
actual execution source revision without fabricating an encoder record or a
candidate result.

## Per-scenario result

`Q` is the probe's scenario quality status, `C` is its frame-derived P95
encode-cost status, and `B` is its actual-bitstream IDR-byte status.  The
matrix validation errors were exactly `base: scrolling-text: scenario cost
failure` and `base: static-text: scenario cost failure`.

| Resolution | Scenario | Q | C (P95 / budget ms) | B |
| --- | --- | --- | --- | --- |
| 1152x720 | static-text | FAIL | PASS (19.813 / 25) | PASS |
| 1152x720 | health-static | PASS | PASS (16.175 / 25) | PASS |
| 1152x720 | scrolling-text | FAIL | **FAIL (25.044 / 25)** | PASS |
| 1152x720 | post-scroll-static | FAIL | PASS (17.251 / 25) | PASS |
| 1152x720 | safety-net | FAIL | PASS (23.008 / 25) | PASS |
| 1728x1080 | static-text | FAIL | **FAIL (48.489 / 45)** | PASS |
| 1728x1080 | health-static | PASS | PASS (34.732 / 45) | PASS |
| 1728x1080 | scrolling-text | FAIL | PASS (34.136 / 45) | PASS |
| 1728x1080 | post-scroll-static | FAIL | PASS (37.350 / 45) | PASS |
| 1728x1080 | safety-net | FAIL | PASS (36.537 / 45) | PASS |
| Both | superfast candidate | NOT RUN | NOT RUN | NOT RUN |

The baseline's quality rows are retained as measured probe facts.  Baseline
quality is a reference measurement; the validator enforces the configured
quality threshold for a candidate.  The control cost failures are mandatory
measurement-integrity gates and therefore stopped the only candidate before
any selection could occur.

## Limits

This offline synthetic result proves neither TURN behavior nor Viewer buffer
continuity, Host event-loop/input acknowledgement, finite loss recovery, or a
production change.  Those runtime gates remain `NOT RUN`, and no automatic
retry, search, threshold change, bitrate/profile/thread change, or hardware
migration was performed.
