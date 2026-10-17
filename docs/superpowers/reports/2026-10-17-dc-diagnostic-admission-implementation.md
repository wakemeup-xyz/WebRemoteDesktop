# Task 1 implementation report

Status: DONE WITH CONCERN. Commit `e279060` (`fix(host): bound disposable DataChannel diagnostic admission`). Only five whitelisted Python source/test files committed; report remains at the requested ignored SDD path for controller to archive/version with final review. Source/index ownership released to controller.

## Scope and implementation

Only worktree Python source/tests changed. Four allowlisted disposable message types share synchronous UTF-8 admission at 4096 bytes. No await, retry, fallback, retained payload, thread or timer was added. All channel properties fail closed. Fixed per-type sent/drop, fixed reason counters and legacy loss counts saturate at 2^63-1; cumulative local summary reuses capture's five-second log point.

Every timing attempt drains both legacy collections under their existing lock and increments frameId, including missing host/DC and rejected sends. Successful legacy wire fields/null semantics remain. Trace sends have independent outcomes: frame drops add only the current actual row count; loss drops return event count plus the previously drained drop count. Empty-events count batches are accepted by existing Viewer acceptLossLabHostTraceBatch (webrtc.js), so they report loss exactly once without extending schema. Reliable ACK, M2 binding, clock, selected pair and lab begin/flush source-watermark paths are unchanged.

## RED

`/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m pytest -q python-host/test_dc_diagnostic_admission.py`

Before implementation: actual AST-extracted `_send_frame_timing`, real RTCDataChannel plus real RTCSctpTransport send/flush, pure-memory established SCTP with deliberately busy outbound: 200 sends accumulated 46290 bytes, failing <=4096. No Host import/network/native calls. After minimal change, the single regression passes and another 200 attempts do not increase queue size. These two light single-test runs preceded the controller's request to defer combined tests during live diagnostics.

## GREEN and fixture baseline

After controller confirmed live diagnostic exit, ran the single-process combination:

```sh
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m pytest -q python-host/test_dc_diagnostic_admission.py python-host/test_media_stage_boundaries.py python-host/test_latency_timing.py python-host/test_loss_lab_taps.py python-host/test_input_frame_causality.py python-host/test_media_timing.py -k 'not test_screen_capture_track_has_timing_fields'
```

Initial result: 60 passed, 6 failed, 1 deselected. All six failures came from four old fake DC construction sites returning a new object every getter call with no readyState/bufferedAmount. Only these fixtures were changed to stable objects, `readyState="open"`, `bufferedAmount=0`; original send capture and all wire assertions retained. Rerun: 65 passed, 1 failed, 1 deselected. New admission file contributes 32 passing cases. Real MSS-construction test intentionally excluded (no actual screenshot/capture authorized).

The remaining failure is detailed below. Final bounded suite excluding that known baseline failure:

```sh
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m pytest -q python-host/test_dc_diagnostic_admission.py python-host/test_media_stage_boundaries.py python-host/test_latency_timing.py python-host/test_loss_lab_taps.py python-host/test_input_frame_causality.py python-host/test_media_timing.py -k 'not test_screen_capture_track_has_timing_fields and not test_real_capture_encoder_rtp_datachannel_and_viewer_trace_wiring_preserves_legacy_timing'
node --test web-client/js/latency-monitor.test.js web-client/js/webrtc.frame-trace.test.js
```

Results: **65 passed / 2 deselected** (4.47s); **45 Node tests passed** (1.22s). Node directly executes in-memory tests; no npm/pretest/build or browser. `git diff --cached --check` passed. Tests preserve null/unavailable missing media evidence and reliable ACK/M2 binding/clock/selected-pair/lab-flush sends above 4096 bytes. New tests also cover UTF-8 exact equality/+1/oversize, all invalid channel properties, legacy drop paths and no replay on replacement, independent trace results, existing loss-count restoration and count-only delivery exactly once, fixed/saturating counters, and two sends observing synchronous byte growth.

## Baseline failure / concern

`test_latency_timing.py::TestFrameTiming::test_real_capture_encoder_rtp_datachannel_and_viewer_trace_wiring_preserves_legacy_timing` still fails at line 297: `viewer_result["matched"][0]["captureSeq"]`, because matched is empty. The actual pipeline is synthetic Screenshot → actual track.recv → actual libx264 encode → instrumented RTP send callback → emitted frame_trace_batch → Node VM Viewer callback and DataChannel onmessage → FrameTraceCollector.takeMatched. Host wire assertions before the Viewer step pass. Static cause: Node fixture PC supplies no `getReceivers`, and video supplies no `srcObject.getVideoTracks`; current `verifiedVideoFrameIdentity` requires the receiver/track association plus synchronization SSRC and immediately returns null without getReceivers. This is outside the diagnostic gate's scope, and all original Viewer assertions remain unchanged.

Confirmed against original `8b8c0dc` production methods (no checkout mutation) in an independent process; same line 297 empty-match failure. Exact command:

```sh
PYTHONPATH=python-host /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 - <<'BASELINE'
import ast, subprocess, pytest, host
source = subprocess.check_output(['git', 'show', '8b8c0dc:python-host/host.py'], text=True)
cls = next(n for n in ast.parse(source).body if isinstance(n, ast.ClassDef) and n.name == 'ScreenCaptureTrack')
methods = [n for n in cls.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in {'recv', '_send_frame_timing', '_send_frame_trace_batch'}]
ns = dict(vars(host))
exec(compile(ast.Module(body=methods, type_ignores=[]), 'baseline-host-methods', 'exec'), ns)
for n in methods: setattr(host.ScreenCaptureTrack, n.name, ns[n.name])
raise SystemExit(pytest.main(['-q', '--tb=short', 'python-host/test_latency_timing.py::TestFrameTiming::test_real_capture_encoder_rtp_datachannel_and_viewer_trace_wiring_preserves_legacy_timing']))
BASELINE
```

## Self-review

Production diff only adds helper import and four diagnostic call sites; reliable methods and registry/Viewer algorithms unchanged. Helper retains no payload, DC, identity or retry state. Trace legacy accumulated droppedTraceCount is never re-added; drained loss counts are returned only on that loss batch's failure. Read-only Viewer contract confirms empty event arrays accepted. All pre-task README/runbook/requirements/review-anchor edits, controller docs and node_modules symlink preserved; no services/tunnel/network/native input touched.

## Limitations

4096 limits admission against reported per-channel bufferedAmount only; SCTP outbound/sent/retransmit and reliable traffic are outside that bound. No ACK latency SLA. No service deployment, production validation, root-cause claim for the prior 13.8-second stall or input→visible acceptance. capture_stats still has no independent TTL. Input→visible NOT RUN.
