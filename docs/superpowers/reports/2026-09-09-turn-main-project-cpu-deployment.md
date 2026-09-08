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
