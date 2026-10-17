# Host-clock rollout: separate300s TURN signaling check

2026-10-17,Asia/Shanghai(+08:00). Read-only analysis of FINALIZED /tmp/wrd-public-media-clock-turn-20261017a. The concurrently running JPEG experiment is excluded. No source/index/Git/runtime/service/tunnel/network/browser/probe/native-input action. Only this0600private report is written.

## Result

PASS for this300-second passive TURN continuity window only: elapsed300.1382463569753s,301samples,0missing/late/failed/identity-change observations. Maximum observed no-progress/frame-gap449.998ms. threeHourContinuityMet=false; active control, physical display and visible-effect NOT RUN. This is a new short window after the parent-reported Host-clock rollout, not proof of permanent reliability or causal proof that the clock change fixed prior media failures.

The prior I2 run's93.094s signaling failure (client ping timeout45003ms after last incoming ping) remains historical failure evidence with initiating missing-ping boundary UNKNOWN. The earlier approximately32-minute long-run media gap5149.8ms and intentional SIGINT/INCOMPLETE also remain separate. Neither is erased by this pass.

## Bounded evidence window

Start checkpoint /tmp/wrd-c5-rollout-private-ilovzfv1/media-clock-short-start.json: epochMs1792211711144, local12:35:11.144; prior Host online/0Viewers. Signal inode31830923/offset1757526; connector inode31832550/offset537292; Host inode42866929/offset9968017. At inspection all inodes match and sizes are nondecreasing. Log reads were capped200000bytes after the checkpoints and timestamp-filtered no later than12:40:49.433 (final summary mtime12:40:37.433 plus12s for known disconnect grace). No later JPEG admission/session is used to support these findings. This report analyzes signaling only; it makes no independent claim about which Host binary/source was loaded beyond the parent's rollout context.

## Client stayed connected until intentional cleanup

Client firstDisconnectEvent=null; Socket disconnect,Manager close,Engine close all0; connect/reconnect errors and reconnect attempts0. Final socket and PC are connected, UI connected, auth verified, not superseded. Same buildc30530f331a4def5 throughout, same PC/attempt/generation/lease/path. Final sample: rVFC5552,decoded5618,droppedFrames0,frameAge19.7ms,relay candidates on both sides overUDP,candidate RTT32ms,inputAllowedtrue. This gate state is not evidence of actual business input because this was passive.

Client received11pings and created11pongs. Last observed ping/pong at observer t290287; preclose t311240, an interval20953ms within the client's45000ms deadline. No prior terminal event is recorded. Browser remained visible/online/focused;311scheduler callbacks,max lag25ms,0missed intervals. Coverage is partial until references exist at t2148; bindingChanges3 is initial Socket/Manager/Engine enrollment, with no capacity/schema failure. Final ring overwrote763old entries; counters and sentinel describe the run, not a fictitious complete tail-ring transcript.

The ordered final browser evaluation appends preclose and stops its observer before intentional browser.close. Browser anchor1792211726057 associates preclose with approximately12:40:37.297. Wall association is not a cross-clock one-way latency or exact ordering proof. Python failure fields are null; browser.close returns closed in66ms and manager.stop ok in21ms, with cleanup api-finished-exit-unknown and ownedProcessExitEvidence not-observed. Do not claim complete owned-process exit from API returns alone.

## One server close, expected after sampling

Exactly one offset-following, time-matched WRD_SIGNAL_HEARTBEAT record belongs to this window: wallMs1792212037790/local12:40:37.790,sourceengine,reasontransport-close,currenttrue,prooftrue,duration305131ms. This matches successful sampling followed by intentional browser teardown. Signal records Viewer transport close12:40:37.790 and8s grace12:40:37.802; controller-disconnect cleanup12:40:45.805 follows outside the300s measured window. Client had no firstclose before its preclose/observer stop. No natural signaling failure is demonstrated in this run.

Server pc/pf/pr counts are11/11/11; messages received407,created9,flush batches19. Coverage partial/post-admission,engine=true,flushScanLimited=false,valueInvalid=false,counterClipped=false. Close-captured transport is WebSocket,writabletrue,bufferLength0,readyStateclosed. Last pingCreated/pingInFlush age21897ms; last pongReceived age21091ms, leaving approximately3909ms until the next normal25000ms post-pong ping. A twelfth ping is not overdue at deliberate cleanup.

The32-entry server ring drops only oldest event1 from33total. First retained pf24149 is followed by pr25014; the following10pc/pf pairs have identical floored timestamps and each is followed bypr. Last tripletpc283233,pf283233,pr284039. pc proves creation; pf proves ping inclusion in a flush batch BEFORE transport.send; pr proves a pong reached this Engine. No wire-delivery guarantee, nonce-matched RTT, receiver decode or optical effect is inferred frompf.

Existing Node snapshot at close is statusok,age5746ms,count60,lastlag0ms,maxlag61ms,p95lag2ms,missed0. This is a fresh rolling close-window summary, not all300s of timer scheduling or evidence that every future heartbeat will be timely.

## Connector and conclusion

Connector added0bytes after its start checkpoint at inspection, so no new edge-loss/re-registration/error is recorded in this window. Five existing watcher samples12:36:03,12:37:10,12:38:15,12:39:21,12:40:23 all show origin_ok1/formal_ok1/actionnone. These are discrete HTTP observations and absent connector events, not continuous path/SLA proof. They corroborate but do not replace the measured Viewer session.

This short TURN session shows normal client/server heartbeat lifecycle and normal intentional cleanup after a passing passive media window. It does not test ordinary-user resume/recovery, active input, three-hour continuity or JPEG behavior; it does not resolve the prior missing-ping initiating cause. No timer/protocol/transport/tunnel or auth/recovery change is justified by this signal-only check.
