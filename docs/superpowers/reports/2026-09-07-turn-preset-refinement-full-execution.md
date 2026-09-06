# TURN preset refinement: complete control and superfast execution

The fixed `relay-preset-refinement` matrix executed both the fresh ultrafast control and the sole superfast candidate. The control was complete and comparable even though its own quality measurements did not qualify it. The candidate is `FAIL`, production remains `relay-legacy-v1`, every runtime gate remains `NOT RUN`, and no frozen candidate manifest was emitted. No additional preset or tuning run is authorized.

The first attempted run was interrupted because another task's pytest began after its start; it wrote no artifact. The retained run began only after process preflight found no pytest, Docker smoke, or matrix process, and `http://127.0.0.1:8080/api/status` reported `hostOnline=true`, `viewerCount=0`, `relayViewerCount=0`, `viewers=[]`, and `viewerEpoch=41`. It used Python 3.11 at `nice -n 15` and completed successfully in about 38 minutes.

## Bound evidence

The raw result is [relay-preset-refinement-full.json](evidence/2026-09-06-turn-next/relay-preset-refinement-full.json), with a separate immutable-metadata [sidecar](evidence/2026-09-06-turn-next/relay-preset-refinement-full.sidecar.json).

| Item | SHA-256 / value |
| --- | --- |
| Raw artifact | `806630a8233e3f7536a84b6d444677e170d5648dec1660e8cf7e28fb174e340f` |
| Execution revision | `ac58a7e640d9a2bf0fdf408211418b2f85c5f896` |
| Input | `a83d190307d46b7c6482044561449c01d95825196ee2af84d4a74590f30e4434` |
| Candidate parameter digest | `9bb53b21f49471e12a3ff4a5c1fdf81cbbe94ee0e3130a1fbb64649b0b2fbdf9` |
| Probe source | `ce39667c59a9f4161dffc845a2d139cae157e382d35ad67d7595b49ab545adc5` |
| Evaluator source | `364b969d8dee44f0ba967e8c28da569d14bdaeeaa090713496a0eb2b1bc87bde` |
| Experiment contract source | `9e6841531a0489b53171bd0efcd5bdf55ebc68147b8f6269016c7f2f5d34c24e` |
| Encoder source | `1eff561493e454b966582f218e6da7baa77a4b7a68386cd90800ce40f87289b3` |

## Independently recomputed gates

`Q`, `C`, and `B` are the artifact quality, frame-derived P95 cost, and actual-IDR-byte gates. P95 was independently recomputed from every frame in each scenario. Each candidate codec record had creation index `1`, reopen reason `initial`, and both requested and submitted preset `superfast`.

| Config | Resolution | Scenario | Q | C | B | Recomputed P95 ms / budget | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ultrafast | 1152x720 | static-text | FAIL | PASS | PASS | 6.744 / 25 | reference only |
| ultrafast | 1152x720 | health-static | PASS | PASS | PASS | 5.709 / 25 | reference only |
| ultrafast | 1152x720 | scrolling-text | FAIL | PASS | PASS | 7.477 / 25 | reference only |
| ultrafast | 1152x720 | post-scroll-static | FAIL | PASS | PASS | 6.693 / 25 | reference only |
| ultrafast | 1152x720 | safety-net | FAIL | PASS | PASS | 5.832 / 25 | reference only |
| ultrafast | 1728x1080 | static-text | FAIL | PASS | PASS | 14.028 / 45 | reference only |
| ultrafast | 1728x1080 | health-static | PASS | PASS | PASS | 13.312 / 45 | reference only |
| ultrafast | 1728x1080 | scrolling-text | FAIL | PASS | PASS | 16.129 / 45 | reference only |
| ultrafast | 1728x1080 | post-scroll-static | FAIL | PASS | PASS | 15.658 / 45 | reference only |
| ultrafast | 1728x1080 | safety-net | FAIL | PASS | PASS | 14.294 / 45 | reference only |
| superfast | 1152x720 | static-text | FAIL | PASS | PASS | 9.566 / 25 | FAIL |
| superfast | 1152x720 | health-static | PASS | PASS | PASS | 9.674 / 25 | PASS |
| superfast | 1152x720 | scrolling-text | FAIL | PASS | PASS | 10.716 / 25 | FAIL |
| superfast | 1152x720 | post-scroll-static | FAIL | PASS | PASS | 11.019 / 25 | FAIL |
| superfast | 1152x720 | safety-net | FAIL | PASS | PASS | 10.023 / 25 | FAIL |
| superfast | 1728x1080 | static-text | FAIL | PASS | PASS | 19.534 / 45 | FAIL |
| superfast | 1728x1080 | health-static | PASS | PASS | PASS | 18.928 / 45 | PASS |
| superfast | 1728x1080 | scrolling-text | FAIL | PASS | PASS | 21.033 / 45 | FAIL |
| superfast | 1728x1080 | post-scroll-static | PASS | PASS | PASS | 18.683 / 45 | PASS |
| superfast | 1728x1080 | safety-net | FAIL | PASS | PASS | 20.150 / 45 | FAIL |

The candidate failed on-demand-IDR PSNR below 28 dB in both static scenarios and in scrolling at both resolutions, plus safety-net failure at both resolutions. Its 720p safety-net was 27.125 dB / 5.264 MAE; its 1080p safety-net was 29.088 dB / 3.375 MAE. The complete failure list is in the raw artifact's `ineligibleReason` array. This offline result does not prove TURN, Viewer buffering, Host event-loop/input acknowledgement, or finite loss recovery; all remain `NOT RUN`.
