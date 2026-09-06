# Mobile Remote-Control Acceptance

## 2026-09-06 Remediation Follow-up

Task1–7 and the additional drag-status/layout feedback fix have been implemented and reviewed on `codex/mobile-input-interaction-remediation` (production through `bfc886d`, acceptance through `f2e694a`). The offline Chromium suite and primary whole-branch review are complete with no unresolved P1/P2 findings. See [current remediation acceptance](2026-09-06-mobile-input-interaction-remediation-acceptance.md). This branch has not been merged/pushed or deployed; physical devices, system IME, Quartz, public entry and live watcher remain NOT RUN. All dated evidence below retains its historical meaning.

## 2026-09-05 Current-Code Review Addendum

The original evidence below is historical. Review of `main` at `000547f` found seven open interaction defects: repeated video-focus stealing, duplicate keyboard-inset layout accounting, toolbar/text cursor divergence, displaced drag-down coordinates, loss of unsent drafts, missing wide-iPad keyboard avoidance, and input controls outside the fullscreen target. See [current logic and review](2026-09-05-mobile-touch-keyboard-logic-review.md) for locations and reproductions.

The seven focused Node suites passed 151/151. Four isolated code reproductions confirmed defects; offline Chromium rendered the real HTML/CSS with connected capabilities and a synthetic keyboard inset, and confirmed real DOM focus stealing. These results are **not** a real Viewer-session, physical-device, system-keyboard, Quartz, or public-path PASS. The earlier automated success does not close the newly identified defects. No production fix or service operation was performed in this review.

## Entry Boundary

The formal Viewer entry for desktop, phone, and iPad is `https://link.stockhub.wiki`. Local checks may use `http://127.0.0.1:8080`. A `*.trycloudflare.com` URL from `/tmp/wrd-safe-current-url.txt` is a temporary safe quick-tunnel diagnostic address only; it is not a substitute for the formal domain and is not used as evidence of a real-device public-path pass.

## Automated Coverage

Implemented coverage verifies one v2 lease envelope for touch click, touch wheel, and mobile text; mouse move remains outside keyboard pending state; DataChannel loss delegates the existing Socket.IO reset barrier; ACK fan-out reaches mouse reset, keyboard transport, and `LatencyMonitor` once each; diagnostics remain metadata-only; and virtual modifier latches clear on reset, visibility park, lease revocation, and disconnect.

2026-09-02 automation evidence: `node --test web-client/js/*.test.js web-client/css/*.test.js` exited naturally with 549 pass and zero failures. `cd signal-server && npm test` passed 322 tests. `cd python-host && PYTHONPATH=. python3 -m pytest -q` passed 197 tests with one existing `mss.mss` deprecation warning. The harness `--help`, `py_compile`, focused tests, and a refused-origin atomic SHA-256 dry run passed; the dry run intentionally emitted only `NOT RUN` evidence and did not start a service.

`scripts/mobile_viewer_acceptance.py` accepts an existing `--base-url`, reads the password only from the named environment variable, runs every named gesture/text/control scenario in a fresh Playwright context, checks the required four viewport layouts, and writes the JSON through an atomic rename before hashing final bytes to `*.sha256`. It writes only action names, transport, ACK status/RTT, pressed counts, safe layout summaries, and status/reason. It does not create screenshots or write text, keys, coordinates, URLs, tokens, or credentials. The application text Dock is recorded separately from system-keyboard evidence; a keyboard-visible PASS requires an observed positive viewport contraction, otherwise the geometry item is `NOT RUN`.

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
