# Bounded local timeout review

```json
{
  "observedAt": "2026-10-17T05:33:52.060666+00:00",
  "requests": [
    {
      "path": "/health",
      "http": 200,
      "seconds": 0.063,
      "bytes": 54,
      "safeFields": {
        "status": "ok"
      }
    },
    {
      "path": "/api/status",
      "http": 200,
      "seconds": 0.003,
      "bytes": 153,
      "safeFields": {
        "status": "ok",
        "hostOnline": false,
        "viewerCount": 0
      }
    }
  ],
  "signal": {
    "tailByteLimit": 2000000,
    "fileBytes": 1830609,
    "tailLines": 69979,
    "windowLines": 901,
    "eventCounts": {
      "diagnostic_uploaded": 12,
      "signal_input_relayed": 3,
      "control_transition_failed_closed": 5,
      "control_reset_retry": 8,
      "connection_attempt_bound": 13,
      "control_reset_blocked": 1,
      "signal_socket_disconnected": 4,
      "viewer_disconnect_grace_started": 1
    },
    "heartbeatRows": [
      {
        "event": "viewer-heartbeat-close",
        "wallMs": 1792215146677,
        "durationMs": 1196226,
        "reason": "ping",
        "node": {
          "status": "ok",
          "ageMs": 4797,
          "count": 52,
          "lastMs": 26,
          "maxMs": 5882,
          "p95Ms": 1289,
          "missed": 7
        },
        "counts": {
          "pingCreated": 45,
          "pingInFlush": 45,
          "pongReceived": 44,
          "messageIn": 1414,
          "messageCreated": 181,
          "flush": 211
        },
        "ages": {
          "pingCreatedMs": 20298,
          "pingInFlushMs": 20298,
          "pongReceivedMs": 45425
        },
        "transport": {
          "name": "websocket",
          "writable": true,
          "bufferLength": 0,
          "state": "closed"
        },
        "coverage": {
          "state": "partial",
          "engine": true,
          "flushScanLimited": false,
          "valueInvalid": false,
          "counterClipped": false
        }
      }
    ],
    "heartbeatRowsInWindow": 1,
    "observerMatchingLines": [],
    "observerMatchingCount": 0
  },
  "host": {
    "tailByteLimit": 2000000,
    "fileBytes": 1323906,
    "tailLines": 4729,
    "windowLines": 1531,
    "eventCounts": {},
    "heartbeatRows": [],
    "heartbeatRowsInWindow": 0,
    "observerMatchingCount": 111,
    "loopRows": 100,
    "loopSeverityCounts": {
      "critical": 100
    },
    "loopRecent": [
      {
        "ts": "2026-10-17T05:33:39.255167+00:00",
        "meta": {
          "lagMs": 635.114,
          "maxLagMs": 4475.128,
          "sampleCount": 49,
          "severity": "critical",
          "pcState": "none",
          "iceState": "none",
          "inputWaiters": 0,
          "relayRunning": false,
          "pendingRelayFrames": 0,
          "taskCount": 20,
          "threadCount": 7,
          "processCpuSeconds": 449.122,
          "currentRssMiB": null,
          "peakRssMiB": null,
          "eventLoop": {
            "count": 49,
            "last": 635.113655,
            "max": 4475.12844,
            "p50": 276.079743,
            "p95": 1944.774689,
            "p99": 4475.12844,
            "missedSampleCount": 11
          }
        }
      },
      {
        "ts": "2026-10-17T05:33:44.057325+00:00",
        "meta": {
          "lagMs": 6.611,
          "maxLagMs": 4475.128,
          "sampleCount": 50,
          "severity": "critical",
          "pcState": "none",
          "iceState": "none",
          "inputWaiters": 0,
          "relayRunning": false,
          "pendingRelayFrames": 0,
          "taskCount": 21,
          "threadCount": 7,
          "processCpuSeconds": 449.167,
          "currentRssMiB": 47.140625,
          "peakRssMiB": 417.875,
          "eventLoop": {
            "count": 50,
            "last": 6.610915,
            "max": 4475.12844,
            "p50": 276.079743,
            "p95": 1944.774689,
            "p99": 4475.12844,
            "missedSampleCount": 11
          }
        }
      },
      {
        "ts": "2026-10-17T05:33:50.709446+00:00",
        "meta": {
          "lagMs": 674.365,
          "maxLagMs": 2680.002,
          "sampleCount": 54,
          "severity": "critical",
          "pcState": "none",
          "iceState": "none",
          "inputWaiters": 0,
          "relayRunning": false,
          "pendingRelayFrames": 0,
          "taskCount": 20,
          "threadCount": 7,
          "processCpuSeconds": 449.282,
          "currentRssMiB": 47.28125,
          "peakRssMiB": 417.875,
          "eventLoop": {
            "count": 54,
            "last": 674.365389,
            "max": 2680.002448,
            "p50": 238.608158,
            "p95": 1678.25421,
            "p99": 2680.002448,
            "missedSampleCount": 7
          }
        }
      }
    ],
    "maxWindowLagMs": 14243.969
  },
  "windowStart": "2026-10-17T05:23:52.060666+00:00",
  "windowEnd": "2026-10-17T05:33:53.847542+00:00",
  "processSnapshot": {
    "localTime": "13:33:24 +0800",
    "signal": {
      "elapsed": "21:09",
      "cpuPercent": 0.0,
      "rssKiB": 53472,
      "state": "S"
    },
    "host": {
      "elapsed": "59:22",
      "cpuPercent": 1.2,
      "rssKiB": 50080,
      "state": "R"
    }
  }
}
```

