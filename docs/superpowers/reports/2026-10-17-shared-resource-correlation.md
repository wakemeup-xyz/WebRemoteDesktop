# Shared resource correlation

```json
{
  "observedAt": "2026-10-17T05:44:02.005216+00:00",
  "uptime": "13:44  up 15 days, 21:57, 10 users, load averages: 641.71 514.48 369.59",
  "swapusage": "vm.swapusage: total = 30720.00M  used = 30240.25M  free = 479.75M  (encrypted)",
  "processCount": 929,
  "cpuPercentSum": 570.6,
  "rssKiBSum": 30303672,
  "top10Cpu": [
    {
      "pid": 77355,
      "ppid": 77267,
      "lstart": "Thu Oct 15 22:04:13 2026",
      "cpuPercent": 145.5,
      "rssKiB": 1645724,
      "comm": "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)"
    },
    {
      "pid": 77339,
      "ppid": 77267,
      "lstart": "Thu Oct 15 22:04:08 2026",
      "cpuPercent": 59.2,
      "rssKiB": 90388,
      "comm": "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service)"
    },
    {
      "pid": 149,
      "ppid": 1,
      "lstart": "Thu Oct 1 15:46:56 2026",
      "cpuPercent": 50.3,
      "rssKiB": 68692,
      "comm": "/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer"
    },
    {
      "pid": 13488,
      "ppid": 77267,
      "lstart": "Fri Oct 16 01:23:02 2026",
      "cpuPercent": 40.2,
      "rssKiB": 1635308,
      "comm": "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)"
    },
    {
      "pid": 877,
      "ppid": 512,
      "lstart": "Thu Oct 1 15:47:50 2026",
      "cpuPercent": 30.8,
      "rssKiB": 83420,
      "comm": "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/154.0.8037.58/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper"
    },
    {
      "pid": 512,
      "ppid": 1,
      "lstart": "Thu Oct 1 15:47:16 2026",
      "cpuPercent": 30.1,
      "rssKiB": 295996,
      "comm": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    },
    {
      "pid": 79465,
      "ppid": 79406,
      "lstart": "Sat Oct 17 13:44:00 2026",
      "cpuPercent": 16.9,
      "rssKiB": 34900,
      "comm": "/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node"
    },
    {
      "pid": 79406,
      "ppid": 79345,
      "lstart": "Sat Oct 17 13:43:50 2026",
      "cpuPercent": 15.8,
      "rssKiB": 180196,
      "comm": "(node)"
    },
    {
      "pid": 222,
      "ppid": 1,
      "lstart": "Thu Oct 1 15:46:57 2026",
      "cpuPercent": 14.1,
      "rssKiB": 10120,
      "comm": "/usr/sbin/coreaudiod"
    },
    {
      "pid": 79309,
      "ppid": 77378,
      "lstart": "Sat Oct 17 13:43:33 2026",
      "cpuPercent": 12.7,
      "rssKiB": 138348,
      "comm": "/Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python"
    }
  ],
  "top10Rss": [
    {
      "pid": 14457,
      "ppid": 512,
      "lstart": "Tue Oct 13 02:16:26 2026",
      "cpuPercent": 5.5,
      "rssKiB": 3044120,
      "comm": "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/154.0.8037.58/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)"
    },
    {
      "pid": 998,
      "ppid": 524,
      "lstart": "Thu Oct 1 15:48:00 2026",
      "cpuPercent": 0.7,
      "rssKiB": 1714400,
      "comm": "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper"
    },
    {
      "pid": 77355,
      "ppid": 77267,
      "lstart": "Thu Oct 15 22:04:13 2026",
      "cpuPercent": 145.5,
      "rssKiB": 1645724,
      "comm": "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)"
    },
    {
      "pid": 13488,
      "ppid": 77267,
      "lstart": "Fri Oct 16 01:23:02 2026",
      "cpuPercent": 40.2,
      "rssKiB": 1635308,
      "comm": "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)"
    },
    {
      "pid": 25366,
      "ppid": 77267,
      "lstart": "Fri Oct 16 01:39:47 2026",
      "cpuPercent": 11.5,
      "rssKiB": 1633704,
      "comm": "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)"
    },
    {
      "pid": 6832,
      "ppid": 77267,
      "lstart": "Fri Oct 16 01:16:57 2026",
      "cpuPercent": 1.1,
      "rssKiB": 1167944,
      "comm": "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)"
    },
    {
      "pid": 79562,
      "ppid": 77267,
      "lstart": "Thu Oct 15 22:10:11 2026",
      "cpuPercent": 3.3,
      "rssKiB": 1016096,
      "comm": "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)"
    },
    {
      "pid": 10564,
      "ppid": 77267,
      "lstart": "Fri Oct 16 01:20:05 2026",
      "cpuPercent": 0.0,
      "rssKiB": 1013540,
      "comm": "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)"
    },
    {
      "pid": 8802,
      "ppid": 77267,
      "lstart": "Fri Oct 16 01:18:24 2026",
      "cpuPercent": 0.0,
      "rssKiB": 844152,
      "comm": "/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/155.0.8059.40/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer)"
    },
    {
      "pid": 77378,
      "ppid": 77267,
      "lstart": "Thu Oct 15 22:04:14 2026",
      "cpuPercent": 0.8,
      "rssKiB": 662012,
      "comm": "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
    }
  ],
  "ownedServiceRows": [
    {
      "pid": 42127,
      "ppid": 1,
      "lstart": "Sat Oct 17 12:34:03 2026",
      "cpuPercent": 1.6,
      "rssKiB": 59176,
      "comm": "/Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python"
    },
    {
      "pid": 64505,
      "ppid": 1,
      "lstart": "Sat Oct 17 13:12:16 2026",
      "cpuPercent": 0.0,
      "rssKiB": 55948,
      "comm": "/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node"
    }
  ],
  "vmStatPageSizeBytes": 4096,
  "vmStatFirst": {
    "Pages free": 137826,
    "Pages active": 3068963,
    "Pages inactive": 3059455,
    "Pages speculative": 8380,
    "Pages throttled": 0,
    "Pages wired down": 1346973,
    "Pages purgeable": 2635,
    "\"Translation faults\"": 24608070799,
    "Pages copy-on-write": 835955666,
    "Pages zero filled": 10210282330,
    "Pages reactivated": 1477623043,
    "Pages purged": 40879462,
    "File-backed pages": 1311181,
    "Anonymous pages": 4825617,
    "Pages stored in compressor": 15538761,
    "Pages occupied by compressor": 766236,
    "Decompressions": 1124775220,
    "Compressions": 1305767021,
    "Pageins": 789875497,
    "Pageouts": 3807601,
    "Swapins": 1938928295,
    "Swapouts": 1963420557
  },
  "vmStatSecond": {
    "Pages free": 102892,
    "Pages active": 3108921,
    "Pages inactive": 3096998,
    "Pages speculative": 10025,
    "Pages throttled": 0,
    "Pages wired down": 1313150,
    "Pages purgeable": 2718,
    "\"Translation faults\"": 24608176152,
    "Pages copy-on-write": 835956947,
    "Pages zero filled": 10210324965,
    "Pages reactivated": 1477623043,
    "Pages purged": 40879462,
    "File-backed pages": 1313149,
    "Anonymous pages": 4902795,
    "Pages stored in compressor": 15500220,
    "Pages occupied by compressor": 755969,
    "Decompressions": 1124813563,
    "Compressions": 1305767021,
    "Pageins": 789875627,
    "Pageouts": 3807601,
    "Swapins": 1939023527,
    "Swapouts": 1963504255
  },
  "vmStatTwoSecondDelta": {
    "Pages free": -34934,
    "Pages active": 39958,
    "Pages inactive": 37543,
    "Pages wired down": -33823,
    "Pages stored in compressor": -38541,
    "Pages occupied by compressor": -10267,
    "Pageins": 130,
    "Pageouts": 0,
    "Swapins": 95232,
    "Swapouts": 83698
  },
  "hostFiveMinute": {
    "windowStart": "2026-10-17T05:39:06.339974+00:00",
    "rowCount": 32,
    "severityCounts": {
      "critical": 32
    },
    "lastSampleOver1000msRows": 22,
    "lastSampleMaxMs": 40126.976,
    "rollingMaxMaxMs": 40126.976,
    "latest": [
      {
        "ts": "2026-10-17T05:43:53.673272+00:00",
        "lagMs": 7450.47,
        "maxLagMs": 7450.47,
        "eventLoop": {
          "count": 35,
          "last": 7450.470268,
          "max": 7450.470268,
          "p50": 284.317073,
          "p95": 4536.393364,
          "p99": 7450.470268,
          "missedSampleCount": 25
        },
        "relayRunning": false,
        "pendingRelayFrames": 0,
        "pcState": "none",
        "taskCount": 23,
        "threadCount": 7
      },
      {
        "ts": "2026-10-17T05:43:59.681541+00:00",
        "lagMs": 633.799,
        "maxLagMs": 7450.47,
        "eventLoop": {
          "count": 36,
          "last": 633.798951,
          "max": 7450.470268,
          "p50": 284.317073,
          "p95": 4536.393364,
          "p99": 7450.470268,
          "missedSampleCount": 24
        },
        "relayRunning": false,
        "pendingRelayFrames": 0,
        "pcState": "none",
        "taskCount": 24,
        "threadCount": 7
      },
      {
        "ts": "2026-10-17T05:44:05.052155+00:00",
        "lagMs": 2.364,
        "maxLagMs": 7450.47,
        "eventLoop": {
          "count": 40,
          "last": 2.36424,
          "max": 7450.470268,
          "p50": 284.317073,
          "p95": 3155.132933,
          "p99": 7450.470268,
          "missedSampleCount": 23
        },
        "relayRunning": false,
        "pendingRelayFrames": 0,
        "pcState": "none",
        "taskCount": 22,
        "threadCount": 7
      }
    ]
  },
  "signalFiveMinuteHeartbeatRows": [
    {
      "wallMs": 1792215657791,
      "event": "viewer-heartbeat-close",
      "reason": "ping",
      "node": {
        "status": "ok",
        "ageMs": 5048,
        "count": 17,
        "lastMs": 7113,
        "maxMs": 41329,
        "p95Ms": 41329,
        "missed": 52
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
  "collectionEnd": "2026-10-17T05:44:06.452716+00:00"
}
```

