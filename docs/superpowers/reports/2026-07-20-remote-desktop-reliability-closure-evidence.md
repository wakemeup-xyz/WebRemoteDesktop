# Remote Desktop Reliability Closure Evidence

Date: 2026-07-20
Branch: `worktree-reliability-closure-p1`
Review baseline (previous anchor): `4faf27148f73aa6d0980a201e0005a0fa964c602`
Latest automated commit on this remediation branch: `c6fad985417834fceddcfe511b41f26cd63c533a`
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

Result: **253 pass / 0 fail**

### Viewer / scripts matrix

```bash
node --test web-client/js/*.test.js scripts/*.test.js
```

Result: **315 pass / 0 fail**

### Python matrix

```bash
PYTHONPATH=python-host python3 -m pytest -q \
  python-host \
  scripts/test_wrd_entry_health.py \
  skills/webremote-service/scripts/wrd_service_test.py
```

Result: **142 passed / 0 fail** (1 deprecation warning from mss)

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
| Media-activity lease + attempt binding | automated-closed | offer carries `connectionAttemptId`; Signal/Host reject wrong attempt; generation restarts per attempt |
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
| trycloudflare safe URL media | **BLOCKED** | policy: do not rebuild tunnel; URL health may be invalid |
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
