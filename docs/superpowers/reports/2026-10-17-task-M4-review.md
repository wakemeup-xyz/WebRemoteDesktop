# M4 independent review

Findings: none. No P0/P1/P2/P3 corrective finding identified in the reviewed scope.

- **Specification verdict: APPROVED.**
- **Code-quality verdict: APPROVED.**
- Reviewed frozen commit range: `40450f3..3d88e1c` (`3d88e1c fix(metrics): measure encoding and capture boundaries accurately`).
- Basis: task-M4-brief.md, task-M4-report.md, and frozen `review-40450f3..3d88e1c.diff`. The existing seven dirty control-recovery requirement lines are excluded.
- Scope is complete for the requested M4 change. Outside-hunk reads were limited to the named ownership risks: selected capture/scope, cache reset sites, worker publication barriers, capture tuple creation, production factory, stage serialization, and ordinary encoder telemetry.

## Specification evidence

| Requirement | File and line | Result / severity |
| --- | --- | --- |
| Lazy encoder work belongs to encode, followed by packetization | `python-host/h264_videotoolbox_encoder.py:1044`; `python-host/media_timing.py:12`; `python-host/test_media_stage_boundaries.py:37` | PASS / none. The production encoder materializes the generator before packetize. Actual encoder with lazy fake codec checks 40ms encode, 3ms packetize, 43ms enclosing total, unchanged tiny payload and timestamp. A separate unhooked reformat remains null. |
| Ordinary encoder sample remains wall duration | `python-host/h264_videotoolbox_encoder.py:1026`, `:1062`; `python-host/test_media_stage_boundaries.py:84` | PASS / none. Existing monotonic elapsed wall time still encloses actual encode and packetize, with a 43ms assertion. |
| Immutable selected capture identity survives worker await and cache fallback | `python-host/host.py:1386`, `:1413`, `:1449`, `:1454`; `python-host/test_media_stage_boundaries.py:161` | PASS / none. Grab tuples and scope are selected before await. Cached pixels retain their original sequence and immutable grab tuple. A failed new conversion uses the cache source label, not the newly selected capture sequence. The regression also mutates the bounds map to prove the cached tuple is retained on subsequent reuse. |
| Failed conversion cannot consume the M2 post-apply candidate | `python-host/host.py:1485`; `python-host/test_media_stage_boundaries.py:197` | PASS / none. Reservation is gated on successful fresh output. Old cache output leaves the pending input unreserved. M2 selected scope and capture-start evidence are unchanged; no callback timestamp is substituted. The worker generation/profile/shutdown checks still precede publication. |
| Blank output carries no capture evidence | `python-host/host.py:1460`, `:1755`; `python-host/test_media_stage_boundaries.py:226` | PASS / none. Blank uses captureSeq 0 and null grab/age evidence; it cannot reserve a fresh candidate. |
| Queue, prepare, convert, build have distinct boundaries; strict v1 wire stays unchanged | `python-host/host.py:1694`; `python-host/media_stage_metrics.py:17`, `:24`, `:64`; `python-host/test_media_stage_boundaries.py:238` | PASS / none. Local convert is added to METRIC_STAGES; serialization still projects exactly the existing nine STAGES fields. Build encloses prepare/convert. Existing frame_timing.frameConvertMs remains the conversion field. |
| Reuse log/wire share pre-reset numerator and denominator | `python-host/host.py:1508`, `:1527`, `:1548`; `python-host/test_media_stage_boundaries.py:107` | PASS / none. Both use interval snapshots even though instance counters reset before transmission. Test asserts 2/3 followed by 0/1. |
| Intentional pause is labeled and excluded from active recv | `python-host/host.py:1344`, `:1372`, `:1496`, `:1517`; `python-host/test_media_stage_boundaries.py:136`, `:201` | PASS / none. Initial suspension and suspension beginning during pacing use the same duration clock; 300 seconds are excluded while active work/pacing remains included. |
| Actual production factory uses 1x and one OpenCV thread | `python-host/host.py:1979`; `python-host/test_media_stage_boundaries.py:271` | PASS / none. The test invokes the actual factory with a mocked constructor and inspects its arguments. |
| No fabricated freshness, network, or visible-effect evidence | `web-client/js/latency-monitor.test.js:78` | PASS / none. The new regression retains individual enclosing totals without pipeline sums and rejects Host timing/paint alone as fresh-frame or visible-effect evidence. |

## Architecture and documentation

Architecture: no finding. Pixel provenance belongs to the cached image sidecar and explicit worker source result; output identity is derived only after the existing publication barriers. This avoids assigning failed screenshot identity to fallback pixels while preserving event-loop PTS ownership. The pure helper and production encoder implement equivalent materialization boundaries as explicitly permitted by M4. The additional local conversion distribution does not enlarge the strict frame_trace_batch v1 contract or require a Viewer schema migration. Per-frame materialization retains only the current output NAL list and introduces no history queue.

Documentation: no finding. The committed requirements update at `docs/需求文档/WebRemoteDesktop-需求文档.md:75` records capture provenance, shared reuse windows and pause semantics; `:78` distinguishes pre-encoder frame_timing from detailed encode trace and describes enclosing totals and unavailable evidence. The existing production-factory description correctly distinguishes current 1x source from compatibility/experimental 2x behavior and makes no historical-process deployment claim. The versioned implementation report states the actual test boundary and NOT RUN acceptance items.

## Validation and residual limits

The supplied implementation report records **16 Python boundary/clock tests, 23 Viewer collector tests, and 23 targeted metrics/causality/worker tests passed**, plus diff whitespace validation. These were inspected as reported evidence and were **not rerun** during this review, per assignment. Test implementations were read for behavioral assertions, including the real encoder object with fake codec and fallback pixel/identity/candidate assertions.

This review performed no service, tunnel, Viewer, network, native capture/input, hardware encoder, dist, index, or source mutations. Real playback, physical-device behavior, optical latency, production performance, deployment state, and long-running stability remain **NOT RUN**; approval does not claim those outcomes.