Conclusion: no sustained loopback HTTP stall at the one direct probe. Host was offline in status, and Host logged signal-disconnect at 13:33:51 local. Both processes remained present at the earlier process snapshot. Signal heartbeat and Host complete sampled windows show multi-second scheduling lag, compatible with intermittent local scheduling stalls, but the earlier urllib timeout cannot be attributed conclusively to scheduling or request proxy/environment from this snapshot. No proxy values inspected.

Limits: exactly one direct/no-proxy round, two requests with 5-second timeout each, response cap 65537 bytes. Logs bounded to 2 MB each (both entire files fit); window 13:23:52–13:33:53 local. Signal structured event counts use multiline event fields; Host JSON loop counts parsed independently. Heartbeat row covers its own ~20-minute connection and only partial engine coverage, not the complete 10-minute review interval. No Signal runtimeobserver-named log rows found; heartbeat node fields are the available runtime evidence. No page content, auth payloads, raw input content, browser actions, process/service/config/tunnel mutations.

## Authorized final recovery snapshot

{
  "boundedTailBytes": 100000,
  "matchingRows": 6,
  "recentMatchingRows": [
    {
      "time": "2026-10-17 13:32:39",
      "class": "Disconnected",
      "safeText": null
    },
    {
      "time": "2026-10-17 13:33:04",
      "class": "connection-error",
      "safeText": null
    },
    {
      "time": "2026-10-17 13:33:51",
      "class": "Disconnected",
      "safeText": "2026-10-17 13:33:51,472 WARNING __main__ Disconnected from signaling server"
    },
    {
      "time": "2026-10-17 13:33:51",
      "class": "signal-disconnect",
      "safeText": "2026-10-17 13:33:51,518 INFO __main__ WRD_MEDIA_RESOURCES reason=signal-disconnect peerClosed=False senderReleased=False track=None tasks=0"
    },
    {
      "time": "2026-10-17 13:33:52",
      "class": "reconnect",
      "safeText": "2026-10-17 13:33:52,602 WARNING __main__ Host offline, attempting reconnect..."
    },
    {
      "time": "2026-10-17 13:33:56",
      "class": "Disconnected",
      "safeText": null
    }
  ],
  "finalDirectStatus": {
    "http": 200,
    "seconds": 0.02,
    "hostOnline": true,
    "viewerCount": 0
  }
}

Safe connection lifecycle lines:
2026-10-17 13:33:05,319 ERROR engineio.client packet queue is empty, aborting
2026-10-17 13:33:51,472 WARNING __main__ Disconnected from signaling server
2026-10-17 13:33:51,518 INFO __main__ [redacted] reason=[redacted] peerClosed=False senderReleased=False track=None tasks=0
2026-10-17 13:33:52,602 WARNING __main__ Host offline, attempting reconnect...
2026-10-17 13:33:56,682 INFO __main__ Connected to signaling server
2026-10-17 13:33:56,709 INFO __main__ Authenticated signaling connection initialization finished
2026-10-17 13:33:56,713 INFO __main__ [redacted] reason=[redacted] peerClosed=False senderReleased=False track=None tasks=0

Recovery confirmed by final status; specific disconnect cause is not established in these lifecycle lines. Shared scheduling pressure is plausible from simultaneous Node/Host lag; low process CPU at point snapshots does not establish machine-wide resource cause.
