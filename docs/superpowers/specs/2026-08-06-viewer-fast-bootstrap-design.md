# Viewer Fast Bootstrap Design

Date: 2026-08-06
Status: Reviewed design; implementation plan complete

## 1. Goal

Make the formal Viewer entry at `https://link.stockhub.wiki` reliably interactive within a few seconds, and make every slower startup stage explicit, bounded, observable, and recoverable. A slow static asset, bootstrap request, Cloudflare connector, or media path must never leave visible controls inert for tens of seconds.

This design preserves the current product flow:

1. The user logs in.
2. The Viewer shell opens.
3. The user clicks `开始学习助手`.
4. The Viewer establishes signaling and then media.

The design changes how that flow is delivered and coordinated, not the user's network-mode choice or the existing WebRTC/Input/Terminal contracts.

## 2. Confirmed Performance Budget

All public-entry targets are measured with a fresh browser context and reported as nearest-rank P95 over at least 20 runs. Local targets are guardrails, not substitutes for public proof.

| Stage | Formal public entry target | Local target | Hard behavior |
|---|---:|---:|---|
| HTML response | P95 <= 2s | P95 <= 200ms | Acceptance reports entry failure; application timing begins only after HTML arrives |
| Core interactive | cold P95 <= 5s; warm P95 <= 2s | P95 <= 1s | Start control always acknowledges a click immediately |
| Click to signaling connected | P95 <= 3s | P95 <= 1s | Bootstrap wait is bounded; no silent wait beyond 5s |
| Click to first stable non-black frame | P95 <= 8s | P95 <= 3s | At 8s, leave connecting state and show a retryable failure/recommendation |
| First Terminal open | P95 <= 5s after Terminal click | P95 <= 2s | Desktop remains usable if Terminal assets fail |

`Core interactive` means the desktop start control and all shell-level controls have registered behavior. Controls that require a live desktop may remain disabled, but their disabled state and reason must be truthful. A rendered button with no handler is a failure.

No individual bootstrap dependency may silently block for more than 5 seconds. Retry loops are allowed only after the UI has entered a visible retryable state; they must not extend one apparent attempt into a tens-of-seconds wait.

## 3. Current Failure and Root Cause

### 3.1 Confirmed failure boundary

The 2026-08-06 incident spent roughly 51 seconds before the Host saw the Viewer online. Once the Host received the offer, WebRTC reached `connected` in about 1.35 seconds and stable video followed within several seconds. The primary delay was therefore in Viewer delivery/bootstrap before signaling, not Host startup, capture, H.264 encode, or ICE completion.

### 3.2 Code amplifiers

The current page amplifies public-path jitter:

1. `viewer.html` loads three parser-blocking third-party CDN assets in `<head>`.
2. It then loads about twenty classic scripts as separate requests.
3. Signal Server applies `no-store, no-cache` to every static file, including immutable JavaScript and CSS.
4. `DOMContentLoaded` starts `/api/webrtc-config`, and `WebRTC.init()` starts it again before creating signaling.
5. The config fetch has no abort deadline.
6. The page has no canonical bootstrap state. HTML visibility, handler readiness, auth verification, config readiness, signaling, and first frame are inferred in different modules.
7. Existing diagnostics begin too late and can upload zero console lines, so the stalled resource or stage is not preserved.

### 3.3 Runtime amplifiers

The fixed-domain connector has recorded QUIC idle timeouts, full connector churn, and canceled asset streams. A legacy token-based `cloudflared` process also remains present alongside the credentials-file named connector. These facts are not permission to restart or rotate a tunnel, but they must be represented in the operational design.

The current safe quick tunnel is a debug-only path and is not part of the formal-entry performance SLO.

## 4. Constraints and Non-Goals

### 4.1 Constraints

