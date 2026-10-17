# Task 1 implementation report — monotonic media pacing and statistics

Date: 2026-10-17. Base: `04ae5d4175d65e625c264bee173080321673ef3b`.
Source/test commit: `f4923571d9032e61bade535272857cc9b1cd0d08` (`fix(media): use monotonic clocks for pacing and stats`).

## Scope and result

Implemented only Task 1 from `task-clock-brief.md`, against the linked `docs/superpowers/specs/2026-10-17-media-monotonic-clock-design.md` and repository AGENTS instructions. Exactly four tracked paths are in the implementation commit:

- `python-host/host.py`: ten substitutions from `time.time()` to `time.monotonic()`. These cover both JPEG statistics initializations, JPEG iteration start/elapsed/current time, ScreenCaptureTrack statistics initialization, recv pacing read/update, frame trace summary trigger and CAPTURE statistics current time. No algorithm, threshold, policy, lifecycle or external interface was changed.
- `python-host/test_frame_worker.py`: matching monotonic `bare_track.last_time`, independent fake clock helper and actual recv pacing/lifecycle regressions.
- `python-host/test_tunnel_relay.py`: deterministic actual `_run` tests with fake JPEG worker/output, real scope-checked ACK, fake sleeps and emit recorder; statistics initialization/reset and epoch timestamp regressions.
- `python-host/test_media_stage_boundaries.py`: actual recv five-second CAPTURE/trace tests and native-free constructor initialization regression; three existing fake-clock patches now target monotonic instead of wall time because the associated private duration fields use the monotonic domain.

No additional fixture files needed modification. The existing media-suspension fixtures use zero/reset sentinels or opaque previous values and remain valid. The unused `_capture_last_log` field stays wall-clock initialized because nothing reads it and the spec excludes unrelated cleanup.

## Actual behavior exercised

The shared MediaClock replaces only `host.time` with a namespace holding independent epoch and monotonic values. It does not change the process/system clock or asyncio's actual scheduling clock. Fake pacing sleeps record the requested delay without waiting. Actual recv still selects/builds the frame using the existing bare track and non-native worker executor; all tracks shut down in `finally`. Constructor initialization uses fake MSS data and a mocked capture thread; no native capture starts.

1. Actual recv is first primed to establish its own previous-output timestamp. At 20fps, monotonic progression of 20ms requests approximately 30ms for wall changes of normal +20ms, +20ms minus 4.24s and +20ms plus 4.24s. At 80ms elapsed, no pacing sleep is requested in any case. PTS continues from 9000 to 12000.
2. First output and resumed output remain immediate. The resumed output contains newly supplied pixels, after a wall rollback, rather than the suspended cache. Suspension triggered inside the pacing sleep reaches the existing pause wait and resumes with fresh pixels. Shutdown triggered there results in MediaStreamError. Existing in-flight-worker shutdown and generation rejection tests also pass.
3. Actual JPEG `_run` retains its medium profile's 6fps interval. With 20ms work it requests approximately 146.6667ms; with 500ms work it retains the existing 1ms yield. Both hold across normal, backward and forward wall time. One worker is created; request/emitted scopes match; the actual scope-checked ACK releases each frame's slot with measured zero RTT.
4. JPEG timestamps equal the supplied epoch milliseconds and remain above 1e12, proving they did not change to monotonic time.
5. CAPTURE and frame trace summary reports are absent at monotonic 104.999 after a 100.0 baseline, present at 105.0, and report again at 110.0. CAPTURE wire/log FPS is 0.4 then 0.2 for two frames then one frame, using five-second denominators; counters reset. This holds with stationary, backward and forward wall clocks.
6. JPEG reporting is exercised at 104.999, 105.0, 109.999 and 110.0 after initialization at 100.0. Two reports have two frames and FPS 0.4 each; the baseline resets to 110.0 and counters reset. Constructor/start both initialize to monotonic time, and start is stopped before capture can run.

## RED evidence, before production edits

Run from `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`, using the already-installed Python environment (no local .venv present, interpreter recovered from the previous media-null report):

