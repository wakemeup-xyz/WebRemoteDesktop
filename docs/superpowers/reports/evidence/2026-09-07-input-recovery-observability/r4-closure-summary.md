# R4 modal composition closure evidence

Date: 2026-09-08. Scope: offline-synthetic; no native input, live Viewer, credentials, or service connection in these tests.
Baseline: `a00a4c41c7b44e31b5d2e6d7180befca5581cc8f`.
Implementation: `22771b62ea9cbea0cc6e93cfde6a67a1622fa36e` (`gpt-5.6-luna / max`).
Acceptance owner: primary agent; independent scoped review by `gpt-5.6-sol / high` passed.

## Unchanged reproduction: RED to GREEN

Run from the repository root:

```text
python3 docs/superpowers/reports/evidence/2026-09-07-input-recovery-observability/reproduce-modal-composition.py
```

The primary independently observed both results with this unchanged script:

| Observation | Baseline | Implementation |
|---|---:|---:|
| Actual text writes | 1 | 1 |
| Originating DOM event | false | true |
| ACK timeouts | 1 | 1 |
| Incidents | 0 | 1 |
| Context cleared / artifact safe | true / true | true / true |
| Requests / sensitive payloads | 0 / 0 | 0 / 0 |
| Process exit | 1 | 0 |

No automatic submission was removed, no original assertion was weakened, and no production recovery state was fabricated. These are actual Chromium DOM composition events, not a physical system IME test.

## Primary full verification

```text
node --test --test-reporter=dot web-client/js/*.test.js web-client/css/*.test.js
794 pass marks, no other marks, exit 0

NODE_PATH=/Users/macstudio1/AI/Claude/WebRemoteDesktop/signal-server/node_modules npm --prefix signal-server test
349 tests, 349 pass, 0 fail/cancelled/skipped, duration_ms=26363.07283
pretest build:web succeeded; exit 0

python3 -m pytest -q python-host/test_observability.py python-host/test_connection_diagnostics.py python-host/test_input_handler.py python-host/test_remote_keyboard_state.py python-host/test_remote_desktop_write_state.py python-host/test_media_suspension.py
99 passed in 2.17s; exit 0

node --test scripts/mobile-input-interaction-acceptance.test.js
4 tests, 4 pass, 0 fail/cancelled/skipped, duration_ms=94169.53245; exit 0
```

The primary CLI ran on exact implementation HEAD and independently parsed its one generated artifact: `scope=offline-synthetic`, Chromium, 23 scenarios, every status PASS, every checks object nonempty and every value true, requests=0 and sensitivePayloads=0. The added required scenario `modal-composition-trace` reports one composition write, one timeout, one incident, and all nine checks true. The CLI still verifies missing browser runtime as NOT RUN/exit2 and post-launch failure as FAIL/exit1.

Input/test/acceptance blobs were verified identical to implementation HEAD after the other primary runs. Python was unchanged by this five-file fix. Existing VM fetch fallback and Signal negative-path logs remain baseline noise, not hidden test failures.

## Behavioral safeguards and build

Primary actual offline Chromium DOM checks preserve: immediate submit after composition does not duplicate the write; real viewport veto retains the exact draft and open modal; an exception from the Diagnostic observation boundary still allows exactly one business write/close; ordinary local textarea input sends nothing remotely. All four clear trace context, do not create an immediate false incident, and keep synthetic canaries out of the trace. These supplemental scratch probes are retained summaries, not the durable reproduction command; the new CLI scenario and focused Input tests are the committed regressions.

The built graph has 33 source files and five assets; trace precedes Input, recovery/diagnostic/Terminal modules and recovery UI are present, and Viewer has one external script. Core asset is `assets/desktop-core.d6d92baf5dae0695.js`; SHA-256 `d6d92baf5dae06953af3985685fcc076ff570688f50e468ea3a27c7a05d5af47`. This initial check was local build evidence; separate post-restart checks later verified all five HTTP-served assets against the merged main build, as recorded in the acceptance report.

## Review / deployment boundary

Independent scoped review of `a00a4c4..22771b6` closed R4 and found no new Critical/Important/Minor breakage. It verified the shared wrapper, unchanged commit business path, finally cleanup, observer-failure safety, rejection retention, actual DOM regression and covering RED/GREEN evidence. It did not rerun suites; primary fresh acceptance is recorded above. The old CLI minimum remains 22, but the new scenario is separately mandatory and the primary counted all 23; this is a non-blocking pre-existing observation, not a missing R4 gate.

Main integration and push completed at `83a9f79f5b7385706463026479e6c55ac3a7d19c`. Primary verification on that merged source again passed Viewer 794/794, Signal 349/349 plus an isolated-output build, Python 99/99, CLI 4/4 and Chromium 23/23, and the unchanged modal reproduction. The authorized local Signal/Host restart succeeded; health, Host online, served asset bytes and both authentication roles passed. Existing tunnel processes and the safe URL file were unchanged. These are service/HTTP readiness checks, not real input acceptance; credentials are not stored in evidence. Physical Android/iPhone/iPad, system IME/WebKit, Quartz, live/public Viewer input, watcher fault and real PTY acceptance remain NOT RUN.

See the [current acceptance report](../../2026-09-07-input-recovery-observability-acceptance.md) for current and historical disposition.