Method: one process snapshot using PID/PPID/lstart/CPU/RSS/comm only; one uptime/load and swapusage; exactly two vm_stat samples separated by two seconds. Logs read only, bounded 1MB Host and200KB Signal. Top10 CPU and top10 RSS intentionally overlap; aggregate RSS double counts shared pages and is not physical memory usage. ps CPU is process lifetime-decayed activity, not a synchronized two-second CPU interval. Parent-owned login-only probe is known active; browser processes cannot be classified as leaks from this snapshot.

Host severity/max fields represent overlapping rolling windows, so critical-row counts are not independent stalls. lagMs is the current sampled delay; counts of lagMs above1s describe observed last samples only and miss intermediate stalls. Simultaneous Node/Host lag is compatible with shared machine scheduling pressure but does not establish its cause. No processes modified or external network/browser calls made.

Assessment: this snapshot provides direct evidence of severe machine-wide load and active swapping, alongside concurrent multi-second Host/Node scheduling delays. Swap-in delta is 372.0 MiB and swap-out delta 326.9 MiB across the two samples; the interval includes command overhead around the requested two-second spacing. These observations strengthen shared resource pressure as an explanation, but do not identify a unique culprit or establish that either login failure was caused by it. Top resource consumers are application processes identified by comm only, with no mapping to user tabs/chat contents and no leak claim.

Current owned service process snapshot:
```json
[
  {
    "pid": 42127,
    "ppid": 1,
    "lstart": "Sat Oct 17 12:34:03 2026",
    "cpuPercent": 1.6,
    "rssKiB": 59176,
    "comm": "/Users/macstudio1/.homebrew/Cellar/python@3.11/3.11.15_1/Frameworks/Python.framework/Versions/3.11/Resources/Python.app/Contents/MacOS/Python"
  },
  {
    "pid": 64505,
    "ppid": 1,
    "lstart": "Sat Oct 17 13:12:16 2026",
    "cpuPercent": 0.0,
    "rssKiB": 55948,
    "comm": "/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node"
  }
]
```

Next bounded observation, if needed: after the already-owned login-only probe has closed, compare one subsequent fixed-duration resource/lag snapshot under user-authorized reduced application workload. Do not launch another media acceptance during current extreme pressure merely to reproduce timing. No automatic app termination, service restart, priority change or tunnel action is justified by this report.
