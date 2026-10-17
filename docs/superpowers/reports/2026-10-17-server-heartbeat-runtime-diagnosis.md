# Server heartbeat observer: finalized300-second runtime diagnosis

2026-10-17, Asia/Shanghai(+08:00). Private read-only analysis of /tmp/wrd-public-server-heartbeat-turn-20261017a after parent notification of completion. No source/index/Git/runtime/browser/network/input/native/service/tunnel changes, extra probe, test server, subagent or polling loop. This report alone is written0600.

## Result and decision boundary

PASS for this300-second passive TURN continuity run only. Artifact summary elapsed is300.2120814549271s,301samples,0missing/late/failed/identity-change observations. Parent runner-reported300.212893s differs by under1ms; the artifact value is used here. Every sample has inputAllowed=true, but no active input was performed, so that is gate state rather than usable-input acceptance. Three-hour continuity is false; ordinary-user recovery, active control, physical display and visible-effect remain NOT RUN.

No evidence in this window blocks proceeding to a separately authorized longer passive run. It does not establish that the prior missing-heartbeat cause was repaired: S1 adds observability, and this window did not reproduce the failure. No recovery path was exercised. Do not describe the earlier93s client ping timeout as fixed on the strength of this pass.

## Runtime and evidence coverage

Parent-supplied implementation d1166ab, primary synced58ad766, local restart14.906s; expected Signal15135/Host15287 and unchanged connector84671/watch897. All301samples actually show buildc30530f331a4def5. This diagnosis makes no independent binary provenance claim beyond those observations.

Start checkpoint /tmp/wrd-c5-rollout-private-ilovzfv1/heartbeat-run-start.json has epochMs1792208067147, approximately11:34:27.147. All three current log inodes match and sizes exceed recorded offsets, so no rotation/truncation gap is observed. New bytes at analysis: Signal4104; connector0; Host258909 including post-cleanup telemetry. Correlation uses only offset-following Signal/Host records and same-window watcher entries; it does not combine earlier-runtime close events.

Client lifecycle coverage is partial at startup because socket/Manager/engine references did not exist until observer t1814. There is no schema failure, capacity marker or binding replacement; three bindings are initial enrollment. Existing periodic sampling/drains and final first-terminal sentinel are consistent with no close during the measured run. Final ring overwrote763 older event entries; counters and sample deltas retain the run evidence. Do not call the tail ring alone a complete event transcript.

## Client continuity and intentional cleanup

Last observed sample tick300 at elapsed300.000368s: socketConnected=true, PC connected, stable generation1/leaseEpoch1/attempt and relay path, input gate true, rVFC5377, framesDecoded5466,0droppedFrames, fresh-frame age13.1ms, relay candidates at both ends overUDP, latest candidate RTT28ms. Render callbacks advanced5374 after baseline. Run-wide max gap1000ms, below5000ms threshold; it is not an end-to-end visible-effect or input latency measurement.

Final observer firstDisconnectEvent=null; Socket disconnect/Engine close/Manager close counters all0; connect/reconnect errors and reconnect attempts0. Browser stays visible/online/focused, scheduler max lag10ms across309one-second callbacks,0missed intervals. Browser received11pings, created11pongs, with last ping/pong at observer t289287.

The preclose marker is t309918. This was recorded after successful sampling while the socket still read connected; the ordered final browser evaluation then stopped observer listeners before intentional browser.close. Its anchor1792208084787 associates preclose with approximately11:39:54.705. This is wall-time association only, not cross-clock latency. Python browser.close API returned closed in126ms; manager.stop returned ok in27ms. Cleanup status is api-finished-exit-unknown and ownedProcessExitEvidence=not-observed. Parent reports external runner session exited0, but API completion/runner exit alone is not adopted as ownership-linked proof of every browser child process exiting.

## The one new server close record

The offset-following Signal log contains exactly ONE WRD_SIGNAL_HEARTBEAT record, wallMs1792208395120 (11:39:55.120), source engine, reason transport-close, current=true, proof=true, observed duration305116ms. It is consistent with intentional browser teardown after the measured run, not an earlier heartbeat failure: the client observed no terminal event before its own preclose/stop and all final samples were connected. Server/client wall association differs by roughly415ms at this boundary; that number is not asserted as network latency or precise cross-clock ordering.

Server coverage: state partial (post-admission), engine=true, flushScanLimited=false, valueInvalid=false, counterClipped=false. Counts pingCreated11, pingInFlush11, pongReceived11, incoming messages408, created messages9, flush batches19. At terminal capture: WebSocket writable=true, writeBuffer length0, Engine readyState closed. The buffer was captured at terminal observation, not reconstructed from later cleanup.

At close, last pingCreated age21493ms, pingInFlush age21493ms, last received pong age20593ms. Under the unchanged25000ms post-pong interval, approximately4407ms remained before the next scheduled ping; absence of a twelfth ping at intentional close is expected and is not a missing-ping failure.

