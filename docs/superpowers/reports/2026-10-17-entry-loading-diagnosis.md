# Entry loading diagnosis, 2026-10-17

Read-only verdict: Cloudflare's injected beacon prolongs DOMContentLoaded and the load event, but it did not delay the login form's submit-handler initialization in the observed navigation. Treating an 8-second Playwright `wait_until='load'` measurement as 8 seconds until usable login overstates the observed JavaScript readiness delay. The initial public-route delivery and stylesheet critical path remain materially slow on this machine.

## Evidence and scope

- Runtime page reports build `c30530f331a4def5`.
- One permitted fresh headless normal Chromium browser/context navigation to unauthenticated formal root, HTTP 200; no login, submit dispatch, input dispatch, Viewer/Start/proof, request blocking, fault injection, screenshot, service/tunnel/config/source modification, or dependency installation.
- Evidence: `/tmp/wrd-entry-loading-evidence.json` (0600); observation script `/tmp/wrd-entry-loading-observe.py` (0600). Both browser and Playwright manager closed through their APIs.
- Response HTML was parsed into script attribute names, safe type values, and app asset path only. Beacon token/content/attribute values were not persisted. DOM readings and CDP `DOMDebugger.getEventListeners` supplied handler evidence without monkeypatching app/event APIs.
- Public response contains classic `/assets/login.41044030db3c1b94.js` with `defer`, followed by the beacon script with `type="module"`, `src`, `integrity`, `data-cf-beacon`, `crossorigin`; no `async` or `defer` attribute on beacon. A module's `.defer === false` does not imply synchronous parser blocking: its normal execution is deferred unless async.
- Existing deployed bundle is present locally, SHA-256 `41044030db3c1b949ae9b1bf838f2bdb6ef85ba79ec48a27a8382493f875bf5c`. It immediately invokes mountLogin and has a submit listener; it has no DOMContentLoaded/load readiness gate.
- Source match: `signal-server/scripts/build-web-client.js:185` produces a single classic deferred login bundle; `web-client/js/login.js:58` mounts the form; line 84 attaches submit; final branch immediately invokes mountLogin. No login code change is indicated by the beacon finding.

All timings below are milliseconds from navigation start, except the listener bound spans two polling observations. CDP and runtime evaluation are sequential, so the bound is observational, not an exact registration timestamp.

| Boundary | Fresh observation |
|---|---:|
| Main document response end | 4026.1 |
| Connection duration (includes TLS) | 2663.0 |
| TLS duration (subset of connection) | 2649.1 |
| Main request-to-first-byte | 1347.0 |
| Login JS response end | 4825.0 |
| Last same-origin stylesheet response end | 5080.8 |
| DOM interactive | 5097.2 |
| Submit listener last observed absent | 5014.9 |
| Submit listener first observed present; login functions exist | 5124.4 |
| Beacon resource response end | 7589.2 |
| DOMContentLoaded end | 7593.9 |
| Load end | 7594.0 |

From 5124.4 ms onward there was one form submit listener and both login functions while the document remained `interactive`; `complete` was first sampled at 7648.7 ms. At least 2469.5 ms separated the first positive listener observation and DCL. This directly rejects the claim that the beacon forced the login handler to wait until DCL on this load. It does not prove successful authentication, paint visibility, user-input responsiveness, or an end-to-end login time; none was exercised.

Beacon resource total duration was 3490.2 ms, start 4099.0 / end 7589.2. Its DNS/connect/TLS/TTFB/body/protocol breakdown is unavailable and remains null because cross-origin detailed timings are hidden (no usable Timing-Allow-Origin exposure), not proven zero. Zero transfer size also cannot establish a cache hit or zero payload across this boundary. Beacon module completion followed by DCL within ~4.7 ms, its parser-inserted module semantics, and already-present earlier login listener explain DCL/load delay without substituting correlation for login readiness.

## Prior evidence correction and cold/warm distinction

