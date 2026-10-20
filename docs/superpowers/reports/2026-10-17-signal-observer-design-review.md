# I2 信令观察设计复审

当前结论：R1 PASS，可实施；保留原两项阻塞及修订复审。源码与运行尚未通过。

# Signal observer feasibility review

Result: BLOCKED ON TWO NARROW DESIGN CORRECTIONS. The passive observer approach is implementable in the existing two harness files; the changes below resolve concrete budget and finalization gaps without requiring product changes or network activity.

Scope: read-only inspection of `/tmp/wrd-signal-observer-brief.md`, `scripts/passive_session_sampler.js`, and `scripts/passive_session_soak.py` in `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`. No source/index/Git change, tests, browser, network, service, or tunnel operation was performed. JSON size calculations below use compact ASCII JSON, whose character and UTF-8 byte counts are identical. Installed dependencies were not re-inspected because no new API risk was identified beyond the brief's verified semantics.

## Blocking correction 1: specify a field set that fits the 192-byte event cap

Brief anchors: `/tmp/wrd-signal-observer-brief.md:53` and `:55`.

The proposed fields are not collectively compatible with 192 bytes. This representative heartbeat event is 217 bytes even without a reason field:

```json
{"atMs":123456789,"seq":123456789,"event":"heartbeat_packet_received","direction":"received","packetType":"ping","transport":"websocket","objectLabel":"engine-64","isCurrentAtCallback":true,"cleanupPhase":"observing"}
```

Including a reason in the full proposed field set is 244 bytes. Removing only transport still leaves the heartbeat example at 193 bytes. These are realistic bounded numeric widths, not unbounded malicious values. A terminal event with only atMs/seq/event/reason/objectLabel/isCurrentAtCallback/cleanupPhase is 175 bytes at those widths, and 189 bytes using maximum safe-integer atMs and seq.

Required correction: define exact per-event schemas, numeric maxima, optional-field rules, and a concrete compact representation before calling the design implementation-ready. Keep the binding facts and fixed reason; remove redundant fields or shorten explicitly allowlisted event enums/keys. For example, direction can be implied by a fixed received/created event enum, and transport can live in bounded snapshot/binding metadata instead of every heartbeat event. With transport and direction omitted, this heartbeat shape is 170 bytes at the demonstrated numeric widths; it must still be checked at the chosen worst-case numeric bounds. Do not implement the size cap by silently discarding oversized terminal evidence. Overflow must produce a fixed incomplete-coverage status.

128 events of at most 192 bytes require 24,576 bytes plus 129 array punctuation bytes = 24,705 bytes. A 32,768-byte lifecycle file therefore leaves 8,063 bytes for anchors, firstDisconnect, fixed counters, scheduler/browser state, binding/coverage metadata, Python cleanup, object punctuation, and all other envelope fields. This is feasible if these fields have explicit bounds; specify that envelope allocation and final size guard. Use compact serialization for this file. Sixteen 192-byte events require 3,089 bytes as an array, leaving approximately 1 KiB under the stated approximately 4 KiB per-row diagnostic allowance for delta metadata.

Existing implementation anchor: `scripts/passive_session_soak.py:299` reserves only one MAX_ROW_BYTES final file. The narrow implementation must reserve two such bounded files (summary plus lifecycle) before samples, e.g. samples <= MAX_RUN_BYTES - 2 * MAX_ROW_BYTES, rather than accidentally consuming the lifecycle reserve. This follows the brief's existing total-budget requirement and does not change the 64 MiB total cap.

## Blocking correction 2: put final evidence outside the entire Playwright manager lifetime

Source anchors: `scripts/passive_session_soak.py:386` opens samples; `:387` enters async_playwright; `:388` launches before the inner try; `:421` catches only Exception; `:432` closes in the inner finally; `:434` through `:442` construct and write summary only after manager exit succeeds.

Brief anchors: `/tmp/wrd-signal-observer-brief.md:65` and `:69` through `:72` describe export/browser close failures and cancellation, but do not explicitly cover async_playwright entry, launch failure, manager exit failure, or an unbounded manager exit after a timed-out browser.close. Merely adding a helper inside the current inner finally does not satisfy the stated failure-survival/bounded-finalization guarantee. A manager exit error or cancellation can still bypass the existing summary write or replace the original failure; an unbounded manager exit can still hang despite a bounded browser.close.

Required correction: specify an outermost evidence-finalization try/finally that owns output state before Playwright manager entry and remains active through manager exit. Treat manager start/launch/exit errors as fixed local lifecycle statuses, preserve the first failure/cancellation, and give manager teardown an explicit finite bound included in the cleanup bound. This can use explicitly managed Playwright start/stop or an equivalent bounded manager wrapper; it does not require a new dependency. Capture preliminary lifecycle AND a preliminary summary before browser.close. The outer finally should finalize both files even if launch never returns a browser, browser.close fails, or manager exit fails/times out. If final serialization/replacement fails, previously committed preliminary files remain intact.

Cancellation must be recognized separately from Exception on current Python, trigger protected bounded cleanup, and then propagate the original cancellation. Protection must cover manager teardown and file finalization, not just browser.close. A pending cleanup task must not be left running indefinitely after its deadline. Add fake manager entry/exit/launch failures and manager-exit timeout/cancellation cases to the proposed actual-run-path tests. No real browser or runtime operation is needed for those tests.

