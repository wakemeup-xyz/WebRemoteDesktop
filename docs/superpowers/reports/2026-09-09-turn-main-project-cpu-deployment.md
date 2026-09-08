# TURN main deployment and project CPU measurement

- User instruction: merge main, restart local services, run; measure only this project CPU and ignore other processes.
- Main implementation commit: `1537a7f852888a2f01d0e5907c7b408f862a3dbd`.
- Main input recovery changes and TURN frame tracing were combined; three manual conflicts independently reviewed without P1/P2 findings.
- Validation: Signal 362 passed; input/recovery/trace/keyboard/mobile/touch/WebRTC selection 452 passed; Host input observation 65 passed; frame-trace/Lab selection 43 passed; project CPU/evaluator 30 passed.
- Local restart succeeded: Signal PID 5556, Host PID 5620. `/health` returned ok; `/api/status` confirmed Host online. Existing quick tunnel URL was unchanged and service status reported reachable. Credentials are not archived here.
- CPU scope: matrix, exact repository Host/Signal and descendants. External CPU is neither measured nor used as an admission criterion. First discovery is warmup outside the 1 Hz window.
- Live Viewer workload CPU sample: 30 samples, total project CPU P50 79.0%, P95 86.4%, max 87.8%. 100% is one logical CPU core; this is not total-machine utilization. This includes the measurement process and is not an encoding qualification result.
- Matrix was invoked from main. It stopped at preflight because one Viewer was connected (`ABORTED_CONTAMINATED`, reason `viewer activity`). There was no external CPU abort. Prescreen/full matrix did not run.
- The production encoder policy remains `relay-legacy-v1`; merging infrastructure does not promote an unqualified candidate. The 1-second quality pulse is not claimed resolved. Long-run 720p/1080p, dedicated desktop input, and isolated finite-loss runtime acceptance remain outstanding.

Evidence: [matrix attempt](evidence/2026-09-09-project-cpu/peak-headroom-main.json), [30-s project CPU](evidence/2026-09-09-project-cpu/live-project-cpu.json).

## Viewer-exited run

After the user exited Viewer, a new run on `e41ec62` confirmed Viewer/relay Viewer both zero and completed the 30-s preflight. The two safety-net prescreens each contain 1,226 frames. Runtime collection took approximately 18 minutes; it collected 1,101 project-CPU samples.

| Resolution | Encode P95 | Limit | Prescreen quality |
| --- | ---: | ---: | --- |
| 1152x720 | 34.478 ms | 25 ms | PASS |
| 1728x1080 | 68.391 ms | 45 ms | PASS |

Re-running the prescreen validator on the preserved raw evidence yields exactly two scenario cost failures. No external CPU was read or used as an abort reason. Project CPU P50/P95/max were 97.5%/101.6%/104.1% (one logical core = 100%), including the evaluator.

The original artifact remains `ABORTED_INCONCLUSIVE`: the inherited ambient sampler still aborts on late ticks; 8 runtime ticks were 0.165–0.541 s late. This monitoring cadence gate is not evidence of an encoder failure. Separately, the actual raw encode P95 fails both existing cost limits, so this run cannot qualify the candidate even if cadence is treated as telemetry. The full five-scenario matrix and live TURN acceptance did not run; no candidate promotion occurred.

Follow-up: runtime CPU timing should be observational under the user’s project-only telemetry instruction. Preserve health/error evidence while removing late CPU-tick timing as a candidate-admission gate. That correction must not relabel this artifact or erase its raw cost failures. Further encoder optimization is required before candidate promotion.

Evidence: [raw run](evidence/2026-09-09-project-cpu/peak-headroom-viewer-exited.json), [independent recomputation summary](evidence/2026-09-09-project-cpu/peak-headroom-viewer-exited-summary.json).
