# Mobile Remote-Control Acceptance

## Automated Coverage

Implemented coverage verifies one v2 lease envelope for touch click, touch wheel, and mobile text; mouse move remains outside keyboard pending state; DataChannel loss delegates the existing Socket.IO reset barrier; ACK fan-out reaches mouse reset, keyboard transport, and `LatencyMonitor` once each; diagnostics remain metadata-only; and virtual modifier latches clear on reset, visibility park, lease revocation, and disconnect.

2026-09-02 automation evidence: `node --test web-client/js/*.test.js web-client/css/*.test.js` exited naturally with 543 pass and one pre-existing `input.test.js` blur-fixture failure; the new Task 6 tests passed. `cd signal-server && npm test` passed 318 tests after the web build. `cd python-host && PYTHONPATH=. python3 -m pytest -q` passed 192 tests with one existing `mss.mss` deprecation warning. The harness `--help`, `py_compile`, and a no-origin atomic SHA-256 dry run passed; the dry run intentionally emitted only `NOT RUN` evidence and did not start a service.

`scripts/mobile_viewer_acceptance.py` accepts an existing `--base-url`, reads the password only from the named environment variable, runs every named gesture/text/control scenario in a fresh Playwright context, captures the required four viewport geometries, and writes the JSON through an atomic rename before hashing final bytes to `*.sha256`. It writes only action names, transport, ACK status/RTT, pressed counts, bounding boxes, and status/reason. Screenshots are emitted beside the selected artifact and are not treated as device evidence.

## Evidence Matrix

| Scope | Status | Evidence boundary |
|---|---|---|
| Node/browser-unit transport and privacy contracts | Automated | Local test suites; no Host Quartz or public path claim |
| Browser harness against `--base-url` | NOT RUN | No operator-supplied existing origin in this task; services were not started |
| Android Chrome | NOT RUN | No physical Android/Chrome device was supplied; desktop emulation is excluded |
| iPhone Safari | NOT RUN | No physical iPhone/Safari device was supplied; desktop emulation is excluded |
| iPad Safari | NOT RUN | No physical iPad/Safari device was supplied; desktop emulation is excluded |
| Physical keyboard | NOT RUN | No physical keyboard/Host Quartz run was authorized or available |
| Tunnel/public path | NOT RUN | No tunnel action or public-path validation was authorized |

The browser harness records its own `NOT RUN` device entries when no physical device/browser is supplied. A successful local unit suite must not change any real-device, physical-keyboard, Host Quartz, tunnel, or public-path entry to PASS.
