# Remote Desktop Reliability Closure Evidence

Date: 2026-07-20
Branch: `main`
Review baseline (previous anchor): `ff1b9a2b9f5a1db4f7c1e2142c56bca262ea750f`
Latest automated commit on this remediation branch / reviewed-up-to: `6241965adbb280702b779046db5ec0c2568d18af`
UTC timestamp: 2026-07-19T21:30:00Z (approx; docs write-up)

Spec: `docs/superpowers/specs/2026-07-20-remote-desktop-reliability-closure-design.md`
Plan: `docs/superpowers/plans/2026-07-20-remote-desktop-reliability-closure-plan.md`

## Remediation commits (post-review P1/P2)

1. `272a805` fix(control): keep disconnects behind reset barrier
2. `f469673` fix(media): bind activity to connection attempt
3. `afc7a79` fix(viewer): require fresh resume frames
4. `dfc8dc9` feat(tunnel): acknowledge applied media control
5. `a134d30` fix(host): fail closed on media apply errors
6. `9b1aa7d` test(ops): restore launchctl regression coverage
7. `c6fad98` docs(remote): reconcile reliability closure status

Earlier reliability-closure implementation history remains on `main` (reset barrier, port search gate, media suspension scaffolding, tunnel viewport, etc.).

## Automated gates (this remediation)

### Signal server

```bash
cd signal-server && npm test
```

Result: **257 pass / 0 fail**

### Viewer / scripts matrix

```bash
node --test web-client/js/*.test.js scripts/*.test.js
```

Result: **333 pass / 0 fail**

### Python matrix

```bash
PYTHONPATH=python-host python3 -m pytest -q \
  python-host \
  scripts/test_wrd_entry_health.py \
  skills/webremote-service/scripts/wrd_service_test.py
```

Result: **143 passed / 0 fail** (1 deprecation warning from mss)

### Diff hygiene

```bash
git diff --check
```

Result: clean

## Automated closure status (recalibrated)

| Item | Status | Notes |
|------|--------|-------|
| ACTIVE controller disconnect reset barrier | automated-closed | disconnect → reset-only `REVOKING`; no FREE window; formal `dispatchLeaseEffect` only |
| Reset barrier fail-closed (reject/timeout) | automated-closed | `failTransition` keeps REVOKING; only matching applied reset-only → FREE |
| Bounded reset retry 1s/2s/4s | automated-closed | same-epoch, single timer, `reset-blocked` after 3 |
| Port search ACTIVE lease gate | automated-closed | read-only is strict no-op; control-lost cancels search |
| Media-activity lease + attempt binding | automated-closed | offer / `connection-attempt-bind` + monotonic `connectionAttemptSequence`; Signal/Host reject wrong attempt; generation restarts per attempt |
| Tunnel connectionAttempt authority bind | automated-closed | no synthetic offer; A→B rebind; applied:false keeps binding B; late A cannot clear B; takeover/disconnect/old socket cannot rebind |
| Host fresh-capture false fail-closed | automated-closed | `wait_for_fresh_capture()` False → applied:false + suspended; no host_media_resumed / success keyframe path |
| Viewer bounded retry / dual-ack | automated-closed | one replay + one refresh; dual-routed Host ack applied once; stale attempt frame cannot unlock |
| Host capture/sender/relay fail-closed apply | automated-closed | input/sender/capture/relay aggregated; failure → `applied:false` + safe suspended |
| Viewer fresh-frame resume gate | automated-closed | baseline framesDecoded / video-callback seq; no cumulative `>0` unlock |
| Tunnel Host applied media control | automated-closed | no Viewer synthetic applied; Host `relay-stream-control-ack` after producer suspend/resume |
| Tunnel viewport stability | automated-closed | CSS contain box; geometry test with 960/640/480 |
| host-launchctl fixture | automated-closed | copies `lib-turn-env.sh` into temp fixture |

## Runtime acceptance (recalibrated)

Previous Task 9 rows that claimed:

- reset barrier automated-closed **for disconnect FREE window** (was still open on review)
- media resume **P95≈333ms** via synthetic `noteMediaRenderedFrame`
- formal tunnel suspend/resume **PASS** without Host applied ack
- Terminal full matrix **PASS**

are **withdrawn** as over-claims. Honest status after this remediation:

| Gate | Status | Evidence / reason |
|------|--------|-------------------|
| Dual Viewer single writer | **NOT RUN** (this session) | prior browser-protocol sample exists; not re-executed here |
| Dual Viewer: disconnect B blocked until reset ack | **automated-closed** / runtime **NOT RUN** | unit+signaling cover FREE window closed; live dual-viewer still open |
| Dual Viewer: old Socket/DataChannel writes fail | **automated-closed** / runtime **NOT RUN** | Signal rejects unauthorized/disconnected writes; Host binding rejects stale lease |
| WebRTC selected candidate / first non-black frame | **NOT RUN** | requires live Host+viewer |
| WebRTC suspend 15s captureSeq/RTP payload | **NOT RUN** | prior payload-stop sample used browser-protocol; not re-run after fail-closed changes |
| WebRTC resume 20× **real** fresh rendered frame P95 ≤1500ms | **NOT RUN** | acceptance scripts no longer synthesize frames; must re-measure |
| Tunnel Host applied ack live | **NOT RUN** | automated Host/Signal/Viewer coverage only |
| Tunnel suspend 15s capture/JPEG/relay = 0 | **NOT RUN** | Host unit/relay unit cover producer stop; live 15s open |
| Tunnel resume 20× real fresh relay frame P95 ≤2500ms | **NOT RUN** | must re-measure with Host ack + real frame |
| Keyboard K-01–K-13 ordinary Chrome product matrix | **PARTIAL / NOT RUN** | protocol subset only historically; physical not claimed |
| physical-keyboard | **NOT RUN** | requires user physical presses |
| os-reserved | **NOT RUN** | OS/browser intercept possible |
| Mouse double-click Host open/select visual | **NOT RUN** | protocol only previously |
| Mouse drag release / blur / takeover pressed=0 | **NOT RUN** | not re-executed |
| Terminal admin password / Enter / Ctrl-C / alt-screen / resize / pause coexistence | **NOT RUN / PARTIAL** | do not claim full product PASS without re-run |
| trycloudflare safe URL media | **NOT RUN / BLOCKED** | policy: do not rebuild tunnel; this session did not revalidate safe URL |
| formal fixed-domain health | **NOT RUN** this session | previous `/health` ok sample not revalidated here |

