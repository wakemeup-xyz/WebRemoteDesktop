# TURN continuity failure review

```json
{
  "summary": {
    "status": "INCOMPLETE",
    "requestedSeconds": 300,
    "elapsedSeconds": 31.002395677845925,
    "samples": 29,
    "failedObservations": 18,
    "identityChangeObservations": 1,
    "maxObservedNoProgressMs": 13849.43,
    "failure": {
      "stage": "sampling",
      "category": "runtime",
      "reason": "session-changed-or-disconnected"
    },
    "lifecycle": {
      "file": "lifecycle.json",
      "captureStatus": "ok",
      "cleanupStatus": "incomplete",
      "writeStatus": "ok",
      "ownedProcessExitEvidence": "not-observed"
    }
  },
  "timeline": [
    {
      "tick": 13,
      "elapsedSeconds": 13.02854734682478,
      "wallUtc": "2026-10-17T06:07:49.190000+00:00",
      "socketConnected": true,
      "pcIdentity": 1,
      "pcState": "connected",
      "generation": 1,
      "inputAllowed": true,
      "callbacks": 192,
      "frameAgeMs": 75.5,
      "maxFrameGapMs": 683.2999999999993,
      "attemptChanged": false
    },
    {
      "tick": 14,
      "elapsedSeconds": 14.004369966918603,
      "wallUtc": "2026-10-17T06:07:50.158100+00:00",
      "socketConnected": true,
      "pcIdentity": 1,
      "pcState": "connected",
      "generation": 1,
      "inputAllowed": true,
      "callbacks": 200,
      "frameAgeMs": 226.99999990463402,
      "maxFrameGapMs": 683.2999999999993,
      "attemptChanged": false
    },
    {
      "tick": 15,
      "elapsedSeconds": 15.000329920789227,
      "wallUtc": "2026-10-17T06:07:51.146700+00:00",
      "socketConnected": true,
      "pcIdentity": 1,
      "pcState": "connected",
      "generation": 1,
      "inputAllowed": true,
      "callbacks": 200,
      "frameAgeMs": 1215.6000000476852,
      "maxFrameGapMs": 683.2999999999993,
      "attemptChanged": false
    },
    {
      "tick": 19,
      "elapsedSeconds": 19.000228959834203,
      "wallUtc": "2026-10-17T06:07:55.146300+00:00",
      "socketConnected": true,
      "pcIdentity": 1,
      "pcState": "connected",
      "generation": 1,
      "inputAllowed": true,
      "callbacks": 200,
      "frameAgeMs": 5215.199999952318,
      "maxFrameGapMs": 683.2999999999993,
      "attemptChanged": false
    },
    {
      "tick": 22,
      "elapsedSeconds": 22.000294331926852,
      "wallUtc": "2026-10-17T06:07:58.146800+00:00",
      "socketConnected": true,
      "pcIdentity": 1,
      "pcState": "disconnected",
      "generation": 1,
      "inputAllowed": false,
      "callbacks": 200,
      "frameAgeMs": 8215.699999952318,
      "maxFrameGapMs": 683.2999999999993,
      "attemptChanged": false
    },
    {
      "tick": 27,
      "elapsedSeconds": 27.000268979929388,
      "wallUtc": "2026-10-17T06:08:03.146400+00:00",
      "socketConnected": true,
      "pcIdentity": 1,
      "pcState": "disconnected",
      "generation": 1,
      "inputAllowed": false,
      "callbacks": 200,
      "frameAgeMs": 13215.300000095369,
      "maxFrameGapMs": 683.2999999999993,
      "attemptChanged": false
    },
    {
      "tick": 28,
      "elapsedSeconds": 28.00216070888564,
      "wallUtc": "2026-10-17T06:08:04.148100+00:00",
      "socketConnected": true,
      "pcIdentity": 2,
      "pcState": "new",
      "generation": 2,
      "inputAllowed": false,
      "callbacks": 202,
      "frameAgeMs": 117.59999990463257,
      "maxFrameGapMs": 13849.43,
      "attemptChanged": true
    }
  ],
  "socketAttribution": {
    "firstDisconnectEvent": null,
    "socketStateAtPreclose": "connected",
    "browserLag": {
      "lastMs": 2,
      "maxMs": 10,
      "count": 36,
      "missedIntervals": 0,
      "buckets": [
        36,
        0,
        0,
        0
      ]
    },
    "coverage": "partial"
  },
  "cleanup": {
    "failureDetectedMs": 1369742521,
    "failureWallEpochMs": 1792217284161,
    "managerStart": {
      "startedMs": 1369697156,
      "finishedMs": 1369698099,
      "status": "ok"
    },
    "managerLaunch": {
      "startedMs": 1369698100,
      "finishedMs": 1369698510,
      "status": "ok"
    },
    "managerStop": {
      "startedMs": 1369745450,
      "finishedMs": 1369745496,
      "status": "ok"
    },
    "browserClose": {
      "startedMs": 1369742699,
      "finishedMs": 1369745450,
      "status": "timeout"
    },
    "cleanupStatus": "incomplete"
  },
  "logBounds": {
    "signal": {
      "sameInode": true,
      "readBytes": 4867,
      "capBytes": 300000
    },
    "host": {
      "sameInode": true,
      "readBytes": 54234,
      "capBytes": 300000
    }
  },
  "hostResourceBoundaryRows": [
    {
      "ts": "2026-10-17T06:07:13.831122+00:00",
      "lagMs": 0.345,
      "maxLagMs": 112.693,
      "systemLoad1": 10.778,
      "resources": {
        "elapsedMs": 4124.631122,
        "swapInBytesPerSec": 190963163.6630026,
        "swapOutBytesPerSec": 14539369.516011717,
        "currentRssMiB": 54.63671875,
        "peakRssMiB": 147.89453125,
        "memoryPressure": "unknown",
        "ageMs": 3937.462189,
        "available": true,
        "status": "ok"
      },
      "relayRunning": false,
      "pcState": "none",
      "captureSeq": 0
    },
    {
      "ts": "2026-10-17T06:07:18.832233+00:00",
      "lagMs": 1.309,
      "maxLagMs": 112.693,
      "systemLoad1": 10.155,
      "resources": {
        "elapsedMs": 4980.034954,
        "swapInBytesPerSec": 262321461.60956445,
        "swapOutBytesPerSec": 164895742.21570817,
        "currentRssMiB": 54.21875,
        "peakRssMiB": 147.89453125,
        "memoryPressure": "unknown",
        "ageMs": 3958.387243,
        "available": true,
        "status": "ok"
      },
      "relayRunning": false,
      "pcState": "none",
      "captureSeq": 0
    },
    {
      "ts": "2026-10-17T06:07:24.840200+00:00",
      "lagMs": 8.859,
      "maxLagMs": 112.693,
      "systemLoad1": 13.305,
      "resources": {
        "elapsedMs": 4999.937831,
        "swapInBytesPerSec": 139486099.1422595,
        "swapOutBytesPerSec": 627846782.5213245,
        "currentRssMiB": 54.23828125,
        "peakRssMiB": 147.89453125,
        "memoryPressure": "unknown",
        "ageMs": 4966.189352,
        "available": true,
        "status": "ok"
      },
      "relayRunning": false,
      "pcState": "none",
      "captureSeq": 0
    },
    {
      "ts": "2026-10-17T06:07:30.833352+00:00",
      "lagMs": 2.02,
      "maxLagMs": 112.693,
      "systemLoad1": 13.44,
      "resources": {
        "elapsedMs": 4803.412908,
        "swapInBytesPerSec": 343019678.62388897,
        "swapOutBytesPerSec": 221887246.50860265,
        "currentRssMiB": 48.28125,
        "peakRssMiB": 147.89453125,
        "memoryPressure": "unknown",
        "ageMs": 964.88579,
        "available": true,
        "status": "ok"
      },
      "relayRunning": false,
      "pcState": "none",
      "captureSeq": 0
    },
    {
      "ts": "2026-10-17T06:07:35.944261+00:00",
      "lagMs": 92.443,
      "maxLagMs": 555.076,
      "systemLoad1": 14.045,
      "resources": {
        "elapsedMs": 5621.518117,
        "swapInBytesPerSec": 168622920.04955217,
        "swapOutBytesPerSec": 234201697.93966708,
        "currentRssMiB": 145.52734375,
        "peakRssMiB": 161.484375,
        "memoryPressure": "unknown",
        "ageMs": 454.120398,
        "available": true,
        "status": "ok"
      },
      "relayRunning": false,
      "pcState": "connected",
      "captureSeq": 22
    },
    {
      "ts": "2026-10-17T06:07:41.925949+00:00",
      "lagMs": 94.363,
      "maxLagMs": 555.076,
      "systemLoad1": 15.002,
      "resources": {
        "elapsedMs": 4397.255223,
        "swapInBytesPerSec": 137253213.0596323,
        "swapOutBytesPerSec": 525984552.34127766,
        "currentRssMiB": 290.8359375,
        "peakRssMiB": 298.48046875,
        "memoryPressure": "unknown",
        "ageMs": 2038.411765,
        "available": true,
        "status": "ok"
      },
      "relayRunning": false,
      "pcState": "connected",
      "captureSeq": 93
    },
    {
      "ts": "2026-10-17T06:07:47.832364+00:00",
      "lagMs": 0.238,
      "maxLagMs": 555.076,
      "systemLoad1": 14.281,
      "resources": {
        "elapsedMs": 4977.536054,
        "swapInBytesPerSec": 99791085.9130464,
        "swapOutBytesPerSec": 178142410.69884974,
        "currentRssMiB": 318.6328125,
        "peakRssMiB": 326.29296875,
        "memoryPressure": "unknown",
        "ageMs": 2966.927854,
        "available": true,
        "status": "ok"
      },
      "relayRunning": false,
      "pcState": "connected",
      "captureSeq": 150
    },
    {
      "ts": "2026-10-17T06:08:03.605143+00:00",
      "lagMs": 12771.098,
      "maxLagMs": 12771.098,
      "systemLoad1": 31.941,
      "resources": {
        "elapsedMs": null,
        "swapInBytesPerSec": null,
        "swapOutBytesPerSec": null,
        "currentRssMiB": null,
        "peakRssMiB": null,
        "memoryPressure": "unknown",
        "ageMs": 18739.248083,
        "available": false,
        "status": "ok"
      },
      "relayRunning": false,
      "pcState": "connected",
      "captureSeq": 151
    }
  ],
  "hostSafeLifecycle": [
    "2026-10-17 14:07:33,917 INFO aioice.ice Connection(0) Check CandidatePair([redacted endpoints]) State.FROZEN -> State.WAITING",
    "2026-10-17 14:07:33,917 INFO aioice.ice Connection(0) Check CandidatePair([redacted endpoints]) State.FROZEN -> State.WAITING",
    "2026-10-17 14:07:33,917 INFO aioice.ice Connection(0) Check CandidatePair([redacted endpoints]) State.WAITING -> State.IN_PROGRESS",
    "2026-10-17 14:07:33,938 INFO aioice.ice Connection(0) Check CandidatePair([redacted endpoints]) State.WAITING -> State.IN_PROGRESS",
    "2026-10-17 14:07:34,488 INFO aioice.ice Connection(0) Check CandidatePair([redacted endpoints]) State.IN_PROGRESS -> State.SUCCEEDED",
    "2026-10-17 14:07:34,513 INFO aioice.ice Connection(0) ICE completed",
    "2026-10-17 14:07:34,514 INFO __main__ ICE connection: completed",
    "2026-10-17 14:08:05,221 INFO aioice.ice Connection(0) Check CandidatePair([redacted endpoints]) State.FROZEN -> State.FAILED",
    "2026-10-17 14:08:05,221 INFO aioice.ice Connection(0) Check CandidatePair([redacted endpoints]) State.FROZEN -> State.FAILED",
    "2026-10-17 14:08:05,233 INFO __main__ Closing peer connection reason=new-offer",
    "2026-10-17 14:08:05,703 INFO aioice.ice Connection(2) Check CandidatePair([redacted endpoints]) State.FROZEN -> State.WAITING",
    "2026-10-17 14:08:05,704 INFO aioice.ice Connection(2) Check CandidatePair([redacted endpoints]) State.FROZEN -> State.WAITING",
    "2026-10-17 14:08:05,705 INFO aioice.ice Connection(2) Check CandidatePair([redacted endpoints]) State.WAITING -> State.IN_PROGRESS",
    "2026-10-17 14:08:05,856 INFO aioice.ice Connection(2) Check CandidatePair([redacted endpoints]) State.WAITING -> State.IN_PROGRESS",
    "2026-10-17 14:08:11,821 WARNING __main__ Disconnected from signaling server",
    "2026-10-17 14:08:11,822 INFO __main__ Closing peer connection reason=signal-disconnect",
    "2026-10-17 14:08:14,134 INFO __main__ Authenticated signaling connection initialization finished"
  ],
  "signalEvents": [
    {
      "ts": "2026-10-17T06:07:28.189Z",
      "event": "viewer_bootstrap_served",
      "reason": null
    },
    {
      "ts": "2026-10-17T06:07:30.269Z",
      "event": "viewer_bootstrap_served",
      "reason": null
    },
    {
      "ts": "2026-10-17T06:07:32.712Z",
      "event": "connection_attempt_bound",
      "reason": null
    },
    {
      "ts": "2026-10-17T06:08:04.960Z",
      "event": "diagnostic_uploaded",
      "reason": "ice-disconnected"
    },
    {
      "ts": "2026-10-17T06:08:05.022Z",
      "event": "connection_attempt_bound",
      "reason": null
    },
    {
      "ts": "2026-10-17T06:08:05.056Z",
      "event": "connection_attempt_bound",
      "reason": null
    },
    {
      "ts": "2026-10-17T06:08:05.102Z",
      "event": "signal_socket_disconnected",
      "reason": "transport error"
    },
    {
      "ts": "2026-10-17T06:08:05.202Z",
      "event": "viewer_disconnect_grace_started",
      "reason": null
    },
    {
      "ts": "2026-10-17T06:08:11.713Z",
      "event": "signal_socket_disconnected",
      "reason": "ping timeout"
    }
  ]
}
```

