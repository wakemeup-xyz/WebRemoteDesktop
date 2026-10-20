# JPEG gate short performance review

```json
{
  "windowUtc": [
    "2026-10-17T06:04:05.747000+00:00",
    "2026-10-17T06:05:56.982860+00:00"
  ],
  "status": "PASS",
  "elapsedSeconds": 111.23586041107774,
  "persistedSamples": 97,
  "stageCounts": {
    "start-ui": 1,
    "readiness": 17,
    "baseline": 6,
    "pause": 5,
    "resume": 7,
    "post-recovery": 61
  },
  "allLifecycleAssertions": true,
  "recoverySeconds": 6.006322422064841,
  "browserClosed": true,
  "postRecovery": {
    "samples": 61,
    "qualifiedLoadAgeMs": {
      "n": 61,
      "min": 27.100000143051147,
      "p50": 822.5,
      "p95": 1772.3999998569489,
      "max": 2884.7000000476837,
      "last": 665.5
    },
    "relayLoadAgeMs": {
      "n": 61,
      "min": 26.90000009536743,
      "p50": 822.2999999523163,
      "p95": 1772.0999999046326,
      "max": 2884.5,
      "last": 665.4000000953674
    },
    "rttLastValuesMs": {
      "n": 60,
      "min": 816.2461779117584,
      "p50": 1259.8850479125977,
      "p95": 1885.2176191806793,
      "max": 1912.4689087867737,
      "last": 1286.2364358901978
    },
    "rttRollingP95ValuesMs": {
      "n": 60,
      "min": 1146.4960358142853,
      "p50": 1494.7176251411438,
      "p95": 1912.4689087867737,
      "max": 1912.4689087867737,
      "last": 1286.2364358901978
    },
    "lastRelayLoadCallbacks": 55,
    "lastMaxRelayLoadGapMs": 6669.700000047684,
    "socketDisconnectCountLast": 0,
    "inputMetricAvailability": {
      "inputAckRttMs": false,
      "inputToPostApplyFrameMs": false,
      "inputToVisibleEffectMs": false,
      "hostQueueMs": false,
      "hostApplyMs": false
    }
  },
  "logBounds": {
    "signal": {
      "sameInode": true,
      "bytesRead": 5641,
      "byteLimit": 3000000
    },
    "host": {
      "sameInode": true,
      "bytesRead": 59812,
      "byteLimit": 3000000
    }
  },
  "host": {
    "rows": 20,
    "lastSampleLagMs": {
      "n": 20,
      "min": 0.115,
      "p50": 0.534,
      "p95": 2.126,
      "max": 37.424,
      "last": 1.292
    },
    "rollingMaxLagMs": {
      "n": 20,
      "min": 31.796,
      "p50": 84.064,
      "p95": 183.468,
      "max": 183.468,
      "last": 32.149
    },
    "systemLoad1": {
      "n": 20,
      "min": 13.404,
      "p50": 23.819,
      "p95": 46.51,
      "max": 47.425,
      "last": 13.404
    },
    "currentRssMiB": {
      "n": 20,
      "min": 85.23046875,
      "p50": 110.8125,
      "p95": 138.35546875,
      "max": 138.3671875,
      "last": 138.3671875
    },
    "swapInBytesPerSec": {
      "n": 20,
      "min": 32022801.566337027,
      "p50": 167496030.9987218,
      "p95": 312427827.7326609,
      "max": 367528400.9848461,
      "last": 49319945.11948023
    },
    "swapOutBytesPerSec": {
      "n": 20,
      "min": 0.0,
      "p50": 157638262.97380516,
      "p95": 488242532.30062145,
      "max": 1017468789.8423096,
      "last": 0.0
    },
    "relayQueueRows": 15,
    "relayQueueFieldDistributions": {
      "droppedCount": {
        "n": 15,
        "min": 0,
        "p50": 0,
        "p95": 0,
        "max": 0,
        "last": 0
      },
      "inFlightCount": {
        "n": 15,
        "min": 0,
        "p50": 0,
        "p95": 0,
        "max": 0,
        "last": 0
      },
      "lastDeliveryWaitMs": {
        "n": 15,
        "min": 0.051715,
        "p50": 0.063762,
        "p95": 0.116512,
        "max": 0.116512,
        "last": 0.060609
      },
      "lastProcessorMs": {
        "n": 15,
        "min": 28.869866,
        "p50": 48.594824,
        "p95": 109.1271,
        "max": 109.1271,
        "last": 53.218762
      },
      "lastQueueWaitMs": {
        "n": 15,
        "min": 0.023378,
        "p50": 0.038377,
        "p95": 0.067452,
        "max": 0.067452,
        "last": 0.042466
      },
      "pendingBytes": {
        "n": 15,
        "min": 0,
        "p50": 0,
        "p95": 0,
        "max": 0,
        "last": 0
      },
      "pendingCount": {
        "n": 15,
        "min": 0,
        "p50": 0,
        "p95": 0,
        "max": 0,
        "last": 0
      }
    }
  },
  "signalHeartbeatRows": []
}
```

Method: persisted samples only; Host runtime fields read directly from meta, queue fields from meta.queues.relayFrames. Time boundary uses exact pre-run epoch plus summary elapsed; because offset time can precede harness entry, precise lifecycle boundaries use sample stages. Reads bounded3MB per file since exact offset with inode check. Distribution percentiles nearest-rank across sampled values; rolling RTT and loop max windows overlap, so these are distributions of snapshot/window values, not independent frames/events or end-to-end latency distributions. All numeric nulls excluded from percentile computation and retained as missing; input measurements remain unavailable/null. JPEG image-load events do not establish optical presentation or visible input effect.

This run passed its short media lifecycle criteria and60-second stable follow-up. Earlier JPEG5.2-second FAIL is a separate window with different scheduling/resource conditions; this pass is not causal proof that the gate solved global resource pressure, and is not long-session acceptance. No network/browser/service/process actions performed for this analysis.

Queue active-age coverage: all15 relay queue snapshots had pendingAgeMs/processorAgeMs/deliveryAgeMs=null; processorActive=false, deliveryPending=false, frozen=false. These idle snapshots cannot bound activity duration between samples. Last processor/delivery/queue waits are historical last-completion values, not full operation distributions. Final maxRelayLoadGap6669.7ms is cumulative across pause/resume, not the post-recovery maximum interval.

Signal heartbeat close bounded post-offset read (300KB cap), outside main run window if wallMs exceeds end:
```json
[
  {
    "wallMs": 1792217157762,
    "event": "viewer-heartbeat-close",
    "reason": "transport-close",
    "durationMs": 82149,
    "node": {
      "status": "ok",
      "ageMs": 3054,
      "count": 60,
      "lastMs": 9,
      "maxMs": 110,
      "p95Ms": 9,
      "missed": 0
    },
    "coverage": {
      "state": "partial",
      "engine": true,
      "flushScanLimited": false,
      "valueInvalid": false,
      "counterClipped": false
    }
  }
]
```