Labels used: **automated-closed**, **runtime PASS**, **PARTIAL**, **BLOCKED**, **NOT RUN**.

## Constraints preserved

- No Cloudflare tunnel rebuild/restart/rotation by this work
- No `scripts/stop-safe-wrd.sh`
- No force push
- No commit of passwords, tokens, `.env`, logs, URL files, screenshots, or Playwright traces
- No wholesale merge/cherry-pick of old media-suspension branch
- Playwright synthetic input is never labeled physical/OS PASS

## Log safety check

New control/media events remain bounded: epoch, attempt id shape, generation, enum reasons only. No lease tokens, SDP, candidate addresses, key values, or image payloads in structured events.


## Review remediation commits (2026-07-21, main)

1. `be7e6a4` fix(signal): bind tunnel attempts with monotonic sequence
2. `0f7ef3b` fix(host): fail closed on fresh-capture false
3. `061e970` fix(viewer): bound media retries and dual-ack de-dupe
4. `c1d3e13` test(ops): harden reliability acceptance gates
5. `2ba9825` docs(remote): document attempt sequence contract
6. `3f8179a` docs(remote): pin evidence SHAs after remediation
7. `6241965` docs(remote): set reviewed-up-to evidence anchor

## Review remediation (2026-07-21)

Closed remaining attempt-authority and fail-closed gaps from the post-`ff1b9a2` review:

1. Explicit tunnel `connection-attempt-bind` with monotonic sequence/epoch.
2. Split attempt binding from generation progress (`applied:false` no longer deletes authority).
3. Host treats `wait_for_fresh_capture()` non-True as capture failure.
4. Viewer dual-ack / timer / stale-frame hardening.
5. Acceptance script keeps strict tunnel conditions (exact active + Host applied ack + fresh relay frame + 20 samples + P95≤2500ms + dual-viewer ordering + PointerEvent path).

Runtime dual-viewer / non-black first frame / FPS-jitter / physical keyboard / Terminal alt-screen / live P95 remain **NOT RUN** unless re-executed with live services. No synthetic PASS.


## Runtime acceptance re-run (2026-07-21)

Services: local `signal-server` + Host restarted; **Cloudflare tunnel not rebuilt**.

Entry status:

- local `http://127.0.0.1:8080/health` + `hostOnline:true` → ok
- formal `https://link.stockhub.wiki` TLS cert subject mismatch on strict curl; with `-k` `/health` returns ok. Acceptance formal-entry page path remains **BLOCKED** for product TLS/entry.
- safe quick tunnel URL deliverable (`/tmp/wrd-safe-current-url.txt`) but media gate left **NOT RUN** (debug-only, not rebuilt)

Command:

```bash
python3 scripts/runtime_reliability_acceptance_final.py
```

Report: `/tmp/wrd-acceptance/task9-final-report.json` (timestamp `2026-07-20T17:24:27Z`)

| Gate | Status | Notes |
|------|--------|-------|
| 9B resume 20× P95 | **PASS** | p95=422ms ≤1500ms, 20/20 |
| 9B suspend 15s payload stop | **PASS** | byte_delta=0 |
| 9C keyboard browser-protocol subset | **PASS** | not physical/OS-reserved |
| 9B mouse PointerEvent path | **FAIL** | only up/move observed; `setPointerCapture` not captured under inactive input gate (protocol harness) |
| 9D dual Viewer ordered single writer | **PASS** | revoke then B takeover; single_writer true |
| 9D tunnel media 20× Host ack+fresh frame | **PASS** | count_ok=20/20, p95=319ms ≤2500ms |
| 9C physical keyboard | **NOT RUN** | needs user presses |
| 9C os-reserved | **NOT RUN** | OS/browser intercept |
| 9A reset-blocked fault injection | **NOT RUN** | no safe fault hook |
| 9D trycloudflare safe URL media | **NOT RUN** | debug tunnel policy; not rebuilt |
| 9D formal fixed-domain product entry | **BLOCKED** | cert subject mismatch / formal login page not accepted as product delivery in this harness |

Follow-up fix validated in the same session:

- automatic `requestControl` no longer takeovers an existing ACTIVE controller (`allowTakeover:false` on auto recovery paths). Without this, dual-viewer tunnel mode switch was revoked by observer recovery and tunnel media control could not send.

Still not claimed: non-black first frame product visual, FPS/jitter product SLO, physical keyboard, Terminal alt-screen matrix, Host-side mouse open/select visual, formal-domain TLS product PASS.
