# Media Monotonic Clock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Remove wall-clock jumps from both media pacing paths and their duration statistics.

**Architecture:** Preserve existing media lifecycle and FPS policy. Replace only duration-clock reads and matching initializations with monotonic seconds; exercise the actual producer methods with fake clocks and workers.

**Tech Stack:** Python asyncio, pytest, existing aiortc and fake capture fixtures.

**Spec:** `docs/superpowers/specs/2026-10-17-media-monotonic-clock-design.md`

## Global Constraints

- No new dependency, protocol, timer, media policy, network mode or quality change.
- Preserve epoch-based JPEG timestamp, logger dates and clock-sync protocol.
- No native MSS/Quartz, browser, network, service or tunnel actions in implementation/tests.
- Preserve the primary checkout and all pre-existing dirty files; stage only task-owned paths.
- Controller alone performs reviewed deployment and guarded public acceptance; no tunnel operation.

### Task 1: Monotonic media pacing and five-second windows

**Files:** Modify `python-host/host.py`, `python-host/test_frame_worker.py`, `python-host/test_tunnel_relay.py`, `python-host/test_media_stage_boundaries.py`; adjust another existing fake fixture only if it sets one of the changed private duration fields, documenting the need. No other production file.

**Interfaces:** Existing `ScreenCaptureTrack.recv`, `set_suspended`, `TunnelRelayStreamer._run` and reset/stat initializations remain unchanged externally. Tests supply distinct fake wall/monotonic clocks, fake sleeps and fake worker output, while retaining the actual producer method.

- [x] Add regressions on actual `recv`: normal and ±4.24s wall jumps with mono advancing 20ms must request 30ms at 20fps. Add elapsed-over-period no pacing sleep, first/resumed frame, suspension during pacing and shutdown regression using existing fixtures. Record old failures before source edits.

```python
# Concrete clock case for actual-method fixture; clocks must stay independent.
prior_mono, now_mono = 100.0, 100.020
prior_wall = 1_792_208_500.0
now_wall = prior_wall + 0.020 - 4.240
expected_sleep = 0.030
# fake sleep records delay without waiting or modifying the system clock.
# Assert the real recv's requested pacing delay approximately equals expected_sleep.
```

- [x] Add actual `_run` iteration tests with fake JPEG worker/emit: 20ms monotonic work with a wall-clock jump uses the unchanged frame interval minus 20ms, not seconds of extra sleep; >period retains the 1ms yield. Stop the fake loop deterministically, preserve source/ACK scope and no native capture. Add five-second monotonic window tests for both paths, with wall time stationary/jumping; ensure JPEG emitted timestamp remains epoch-based.
- [x] Run the new named tests with the existing Python environment and retain RED output. A failed fixture/import is not RED evidence.
- [x] Implement the substitutions consistently:

```python
# Duration reads and matching initialization/reset, never protocol timestamps:
self.last_time = time.monotonic()
now = time.monotonic()
elapsed = now - self._last_frame_time
self._last_frame_time = time.monotonic()
started = time.monotonic()
elapsed = time.monotonic() - started
# stats_started_at, current_time and trace summary trigger use the same clock.
```

- [x] Run `test_frame_worker.py`, `test_tunnel_relay.py`, `test_relay_frame_worker.py`, `test_rtp_frame_observer.py`, `test_input_frame_causality.py`, `test_media_stage_boundaries.py`, `test_media_suspension.py` using the existing interpreter. Review changed private-field fixtures; do not broaden into native/environment tests.
- [x] Self-review diff for mixed clocks, unchanged PTS/TTL/epoch contract, thread/lifecycle behavior and fixture cleanup. Commit only owned changes with `fix(media): use monotonic clocks for pacing and stats`; write report containing commit, exact RED/GREEN commands/results and limitations.

### Task 2: Review, Host-only rollout and real continuity

- [x] Controller packages Task 1 diff and dispatches independent spec/quality review. Resolve findings before deployment.
- [ ] Freeze reviewed candidate against primary synced baseline `536baee684f84fa0868d64bcae4491540993b1b7`; preserve four deferred WATCH files, HEAD/index, dirty docs, URL and tunnel/watcher identities; verify fresh `viewerCount=0` and Host online before apply/restart.
- [ ] Use `python3 skills/webremote-service/scripts/wrd_service.py restart-host`; verify health, Host, production hashes, unchanged Signal/build/tunnel and report current local-config Viewer/Terminal credentials only in conversation.
- [ ] Run existing guarded real UI short acceptance for TURN and JPEG, then strict long continuity with fresh one-use proof per new run. Never remint a consumed proof to hide a failed run. Do not adjust system time on production.
- [ ] Update diagnosis and live acceptance with actual measurements and failures; compare throughput, fresh/cached frames, stage timing availability and signal heartbeat. Native input/visible-effect remains unverified until independently safe evidence exists.