```sh
PYTHONPATH=python-host /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m pytest python-host/test_frame_worker.py python-host/test_tunnel_relay.py python-host/test_media_stage_boundaries.py -k media_clock -q
```

Exact first-run summary: `14 failed, 9 passed, 50 deselected in 2.78s` (exit 1). Repeated before source edits with stdout/stderr retained in same-directory `task-clock-red.txt`; exact retained summary: `14 failed, 9 passed, 50 deselected in 2.20s` (exit 1).

The 14 failures were assertions on producer behavior/clock initialization, not import or fixture failures:

- recv 20ms/backward jump requested `[4.270000028610229]`, expected `[0.03]`.
- recv 20ms/forward jump requested `[]`, expected `[0.03]`.
- recv 80ms/backward jump requested `[4.210000085830688]`, expected `[]`.
- JPEG 20ms/backward jump requested `[4.3866666952768965]`, expected `[0.14666666666666667]`.
- JPEG 20ms/forward jump requested `[0.001]`, expected `[0.14666666666666667]`.
- JPEG 500ms/backward jump requested `[3.9066666762034097]`, expected `[0.001]`.
- Three JPEG window tests failed: stationary/backward clocks produced no five-second reports, forward clock produced FPS `0.23584905607329437` instead of `0.4`.
- JPEG constructor/start test found baseline `1792208500.0` instead of `100.0`.
- Three CAPTURE/trace tests reported immediately from mixed epoch elapsed instead of respecting monotonic five-second baseline.
- Capture constructor test found baseline `1792208500.0` instead of `100.0`.

The nine pre-fix passing cases include ordinary pacing, over-period cases without rollback, first/resumed output and pacing lifecycle checks.

## GREEN evidence

After source edits, the exact same new-test command exited 0:

```text
.......................                                                  [100%]
23 passed, 50 deselected in 1.46s
```

Required regression suite command (stdout/stderr retained in `task-clock-green.txt`):

```sh
PYTHONPATH=python-host /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m pytest python-host/test_frame_worker.py python-host/test_tunnel_relay.py python-host/test_relay_frame_worker.py python-host/test_rtp_frame_observer.py python-host/test_input_frame_causality.py python-host/test_media_stage_boundaries.py python-host/test_media_suspension.py -q
```

Exact output, exit 0:

```text
........................................................................ [ 69%]
................................                                         [100%]
104 passed in 5.01s
```

`git diff --check` and `git diff --cached --check` both passed. The staged review contained only the four named paths, with 259 insertions and 14 deletions. The production portion is exactly ten one-line substitutions (10 insertions/10 deletions).

## Self-review and limits

- All reads/writes of the changed duration fields match monotonic seconds. Zero sentinels in constructor/resume are preserved. Statistical FPS denominators and summary triggers share the same domain as their baseline.
- JPEG payload timestamp and clock-sync h0/h1 stay epoch-based; Python logging uses its existing clock. RTP PTS, frame capture monotonic_ns, TTL/ACK timing and input causality are unchanged. Existing RTP/causality and no-ACK/expiry tests pass.
- Frame interval, FPS profile, minimum yield, suspension recheck, authority/scope checks and worker lifecycle are unchanged. No new native work, dependency, timer, protocol or network mode.
- No service, tunnel, network, browser, native MSS/Quartz/input, package installation or deploy action occurred. No primary-checkout writes occurred. The pre-existing dirty README, runbook, requirements document, review anchor and node_modules symlink remain outside the commit, untouched by this task.
- This is offline source/test acceptance. Independent review, deployment, running Host verification, real TURN/JPEG observations and long-session acceptance are NOT RUN by this implementer. The fix removes a deterministically reproduced clock defect; it does not prove all historical stalls were caused by it or now resolved.
- This report and raw RED/GREEN outputs are in the requested ignored SDD directory; the controller owns archiving durable final evidence into tracked docs. No report/log was staged in the implementation commit.

The scoped implementation commit is complete. Post-commit index is empty, owned tracked files are clean, and source/index ownership is released to the controller. No further writes are planned during independent review.