First boundary: frame progress stops after callback200 near elapsed13.8s; tick15 is first unchanged-count sample, tick19 first observed frame-age>5s. At tick22 PC becomes disconnected and input gate closes while Socket.IO remains connected. Tick28 changes PC identity1→2, generation1→2 and attempt hash, triggering continuity failure; frame callbacks recover briefly but cannot qualify as the same session. This is a media/PC continuity failure followed by refresh, not an observed source signaling disconnect or initial proof rejection. Exact network/TURN/Host scheduling root cause remains unproven.18 failed observations overlap the same ongoing gap/refresh and are not18 independent stalls.

Cleanup obligations: browserClose timed out (~2.751s); managerStop reports ok but owned process exit was not observed. No owned OS script/browser PID is recorded in summary/lifecycle/samples, so these artifacts do not authorize choosing a process to kill. Root exec session exit1 is not browser process-exit evidence. Resolve owned browser/child exit using exact ownership evidence before another acceptance; no broad process cleanup.

Resource comparison: Host current-sample and rolling-max must be read separately. Rows near the first gap contain renewed multi-second lag and paging; compare with earlier JPEG window whose current-sample lag max37.424ms, rolling max183.468ms, load47.425→13.404. Different mode/time windows preclude a causal claim about JPEGgate or TURN. Later Host signaling disconnects after failure/cleanup are not the first failure cause. Input measurements remain unavailable/null. No network/browser/process/service mutations performed.
