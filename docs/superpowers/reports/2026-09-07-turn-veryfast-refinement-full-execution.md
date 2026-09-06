# TURN veryfast refinement: complete superfast control and veryfast execution

The one authorized `relay-veryfast-refinement` run completed with a fresh `superfast` control and the sole `veryfast` candidate. The candidate is `FAIL`: on-demand IDR quality remains below 28 dB in required scenarios and both safety-net checks exceed the change-MAE limit. Every frame-derived P95 cost is within its resolution budget, but that does not compensate for the quality failures. Production remains `relay-legacy-v1`; all runtime gates remain `NOT RUN`, no manifest was emitted, and this result authorizes no follow-on preset or tuning attempt.

The matrix started only after process preflight found no pytest, Docker smoke, prior matrix, T3 collector, or Lab runner/Host. `http://127.0.0.1:8080/api/status` reported `hostOnline=true`, `viewerCount=0`, `relayViewerCount=0`, `viewers=[]`, and `viewerEpoch=41`. It used Python 3.11 at `nice -n 15` and exited with status 0.

The raw result is [relay-veryfast-refinement-full.json](evidence/2026-09-07-turn-veryfast/relay-veryfast-refinement-full.json); immutable run metadata is in its [sidecar](evidence/2026-09-07-turn-veryfast/relay-veryfast-refinement-full.sidecar.json).

| Item | SHA-256 / value |
| --- | --- |
| Raw artifact | `20d8ddd3cbdc7fbaebb5e68b3eaed8b1fde054a120dea8bf33b7a454570ddd8c` |
| Execution revision | `43bdb90f83363bcfbdf2d4b5db44106e61458632` |
| Input | `a83d190307d46b7c6482044561449c01d95825196ee2af84d4a74590f30e4434` |
| Superfast control parameter digest | `9bb53b21f49471e12a3ff4a5c1fdf81cbbe94ee0e3130a1fbb64649b0b2fbdf9` |
| Veryfast candidate parameter digest | `5b9f15528b42024dba6f6010f7d33e2d6ea49125342e1033db676faca7ae5636` |

## Independent recomputation

The report recomputed P95 from each raw scenario frame sequence, compared every candidate frame with the control, and checked actual codec-creation records. All 6,184 matched frame positions had identical input hashes and PTS. Each scenario had one codec creation record with `creationIndex=1` and `reopenReason=initial`; the actual requested and submitted preset was `superfast` for the control and `veryfast` for the candidate. The submitted options retained libx264/Baseline/20 FPS/threads 1/zerolatency, 3.2/5 Mbps, VBV 200 ms with `vbv-init=0.4`, no B-frames/lookahead, closed GOP, no intra refresh, `forced-idr=1`, and `keyint=min-keyint=1201`.

The exact expected bitstream IDR schedule was present in every scenario: initial IDR where applicable, on-demand IDRs at static 5, scrolling 5/200, post-scroll 305/500, and safety-net 1201. No application periodic IDR appeared. Every burst list matched the actual IDR bytes, so each `B` gate passed.

`Q` is the required on-demand-IDR PSNR gate (at least 28 dB) plus the safety-net PSNR/change-MAE gate (at least 28 dB and at most 3.0). `C` is the recomputed P95 encode-cost gate (25 ms at 720p, 45 ms at 1080p). `B` is actual IDR-byte evidence.

| Config | Resolution | Scenario | Q | C | B | IDR PSNR or safety PSNR/MAE | P95 ms / budget | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| superfast control | 1152x720 | static-text | FAIL | PASS | PASS | 24.965 | 7.314 / 25 | reference only |
| superfast control | 1152x720 | health-static | PASS | PASS | PASS | — | 8.295 / 25 | reference only |
| superfast control | 1152x720 | scrolling-text | FAIL | PASS | PASS | 23.180, 27.179 | 8.107 / 25 | reference only |
| superfast control | 1152x720 | post-scroll-static | FAIL | PASS | PASS | 27.159, 27.058 | 8.223 / 25 | reference only |
| superfast control | 1152x720 | safety-net | FAIL | PASS | PASS | 27.125 / 5.264 | 11.406 / 25 | reference only |
| superfast control | 1728x1080 | static-text | FAIL | PASS | PASS | 25.067 | 30.128 / 45 | reference only |
| superfast control | 1728x1080 | health-static | PASS | PASS | PASS | — | 36.093 / 45 | reference only |
| superfast control | 1728x1080 | scrolling-text | FAIL | PASS | PASS | 25.121, 28.897 | 19.107 / 45 | reference only |
| superfast control | 1728x1080 | post-scroll-static | PASS | PASS | PASS | 28.912, 28.912 | 19.421 / 45 | reference only |
| superfast control | 1728x1080 | safety-net | FAIL | PASS | PASS | 29.088 / 3.375 | 18.168 / 45 | reference only |
| veryfast candidate | 1152x720 | static-text | FAIL | PASS | PASS | 24.642 | 13.379 / 25 | FAIL |
| veryfast candidate | 1152x720 | health-static | PASS | PASS | PASS | — | 11.788 / 25 | PASS |
| veryfast candidate | 1152x720 | scrolling-text | FAIL | PASS | PASS | 24.662, 27.343 | 15.050 / 25 | FAIL |
| veryfast candidate | 1152x720 | post-scroll-static | FAIL | PASS | PASS | 27.197, 27.442 | 13.614 / 25 | FAIL |
| veryfast candidate | 1152x720 | safety-net | FAIL | PASS | PASS | 27.079 / 5.442 | 12.729 / 25 | FAIL |
| veryfast candidate | 1728x1080 | static-text | FAIL | PASS | PASS | 26.028 | 23.615 / 45 | FAIL |
| veryfast candidate | 1728x1080 | health-static | PASS | PASS | PASS | — | 21.840 / 45 | PASS |
| veryfast candidate | 1728x1080 | scrolling-text | FAIL | PASS | PASS | 25.438, 29.563 | 24.757 / 45 | FAIL |
| veryfast candidate | 1728x1080 | post-scroll-static | PASS | PASS | PASS | 28.895, 29.682 | 22.319 / 45 | PASS |
| veryfast candidate | 1728x1080 | safety-net | FAIL | PASS | PASS | 28.941 / 3.552 | 22.511 / 45 | FAIL |

The offline result only covers synthetic encoder evidence. It does not prove TURN transport, Viewer buffering or decode continuity, Host event-loop/input acknowledgement, or finite loss recovery; those gates remain `NOT RUN`.