1. `https://link.stockhub.wiki` remains the formal public entry.
2. `http://127.0.0.1:8080` remains the local entry; port `5173` is not a production dependency.
3. The Viewer remains browser-only and keeps Vanilla JavaScript behavior.
4. Existing Socket.IO, WebRTC, TURN selection, tunnel relay, control lease, media suspension, and Terminal protocols remain compatible.
5. The user keeps the explicit `开始学习助手` action; this design does not auto-connect media on page load.
6. Local service restarts must preserve quick tunnel state. Tunnel mutation requires separate explicit user authorization.
7. Runtime evidence must distinguish local health, formal public entry, browser bootstrap, signaling, and media acceptance.

### 4.2 Non-goals

1. No SPA framework migration.
2. No Service Worker or offline application shell in this phase.
3. No WebRTC protocol rewrite or automatic network-mode switching.
4. No change to media quality, encoder, input protocol, or Terminal PTY semantics.
5. No automatic stopping, restarting, rotating, or credential migration of `cloudflared`.
6. No attempt to make an unavailable Cloudflare edge appear healthy through unlimited retries.

## 5. Options Considered

### Option A: Header and script-tag patch

Add `defer`, relax cache headers, and add fetch timeouts while keeping all current files independently loaded.

Advantages:

- Smallest code change.
- No build step.

Rejected as the final design because request count, third-party CDN dependency, duplicated config loading, and scattered startup truth remain. It improves the median but does not reliably bound cold P95 on an unstable tunnel.

### Option B: Build-time asset convergence plus runtime bootstrap coordinator

Use esbuild during service startup/deployment to produce content-hashed desktop and Terminal assets. Load one critical desktop bundle, lazy-load Terminal, add one authenticated Viewer bootstrap endpoint, and coordinate all startup stages through one frontend module.

Advantages:

- Removes external runtime CDN dependencies.
- Reduces critical request count.
- Enables immutable caching without serving stale HTML.
- Gives callers one startup interface and one failure model.
- Preserves the current application and protocol architecture.

This is the selected option.

### Option C: SPA and Service Worker rewrite

Move Viewer to a framework, precache an offline shell, and redesign routing/state around it.

Rejected because it expands migration and cache-invalidation risk without being necessary to meet the agreed SLOs. A Service Worker would also introduce another persistent cache truth while the current deployment still needs basic asset and connector hygiene.

## 6. Architecture

```text
source files + local vendor packages
             |
             v
      WebAssetBuilder
      - canonical asset graph
      - esbuild transform/minify
      - content hashes
      - generated viewer.html + manifest
             |
             v
  Signal Server WebAssetDelivery
  - HTML: revalidate
  - hashed assets: immutable
  - startup manifest validation
             |
             v
      tiny inline ShellGuard
      - click acknowledgement
      - core-load deadline
      - performance marks
             |
             v
     desktop-core.<hash>.js
     - ViewerBootstrap coordinator
     - desktop/WebRTC/input/UI/diagnostic code
     - TerminalLoader only
             |
             +---------- first Terminal click ----------+
             |                                           v
             |                               terminal.<hash>.js/css
             v
   GET /api/viewer-bootstrap
   - token verification
   - Host/capability snapshot
   - selected WebRTC/TURN config
             |
             v
     explicit startup state machine
             |
             v
       Socket.IO -> WebRTC -> first frame
```

The architecture introduces four deep modules and one operational contract:

1. `WebAssetBuilder`: build inputs in, validated manifest and hashed assets out.
2. `WebAssetDelivery`: request path in, correct file and cache policy out.
3. `ViewerBootstrap`: token/config loading and bounded fallback behind one interface.
4. `TerminalLoader`: one lazy-load interface that isolates optional Terminal failures.
5. `FormalTunnelPreflight`: read-only ownership and transport facts before any separately authorized connector change.

## 7. WebAssetBuilder

### 7.1 Canonical asset graph

Create `signal-server/scripts/web-asset-graph.js` as the only ordered source list:

```javascript
module.exports = Object.freeze({
  desktopScripts: [
    'js/runtime-config.js',
    'js/auth.js',
    'js/webrtc-stats.js',
    'js/link-quality-controller.js',
    'js/media-activity-controller.js',
    'js/media-activity-lifecycle.js',
    'js/media-activity-runtime.js',
    'js/stun-port-search-controller.js',
    'js/turn-selftest.js',
    'js/bootstrap-controller.js',
    'js/terminal-loader.js',
    'js/webrtc.js',
    'js/input-geometry.js',
    'js/keyboard-transport.js',
    'js/remote-keyboard-controller.js',
    'js/input.js',
    'js/ui.js',
    'js/latency-monitor.js',
    'js/diagnostic.js',
  ],
  terminalScripts: [
    'js/terminal-echo-controller.js',
    'js/terminal-composer.js',
    'js/terminal.js',
  ],
});
```

The list is an implementation detail of the builder, not a second runtime loader. Source order remains explicit while callers only consume the generated bundle names.

### 7.2 Build outputs

`signal-server/scripts/build-web-client.js` must:

1. Read the canonical graph.
2. Read Socket.IO browser client from the installed `socket.io` package.
3. Read xterm and addon-fit from pinned local npm dependencies.
4. Concatenate compatible classic sources by bundle and run esbuild transform/minification.
5. Produce content-hashed files under ignored `web-client/dist/assets/`.
6. Produce hashed Viewer CSS and lazy Terminal CSS.
7. Generate `web-client/dist/viewer.html` with only first-party hashed references and a bounded inline `ShellGuard`.
8. Copy the login shell and required non-Viewer static files.
9. Write `web-client/dist/asset-manifest.json` atomically after all assets exist.
10. Preserve third-party license notices.

The build must be deterministic: identical source and dependency bytes produce identical filenames and manifest content. Temporary files are removed on failure. A failed build must not replace a previously complete manifest.

The executable `node server.js` path runs the build before opening port 8080. This is required because repository LaunchAgent, safe-start, fixed-domain, and service-helper paths invoke `server.js` directly and would bypass an npm-only `prestart` hook. `npm run build:web` remains available for CI and explicit verification. A failed build exits before the server listens. Generated `dist/` remains ignored; source and build logic are versioned.

The repository currently ignores every `package-lock.json`. This implementation adds a narrow `.gitignore` exception for `signal-server/package-lock.json` and versions that lockfile. The build is not considered deterministic if esbuild/xterm versions are specified only by semver ranges.

### 7.3 Bundle split

Critical navigation loads:

- one Viewer CSS asset;
- one desktop-core JavaScript asset containing the local Socket.IO browser client;
- HTML.

Terminal JavaScript, xterm, addon-fit, and xterm CSS are absent from the critical path. They load only on first Terminal activation.

The build does not create one bundle per source file. That would retain the existing request amplification.

## 8. WebAssetDelivery

Create `signal-server/lib/web-assets.js` with a small interface:

```javascript
loadWebAssetManifest({ distDir }) -> manifest
cachePolicyForAsset(pathname, manifest) -> headerValue
createWebAssetMiddleware({ distDir, manifest, express }) -> middleware
```

Rules:

1. `index.html`, `viewer.html`, and manifest responses use `Cache-Control: no-cache, max-age=0, must-revalidate` and retain ETag/Last-Modified validation.
2. Manifest-listed content-hashed JS/CSS use `Cache-Control: public, max-age=31536000, immutable`.
3. Unknown or non-hashed files never receive immutable caching.
4. API and auth responses remain `no-store` where appropriate; static middleware must not impose cache policy on `/api`.
5. Signal Server fails fast at startup if the manifest is missing, malformed, references absent files, or points outside `distDir`.
6. The middleware must not accept a user-controlled filesystem path.

This module replaces the current blanket static `no-store` callback. Cache classification is tested through the same interface production uses.

## 9. ShellGuard and Immediate Interaction

