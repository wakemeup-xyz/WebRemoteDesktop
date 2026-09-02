# Remote Desktop Input, Diagnostics and Stability Acceptance

Date: 2026-09-03

## Automated Evidence

| Area | Result | Evidence |
|---|---|---|
| Production asset graph/build | PASS | `node --test signal-server/test/web-asset-build.test.js`; 5 passed. Temporary build emitted hashed `desktop-core` bundle, HTTP 200, and contained `TouchInputAdapter` and `MobileTextInput`. |
| Viewer input regression | PASS | `node --test web-client/js/input.test.js web-client/js/touch-input-adapter.test.js`; 43 passed. |
| Network capability | PASS | `node --test web-client/js/chrome-layout.test.js`; 22 passed. Disconnected network button is visible and enabled; idle remains gated. |
| Latency semantics and display | PASS | `node --test web-client/js/latency-monitor.test.js web-client/js/diagnostic.test.js`; 26 passed. |
| Layout contract | PASS | `node --test web-client/css/viewer-layout.test.js`; 24 passed. |
| Browser geometry over 375/768/1440 viewports | NOT RUN | No service was started and no operator-provided browser origin was supplied for this run. |
| Full JavaScript/Signal suite | PASS | `node --test web-client/js/*.test.js web-client/css/*.test.js signal-server/test/*.test.js`; 736 passed, 0 failed. Existing auth/log output is test noise. |
| Host timing/input diagnostics | PASS | `pytest -q python-host/test_latency_timing.py python-host/test_connection_diagnostics.py python-host/test_input_handler.py`; 46 passed, 1 existing `mss.mss` deprecation warning. |

## Runtime Evidence

- No service, Host, Signal Server, or Cloudflare tunnel was started, stopped, restarted, or rebuilt.
- Real Android Chrome, iPhone Safari, iPad Safari, physical Quartz input, and public-path browser acceptance: `NOT RUN` because no operator-run device/public-path evidence was supplied.
- The build smoke requests the emitted hashed bundle from a temporary local HTTP server. Individual `/js/*.js` URLs are not expected in production because the build concatenates them into `desktop-core.<hash>.js`.

## Remaining Risk

Automated tests prove contracts and local rendering behavior, but not physical touch hardware, macOS Quartz execution, or long-running public tunnel behavior. Those remain separate operator acceptance gates.
