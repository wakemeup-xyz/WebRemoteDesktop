# Task 1 — JPEG transport admission implementation

Base package: 7bc1322; worker-stage implementation already present at 00d1a81 and untouched. Binding inputs: task-1-brief.md and docs/superpowers/specs/2026-10-17-jpeg-transport-admission-design.md. No network, browser, native capture, service, tunnel, config or dependency operations performed.

## Implementation

TunnelRelayStreamer freezes task, production generation, value-copied relay scope and exact sio/eio/queue/writer references. The checker fails closed on missing/broken state, disconnected transport, dead writer, replaced identities, suspended/disabled producer, or revoked authority. The gate awaits real Queue.join with a 0.25-second deadline; cancellation propagates and neither timeout nor cancellation changes queue accounting. Invalid immediate and post-await states yield. Capture and feedback require successful admission. Feedback, capture return and metadata/whole-frame emit boundaries revalidate the original token; the binary event uses token sio. ACK expiry/window/profile logic remains independent, and ACK timeout no longer directly emits feedback into a blocked queue. Existing cleanup, worker ownership and retirement remain intact.

FakeSio now supplies connected/state/real asyncio.Queue/a stable live-writer stub. Existing no-ACK fake-clock tests now allow the empty real Queue.join to complete and only synthesize ACK timeouts; this is a test adapter correction, not a production bypass.

## Commands and observed results

Working directory for commands below: /Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop.

1. `cd python-host && python3 -m pytest -q test_relay_transport_admission.py` (before implementation, output /tmp/wrd-transport-red.txt). Initial run reached 34 behavioral failures and 3 passes, then was interrupted at 129.33 seconds while investigating cleanup. Failures include actual capture/feedback despite writer-owned unfinished queue work, stale-client/capture frames emitted, dead writer admitted and missing join waiter. No import failure is used as evidence. Fixed the AST loader to supply real input_timing.relay_ack_duration_ms and made harness cleanup disable production before cancelling tasks. A repeat overlapped the host.py edit and is discarded as clean RED evidence.
2. Isolated RED snapshot: `mkdir -p /tmp/wrd-transport-red-snapshot`; `cp python-host/test_relay_transport_admission.py /tmp/wrd-transport-red-snapshot/`; `git show 00d1a81:python-host/host.py > /tmp/wrd-transport-red-snapshot/host.py`; `PYTHONPATH="$PWD/python-host" python3 -m pytest -q /tmp/wrd-transport-red-snapshot/test_relay_transport_admission.py` (output /tmp/wrd-transport-red-clean.txt). Result: 49 failed, 5 passed in 98.43 seconds. Of these, 34 are behavioral failures in the actual pre-change loop; 15 helper-specific tests fail because the helpers do not yet exist and are explicitly excluded as RED behavioral evidence. The worktree source was never swapped.
3. `cd python-host && python3 -m pytest -q test_relay_transport_admission.py test_tunnel_relay.py test_relay_frame_worker.py test_runtime_observability.py` (output /tmp/wrd-transport-green.txt). First GREEN attempt: 2 failed, 99 passed in 67.50 seconds. Both failures are the existing fake-clock wait_for wrapper treating Queue.join as an ACK timeout. Corrected that test wrapper as described above.
4. Same exact targeted suite after that correction and 15 added helper/race cases (output /tmp/wrd-transport-green2.txt): **116 passed in 97.57 seconds**. No failures, skips, or test deadline changes.
5. `python3` with importlib.metadata.version: python-socketio 5.16.1, python-engineio 4.13.1. The suite's installed AsyncClient synthetic test instantiates but never connects; it sets a synthetic namespace/EIO state, awaits a single bytes-bearing emit, verifies exactly two queued packets (envelope and attachment) and that a scheduled sibling has not run, then cleans only the sibling/test queue. No reader, writer, socket or native capture is started.
6. `git diff --check`: PASS before final review.

## Coverage and limitations

Actual streamer methods are AST-loaded from production source, with actual constants/validation and real input_timing helper. Real asyncio.Queue and actual controlled writer tasks are used in specialized tests. Coverage includes qsize=0 writer-owned work across multiple deadlines and metadata TTL expiry; feedback suppression; pause/resume, restart/replacement; original-token revalidation after join, feedback and capture with client/eio/queue/writer/task/generation/scope/authority changes; dead writer with empty queue; orphan queue independence; cancellation waiter removal/accounting retention; healthy drain plus independent ACK window; malformed transport and yielding.

Queue.join establishes writer accounting completion only, not network flush, delivery, paint or visible-input causality. Persistent control traffic can conservatively delay JPEG admission. Dead/poisoned queues fail closed until existing connection recovery replaces transport. No claim of a total memory bound across library/network copies, nor of fixing the historical 5.2-second freeze. Live acceptance and deployment are NOT RUN by this implementer. Root reported extreme shared-machine pressure during this run; test deadlines/assertions were not weakened.

## Self-review and commit scope

Reviewed `git diff -- python-host/host.py python-host/test_tunnel_relay.py` and the new test file. All three helpers are private to TunnelRelayStreamer. There is no queue mutation, qsize admission, shield, timeout bypass, reconnect, native capture call or library monkeypatch in production. The gate does not mutate application state. ACK timeout and transport timeout remain separate. Token identity is held through every await boundary until the whole frame emit, and the old JPEG references still clear in finally. Scope snapshots are value copies.

Final `git diff --check` passed. Staging is limited to host.py, test_tunnel_relay.py, test_relay_transport_admission.py and this report (force-added only because the requested .superpowers report directory is ignored). Root-owned dirty files and worker-stage files are excluded. Commit message: `fix(relay): gate JPEG capture on transport accounting`.