Server ring contains32of33heartbeat events (one oldest pc overwritten). Its first retained event is pf at t24177 followed by pr25055. The next TEN retained pc/pf pairs have equal floored millisecond times, and each is followed by a pr. Following received-pong-to-next-created-ping gaps are24999..25006ms across10intervals, consistent with the configured25000ms timer and timestamp flooring. Counts retain the eleventh initial pc even though its ring entry was overwritten. The last retained triplet is pc283622,pf283622,pr284522, all in this server observer's own monotonic domain.

Meaning is deliberately bounded: pc proves ping creation, pf proves inclusion in a flush batch BEFORE transport.send, and pr proves a pong reached this Engine callback. pf is handoff intent, not wire delivery; no cross-clock or nonce-matched RTT is claimed. Aggregate equal counts and observed ordering show the normal heartbeat boundary operating in this run, not elimination of intermittent path failures.

The same close record reused the existing Node observer: status ok, snapshot age3862ms,60samples, last lag1ms, maximum84ms, p95lag53ms, missed0. This is a fresh rolling Node scheduling window near close, not a full300-second trace and not proof that every heartbeat timer was perfectly punctual. It supplies no evidence of multi-second Node starvation at cleanup.

Signal records matching Viewer transport-close at11:39:55.120; grace8000ms begins11:39:55.121. Controller-disconnect cleanup at11:40:03.125 and reset retry11:40:04.126 follow the deliberate client departure. Host closes peer11:40:03.139, reports0Viewers11:40:03.143 and closes both input channels11:40:03.171. These later events are expected session cleanup, not acceptance failures inside the300s sample window. Host had301Viewer-stat reports from11:34:54.510 through11:39:54.370.

## Formal connector correlation and limits

Connector log inode is unchanged and has ZERO new bytes after the start offset: no new connector edge loss/re-registration/error event is recorded for this run. This is absence of logged events, not a continuously measured transport guarantee. Existing formal watcher samples at11:34:22,11:35:27,11:36:31,11:37:36,11:38:41 and11:39:47 all show origin_ok1/formal_ok1/actionnone;11:40:53 remains healthy after cleanup. Discrete HTTP health is additional context and does not substitute for the real observed Viewer continuity.

Previous I2's93.094s client ping timeout,45.003s missing inbound ping and coincident connector edge losses remain a different build/runtime/window. There was no S1 server heartbeat record for that failure. Today's normal pc/pf/pr sequence cannot retroactively decide whether its next ping was ungenerated, unflushed or lost downstream. The exact historical missing-ping origin/delivery boundary is still UNKNOWN.

For a longer authorized run, retain this same strict first-discontinuity rule, proof fencing and observer fields. A future failure now has server pc/pf/pr/coverage/transport/Node evidence available for boundary comparison. This pass justifies continuing evidence collection; it does not justify timer, transport, IP-family, tunnel, recovery or authority changes.


# Separate long-run diagnosis: approximately32minutes, incomplete

Appended2026-10-17 after the parent intentionally stopped the owned test. This section concerns /tmp/wrd-public-server-heartbeat-turn-long-20261017a and does not change the preceding300-second result. Requested10800s; observed1922.4988947431557s,1922samples,0missing,0late,0identity changes. Final status INCOMPLETE, failure sampling/runtime/cancelled. threeHourContinuityMet=false. No three-hour PASS, ordinary recovery, active input or visible-effect acceptance is claimed.

## Media threshold failure and intentional stop

The long-run checkpoint is /tmp/wrd-c5-rollout-private-ilovzfv1/heartbeat-longrun-start.json, epochMs1792208510315. It records Host online and0Viewers before the run. All1922samples show signaling connected and PC connected; generation, lease epoch3, attempt and selected relay path stay unchanged. All samples use buildc30530f331a4def5.

First sampled media freshness threshold violation is tick1825, elapsed1825.002375s: frameAge5132.1ms, while the already completed maximum inter-frame gap was still4033.276ms. After a later callback resumed, completed maxFrameGap becomes5149.8ms and remains above the5000ms criterion. The97failedObservations run from tick1825 through1921; they are repeated bad freshness/cumulative maximum-gap observations, NOT97natural signaling disconnects or necessarily97independent media stalls. Approximately96s of further samples follow the first detected threshold violation before the final sample. The parent stopped because uninterrupted continuity was already violated; its separate agent is diagnosing Host/media causality.

Owned-stop record /tmp/wrd-c5-rollout-private-ilovzfv1/longrun-owned-stop.json records a narrowly matched passive runner and SIGINT at epochMs1792210453780 (12:14:13.780), with the explicit gap-threshold reason. Python failure wall time is1792210453781, consistent with that interruption. The final cancellation reason is therefore intentional test termination, not evidence of a naturally disconnected Signal socket.

Last sample tick1921: socket/PC connected, rVFC34234, decoded34645,0droppedFrames, fresh-frame age10.4ms, latest candidate RTT47ms, relay on both ends overUDP, lease epoch3 and inputAllowed=true. Media had resumed by the end, but recovery cannot erase the earlier continuity failure. Gate state and fresh media still do not substitute for actual input/visible-effect acceptance.

