# Loaded Viewer startup evidence (2026-10-19)

Fourth baseline remains **failed-or-indeterminate**: coverage validation failed after a worker child-exit observation race (`NoSuchProcess` / `observation-unavailable`). Worker exit 0, no timeout, no worker error or cleanup error do not change qualification.

Viewer `fefc555aea9640b563bfd22f5b36b6b8ca6365ec`, build `a3671ba674ad7516`; Signal/Host `dfb15434e79da90b803b763c533836e16c080c71`. Relay UDP/H.264 passive session; no actual input injection.

Persisted browser performance marks: click 1968.3 ms; bootstrap-start 1969.0; bootstrap-ready 2641.1; signal-connected 5636.4; first-frame/active 8106.0. Thus click→signal = **3668.1 ms**; click→first-frame mark = **6137.7 ms**; bootstrap duration = 672.1 ms; bootstrap-ready→signal = 2995.3 ms; signal→first-frame mark = 2469.6 ms. These are same-clock mark subtractions, not poll-count estimates.

Exact first callback time and click→first callback remain **null / not established**. The first callbacks-positive observation has 12 callbacks; lastFrameAtMs is the latest callback (8675.8 ms), not the first. Root supplied targeted source proof: markMediaAttemptReady stamps first-frame and active together, and can be called from stats-based readiness, tunnel rendering, rVFC and other rendered-frame paths. Thus first-frame is a media-ready mark, not a unique first-rVFC timestamp; active is not control grant/input-ready proof. Source SHA256 `4fde802193ca0057203a6fdf40a0c9a37ef64626444cb33bcde6bb8f82052924` for pinned webrtc.js; root inspected lines 1175–1197 and callsites 2050, 5536, 6213, 1161. This agent did not read a third source file. Configuration, grant, offer and peer-connected event timestamps are null: schema has no such named fields and all serverEvents arrays are empty. Generic diagnostic rx/tx events cannot identify these messages.

Old single-probe click→signal was 4577.8 ms, and click→first callback was 7880.8 ms (parent-supplied context, old artifact not re-read). New click→signal is 909.7 ms lower in this observation. The samples differ; this establishes neither causal improvement nor P95. Do not subtract old first callback from the new first-frame mark as though their semantics were proven equal.

The summary records passive continuity 300.40683215111494 s, 301 samples, no missing/late/failed/identity-change observations, max observed no-progress 533.312 ms, and three-hour continuity false. This is a continuity sub-result, not a qualification pass. All 312 persisted rows cover Python elapsed 0.013160167–309.258925123 s; browser performance time 945.5–310141.9 ms. Browser time origin 1792348658779 maps these row observations to 2026-10-18T18:37:39.724500+00:00–2026-10-18T18:42:48.920900+00:00. Epoch mapping is descriptive; no browser/Python cross-clock subtraction is made.

The row clock is Python time.monotonic()-began at row emission. Startup marks use browser performance.now(). Ordinary observation ticks have a configured 2 s outer budget with 0.1 s cancellation settlement; Host status budget 0.75 s (injected-reader settlement 0.075 s); final observation has a 1 s cleanup outer deadline. These are producer budgets, not measured connection latency.

All six input metrics remain unavailable, count 0, last/p95 null in all rows: inputAckRttMs, inputToPostApplyFrameMs, inputToVisibleEffectMs, hostQueueMs, hostApplyMs, hostAdapterAwaitMs. Native after-grace, business input, visible effect and physical display remain NOT_RUN.

Only six bounded persisted artifact files were read; no live logs, process/network/Git/service/browser/Host/sample/qualification commands or source execution. Two source files were read as definitions: startup-telemetry.js and ordinary_session_recovery.py. JSON companion contains exact paths, SHA256, raw measured marks, clock semantics and confidence.

| Artifact | Bytes | SHA256 |
|---|---:|---|
| qualification-result.json | 7662 | `5ebf46ff9919847f0be320f7f55df255928b6e4b8c9b22c0f9059364909f0dfd` |
| runtime-manifest.json | 1158 | `2002654ee48a6aa1485e670181dee94af59ca71963a845beb5b35bd75f23ae83` |
| deployment-evidence.json | 4977 | `04f4ab79ce84eb33353d1e03462d07196788fc9fde6eaacc8308965985718b46` |
| summary.json | 2361 | `5898c37279fb3105301d53ab6b3426016055450605fd16c37bb266bf1e246e4d` |
| lifecycle.json | 8412 | `b5e38c4708772a2f1381b36941670d1249c181ec66c564c9de4e8f0f50ab77d0` |
| samples.jsonl | 1164155 | `a96b18e67f05febca112059404495c1db7dd1c24da20f182438a15d852bf25cc` |