Generated `viewer.html` contains an inline, dependency-free `ShellGuard` small enough to be parsed with the HTML. It owns only the pre-core interval.

Interface:

```javascript
window.__WRD_SHELL__ = {
  mark(name, detail),
  acknowledgeStartClick(),
  installCore(startHandler),
  failCore(reason),
  snapshot(),
};
```

Behavior:

1. Before desktop-core loads, clicking Start immediately changes the loading state to `正在加载必要资源…`; it never does nothing.
2. Controls that require core logic start with a real `disabled` attribute.
3. When desktop-core calls `installCore`, ShellGuard transfers any queued Start intent exactly once, enables shell-safe controls, and records `core-interactive`.
4. At 5 seconds without core ownership, ShellGuard shows `页面资源加载超时` with a retry action. It does not auto-loop forever.
5. ShellGuard contains no auth token, endpoint configuration, WebRTC logic, or Terminal logic.

The desktop bundle remains the truth source after takeover. ShellGuard is a temporary adapter, not a parallel state machine.

## 10. Viewer Bootstrap Contract

### 10.1 Backend endpoint

Add authenticated `GET /api/viewer-bootstrap`.

Response shape:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-06T00:00:00.000Z",
  "host": {
    "online": true,
    "capabilities": {
      "turnReady": true,
      "turnFingerprint": "...",
      "turnServerId": "aliyun",
      "supportsSessionTurn": true,
      "supportsMultiTurn": true,
      "turnServerIds": ["aliyun"]
    }
  },
  "webrtc": {
    "stunUrls": ["stun:..."],
    "turnConfigured": true,
    "turnStatus": "configured",
    "turnSource": "json",
    "turnFingerprint": "...",
    "turnUrls": ["turn:..."],
    "turnServers": [],
    "selectedTurnServerId": "aliyun",
    "defaultTurnServerId": "aliyun",
    "iceServers": [],
    "mediaModes": {},
    "publicEntry": {}
  }
}
```

The existing `/api/webrtc-config` remains as a compatibility endpoint for manual TURN refresh and older Viewer artifacts. Both endpoints use one backend builder function, `buildViewerBootstrapSnapshot()`, so TURN and Host capability mapping are not duplicated.

The endpoint performs no external network probe. It reads in-process configuration and current Host capability truth, so normal origin processing should remain below 50ms P95.

### 10.2 Frontend module

Create `web-client/js/bootstrap-controller.js`:

```javascript
createViewerBootstrap({
  fetchSnapshot,
  timeoutMs,
  fallbackFactory,
  now,
  setTimer,
  clearTimer,
}) -> {
  load(options),
  retry(options),
  getSnapshot(),
  subscribe(listener),
}
```

States:

- `idle`
- `loading`
- `ready`
- `degraded`
- `auth-required`
- `failed`

Invariants:

1. Only one request is in flight for the same selected TURN server.
2. Page warmup and Start click share the same promise; Start never creates a duplicate fetch.
3. `AbortController` ends the request at 3 seconds by default; the total visible bootstrap stage cannot exceed 5 seconds.
4. HTTP 401/403 enters `auth-required` and redirects through the existing logout path. It never falls back to anonymous signaling.
5. Network/5xx/timeout in `auto`, `lan`, or `stun` produces a built-in STUN degraded snapshot and continues signaling.
6. `tunnel` may continue without WebRTC configuration because its media adapter uses the authenticated Socket.IO path.
7. `relay` cannot invent TURN credentials. It enters a visible retryable failure until a valid snapshot is loaded or the user manually chooses another mode.
8. Late results from an aborted or superseded load cannot overwrite the current snapshot.

### 10.3 WebRTC integration

Change `WebRTC.init()` to accept the resolved bootstrap snapshot:

```javascript
WebRTC.init({ bootstrapSnapshot, trigger: 'start-button' })
```

It must not call `loadServerConfig()` internally. It begins the connection attempt and creates signaling immediately from the supplied ready/degraded snapshot.

Manual TURN node selection and TURN self-test may force a new bounded config refresh, but they call the same `ViewerBootstrap` interface. The old direct fetch code becomes a compatibility adapter and is removed once all callers use the coordinator.

## 11. TerminalLoader

Create `web-client/js/terminal-loader.js`:

```javascript
createTerminalLoader({ assets, document, timeoutMs }) -> {
  load(),
  getState(),
  retry(),
}
```

States are `idle`, `loading`, `ready`, and `failed`.

Rules:

1. First Terminal click starts one JavaScript and one CSS load.
2. Concurrent clicks share one promise.
3. A 5-second load deadline produces a visible Terminal-only retry state; it does not block or disconnect Desktop.
4. Successful load calls idempotent `TerminalPanel.init()` and activates Terminal.
5. Returning to Desktop never waits for Terminal assets.
6. xterm and addon-fit are installed npm dependencies pinned by `package-lock.json`; no runtime jsDelivr dependency remains.

## 12. Startup State and UI Contract

The canonical user-visible sequence is:

```text
shell-loading
  -> core-ready
  -> bootstrap-loading
  -> ready | degraded | auth-required | failed
  -> signaling
  -> media-connecting
  -> first-frame
  -> active