## Feasible portions and implementation checks

- Pre-Start installation is compatible with the current flow: move sampler installation before `start_via_ui` at `scripts/passive_session_soak.py:400` through `:403`, after Viewer navigation. The sampler resolves WebRTC dynamically at `scripts/passive_session_sampler.js:87`; missing objects can remain unavailable until the existing permitted callbacks find them. Do not add another admission/click/probe. The first engine can still fail before enrollment, so the brief correctly requires explicit coverage limits.
- Existing strict termination at `scripts/passive_session_soak.py:346` through `:348`, identity evaluation at `:236` through `:256`, and the single-use Start sequence at `:188` through `:203` can remain unchanged. An observed later recovery must not reverse the first continuity failure.
- The stated installed engine event interpretation is appropriately conservative: incoming packet ping, queued packetCreate pong, engine ping/pong, and batch flush do not establish heartbeat delivery or RTT. Reading only packet.type and a whitelisted transport name is sufficient. No additional API or instrumentation is needed for this design.
- Own callback registration/detachment and a cap of one currently attached Socket/Manager/engine are implementable. Retain an in-flight enrolled terminal callback even when product listeners have already replaced the reference; preserve the local label and false currentness without promoting it to current authority or an initiating fault.
- The firstDisconnect field must keep its event kind/label/currentness explicit and its cause UNKNOWN when attribution is unsupported. A disconnected state sample with no enrolled event must leave firstDisconnectEvent null. Ring sequence establishes observer callback order only; it does not reconstruct product listener order or server chronology.
- Make the final browser evaluation one ordered operation: record pre-close marker, obtain sanitized snapshot, stop own observation/listeners, return final snapshot. If snapshot-after-stop is called, it must not execute the normal binding path or restart a timer. This resolves the interaction between bind-on-snapshot at brief :43 and snapshot-after-stop at :61. Preserve the last validated delta when evaluation is unavailable.
- The existing sample source starts stats only through `sample()` at `scripts/passive_session_sampler.js:100` through `:102`, with its 800 ms deadline at `:58` through `:59`; the new timer need not touch stats. Existing stop at `:127` through `:129` is a clear extension point for exact own listener/timer cleanup.
- Python must validate new nested diagnostic keys/types/enums/bytes rather than rely on `private_row` at `scripts/passive_session_soak.py:354` through `:361`, which currently copies the returned sample. No arbitrary exception/browser dictionary should be persisted as a fallback. Existing sanitized fixed failure strings remain suitable.

Once the two blocking corrections are written into the brief, this is a narrow, offline-testable harness implementation. It can improve the timing evidence for a future explicitly authorized run; it cannot resolve the historical 173.094-second initiating cause or establish durable production usability by itself.


## R1 scoped recheck — 2026-10-17

Current result: PASS FOR DESIGN FEASIBILITY. Both original blocking corrections are resolved by R1; the earlier BLOCKED result above remains historical. This recheck covers only those corrections and their newly introduced constraints. It does not certify an implementation or a live run.

Blocker 1 resolved. The required compact per-event table at revised brief :53 through :70 replaces the oversized suggested field set with fixed keys/enums, bounded integer widths, explicit required additional fields and no arbitrary optional keys. Independent compact-JSON calculations at t=43320000, n=999999999, label=s64/m64/e64 and c=false produce terminal79, heartbeat71, bind59, visibility54, focus50 and preclose43 bytes, matching R1. Every stated variant is comfortably below192. The :72 envelope allocations sum exactly8063, so ring24705 + envelope8063 =32768; the :74 delta allocation is3089 +1007 =4096. The :104 sample allocation67043328 plus two32768-byte final files equals67108864. Exact serialization/sub-budget validation remains an implementation requirement rather than an assumption that these calculations prove every future field.

Blocker 2 resolved. Revised brief :84 through :98 explicitly places evidence ownership outside manager start/launch/stop, commits both initial files before manager startup and both preliminary files before browser.close, bounds total async cleanup to8s with remaining-budget accounting, preserves the first failure/cancellation, and finalizes both artifacts in the outermost finally. Manager stage failures/timeouts/cancellation are included in the actual-run-path fake tests at :123. Synchronous final serialization/write attempts are explicitly outside exhausted async waits, with honest limits for filesystem failure. The snapshot/stop ordering at :95 also prevents after-stop rebinding.

No new design blocker was found within this narrow scope. The cooperative-cancellation requirement at :90 is an explicit conditional implementation gate, not proof of real Playwright behavior and not an instruction to build a process supervisor. Test doubles can establish harness ownership/order/settlement behavior; they cannot establish actual driver/browser process exit. R1 :100 correctly records ownedProcessExitEvidence=not-observed by default, keeps failed launch/teardown cleanup incomplete/exit unknown where evidence is absent, and avoids requiring new process capabilities merely to preserve useful failure evidence. Do not expand this passive harness task into process-management work to make a stronger claim than the evidence supports.

Unchanged limits remain appropriate: old enrolled terminal events retain c=false without current authority; first cause stays unknown when unsupported; missing events remain missing; queued pong/flush never becomes delivery or RTT evidence; strict continuity and the one-use Start protocol remain binding. No source/Git/runtime operation, implementation test, dependency inspection, browser, network, service or subagent was used for this recheck. Only this mode0600 review file was appended.
