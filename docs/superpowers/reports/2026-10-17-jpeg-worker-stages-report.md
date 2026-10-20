# Task 1 implementation report

Result: DONE. Commit `00d1a819ecb316422ad39202e04108d0e5701daf` (`feat(diagnostics): distinguish JPEG processing and loop delivery`). Assigned four source/test paths only; Git index released to root. Other dirty documentation and pre-existing node_modules link were preserved.

## Contract and implementation

RelayFrameWorker accepts keyword `now_ns=time.monotonic_ns`. Pending tuple retains request/bytes/future as its first three entries and appends submission time. Under the existing Condition, dequeue records queue wait/start; processor exit (including error) records duration and delivery start; loop `_complete` records delivery wait and clears delivery state. Snapshot computes current ages from one clock sample and exports only fixed scalars. Zero timestamps are explicitly retained; no stage is cleared by invalidate or stop before its real completion. last* values persist as lifecycle observations.

Runtime adds eight fields only for relayFrames, strictly validates both new bool fields and finite nonnegative duration numbers, preserves zero, strips canaries. Input queue schema is unchanged. `snapshot_relay_queue` implementation is unchanged; its blocking=False behavior and real lock contention remain tested. No Host changes, service/network/browser/native/dependency actions, npm pretest/test, or reviewer dispatch occurred. No native Host imports occurred; existing AST-only Host context test still executes.

## RED

Command: `cd python-host && python3 -m unittest test_relay_frame_worker test_runtime_observability`.
The initial tests used the existing constructor plus a test clock assignment, so RED was actual missing output fields, not constructor/import failure. Once injection existed the fixture switched to the public now_ns constructor.

```text
....EE....E..........
======================================================================
ERROR: test_processor_and_loop_delivery_are_distinct (test_relay_frame_worker.StageTests.test_processor_and_loop_delivery_are_distinct)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/unittest/async_case.py", line 90, in _callTestMethod
    if self._callMaybeAsync(method) is not None:
       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/unittest/async_case.py", line 112, in _callMaybeAsync
    return self._asyncioRunner.run(
           ^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/asyncio/runners.py", line 118, in run
    return self._loop.run_until_complete(task)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/asyncio/base_events.py", line 654, in run_until_complete
    return future.result()
           ^^^^^^^^^^^^^^^
  File "/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop/python-host/test_relay_frame_worker.py", line 184, in test_processor_and_loop_delivery_are_distinct
    await self.exercise_stages()
  File "/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop/python-host/test_relay_frame_worker.py", line 144, in exercise_stages
    self.assertTrue(snapshot['processorActive'])
                    ~~~~~~~~^^^^^^^^^^^^^^^^^^^
KeyError: 'processorActive'

======================================================================
ERROR: test_processor_error_still_enters_delivery (test_relay_frame_worker.StageTests.test_processor_error_still_enters_delivery)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/unittest/async_case.py", line 90, in _callTestMethod
    if self._callMaybeAsync(method) is not None:
       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/unittest/async_case.py", line 112, in _callMaybeAsync
    return self._asyncioRunner.run(
           ^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/asyncio/runners.py", line 118, in run
    return self._loop.run_until_complete(task)
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  File "/Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/asyncio/base_events.py", line 654, in run_until_complete
    return future.result()
           ^^^^^^^^^^^^^^^
  File "/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop/python-host/test_relay_frame_worker.py", line 187, in test_processor_error_still_enters_delivery
    await self.exercise_stages(fail=True)
  File "/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop/python-host/test_relay_frame_worker.py", line 144, in exercise_stages
    self.assertTrue(snapshot['processorActive'])
                    ~~~~~~~~^^^^^^^^^^^^^^^^^^^
KeyError: 'processorActive'

======================================================================
ERROR: test_stage_types_zero_and_input_schema (test_runtime_observability.RelayStageWhitelistTest.test_stage_types_zero_and_input_schema)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop/python-host/test_runtime_observability.py", line 292, in test_stage_types_zero_and_input_schema
    self.assertEqual(relay[field], value if type(value) in (int, float) and value >= 0 else None)
                     ~~~~~^^^^^^^
KeyError: 'pendingAgeMs'

----------------------------------------------------------------------
Ran 21 tests in 3.360s

FAILED (errors=3)
```

## GREEN and adjacent tests

Command: `cd python-host && python3 -m unittest test_relay_frame_worker test_runtime_observability`.
Initial implementation: 21 tests OK (2.551s). Added queue wait/valid error delivery and real lock contention checks during self-review; final output:

```text
................Executing <Task cancelling name='Task-59' coro=<run_command() running at /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop/python-host/runtime_observability.py:178> wait_for=<Future pending cb=[shield.<locals>._outer_done_callback() at /Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/asyncio/tasks.py:908, Task.task_wakeup()] created at /Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/asyncio/base_events.py:428> cb=[_release_waiter(<Future pendi...events.py:428>)() at /Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/asyncio/tasks.py:431] created at /Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/asyncio/tasks.py:680> took 0.177 seconds
.Executing <Task pending name='Task-66' coro=<ResourceSamplerTest.test_cached_sample_age_expiry_timeout_and_explicit_pid() running at /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop/python-host/test_runtime_observability.py:97> wait_for=<Future pending cb=[Task.task_wakeup()] created at /Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/asyncio/base_events.py:428> cb=[_run_until_complete_cb() at /Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/asyncio/base_events.py:181] created at /Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/lib/python3.11/asyncio/runners.py:100> took 0.120 seconds
......
----------------------------------------------------------------------
Ran 23 tests in 3.645s

OK
```

Command: `cd python-host && python3 -m unittest test_input_admission_queue`.

```text
......
----------------------------------------------------------------------
Ran 6 tests in 2.131s

OK
```

`git diff --check`: exit 0, no output. Reviewed full assigned-path diff; no changes to admission, generation, stopping, future validity, encoded-size budget, thread ownership or output retention. Staged explicit four paths; staged stat confirmed four files, 184 insertions(+), 5 deletions(-). Commit succeeded with no hooks skipped.

## Coverage and limits

Offline real dedicated worker blocked by threading.Event, fake monotonic clock starting at zero, worker-specific loop completion adapter holds one callback and runs it manually. Tests cover processor versus delivery, pending age replacement, invalidate preserving resource stages, error through held delivery and valid future error propagation, stop retirement with held completion, existing two-second stop timeout, whitelist sanitation, and nonblocking contention.

Two asyncio slow-task debug messages appeared in existing resource sampler/command tests in the final run; all tests passed. No functional concerns identified. Runtime loading and live continuity acceptance remain NOT RUN; this change supplies observations and does not identify the past stall's unique cause or measure transport/input-to-visible latency.
