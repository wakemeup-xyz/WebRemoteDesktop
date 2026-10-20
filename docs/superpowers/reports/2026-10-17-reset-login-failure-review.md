# Read-only login failure review

Start UTC 2026-10-17T05:36:34.278000+00:00

```json
{
  "signal": {
    "offset": 1830649,
    "sameInode": true,
    "readBytes": 4668,
    "byteCap": 500000,
    "structuredEventCounts": {
      "diagnostic_uploaded": 3,
      "connection_attempt_bound": 4
    },
    "safeMatchingRows": [
      "event: '[redacted]',",
      "meta: { [redacted]: 37, rebound: true },",
      "event: '[redacted]',",
      "meta: { [redacted]: 37, rebound: false },",
      "event: '[redacted]',",
      "meta: { [redacted]: 38, rebound: true },",
      "event: '[redacted]',",
      "meta: { [redacted]: 38, rebound: false },"
    ],
    "matchingRowCount": 8
  },
  "host": {
    "offset": 1361966,
    "sameInode": true,
    "readBytes": 87352,
    "byteCap": 500000,
    "structuredEventCounts": {},
    "safeMatchingRows": [
      {
        "ts": "2026-10-17T05:36:39.111999+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 25.614,
          "maxLagMs": 4985.849,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:36:45.282463+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 246.869,
          "maxLagMs": 4985.849,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:36:51.225828+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 186.414,
          "maxLagMs": 4985.849,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:36:56.636088+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 1600.944,
          "maxLagMs": 4985.849,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:37:02.036014+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 0.562,
          "maxLagMs": 4985.849,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:37:07.191018+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 29.752,
          "maxLagMs": 4985.849,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:37:12.239086+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 30.387,
          "maxLagMs": 4985.849,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:37:17.171297+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 86.539,
          "maxLagMs": 4985.849,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:37:23.038872+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 2.863,
          "maxLagMs": 1643.007,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:37:29.772073+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 54.101,
          "maxLagMs": 1643.007,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:37:35.331994+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 295.222,
          "maxLagMs": 1643.007,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:37:41.540473+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 388.029,
          "maxLagMs": 1643.007,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:37:47.037589+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 1.077,
          "maxLagMs": 1643.007,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:37:50.174619+00:00",
        "event": "host_viewer_diagnostic_summary",
        "meta": {
          "reason": "dc-error"
        }
      },
      {
        "ts": "2026-10-17T05:37:50.767021+00:00",
        "event": "host_viewer_diagnostic_summary",
        "meta": {
          "reason": "dc-stuck"
        }
      },
      {
        "ts": "2026-10-17T05:37:51.669080+00:00",
        "event": "host_session_presentation",
        "meta": {}
      },
      {
        "ts": "2026-10-17T05:37:53.923631+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 1886.575,
          "maxLagMs": 1886.575,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:37:57.082620+00:00",
        "event": "host_viewer_diagnostic_summary",
        "meta": {
          "reason": "dc-stuck"
        }
      },
      {
        "ts": "2026-10-17T05:37:59.039022+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 2.458,
          "maxLagMs": 1886.575,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:38:05.040261+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 3.164,
          "maxLagMs": 1886.575,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:38:06.147892+00:00",
        "event": "host_session_presentation",
        "meta": {}
      },
      {
        "ts": "2026-10-17T05:38:10.154566+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 115.948,
          "maxLagMs": 1886.575,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:38:15.993270+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 908.736,
          "maxLagMs": 1886.575,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:38:21.041743+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 2.836,
          "maxLagMs": 1886.575,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:38:26.813393+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 775.344,
          "maxLagMs": 1886.575,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:38:33.383522+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 2344.276,
          "maxLagMs": 2344.276,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:38:39.099144+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 58.157,
          "maxLagMs": 2479.01,
          "severity": "critical"
        }
      },
      {
        "ts": "2026-10-17T05:38:45.083127+00:00",
        "event": "host_event_loop_lag",
        "meta": {
          "lagMs": 3041.576,
          "maxLagMs": 3041.576,
          "severity": "critical"
        }
      }
    ],
    "matchingRowCount": 28
  }
}
```

Summary: entry HTTP 200 and visible password field passed; ui-login TimeoutError occurred before Start/proof, samples=0. ui-login block includes imported login_via_ui plus a subsequent 30-second WebRTC-global wait, so generic stage timeout alone does not identify the precise await. Zero console category rows is not proof of no network or JavaScript failure. No startup diagnostics were installed yet. No login acceptance, expected-build confirmation, beacon, shell readiness or core-load success can be established merely from the summary. Existing logs may not log successful HTTP authentication; absence of auth events is not rejection evidence. Owned browser close confirmed. No network/browser/service/config changes made.

Additional safe Signal event timeline:
```json
{
  "signalBlocks": [
    {
      "ts": "2026-10-17T05:37:49.559Z",
      "event": "diagnostic_uploaded",
      "reason": "dc-error",
      "trigger": "auto-failure",
      "viewerRoleLoginMarker": false
    },
    {
      "ts": "2026-10-17T05:37:50.717Z",
      "event": "diagnostic_uploaded",
      "reason": "dc-stuck",
      "trigger": "auto-failure",
      "viewerRoleLoginMarker": false
    },
    {
      "ts": "2026-10-17T05:37:51.318Z",
      "event": "connection_attempt_bound",
      "reason": null,
      "trigger": null,
      "viewerRoleLoginMarker": false
    },
    {
      "ts": "2026-10-17T05:37:51.321Z",
      "event": "connection_attempt_bound",
      "reason": null,
      "trigger": null,
      "viewerRoleLoginMarker": false
    },
    {
      "ts": "2026-10-17T05:37:57.030Z",
      "event": "diagnostic_uploaded",
      "reason": "dc-stuck",
      "trigger": "auto-failure",
      "viewerRoleLoginMarker": false
    },
    {
      "ts": "2026-10-17T05:38:05.780Z",
      "event": "connection_attempt_bound",
      "reason": null,
      "trigger": null,
      "viewerRoleLoginMarker": false
    },
    {
      "ts": "2026-10-17T05:38:05.818Z",
      "event": "connection_attempt_bound",
      "reason": null,
      "trigger": null,
      "viewerRoleLoginMarker": false
    }
  ],
  "keywordOccurrences": {
    "auth": 0,
    "login": 0,
    "beacon": 0,
    "build": 0,
    "shell": 0,
    "HTTP": 0,
    "password": 0,
    "core": 0
  },
  "observationEndUtc": "2026-10-17T05:39:04.524031+00:00",
  "attributionLimit": "Offsets mark pre-attempt boundary but logs continue after 50s run; no raw session correlation used, so later diagnostic traffic is not attributed to owned attempt."
}
```