## No observed client signaling close before cleanup

Client firstDisconnectEvent=null; Socket disconnect, Manager close, Engine close counters all0; connect/reconnect errors and reconnect attempts all0. Incoming engine ping74 and queued pong74; current socket remains connected at final capture. No binding replacement, schema-capacity or invalid-coverage failure is reported. Browser remains visible/online/focused; scheduler count1932,max lag88ms,0missed intervals. This is evidence against a prolonged browser timer suspension, but does not explain the media pipeline failure.

Observer last ping and queued pong are t1919361; preclose is t1932902. The same-browser monotonic interval13541ms is well below its45000ms heartbeat deadline. Its initial reference-availability coverage is partial untilt1952, and its final128-event ring overwrote5432older entries; use counters/first-terminal sentinel and sampled deltas rather than pretending this tail is the full32-minute transcript.

Browser wall anchor1792208525121 plus preclose would associate it with12:14:18.023, whereas the owned SIGINT/Python wall record is12:14:13.780. This multi-second difference is a direct reminder that fixed browser wall anchors plus long-running performance intervals must not be treated as exact cross-clock ordering or network delay. Cleanup attribution uses the within-browser no-close/preclose sequence plus the explicit owned-stop/Python cancellation chain, not subtraction of those unlike clocks.

Browser.close API returns closed in531ms; manager.stop reports ok in53ms. Final cleanup is api-finished-exit-unknown with ownedProcessExitEvidence not-observed; no claim about every owned child process exiting follows from API status alone.

## Server heartbeat boundary stayed live in this run

After the long-run Signal offset there is exactly ONE new WRD_SIGNAL_HEARTBEAT record: server wallMs1792210454777, local12:14:14.777, source engine, reason transport-close, current=true, proof=true, observed duration1927395ms. Signal disconnect log follows12:14:14.806, grace8000ms starts12:14:14.834, controller-disconnect cleanup12:14:22.835. This close is consistent with the documented owned SIGINT/intentional browser teardown. There is no client or server evidence of a preceding natural signaling disconnect during the media violation.

Server counts pc74/pf74/pr74, incoming ordinary messages2584, created messages9, flush batches82. Coverage state partial/post-admission, engine=true, flushScanLimited=false, valueInvalid=false, counterClipped=false. Close-captured WebSocket writable=true, bufferLength0, readyState closed. Last pingCreated/pingInFlush ages15122ms; last server pongReceived age14027ms. The next ping would normally be due approximately10973ms later under the unchanged25000ms post-pong interval, so a75th ping is not overdue at cleanup.

Server ring retains32of222heartbeat events, with190old entries overwritten. The retained tail spans t1653311..1913368, about260s and therefore includes the late-run period around the media threshold violation by log-window association. It has10retained pc/pf pairs: nine have0ms floored difference and one has10ms, with following pong receipt for each. Ten retained pong-to-next-ping gaps range25000..25053ms. No45-second missing-heartbeat interval appears in that retained tail, and the client's uninterrupted connected state/counters give no earlier natural close evidence. Aggregate equal pc/pf/pr totals do not provide a retained per-event transcript for all32minutes; no unavailable earlier ordering is invented.

pc is creation, pf is inclusion in flush BEFORE transport.send, pr is server pong observation. These records do not prove optical presentation or exactly attribute the media gap, and a pf remains handoff intent rather than delivery. This long-run failure does not reproduce the prior I2 missing-heartbeat mechanism.

The close record's existing Node snapshot is statusok, age4797ms,count60,last lag0ms,max40ms,p95lag8ms,missed0. That is the rolling window near intentional stop; the first media threshold violation was approximately97s earlier and is outside this final60s Node window. Do NOT use these final metrics to declare the Node event loop healthy at media-gap onset or to exclude transient earlier scheduling. Host/media causality remains outside this signal-only diagnosis.

## Connector and scoped conclusion

All Signal/Host/connector inodes still match the long-run start checkpoint and sizes are nondecreasing. New Signal bytes4186 at inspection; connector adds0bytes after its recorded offset. No new connector edge-loss/re-registration/error is logged. Existing watcher has31samples from11:41:57 through12:14:15, ALL origin_ok1/formal_ok1/actionnone. These are discrete health observations and absence of connector logs, not continuous delivery guarantees.

No signaling-source fault is demonstrated for this32-minute media continuity failure. Signal heartbeat generation, flush inclusion and pong receipt continue; the only close corresponds to intentional cleanup. A recovered final frame does not make uninterrupted media pass, and working heartbeat does not prove the capture/encode/RTP/decode/presentation path. Preserve UNKNOWN for the media root cause until the separate Host/media evidence resolves it. Also preserve the historical I2 missing-ping origin/delivery boundary as UNKNOWN; this nonreproducing long-run segment cannot retroactively repair or explain it.

This append performed no source/index/Git/runtime/browser/network/native-input/service/tunnel action. It only analyzed finalized local artifacts/log offsets and appended this private0600report.