```

The status text and control enablement derive from this sequence. Individual modules do not independently decide that the page is “ready”.

Required behavior:

1. Every Start click produces visible acknowledgement within one task turn (target <= 100ms).
2. A second Start click during the same attempt does not create duplicate Socket.IO or PeerConnection instances.
3. Failure states retain working Diagnostics, Network Mode, and Retry controls.
4. Disconnect cancels bootstrap/signaling/media timers belonging to the current attempt.
5. A later success cannot revive a superseded or manually disconnected attempt.
6. Existing connection-attempt IDs remain the authority for media and input readiness.

## 13. Observability

### 13.1 Browser timing model

Record monotonic marks for:

- `html-shell`
- `core-requested`
- `core-interactive`
- `bootstrap-start`
- `bootstrap-ready|degraded|failed`
- `start-click`
- `signal-connected`
- `offer-sent`
- `pc-connected`
- `first-frame`
- `active`
- `terminal-load-start|ready|failed`

Diagnostics include bounded durations and at most the ten slowest same-origin resource paths. Query strings, auth headers, credentials, TURN passwords, and full external URLs are excluded.

Expose a read-only runtime snapshot at `window.__WRD_STARTUP_SNAPSHOT__` for acceptance tooling. Product logic must not read it back as a truth source.

### 13.2 Backend timing

Record bounded structured events for `/api/viewer-bootstrap`:

- response status class;
- server processing milliseconds;
- selected TURN server ID;
- Host online boolean;
- no credentials or token material.

### 13.3 Immutable acceptance evidence

Create `scripts/viewer_bootstrap_acceptance.py` to write timestamped JSON under `artifacts/viewer-bootstrap/`, a mutable `latest.json` pointer, and SHA-256. Generated evidence remains ignored unless a later task explicitly promotes a report into `docs/superpowers/reports/`.

## 14. Formal Tunnel Hardening

Frontend changes remove request amplification but cannot make an unstable connector healthy. The formal tunnel gets a separate, explicit operational contract.

### 14.1 Read-only preflight

Add `scripts/fixed-tunnel-preflight.sh` that reports, without mutation:

- local `8080` health;
- credentials-file configuration present;
- named-tunnel process count;
- token-in-argv presence without printing the token;
- configured protocol;
- recent fixed-domain timeout/reconnect counts;
- formal `/health` timing.

Multiple formal named-tunnel owners or any token-based formal connector make the preflight non-deliverable and produce remediation instructions. The script must never call `kill`, `pkill`, `launchctl remove`, or a tunnel start command.

### 14.2 Managed connector policy

The desired steady state is one credentials-file named-tunnel owner managed by the repository LaunchAgent. Because current logs show repeated UDP/QUIC reachability failures, the repository-managed fixed-domain command defaults to `--protocol http2`, configurable only through `WRD_FIXED_TUNNEL_PROTOCOL=http2|quic`.

Changing the running connector remains an operational migration requiring explicit user authorization. Implementation may prepare scripts, tests, and runbook steps but must not stop the existing token process or restart the formal tunnel automatically.

Quick tunnel behavior and `/tmp/wrd-safe-current-url.txt` remain untouched.

## 15. Failure Matrix

| Failure | Required result |
|---|---|
| desktop-core asset slow | ShellGuard acknowledges click and reports core timeout at 5s |
| desktop-core 404/corrupt | Retryable page-load failure; no inert controls |
| Viewer bootstrap timeout in auto/stun/lan | Continue with degraded built-in STUN and visible warning |
| Viewer bootstrap timeout in relay | Stay retryable; never invent TURN credentials or silently switch mode |
| auth expired | Clear session token and redirect to login |
| Host offline | Shell remains interactive; Start reports Host offline and retry remains available |
| Socket.IO unavailable | Fail current attempt within the connection budget; controls remain responsive |
| WebRTC first frame absent at 8s | End connecting state; show network-mode/diagnostic/retry actions |
| Terminal asset failure | Desktop unaffected; Terminal shows isolated retry |
| stale bootstrap response | Ignore by request generation |
| duplicate Start clicks | One bootstrap, one signaling socket, one connection attempt |
| formal connector ownership conflict | Read-only preflight fails; no automatic process mutation |

## 16. Security and Compatibility

1. Bundled static assets contain no runtime secrets.
2. `asset-manifest.json` contains filenames and hashes only.
3. TURN credentials remain inside authenticated bootstrap/config responses and are never cached publicly.
4. Generated HTML does not inline tokens or server configuration.
5. Content hashes prevent stale asset mixing across deployments.
6. Existing `/api/webrtc-config` and classic source files remain during migration; production HTML no longer references the classic list.
7. Existing `viewer.html` element IDs and public behavior remain compatible with current tests until tests move to the generated shell fixture.
8. Third-party versions and licenses are pinned and recorded.
9. `signal-server/package-lock.json` is the dependency-resolution truth for the build and runtime packages.

## 17. Testing Strategy

### 17.1 Builder tests

- deterministic manifest and filenames;
- asset changes produce a new hash;
- unchanged input produces identical output;
- no `cdn.jsdelivr.net` or `cdn.socket.io` references;
- critical request graph contains only HTML, one CSS, and one JS;
- missing source/vendor file fails atomically;
- Terminal bundle is absent from generated critical HTML;
- license output exists.

### 17.2 Delivery tests

- HTML revalidation headers;
- immutable hashed-asset headers;
- unknown asset does not receive immutable cache;
- manifest traversal/missing-file rejection;
- API responses do not inherit static caching.

### 17.3 Bootstrap tests

- single-flight warmup plus click;
- 3-second abort and mode-specific fallback;
- auth failure never falls back;
- relay timeout remains blocked and retryable;
- stale request generation ignored;
- duplicate Start does not create duplicate signaling;
- disconnect cancels attempt timers;
- first-frame watchdog exits connecting at 8 seconds.

### 17.4 Terminal tests

- first click lazy-loads once;
- load success initializes once;
- load failure is Terminal-only;
- retry succeeds;
- Desktop remains usable throughout.

### 17.5 Browser acceptance

Run local and formal-entry matrices with fresh contexts:

1. 20 cold starts.
2. 20 warm reloads.
3. 20 Start-to-signal and Start-to-first-frame samples.
4. Artificial 10-second bootstrap delay: UI must degrade/fail by 5 seconds.
5. Block former CDN domains: Viewer must remain functional and make zero requests to them.
6. Delay or abort Terminal assets: Desktop must remain active.
7. Double-click Start rapidly: one current attempt only.
8. Verify a non-black canvas sample and final state `active`, not `connecting` or `resuming`.
9. Verify static asset cache headers and warm transfer sizes.

Public acceptance is not replaced by green unit tests or local timing.

## 18. Rollout and Rollback

### Phase 1: Build and delivery

Introduce deterministic bundles and header policy while preserving the existing runtime behavior inside the desktop bundle. Validate generated HTML and tests before changing the production static root.

### Phase 2: Bootstrap coordinator

Introduce `/api/viewer-bootstrap`, single-flight loading, deadlines, degraded modes, and ShellGuard takeover. Remove duplicate page-load/init config fetches.

### Phase 3: Lazy Terminal and observability

Move xterm/Terminal off the critical path, add startup timing snapshots, and add acceptance tooling.

### Phase 4: Formal tunnel preparation

Add read-only preflight, repository-managed HTTP/2 default, and runbook migration. Do not change the live connector without explicit authorization.

### Phase 5: Runtime acceptance

After the user manually restarts local services, run local acceptance. After separately authorized formal tunnel migration, run formal 20-run cold/warm/media acceptance. Archive evidence and compare against all SLOs.

Rollback is one code deployment: restore the previous static root and server routes. Content-hashed assets can remain on disk because no HTML references them. Tunnel rollback is separate and follows the authorized operational runbook; it is never coupled to application rollback.

## 19. Definition of Done

Implementation is complete only when all are true:

1. Generated Viewer HTML makes no runtime request to jsDelivr or cdn.socket.io.
2. Critical Viewer delivery is HTML plus no more than one critical CSS and one critical JS asset.
3. Hashed assets are immutable-cacheable; HTML revalidates; authenticated bootstrap data is not publicly cached.
4. Start has immediate acknowledgement before core readiness and one canonical handler after takeover.
5. Warmup and Start share one bounded bootstrap request.
6. No bootstrap dependency can silently keep the page in one apparent attempt beyond 5 seconds.
7. Mode-specific degraded behavior follows Section 10.2 and never weakens authentication or TURN policy.
8. Terminal/xterm are lazy and cannot block Desktop readiness.
9. Browser diagnostics expose complete startup stages and bounded slow-resource evidence.
10. Formal-tunnel preflight detects token and multiple-owner hazards without mutation.
11. Local and formal-entry acceptance artifacts are immutable and include final `active` plus a non-black frame.
12. Formal cold P95 core interactive <= 5s, click-to-signal <= 3s, and click-to-stable-frame <= 8s over at least 20 runs.
13. Existing WebRTC, input, media suspension, TURN selection, tunnel relay, Terminal, and service-control regression suites pass.
14. README, safe-startup runbook, and the active requirement document match the implemented behavior and operational authorization boundary.

## 20. Design Review

### Completeness

The design covers the full observed path: source assets, build, static delivery, browser handler readiness, authenticated bootstrap, signaling/media transition, optional Terminal loading, observability, formal connector facts, rollout, and runtime proof.

### Architecture

Each new rule has one truth source:

- asset membership/order: `web-asset-graph.js`;
- emitted filenames: generated manifest;
- static cache policy: `web-assets.js`;
- Viewer bootstrap state: `bootstrap-controller.js`;
- optional Terminal loading: `terminal-loader.js`;
- connection/media truth: existing connection-attempt and WebRTC modules;
- formal connector eligibility: read-only preflight plus runbook authorization.

ShellGuard is intentionally a temporary adapter and cannot become a second bootstrap implementation. `/api/webrtc-config` is an explicit compatibility endpoint backed by the same snapshot builder.

### Ambiguity and scope

The agreed phrase “a few seconds” is replaced by objective local/public P95 targets and hard stage behavior. The design does not claim that application code can eliminate all Cloudflare latency; it reduces request amplification, bounds waits, and makes connector migration a separately authorized operation.

There are no placeholders or deferred requirements in the implementation scope.