- `entry-timing-20261017a.json` contains invalid cross-origin zero/derived phase timings; its `formal-warm` visit used a new page/context and must not be called a warmed same-context visit.
- `entry-timing-20261017b.json` fixes TTFB/body nulls, identifies beacon, and uses an actual same-context reload: fresh formal load 8083.8 ms, beacon total 4956.9 ms, DCL 8079.0 ms; reload load 868.3 ms, zero new TLS, cached assets, main TTFB 854.3 ms. Its cross-origin DNS/connect zeros should also be treated as unavailable rather than measured zero. Only the navigation and same-origin detailed timings support phase attribution.
- The local-root 150 ms result is an origin-local baseline, not a public-route browser connection baseline. New Chromium/context means fresh browser state; OS DNS, edge caches, network/proxy routing, and external service caches may already be warm.
- The 2.2–2.7 second browser TLS observations and roughly 0.8–1.35 second public document TTFB are specific to this machine's Chromium route. They do not establish the user's device/network delay, Cloudflare-wide behavior, or origin compute latency. TTFB includes network/edge/tunnel/origin transit and cannot identify the slow component alone.
- These few visits do not establish a P95 or a trend. Do not combine initial and warmed observations into a performance acceptance result.

## Actionable options, not performed

1. Correct reporting now: record login-handler readiness separately from DOM interactive, DCL, and load; retain fresh-browser versus same-context reload labels and cross-origin nulls. Current login initialization bound is ~5.01–5.12 seconds on this route, not 7.59 seconds. Future instrumentation should mark actual mount completion, with successful auth measured as a separate phase. This task changed no source.
2. If the objective is reducing DCL/load and eliminating this third-party dependency, disable Cloudflare Web Analytics injection for this hostname in the edge configuration (or, if the managed injection mechanism supports it, use an asynchronously executed module/script). Verify resulting served HTML and separately repeat readiness/DCL measurements. This requires explicit external-configuration authorization; no edge setting was accessed or changed. It is not evidence that login initialization itself will improve by 2.47 seconds.
3. If the objective is faster usable login, prioritize the observed first-party path: characterize the exact Chromium network/proxy/TLS route and compare a real target-device fresh navigation. On this observation, HTML arrives at ~4.03 seconds and small same-origin stylesheets add ~1.05 seconds before parser completion/login initialization. The stylesheets precede a classic inline build-info script in HTML, so stylesheet availability is consistent with the parser/initialization boundary. A reviewed implementation could inline a minimal login style subset and its tokens, and preserve the immediate login mount; expected benefit is bounded to first-party resource waits and needs measurement. Do not attribute all TLS/TTFB to a source-code defect.
4. Avoid a speculative local index/login fix to remove or race an edge-injected module. The beacon is absent from repository login HTML/build output; current deferred login mount already runs before beacon finishes. Any retained analytics approach should be verified at the served page boundary.

Operational decision: preserve services and all tunnels. No runtime restart or tunnel operation is needed to validate this finding. Authentication and actual user-visible readiness remain untested; the evidence establishes handler initialization before the late analytics/DCL/load boundary.


## Follow-up proxy-route boundary

Read-only system settings show HTTP/HTTPS/SOCKS enabled on loopback port 7897, with proxy environment variables also present. A fresh default-browser root navigation returned HTTP 200 with Playwright server address classified loopback (DCL 6.639s, TLS 2.104s, TTFB 1.012s). A separate disposable browser launched with --no-proxy-server also reported loopback (HTTP 200, DCL 8.051s, TLS 3.773s, TTFB 1.090s). Thus the latter did NOT establish an independent direct connection and cannot be used as a proxy-versus-direct result or a reason to change routing. Only the disposable test browser flags differed; no system/application/tunnel configuration changed, no login or Viewer was created. Evidence is private browser-route-ab-20261017a.json and readonly-proxy-route-20261017a.json under the rollout directory.
