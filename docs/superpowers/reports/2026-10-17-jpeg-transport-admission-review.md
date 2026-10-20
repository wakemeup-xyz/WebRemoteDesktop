# Task 1 independent spec and quality review

Verdict: **PASS** for the Task 1 source/test package. No actionable P0–P3 correctness or architecture findings were identified. No source change or test rerun is requested.

Reviewed range: `7bc1322..d5ecb23`, with the report-only administrative followup `6de770e` acknowledged. The three production/test files in the working tree match `d5ecb23` (read-only diff returned empty). Reviewed the task brief/report, packaged diff, linked design and plan, prior `/tmp/wrd-jpeg-transport-gate-design-review.md`, surrounding lifecycle and buffer-cap code, relevant active requirements, and installed library source. This is a scoped implementation review, not a new whole-branch historical review anchor.

## Spec compliance

- `python-host/host.py:855–898`: the token freezes current task, generation, copied scope and exact Socket.IO/Engine.IO/queue/writer references. Validation includes current task ownership, enabled/non-suspended/viewer state, existing authority, connected flags and live writer. Missing attributes, broken authority and join errors reject admission. A missing or completed writer rejects even an empty queue.
- `python-host/host.py:1080–1150`: ACK expiry cannot bypass admission. The gate precedes feedback and capture, feedback completion rechecks the original token, ACK waiting always returns to the outer gate, and capture completion/pre-emit checks retain the original token. JPEG emit uses its captured client. Task/client/queue/writer/generation/scope replacement or authority revocation cannot give an old capture a fresh admission token.
- `python-host/host.py:925–1023`: unchanged stop/start serialization and retirement ownership invalidate generation and cancel/await the old producer. Resume and replacement first iterations use the same unconditional gate. Fresh client admission is independent of unfinished accounting in an orphan old queue.
- Timeout/cancellation never drains or modifies shared accounting and never grants fallback admission. No shield or accumulating detached join waiter is introduced. Immediate failures, malformed joins and post-await rejection yield. Feedback is no longer emitted directly by the ACK-timeout branch.
- The existing `RelayOutputBuffer`/processor 16 MiB JPEG cap remains intact. No global queue, writer, shared accounting, reconnect, ACK TTL/window, profile/FPS, resolution, quality or control-identity policy changes appear in the source diff.

## Quality, assumptions and evidence

The helpers remain local to the single producer and reuse existing authority/lifecycle ownership; there is no competing transport state or recovery mechanism. The numeric tuple is small and consistently unpacked; it does not create an actionable maintainability issue in this change.

Read installed `socketio/async_client.py` and `engineio/{base_client,async_client}.py` under `/Users/macstudio1/.homebrew/lib/python3.11/site-packages`. Engine.IO creates an unbounded asyncio.Queue; Socket.IO loops over the encoded envelope/attachment and Engine.IO enqueues each via queue.put. For the current unbounded queue this path has no actual task switch between packets. The reported installed-client synthetic test additionally verifies that assumption without connecting. WebSocket writer accounts after each send; polling accounts after the request returns and before checking response success. Therefore writer/state rechecks are necessary, and the implementation supplies them. The dependency behavior is a compatibility assumption, not a delivery guarantee.

The actual streamer is AST-loaded in `test_relay_transport_admission.py`, rather than reimplemented. Real queues and actual controlled writer tasks cover retained dequeued work, repeated gate deadlines plus ACK expiry, first-frame lifecycle admission, join/feedback/capture identity races, dead writer, orphan queue independence, waiter cancellation/accounting retention and healthy progress with an independent ACK window. Helper tests cover missing/broken transport and yielding. The synthetic installed-client test covers two packet enqueue and absence of scheduler interleaving. Ordinary test fakes expose the necessary transport fields without adding a production bypass.

Read `/tmp/wrd-transport-green2.txt`: **116 passed in 97.57 seconds**, consistent with the implementation report. This reviewer did not rerun tests under the reported memory pressure; no specific unresolved concern justified another run. Initial incomplete RED and helper-absence failures are correctly separated from the reported isolated behavioral RED evidence.

## Documentation and remaining scope

The linked active design accurately describes the accounting invariant and limitations. Existing requirements retain their buffer-cap and ACK-TTL contracts; these are not contradicted. The design still labels implementation pending, and the main requirements do not yet summarize this new gate. Reconcile implementation/deployment status when root completes Task 2 and archives final evidence; this is an integration documentation followup, not a Task 1 source blocker or evidence that deployment occurred.

The proven scope remains: after the first gate accounts for old backlog, at most one JPEG event has unfinished writer accounting on the current shared queue. Queue.join is neither network flush, Signal receipt, Viewer load, visible-input proof, nor an exclusive drain-and-reserve. Previous completed JPEG objects can remain in writer locals. Persistent control traffic can delay JPEG admission; poisoned transport remains fail closed until existing recovery replaces it. No global memory bound or historical-freeze root cause is established.

Deployment, browser/native/network validation and live continuity acceptance: **NOT RUN by this reviewer**. Only this ignored review file was written; no source/index/service/network/browser/native/dependency mutation was performed.
