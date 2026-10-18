# Guarded ordinary recovery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Root dispatches a fresh implementer for every source task, grants sole-writer ownership only of its listed paths, then obtains independent spec-compliance and quality reviews before the next task. Workers may not spawn subagents. Root alone performs live operations and explicitly scoped ephemeral-loopback API tests. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admit a disposable real ordinary Viewer only under a server-enforced vacant/human-first policy, qualify normal recovery and a fresh three-hour continuity run without business input.

**Architecture:** Narrow the existing initial ticket; keep ordinary resume and strict proof unchanged. A separate runner imports pure validation/sampling/lifecycle helpers and owns one disposable browser. Its separately reviewed browser-local adapter interrupts only that page's exact Socket.IO transport; server lifecycle evidence classifies recovery.

**Tech Stack:** Existing Node.js/Express/Socket.IO, browser JavaScript, Python 3.11 asyncio, installed Playwright 1.59.0.

**Spec:** `docs/superpowers/specs/2026-10-18-guarded-ordinary-recovery-design.md` (root copies the reviewed private draft to this repository path).

## Global constraints

- Preserve four pre-existing dirty docs, node_modules, primary checkout/index, W2 and tunnel/watch state. Root controls one source/index writer at a time through explicit owned-path handoff; root alone deploys. No root or other worker writes while that handoff is active.
- Finish separate Host reset-ACK, ordinary acquire-intent and watchdog ownership source/review gates first; do not mix that implementation into these files.
- No grace, lease, reset/rebind ACK, input/media deadline, network, codec, quality, resolution or replay policy changes. No proof conversion, replay, remint, ordinary fallback or artificial ACK.
- Strict `scripts/passive_session_soak.py`, `scripts/passive_session_sampler.js` and original SUP stay byte-unchanged. Import pure helpers; do not clone 1100 lines or introduce a general harness framework.
- Default TTL 30000 ms/max120000; map128/max256; consumed replay evidence never evicted. Guards cannot invalidate a pending human Start or a retained human owner.
- Row32768 bytes/run64MiB, summary/lifecycle32768 each, selected server events1024, log read65536 bytes/tick, line16384; unknown fields and coverage gaps fail closed.
- ManagerStart10 s, launch15 s, export1 s, browserClose5 s, managerStop3 s, totalCleanup8 s. No API return claimed as process exit.
- Runtime sequence is baseline300, within-grace (baseline300/fault/recovery<=60/stability30), after-grace (same, local block12), fresh continuity10800. Every run has one real UI Start; no automatic retry after terminal failure/human arrival.
- All businessInput/visibleEffect/physical remain NOT_RUN. No synthetic live human takeover.
- Source working directory: `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`.
- Node executable: `/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node`. Python executable: `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11`.
- Use direct scoped commands, not npm/pretest/broad tests/build/install. Root alone may run existing isolated loopback API tests after review; they are not production checks.

## Read-only prerequisite gate (outside SDD task numbering)

Read root's completed Host reset-ACK, ordinary after-grace acquire-intent and watchdog-own-handle source/review reports and the exact reviewed commit(s). Inspect `web-client/js/webrtc.js`, `web-client/js/input-signaling-continuity.test.js`, `web-client/js/webrtc.test.js` and `/tmp/wrd-ordinary-runtime-recovery-source-audit.md` only to reconcile those reports. Do not implement, alter fixtures, rerun tests or stage a fix under this gate.

- [ ] Record exact reviewed Host/P1/P2 commit(s) and root source gate report. Require evidence of actual ACTIVE/noncontroller disconnect -> after-grace/reset FREE -> welcome then FREE behavioral RED/GREEN, without fixture-forced FREE masking; same ordinary generation, one takeover:false acquire, no remint and existing input gates retained.
- [ ] Require recorded P2 real VM evidence: A timer retirement preserves started-at/pending budget; B connect-error rearms; queued old A cannot clear B timer, create a PC or replace B. Manual release/superseded/stale callbacks and retry budget remain guarded.
- [ ] If any prerequisite source/review is incomplete, report the exact missing artifact to root and stop dependent implementation. The preceding increment owns correction; this plan contains no duplicate correction task.

## SDD execution and review gates

Tasks1–6 are serial source tasks. Root dispatches a fresh implementer with only that task, approved spec/global constraints and predecessor interfaces; grants its listed source/test paths as exclusive ownership; prohibits subagents, primary writes, service/build/browser/network/proof/native work. Workers may run only assigned pure unit/VM tests. Root owns specified ephemeral-loopback API checks after worker handback. At task completion, return ownership and provide RED/GREEN commands/results, changed paths and self-review. Root dispatches independent spec-compliance and code-quality review, sends findings back to the original implementer under a new exclusive handoff, and obtains scoped re-review. Do not begin the next task while a required finding remains. After Task6, root dispatches the most capable available reviewer for the whole increment, records rulings/fixes and repeats the affected focused review. Root commits exact owned hunks; pre-existing dirty documentation is never swept into staging. The root-only rollout gate is operational work, not an implementer task.

## Fixed runtime evidence contracts

## Authorized origin selection

The runner consumes one root-verified origin and the manifest binds its normalized SHA256 plus `originSource`. For a quick-tunnel run, source is exactly `/tmp/wrd-safe-current-url.txt`; absence or stale/invalid URL means that quick origin is unavailable and never authorizes tunnel regeneration. For the already configured formal entry, source is the existing reviewed preserved fixed-domain configuration plus the user's authorized known origin, with root's fresh bounded entry verification recorded before manifest creation. Root identified `https://link.stockhub.wiki` as this formal origin; drafting did not independently browse it. A missing quick-URL file does not block that formal-origin path.

Manifest `originSource` is exactly quick-url-file or formal-configured; `originEvidenceSha256` is64 lowercase hex identifying root's corresponding source/entry verification record. Quick origin must equal the URL-file value; formal origin must equal the authorized configured origin and fresh verification. The runner compares CLI origin hash with the pinned manifest and does not discover, guess, redirect to another origin or write any URL file. Never create a fake quick URL, start/restart/rebuild tunnel or modify fixed-domain configuration to satisfy this plan.

## Pinned runtime manifest

Every run requires `--runtime-manifest /absolute/private/path.json` and `--runtime-manifest-sha256` containing exactly 64 lowercase hex characters. Root creates a fresh manifest for that run after checking the actual deployed component code/assets, current log file and that the reviewed public origin routes to this same local Signal8080/Host instance, then pins its exact UTF-8 bytes with SHA256. This is a private operational artifact, not a new server API or automatically inferred .env value. No ticket, token, password, session or raw input may appear. Current source `/api/status` has no loaded-code revision; the runner must label Host/Signal source evidence **root-attested**, not independently runtime-proved.

Schema is an exact-key object, with no extras at any level:

| Field | Exact type/constraint |
|---|---|
| `schemaVersion` | integer1, not bool |
| `runNonce` |32 lowercase hex; equality identity only, no authority |
| `createdAtEpochMs`, `validUntilEpochMs` |integers0..9999999999999; validUntil>created; validity interval<=43200000 ms |
| `scenario` |baseline / within-grace / after-grace / continuity; must equal CLI |
| `mode` |stun / relay / tunnel; must equal CLI |
| `originSource`, `originEvidenceSha256` |quick-url-file or formal-configured;64 lowercase hex source/verification record digest, under Authorized origin selection |
| `originSha256` |64 lowercase hex; SHA256 of normalized CLI origin UTF-8, excluding trailing slash; origin allows only scheme+authority with no credentials/query/fragment/path |
| `deploymentEvidence` |exact `{kind:'root-verified-local-deployment',sha256:<64 lowercase hex>}`; digest identifies root's already-reviewed deployment evidence, never a runner proof of code loading |
| `signal`, `host` |each exact `{sourceCommit:<40 lowercase hex>,sourceTreeSha256:<64 lowercase hex>}`; root records actual component deployment, not current documentation HEAD |
| `viewer` |exact `{sourceCommit:<40 lowercase hex>,buildId:<16 lowercase hex>}`; expected deployed asset build identity |
| `signalLog` |exact `{path:<absolute UTF-8 path1..512 bytes>,device:<integer0..2^53-1>,inode:<integer1..2^53-1>}`; regular current configured JSONL, identity must match opened file |

Before importing optional runtime packages or creating a browser, open manifest with no symlink following, require regular file, current UID, permissions0600, read at most16385 bytes and reject length>16384, decode strict UTF-8/JSON with duplicate-key rejection, validate exact keys/types/bounds, and compare SHA256 with CLI pin. Require `0 <= now-createdAtEpochMs <= 900000`, and validUntil at least requested scenario budget +120 seconds from now (baseline300, recovery390, continuity10800 seconds). Clock reversal, missing/stale/invalid manifest or pin mismatch stops before browser. Preserve errors as fixed codes only.

Pin the validated object in memory. Re-read and hash the bounded manifest immediately before fault and at final export; mutation, expiry, inode/path substitution or hash mismatch terminates qualification. Open the manifest-selected Signal log with regular-file/no-symlink checks and compare device/inode. Its existing configured permissions are retained; the0600 requirement applies to the new private manifest, not to the service log. Root does not change deployment during a run. Compare every sampled Viewer `buildId` exactly with manifest.viewer.buildId; absent/mismatch is terminal. The existing snapshot only proves loaded browser build; Host/Signal live source remains root-attested by the pinned deployment evidence, with the bounded Host-ID status/log producer below checking Host continuity separately. Any observed Host replacement or code/build change stops and preserves first failure.

Persist only manifest SHA256/runNonce, originSource/originEvidenceSha256, the three source commits, Viewer buildId and `sourceEvidence:'root-attested'`; never copy the manifest's log path or entire object into output. This preserves exact revision claims with honest evidence provenance. The report must not elevate root attestation to a direct remote source measurement.

## Bounded Host continuity observation

Use the existing fixed local `http://127.0.0.1:8080/api/status` response fields hostOnline and hostId as a private equality observation. The runner executes locally beside this configured Signal service; public Cloudflare latency is not added to every sampling tick. No new endpoint, admin login, server authority or diagnostic framework. `HostContinuityObserver` owns only the first validated raw Host ID (string1..128) in memory, a salted hash, count/last-tick and sticky coverage/alarm state. Never log or persist raw Host IDs or whole status bodies.

Open the pinned local Signal log cursor before the first Host status observation. Read local status after the final authenticated Viewer navigation but before Start, immediately before fault, on every one-second sampling tick throughout baseline/outage/recovery/stability/continuity, and once during final preclose export. At most one status request is outstanding; no backlog or catch-up burst. The production reader is `read_local_host_status()` using one owned `asyncio.open_connection("127.0.0.1",8080)` reader/writer, never a thread, executor, HTTP proxy, redirect, environment-derived host or arbitrary URL. Send only fixed GET /api/status HTTP/1.1 with Host:127.0.0.1:8080, Connection:close, Cache-Control:no-store and Accept:application/json; no credentials/cookies or body. Require HTTP200, JSON content type, identity/no content encoding, one valid Content-Length0..16384 and no Transfer-Encoding; reject redirects/chunked/duplicate length or unsupported framing instead of adding fallback. Headers total<=8192 bytes, <=32 headers, each line<=1024; JSON body<=16384, strict UTF-8 with required hostOnline/hostId types; discard all other response fields immediately. The current endpoint sends bounded JSON with Content-Length; unsupported framing is unavailable evidence, not permission to alter services.

Use `lifecycle_stage(read_local_host_status(),0.75,settlement=0.075)` for a750ms total request budget including cancellation/close. The reader owns writer from successful open through finally; always writer.close(), with wait_closed bounded by the same remaining deadline, and no detached close task. Noncooperative cancellation is an implementation gate failure with incomplete cleanup, never a completed observation. Inject `status_reader` in run() for pure fake tests; no default reader is invoked when injected. During a tick, start only this one status read and the existing one bounded page sample concurrently, own both tasks, and await both under the existing2-second sampling limit before any PASS decision. A pending request forbids launching another tick/read. Any failure cancels/settles owned work within the same deadlines; no status task survives teardown unreported. This is one small request function plus observer state, not a general HTTP framework.

A tick without a completed valid status, a missed tick or a late interval>1500ms permanently marks coverage incomplete and stops qualification. Final export retains its existing total1-second budget: status read and diagnostic export may run concurrently but both are owned within that one budget. Inability to complete either is incomplete, not an enlarged deadline. Public entry verification happens separately in root preflight, never in this one-second status loop.

At the first valid response require hostOnline===true and a nonempty bounded hostId. Every subsequent response must have the same ID and true online flag. Changed ID -> host-replaced; false online -> host-unavailable; invalid HTTP/schema/deadline -> host-observation-unavailable; missed/late tick -> host-observation-gap. For requested recovery, any such condition after fault forces INCOMPLETE even if owner/build/lease/fresh-media gates later become valid; before fault recovery is NOT_RUN. The run never retries admission or clears the sticky Host result.

Also select the existing structured event `signal_socket_disconnected` only when meta.role==='host' from the pinned current log interval. Map it to fixed `host-disconnected` event with viewerHash/sessionHash/leaseEpoch/state all null. Any such event, including a possibly stale Host socket, triggers a conservative sticky host-disconnect-observed terminal condition. A missing/malformed role on that event, truncation/rotation, byte/event cap or reader uncertainty prevents complete coverage. This closes the obvious observation gap while Viewer signaling is down; it does not infer Host identity from hostOnline alone. Cross-check status and log in the same tick before a recovery PASS decision, and drain pending log/status at final export before allowing PASS.

`hostObservation` exact keys are `{status,hostHash,coverage,samples,hostDisconnectObserved}`. status=not-started/stable/unavailable/changed; hostHash=null or16 lowercase hex using the run's private salt; coverage=not-started/complete/incomplete; samples integer0..12000; hostDisconnectObserved bool. A disconnect alarm uses status unavailable unless a changed ID was observed; changed dominates. Store this bounded projection in summary and every sample, no raw ID. Complete recovery requires stable+complete+false alarm plus all existing server and Viewer gates. A new fake status/log scenario must replace Host during the after-grace outage while preserving admission generation, build and final good media/control gates; the result must remain INCOMPLETE and cannot PASS. Same-ID final snapshot after an intervening Host-disconnect event must also remain INCOMPLETE.

## Browser-local fault adapter and scope of evidence

Use two explicit instrumentation paths. `fault.instrumentation` is exactly none / native-direct / playwright-routed. Baseline and fresh10800 continuity use none, no HTTP/WebSocket routes and no fault adapter; within-grace uses native-direct with no HTTP/WebSocket routes anywhere on its fresh browser/context/page; after-grace uses playwright-routed from before final navigation, so its entire300-second baseline, close and reconnect use routed signaling. Never carry a page/context between these scenarios.

Static installed Playwright1.59.0 source confirms `route_web_socket` installs `webSocketMockSource`, captures its original native constructor privately and replaces global WebSocket with a wrapper. Public wrapper close can supply synthetic clean-close metadata; message forwarding can alter timings. `instanceof globalThis.WebSocket` does not establish native identity under that API. Accept the supported routing behavior explicitly; do not access private `_ws` or other Playwright internals and do not introduce an unreviewed CDP alternative.

**Native-direct within grace:** before any application script in the newly owned route-free page, the adapter's init closure captures the original WebSocket constructor and its original prototype.close reference without replacing either. The application and unchanged passive sampler do not replace them. The closure exposes only a runner-owned one-shot trigger and fixed status snapshot, not a product method or grant. At trigger, require current ordinary owner/auth/socket/host/path/readiness; exact `WebRTC.socket.io.engine.transport.ws` object; transport websocket; original constructor and close still identical to the page globals; instance of the captured original constructor; OPEN state; exact expected origin/socket.io path. Then call the captured original close with that exact current object once, code1000 and fixed reason wrd-local-recovery-check. This provenance plus unchanged constructor/close is the direct native operation claim; global instanceof alone is never the claim. Constructor/prototype change or ambiguous target stops NOT_RUN before fault. All subsequent Manager retries remain the product's normal uninstrumented requests. No routes are installed to achieve within-grace timing; actual server evidence decides whether it landed within grace.

**Playwright-routed after grace:** capability-check Page.route, Page.route_web_socket, WebSocketRoute.connect_to_server/close before browser creation. Install supported routes before final Viewer navigation only on this owned page for exact origin `/socket.io/`, EIO4 and known websocket/polling transport with bounded standard parameters. Other requests pass untouched. Block service workers in the owned context. In the open phase use connect_to_server with automatic message forwarding and no on_message inspection/rewrite. At the end of the300-second routed baseline, arm a12-second local monotonic block and call public close once on the exact current engine transport.ws **wrapper**, after the same current owner/auth/path checks. Call it routed public close, not native close; do not inspect its private upstream. Future matching polling requests abort; future matching WebSocket routes close without upstream connection. Deadline does not extend on retries; at12 seconds normal future routes pass through and product Manager retries automatically. Maximum32 blocked attempts total; overflow fails the run, clears the block and records a fixed reason. No request is held asleep.

`BrowserLocalFault.install(page, origin, *, scenario)`, `trigger_once(page)` and `disarm()` are the adapter interfaces; scenario is within-grace/after-grace only and fixes instrumentation/blockSeconds respectively native-direct/0 and playwright-routed/12. Capability checks are scenario-specific: lack of route_web_socket does not block route-free within-grace or no-fault runs. Unknown/unsupported transport/origin or missing required APIs yields NOT_RUN without fallback. No Socket.IO Socket.disconnect/connect, Manager.close/open, Engine.close, product recovery call, admission request, timer/auth rewrite, global offline toggle or service/tunnel action.

Disarm first during cleanup. Native-direct disarm retires its one-shot closure; no routes exist to remove. Routed disarm clears blocking and leaves supported WebSocket routes forwarding until this owned context closes; the API does not promise a symmetric unroute for its installed wrapper. HTTP unroute uses only the adapter's exact matcher/handler. In-flight handlers remain bounded/owned; failure or incomplete settlement prevents PASS. Close only the owned browser. Native-direct clean close and routed synthetic clean-close metadata both remain intentional stimuli and **neither reproduces natural WS1006**.

`qualificationEvidenceScope` is a mandatory fixed field in summary, ordinaryRecovery and every sample wrapper: native-passive-continuity / ordinary-functional-native-direct-close / ordinary-functional-playwright-routed-stimulus, selected respectively by baseline/continuity, within-grace, after-grace and immutable from preflight. An after-grace PASS qualifies real ordinary server/application admission, reset/regrant and fresh-media readiness **under the routed stimulus**; it does not qualify uninstrumented WebSocket performance, native after-grace network failure or natural1006 recovery. Persist `nativeAfterGraceQualification:'NOT_RUN'` for every scenario of this runner. A separately observed natural native after-grace event would require its own reviewed evidence record; this runner never silently promotes a routed PASS. Within-grace PASS covers ordinary recovery after the explicitly induced original-native close, not arbitrary natural outages. The clean no-route baseline/10800 continuity remains separate.

## Exact runner result and phase schemas

All new output objects reject extra keys. Existing private sampler fields and `ContinuitySummary.result` retain their existing schema and validators; the wrapper below does not widen them. New unknown exception strings are mapped to `internal-error`, never copied into evidence. Counts reject bool, NaN and infinity. `seconds` means a finite number0..12000; nullable values stay null until observed. Hashes are null or exactly16 lowercase hex. Epochs/counts are integer0..999999999, server timestamps integer0..9999999999999.

- `scenario`: baseline / within-grace / after-grace / continuity.
- `phase`: preflight / startup / baseline / fault / recovering / recovered-stability / continuity / terminal. Allowed nonterminal edges are preflight->startup; startup->baseline for baseline/recovery or startup->continuity for continuity; baseline->fault only for recovery; fault->recovering; recovering->recovered-stability. Every phase may transition to terminal, which has no outgoing edge. No phase restart or backward edge is allowed. Recovery phases are never used by baseline/continuity scenarios.
- `ordinaryRecovery.status`: NOT_RUN / INCOMPLETE / FAIL / PASS. No implicit RUNNING status: preliminary recovery output uses NOT_RUN before a confirmed trigger, INCOMPLETE afterward, reason run-in-progress.
- `ordinaryRecovery.classification`: not-attempted / unclassified / within-grace-rebind / after-grace-reset. Before confirmed fault trigger use not-attempted; thereafter unclassified until complete matched server event ordering determines the class. A wrong observed grace class is retained and fails the requested scenario; it is never relabeled.
- `ordinaryRecovery.serverCoverage`: not-started / complete / incomplete. Complete means the opened pinned log interval is contiguous and every required selected event was valid, not that unrelated historical logs were inspected.
- `ordinaryRecovery.reason`: none / scenario-not-requested / run-in-progress / runtime-manifest-unavailable / runtime-manifest-invalid / runtime-manifest-pin-mismatch / runtime-manifest-stale / runtime-manifest-changed / deployment-build-mismatch / runtime-dependency-unavailable / entry-unavailable / authentication-unavailable / authentication-changed / selector-invalid / proof-conflict / start-ui-unavailable / start-ui-deadline / start-ui-not-fresh / start-ui-state-changed / start-ui-click-unproven / admission-refused / extra-admission-request / extra-start / baseline-incomplete / baseline-failed / fault-capability-unavailable / fault-target-unavailable / fault-already-triggered / fault-handler-failed / fault-attempt-cap / fault-trigger-unconfirmed / server-log-unavailable / server-log-identity-changed / server-log-gap / server-log-schema / server-log-capacity / server-clock-regression / sampling-gap / schema-rejected / ordinary-owner-changed / human-priority / host-unavailable / host-replaced / host-observation-unavailable / host-observation-gap / host-disconnect-observed / rebind-rejected / rebind-timeout / reset-unconfirmed / recovery-deadline / wrong-grace-class / recovery-gates-unmet / recovered-stability-incomplete / cancelled / cleanup-incomplete / evidence-write-failed / evidence-budget-exceeded / cancellation-noncooperative / internal-error.

`ordinaryRecovery` has exactly these keys: `status`, `classification`, `requestedScenario` (scenario enum), `qualificationEvidenceScope` (fixed scenario mapping above), `recoverySeconds` (seconds|null, Python monotonic from confirmed fault trigger to first complete recovered gate), `recoveredStableSeconds` (seconds, initially0), `serverCoverage`, `reason`. PASS requires reason none, requested matching class, complete server coverage, recoverySeconds nonnull<=60, recoveredStableSeconds>=30 and complete lifecycle cleanup plus stable complete Host observation without disconnect alarm. Scope must match instrumentation; routed evidence never becomes native qualification. Baseline/continuity always have recovery NOT_RUN/not-attempted/scenario-not-requested; they can still exit0 when their own continuity target and cleanup pass. For a requested recovery scenario, pre-trigger startup/capability failure is NOT_RUN with its fixed reason. A no-fault scenario retains scenario-not-requested in ordinaryRecovery and records any run failure in the top-level failure object. Post-trigger observation/identity/human-priority/cancellation/cleanup gap is INCOMPLETE. FAIL requires a known unmet product gate or wrong requested class with sufficient observation; a timeout with incomplete required evidence remains INCOMPLETE rather than inventing failure causality. `reason` stores the first terminal reason and cannot be replaced by later cleanup failure; lifecycle separately records cleanup faults and downgrades PASS to INCOMPLETE. If cleanup is the first failure after a provisional PASS, set reason cleanup-incomplete; otherwise preserve the earlier terminal reason.

`summary.json` exact keys: `schemaVersion`=1, `scenario`, `mode`, `phase`, `qualificationEvidenceScope`, `nativeAfterGraceQualification`='NOT_RUN', `hostObservation`, `continuity` (unchanged imported result, reset for the selected no-fault target only), `ordinaryRecovery`, `failure` (null or exact first-failure record below), `startup` (null or exact verified record below), `manifest` (null or exact projection below), `lifecycle` (exact projection below), `fault` (exact snapshot below), `businessInput`='NOT_RUN', `visibleEffect`='NOT_RUN', `physical`='NOT_RUN'. Continuity for a triggered recovery is finalized interrupted and never starts a new PASS continuity epoch inside the same run.

- `failure`: null until a failure, otherwise exact `{phase,reason}` using the phase enum and finite reason enum above; reason cannot be none/scenario-not-requested/run-in-progress. Preserve the first failure; later cleanup failure remains in lifecycle. A preflight manifest error can create this bounded result with manifest=null before optional runtime imports; if output creation itself fails, return nonzero without claiming evidence was written.
- `startup`: exact `{status:'verified',freshPage:true,authVerified:true,selector:'vacant-only-v1',startClickMarksBefore:0,startClickMarksAfter:1,guardedApiRequests:1}`; otherwise null.
- `manifest`: exact `{sha256,runNonce,originSource,originEvidenceSha256,signalSourceCommit,hostSourceCommit,viewerSourceCommit,viewerBuildId,sourceEvidence:'root-attested'}` with manifest bounds above.
- `lifecycle`: exact `{captureStatus,cleanupStatus,writeStatus,ownedProcessExitEvidence:'not-observed'}`. captureStatus=not-started/ok/unavailable/timeout/error/cancelled/schema-rejected/noncooperative. cleanupStatus=not-started/running/api-finished-exit-unknown/incomplete. writeStatus=ok/error.
- `fault`: exact `{capability,status,instrumentation,triggerCount,blockedHttp,blockedWebSocket,blockSeconds}`. instrumentation=none/native-direct/playwright-routed with the immutable scenario mapping specified above. capability=not-checked/available/unavailable; status=not-requested/ready/triggered/disarmed/failed; triggerCount integer0..1; blockedHttp and blockedWebSocket each0..32 with combined count<=32; blockSeconds exactly0 or12. Unknown capability forbids trigger.
- `lifecycle.json`: exact `{schemaVersion:1,diagnostics:<existing validated diagnostic>,python:<existing fixed Python lifecycle record>,captureStatus,writeStatus,ownedProcessExitEvidence:'not-observed'}`. Reuse old helper's Python record keys/status bounds without adding arbitrary stage/error dictionaries; initialize browserClose not-created and all other stages not-started. Add no process-exit assertion.
- Selected server event row: exactly `{n,event,serverTimestampMs,viewerHash,sessionHash,leaseEpoch,state}`. n integer1..1024; event=grace-started/grace-expired/rebind-confirmed/rebind-failed/reset-completed/host-disconnected; serverTimestampMs integer0..9999999999999; viewerHash/sessionHash null or16 lowercase hex; leaseEpoch null or integer0..999999999; state=FREE/GRANTING/ACTIVE/REVOKING/null. Identity object is exactly `{sessionHash,socketHash,admissionHash}` with the same hash bounds. Unknown extra fields reject.
- `ServerRecoveryEvidence.snapshot()`: exact `{status,selectedEvents,lastSequence,coverage}`; status=not-started/reading/closed/failed; coverage=not-started/complete/incomplete; lastSequence0..1024; selectedEvents is at most1024 validated rows with exactly the fields already specified in Server evidence and privacy.
- New sample wrapper exact keys: `schemaVersion:1`, `scenario`, `elapsedSeconds`, `phase`, `qualificationEvidenceScope`, `hostObservation`, `sample` (existing validated/private sampler row or null on missing observation), `identity` (exact sessionHash/socketHash/admissionHash), `serverEvents` (at most1024 selected rows subject to row32768 cap). A missing sample does not gain fake metric zeroes; it terminates qualification as sampling-gap. Drain only new selected events into each sample so prior events are not copied every tick.

The finite reason enum is shared by spec, implementation and table-driven tests. Do not invent additional statuses/reasons in a task; a justified schema change requires root's recorded spec ruling and review. All summaries/lifecycle records remain <=32768 bytes and total output<=64MiB.

## Task 1: Server guarded tickets, retained human owner and races

**Files:** Modify `signal-server/lib/viewer-admission.js`, `signal-server/routes/auth.js`, `signal-server/websocket/runtime-context.js`, `signal-server/websocket/signaling.js`. Create `signal-server/lib/viewer-admission.test.js`. Extend `signal-server/test/viewer-admission-api.test.js`, `signal-server/websocket/runtime-context.test.js`, `signal-server/websocket/viewer-admission.integration.test.js` and `signal-server/test/proof-admission.test.js` only as needed for explicit interleavings.

**Interfaces:**

```js
// All values are server-owned snapshots, never request bodies.
runtime.viewerAdmissionContext() // { viewerEpoch, occupied, relayOccupied, hostOnline }
issue(subject, session, { initialPolicy = null, context = null } = {})
admit({ subject, session, admission, occupied = false,
        sameSessionOccupancy = false, initialContext = null })
// issue -> {ticket,expiresAt} | {error: fixed enum}; admit existing shape unchanged.
// owner gains initialPolicy:null|'vacant-only-v1'; ticket gains that plus viewerEpoch.
```

- [ ] Add behavioral RED pure-unit tests proving guard issue does not change human sequence or replace a retained human owner. Tests must demonstrate behavior, not merely assert new fields.

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createViewerAdmission } = require('./viewer-admission');
const vacant = { viewerEpoch: 0, occupied: false, relayOccupied: false, hostOnline: true };
const guarded = context => ({ initialPolicy: 'vacant-only-v1', context });
test('pending human Start survives a rejected guard', () => {
  const a = createViewerAdmission();
  const human = a.issue('subject', 'session-human');
  assert.equal(a.issue('subject', 'session-guard', guarded(vacant)).error, 'human-intent-pending');
  assert.equal(a.admit({subject:'subject',session:'session-human',
    admission:{mode:'explicit',ticket:human.ticket}}).ok, true);
});
test('human owner survives vacancy and all ticket expiry', () => {
  let now = 0;
  const a = createViewerAdmission({now:()=>now});
  const human = a.issue('subject', 'session-human');
  const accepted = a.admit({subject:'subject',session:'session-human',
    admission:{mode:'explicit',ticket:human.ticket}});
  now = 120001;
  assert.equal(a.issue('subject','session-guard',guarded(vacant)).error,'human-owner-retained');
  assert.equal(a.admit({subject:'subject',session:'session-human',
    admission:{mode:'resume',generation:accepted.generation}}).ok,true);
});
```

- [ ] Run `node --test signal-server/lib/viewer-admission.test.js` with the absolute Node executable. Record the failing assertions before implementation.
- [ ] Implement exact enum/context validation and a bounded live-record scan. Capture time once. Reject pinned owner when `owner && owner.initialPolicy !== 'vacant-only-v1'`; guard rejection does not mutate owner/tickets/fence. Guard issue records current sequence and server epoch. Guard consume requires exact context, no pinned human owner and no pending human intent before existing commit.

```js
const isLive = (record, at) => record.expiresAt > at;
const isPendingHuman = (record, at) => isLive(record, at) && !record.consumed && record.initialPolicy === null;
const isRevocableGuard = (record, at) => isLive(record, at) && !record.consumed
  && record.initialPolicy === 'vacant-only-v1';
// Human request is validated before capacity and mutation.
const effectiveHumanSize = [...tickets.values()].filter(r => isLive(r, at) && !isRevocableGuard(r, at)).length;
// If effectiveHumanSize >= capacity, return existing admission-capacity unchanged.
// On success only: prune expired + unconsumed guards, ++sequence, insert human record.
```

Consumed branches execute current-owner equality before initial guard checks; they retain the recorded policy. Human and legacy acceptance explicitly set owner.initialPolicy null. `noteProofAdmission` still clears owner/tickets and increments sequence. Do not add owner persistence.
- [ ] Add runtime snapshot and route own-property validation. `Object.prototype.hasOwnProperty.call(req.body || {}, 'initialPolicy')` distinguishes absent from null. Map invalid policy/session to400, capacity429, known guarded availability/priority errors409, unavailable context503; auth remains401/403. Request body never supplies context. Signaling passes `initialContext: instanceRuntime.viewerAdmissionContext()` at current admission call, before noteHumanViewerAdmission/map mutation.
- [ ] Complete the matrix as named tests: human intent before issue; human later issue then expiry; two guards race; current epoch changes then vacancy; occupied/grace at issue/consume; Host/relay change; pinned human after grace/TTL; prior guarded owner after grace/TTL; current consumed lost-welcome retry; stale consumed retry after newer human; same-session new generation; capacity full of pending guards allows human; capacity consumed records denies without eviction; subject/session confusion; legacy retained owner; proof-first/guard-first; rejected guard preserves outstanding proof. For actual handler rejection reuse `expectRejectedWithoutMutation` and extend it to assert a previously issued proof remains valid.
- [ ] Add guard-owned version of existing current-owner within/after-grace integration scenario: create guarded initial ticket with fresh server context, consume normally, disconnect, then resume returned generation. Reuse existing real handlers and fake Host ACK injection only in offline fixtures. Verify late old rebind ACK/current Host change cannot grant; expired/reset flow waits applied ACK. Do not add fake ACK to runtime tools.
- [ ] Run pure scoped unit/runtime/handler tests. Root separately runs existing `signal-server/test/viewer-admission-api.test.js` and `signal-server/test/proof-admission.test.js` under their owned ephemeral loopback servers. Record source-only results separately from production.
- [ ] Review exactly these diffs, then root commits `feat(admission): add human-first vacant ordinary admission`. Do not stage dirty docs.

## Task 2: Viewer exact selector and auth/start race guards

**Files:** Modify `web-client/js/webrtc.js`; extend `web-client/js/auth-start-integration.test.js` and relevant existing admission/recovery assertions in `web-client/js/input-recovery.test.js`.

**Interfaces:** `WebRTC.readInitialAdmissionPolicy() -> null | 'vacant-only-v1'` throws fixed `invalid-initial-policy` for malformed selector; `requestExplicitViewerAdmission(episode)` keeps signature. No other product public method.

- [ ] Add RED tests that run real extracted/VM product methods with fixture location, Auth and fetch. Assert unknown/duplicate selector does not call fetch or io; proof+guard does not call either; absent selector retains exactly current request body; correct selector adds exactly initialPolicy; automatic socket reconnect does not request an initial ticket.

```js
readInitialAdmissionPolicy() {
  const values = new URLSearchParams(window.location.search).getAll('wrdAdmission');
  if (values.length === 0) return null;
  if (values.length !== 1 || values[0] !== 'vacant-only-v1') {
    throw Object.assign(new Error('桌面连接授权暂不可用，请手动重试'), {code:'invalid-initial-policy'});
  }
  return values[0];
}
```

- [ ] Run `node --test web-client/js/auth-start-integration.test.js` and record RED.
- [ ] At request entry parse policy, then proof marker; proof+policy rejects, proof-only preserves old branch. Include conditional body property via `...(initialPolicy ? { initialPolicy } : {})`. After awaited fetch check same policy, absence of newly appearing proof and existing token/auth generation/request sequence/start episode gates. Policy removal cannot produce a follow-up unrestricted request. Avoid logging URL or request body.
- [ ] Test response arrives after auth logout/login, episode cancelled, selector removed/changed, proof marker added, failed HTTP, request timeout, duplicate Start and normal welcome-to-resume update. Tests assert no late socket creation or overwriting newer `_viewerAdmission`, no automatic reclaim after denial, draft preserved.
- [ ] Run scoped Viewer tests and existing full input recovery suite. Inspect no changes to welcome auth generation/reconnect/reset/media input gates. Root commits `feat(viewer): select guarded initial admission explicitly`.

## Task 3: Minimal server lifecycle evidence and pure log projection

**Files:** Modify only the existing grace-expiry, confirmed-rebind and both failed-rebind observation sites in `signal-server/websocket/signaling.js`; extend `signal-server/websocket/viewer-admission.integration.test.js`. Create `scripts/ordinary_session_recovery.py` and `scripts/test_ordinary_session_recovery.py` initially with pure evidence classes.

**Interfaces:**

| Interface | Return and ownership |
|---|---|
| `ServerRecoveryEvidence(path, salt)` | One read-only regular file cursor and private hash salt; no I/O until start. |
| `.start()` | None; record inode/device/current end offset or raise fixed evidence error. |
| `.read_tick(identities)` | List of projected selected events; at most65536 bytes; identities private only. |
| `.snapshot()` | Fixed status, selectedEvents, lastSequence and coverage enum; no raw path/identity/error. |
| `.close()` | None; idempotent closure of its one file descriptor. |
| `HostContinuityObserver(salt)` | One private initial Host ID and sticky bounded coverage/alarm state; no raw identity persistence. |
| `.observe_status(value, tick_ms)` | Consume private validated hostOnline/hostId response; return fixed hostObservation projection. |
| `.observe_host_disconnect()` | Sticky conservative alarm; subsequent same ID cannot clear it. |
| `async read_local_host_status()` | Fixed local127.0.0.1:8080 asyncio HTTP read;750ms total,8192-byte headers/16384-byte body, one owned request, no proxy/redirect/threads. |
| `hash_identity(value, salt)` |16hex for string length1..128, otherwise None. |
| `validate_recovery_row(value)` | Validated same value or ValueError with fixed reason. |

The signatures above specify interfaces; implement bodies with the exact bounded behavior below, not pass-through dictionaries. `identities` is private in-memory current/previous socket and stable session; never serialize it.

- [ ] RED handler test fires the identity-checked 8000 ms timer, expects one `viewer_disconnect_grace_expired` with resulting leaseEpoch/state; stale timer emits none. Throwing logger leaves the same map/lease removal. Confirmed-rebind event must have current epoch only after applied ACK.
- [ ] Add try/catch observation **after** `removeDesktopViewer(socket,'viewer-disconnect-timeout')` returns. Snapshot lease and emit fixed expiry event with existing correlation. Add current epoch to existing rebind-confirmed event without changing ACK validation or operation order.
- [ ] At confirmed-rebind and both failed-rebind observations, pass the existing server-owned sessionId to the logger; assert the actual emitted browserSessionId in real-handler fixture tests. Match a not-yet-observed new socket only through the directly logged stable browserSessionId plus known previousViewerId. Keep the projected event schema unchanged and sessionHash derived from the direct server field. RED fixtures must cover server-before-browser ordering, all three rebind sites, foreign session, unknown previous socket, missing/malformed correlation and privacy. This correction changes observation only, never authority or ACK/timer ordering.
- [ ] Add RED Python tests for Host status/log producer: stable bounded ID, changed ID while offline, offline bool, invalid HTTP/JSON/body/header/framing/timeout, loopback-only target, redirect/proxy refusal, one-request/no-thread ownership, writer-close timeout/cancellation, sample+status concurrency/2-second outer bound, missed/late tick, role=host disconnect alarm even if final ID matches, and unchanged owner/build/final gates after a Host replacement. All change/gap cases remain terminal INCOMPLETE after fault; no raw-ID canary reaches artifacts.
- [ ] Add RED Python tests with temporary local fixture logs: start at EOF excludes historical records; exact matching identities only; reset-completed epoch bound to preceding expiry; duplicate/irrelevant event; malformed selected line; truncation/rotation; overlong line; event1025; byte overflow; unknown fields; credential/URL/ID canaries absent from output. Inject fixture salt and compare hashes deterministically.

```python
def hash_identity(value, salt):
    if not isinstance(value, str) or not 1 <= len(value) <= 128:
        return None
    return hashlib.sha256(salt + value.encode('utf-8')).hexdigest()[:16]
```

Use exact-key validation, event allowlist, bounds and fixed missing/overflow enums. No unbounded `read()`, no raw line accumulation. If partial line exceeds16384 or unread bytes exceed65536 per tick, fail coverage and close the reader; do not silently skip then claim complete. Selected events array stops at1024.
- [ ] Run `python3.11 -m unittest scripts.test_ordinary_session_recovery` and scoped Node handler tests. Root commits `test(recovery): observe exact server grace lifecycle`.

## Task 4: Separate guarded runner, state model and owned cleanup

**Files:** Modify the files created in Task3: `scripts/ordinary_session_recovery.py`, `scripts/test_ordinary_session_recovery.py`. Read/import only existing pure helper exports from `scripts/passive_session_soak.py`; no edits to it or sampler/SUP.

**Interfaces:**

| Interface | Return and ownership |
|---|---|
| `async start_guarded_via_ui(page, *, timeout_s=30, monotonic=time.monotonic, sleep=asyncio.sleep)` | Fixed verified startup record below; exactly one actual click. |
| `OwnedBrowserLifecycle(*, limits=None)` | Owns manager/playwright/browser/context/page and fixed lifecycle status records. |
| `async .start(manager_factory)` | The owned page, after manager start/launch/context/page success. |
| `async .cleanup(export)` | None; one deadline, disarm callback before export, independent browser/manager teardown. |
| `.snapshot()` | Fixed lifecycle record and API-exit-unknown status. |
| `OrdinaryRecoverySummary(scenario, mode)` | Bounded phase state, baseline/continuity reducers and one recovery record. |
| `.observe(row)` | None; consume one validated bounded row and update phase/gates. |
| `.result(*, cleanup_complete)` | Fixed summary containing separate continuity and ordinaryRecovery results. |
| `async run(args, *, manager_factory=None, status_reader=None, limits=None)` | Integer exit0 for selected baseline/continuity PASS or selected recovery PASS, plus successful cleanup; otherwise1. NOT_RUN recovery is expected in a successful no-fault scenario. |
| `read_runtime_manifest(path, expected_sha256, *, origin, scenario, mode, now_epoch_ms)` | Validated in-memory manifest using the exact contract above; fixed failure before optional runtime imports/browser. |

`start_guarded_via_ui` returns only `{status:'verified',freshPage:true,authVerified:true,selector:'vacant-only-v1',startClickMarksBefore:0,startClickMarksAfter:1,guardedApiRequests:1}`. Missing/extra marks or API requests fail. Observe request events without persisting request objects; no direct admission fetch.

- [ ] Add manifest RED tests: exact valid bytes, duplicate/extra keys, bool/infinite/wrong SHA, >16384 bytes, stale/expired/future time, CLI origin/mode/scenario mismatch, symlink/nonregular/wrong-owner/permissions, log identity mismatch, post-start manifest mutation, expected browser build mismatch, root-attestation label preserved.
- [ ] RED fake-page tests cover delayed core/auth, existing socket/PC/queued Start, wrong URL selector, auth changes during actionability await, query removed after verification, malformed proof, two API requests, two Start marks, unavailable UI, login navigation stripping query, and one allowed actual click. No fake product admission/connected events are injected by runner implementation.
- [ ] Validate/pin manifest before optional imports. Keep new module top-level imports stdlib plus passive_session_soak pure exports only. In run(), lazily import `dotenv_values` for actual runtime config; import `async_playwright` only if manager_factory is None. A supplied synchronous manager_factory is called inside the owned try/finally after initial evidence persistence. Match old helper: manager.start() else __aenter__(); returned playwright.chromium.launch(headless=True); new_context(service_workers="block") and new_page(); cleanup prefers returned playwright.stop(), then manager.stop(), then manager.__aexit__(None,None,None). Each start may be an awaitable; factory itself is synchronous, not awaited. Factory throws leave manager null; start failure after factory returns still attempts its stop/exit. Fake tests patch dotenv/import availability as the current pure tests do; no Playwright import is needed when injecting a fake manager. Runtime dependency absence maps to runtime-dependency-unavailable; no optional dependency import occurs at module import time.
- [ ] Implement the status producer at the specified pre-Start/pre-fault/one-second/final-export points and consume sticky Host-log alarms before every PASS decision. Do not add server API or optional fallback.
- [ ] Implement login using existing form selectors; wait normal viewer redirect, then navigate exact guarded Viewer URL. Install sampler only on final fresh page. Implement read-only startup projection that captures auth identity in page-local closure and returns equality boolean; root runner sees no token. Verify one shell/core, no preexisting session work, stable exact selector before click and response.
- [ ] Write lifecycle RED tests for factory construction/start/launch/context/page failure; export timeout; browserClose exception/noncooperation; managerStop attempted independently; repeated cancellation retains one deadline/cleanup task; initial/final write failure; zero process-exit inference. Use existing `lifecycle_stage` and `cleanup_allowance` rather than hand-written `wait_for` cleanup.

```python
# Teardown uses one coordinator and existing cancellation-settlement ownership.
coordinator = asyncio.create_task(lifecycle.cleanup(export))
while not coordinator.done():
    try:
        await asyncio.shield(coordinator)
    except asyncio.CancelledError:
        cancelled = True
# Persist fixed terminal evidence after the one coordinator finishes.
```

Implement caps from global constraints and reserve manager stop. If manager exists but start failed, attempt the existing manager stop/exit fallback. Never attach to shared CDP browser. Preserve preclose first terminal event if final export loses it. No raw exceptions in results.
- [ ] Implement only the exact phase/status/reason schemas in Fixed runtime evidence contracts, including preflight. Import unchanged ContinuitySummary for baseline/no-fault continuity. Recovery classifier requires server event order/current identity and gates; sampled continuing media alone is insufficient. Store separate continuity/recovery outcomes and all three NOT_RUN labels. Every unexpected auth/owner/build/Host/extra-Start/API change terminates without request or reclaim.
- [ ] Add RED classifier table: within success, expiry before rebind, rebind timeout/rejected/stale, after success, missing reset ACK, changed generation, mismatched reset epoch, wrong grace class, sampling loss, retained first-close, 30 s recovered stability incomplete, server clock jump (unknown timing), 60 s observation budget expiration, human supersession and cleanup failure. Demonstrate unchanged baseline/continuity rejects first disconnect/identity change.
- [ ] Projected current matched rebind failures use recovery-gates-unmet, because the fixed event schema omits the raw reason. Test raw timeout/rejected/cancelled inputs projecting to the same generic result, stale/foreign failures remaining unmatched, and incomplete server/Host/owner coverage yielding INCOMPLETE rather than known FAIL. Do not add a hidden reason API, infer missing cause, or expand the output schema.
- [ ] Run `python3.11 -m unittest scripts.test_ordinary_session_recovery scripts.test_passive_session_soak`; run no browser. Root verifies unchanged strict helper/sampler/SUP hashes and commits `test(recovery): add guarded ordinary session qualification`.

## Task 5: Separately reviewed native-direct and routed page-local stimuli

**Owned files:** Create `scripts/ordinary_recovery_fault.py`, `scripts/test_ordinary_recovery_fault.py`; modify `scripts/ordinary_session_recovery.py` only for adapter integration and fixed scope labels. No production method changes.

**Interfaces:** synchronous `BrowserLocalFault(*, scenario)` before browser creation, with scenario-specific public API capability validation after manifest validation; awaited `.install(page, origin, scenario=scenario)`, `.trigger_once(page)`, `.disarm()`; synchronous `.snapshot()`. Install must match the immutable constructor scenario. Scenario is within-grace/after-grace only, fixing native-direct/0 or playwright-routed/12. Missing module/capability yields fault-capability-unavailable/NOT_RUN before browser. Snapshot includes instrumentation and the exact fixed fields above. Baseline/continuity skip adapter import/construction and install no routes.

Read-only `failure_reason` is none initially, then sticky fault-attempt-cap or fault-handler-failed. It is directly owned private adapter evidence, with no snapshot/output expansion or inferred server cause. Caller finite-validates it (absent on existing test fakes defaults handler failure; malformed is schema-rejected), preserves the first reason and rejects failed adapter status at both ticks and final cleanup snapshot. Keep counters<=32 and failure sticky through disarm; cover late failure after browser close and earlier-failure preservation in pure tests.

- [ ] Record installed Playwright1.59.0 API and implementation facts from read-only source: routing replaces global WebSocket with a wrapper, its public close metadata may be synthetic, and forwarding affects stimulus timing. Required supported routing APIs are only a capability gate for after-grace. No private `_ws`/upstream access or CDP alternative.
- [ ] Write RED pure fake-page tests: baseline/continuity/within never call route or route_web_socket; within captures original constructor/prototype.close before app code and refuses changed references; current exact engine object only closes once via captured original close. Test wrong owner/auth/socket/path/transport/readyState and second trigger rejection without product-method invocation.
- [ ] Implement native-direct init closure: capture original constructor and prototype.close without replacing either; at trigger compare both still unchanged, require exact current object/expected path plus current owner/auth/gates, then invoke captured close.call(currentWs,1000,'wrd-local-recovery-check'). `instanceof` may validate against the captured original as one check but is never independent native provenance. Public trigger returns only fixed status. No HTTP/WebSocket routes exist on this fresh page/context/browser.
- [ ] Write RED fake-route tests for after-grace: exact owned origin/path/EIO4/transport predicate; open forwarding through supported connect_to_server without on_message; public current wrapper close explicitly labeled routed;12-second future-attempt block; no upstream for blocked WS; polling abort; combined32-attempt cap; monotonic deadline unchanged by retries; disarm and failure clear block. Test a wrapper that passes global instanceof but is not native: result must retain playwright-routed and cannot claim native-direct.
- [ ] Implement the supported routed branch under the complete Browser-local fault adapter contract above. Capture no Playwright-private native upstream. Apply routes before final navigation, so baseline and recovery share routed instrumentation. The independently owned fixed local status reader is unaffected by page Socket.IO routing and remains active during the block. Unknown alternate socket origin/transport fails closed.
- [ ] Integrate immutable qualificationEvidenceScope into summary, ordinaryRecovery and sample schemas, with nativeAfterGraceQualification NOT_RUN in the summary exactly as specified; test that after-grace PASS is ordinary-functional-playwright-routed-stimulus only, within-grace is ordinary-functional-native-direct-close, and both no-fault scenarios are native-passive-continuity. Any attempted promotion or instrumentation mismatch is schema-rejected, not silently normalized.
- [ ] Run only pure adapter/runner tests. Root separately reviews the fault capability, its narrowed evidence meaning and cleanup before committing `test(recovery): add explicit page-local recovery stimuli`. No live experiment is part of this source task.

## Task 6: Complete authority regression, docs and combined source gate

**Owned files:** Create `docs/superpowers/reports/2026-10-18-guarded-ordinary-recovery-review.md`; modify clean `docs/superpowers/specs/2026-10-17-viewer-admission-recovery-addendum.md`. The four pre-existing dirty documents, including requirements, remain byte-unchanged and unstaged in this increment. Record the new guarded contract in the clean C5 addendum, this spec and the review; no requirements patch is applied or staged. This root integration ruling avoids conflict with the eight preserved operational baseline exceptions. Root creates the later execution report during operations.

- [ ] Worker runs scoped pure admission/handler, auth-start/input-recovery and new runner/adapter tests. After handback root alone runs `signal-server/test/viewer-admission-api.test.js` and `signal-server/test/proof-admission.test.js` with their ephemeral-loopback servers; no worker network execution. Use the verified existing `signal-server/lib/desktop-control-lease.test.js`, `signal-server/lib/control-transition-retry.test.js`, `signal-server/websocket/viewer-admission.integration.test.js`, `web-client/js/input-signaling-continuity.test.js`, `web-client/js/input-recovery.test.js`, `web-client/js/input-backpressure.test.js`, `web-client/js/media-activity-runtime.test.js`, `web-client/js/media-activity-controller.test.js`, `web-client/js/media-activity-lifecycle.test.js` and `web-client/js/webrtc.test.js` to cover current Host/attempt/lease ACK fences, no pre-ACK grant, reset timeout/failure, media freshness/pause and no uncertain-input replay. Do not expand into unrelated suites without a new failure or review finding. Record exact paths and command exit/test counts in review, not only a claim of full tests.
- [ ] Run/review the guard-owned within/after-grace real-handler regression created in Task1. Do not modify its integration test or any product source under Task6; report a finding to root for an exclusive handback to the owning implementer.
- [ ] Root self-review spec coverage and independent review of source plus tool boundaries. Explicitly inspect human pinned owner, later human intent capacity, proof interleavings, zero side effects on guard reject, immutable consumed evidence and singleton ownership. Scan output schemas for raw IDs/tokens/input and root-level logs for accidental secrets.
- [ ] Commit reviewed spec/plan/review and the clean C5 addendum; do not stage any of the four pre-existing dirty documents. Source and docs commits are distinct from runtime qualification; retain old longA and all cleanup gaps.

## Root-only guarded combined rollout and actual acceptance (after SDD source gates)

**Root-owned files:** Create `docs/superpowers/reports/2026-10-18-guarded-ordinary-recovery-execution.md`; private per-run evidence directories, sanitized summaries only copied to tracked report area. No source changes during live acceptance.

- [ ] Read README, runbook and webremote-service skill before service commands. Confirm separately reviewed Host reset-ACK, ordinary acquire-intent and watchdog ownership code plus admission/Viewer commits, exact build/source manifest and unchanged tunnel process/current URL. Confirm current no Viewer/relay and Host online; do not clear owner or restart just to bypass a human. Required Signal code deployment naturally creates a new runtime, not a test escape hatch.
- [ ] Root uses existing guarded local promotion/restart procedure for combined Host/Signal/Viewer release and exact asset build; helper `python3 skills/webremote-service/scripts/wrd_service.py restart-local` is the allowed local management entry after preflight, never full-chain stop/start. Verify health, Host online, source/build and tunnel identity preserved. Report both runtime passwords privately; do not store them in versioned report.
- [ ] Establish configured structured log file exists and is current; if absent/unreadable do not induce a fault or change logging config silently. Record runtime capability check and exact Python/Playwright selected. Ordinary pinned human owner refusal means stop/yield, not server reset or proof workaround.
- [ ] Root selects the authorized origin under the fixed contract: quick URL only from `/tmp/wrd-safe-current-url.txt`, or the preserved configured formal origin with prior user authorization and fresh root verification. The current authorized formal origin is https://link.stockhub.wiki; absence of the quick URL file does not block it. Never fabricate that file or regenerate tunnel. Create the per-run manifest with matching originSource/originEvidenceSha256, then run one runner command per scenario with unique output dir. Command shape is fixed and draws secrets only from runtime config, never shell interpolation of credentials:

```bash
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 scripts/ordinary_session_recovery.py --origin "$wrd_current_origin" --mode relay --scenario baseline --runtime-config signal-server/.env --runtime-manifest "$wrd_pinned_runtime_manifest" --runtime-manifest-sha256 "$wrd_pinned_runtime_manifest_sha256" --output-dir "$wrd_new_output_dir"
```

`wrd_current_origin` is the exact verified formal configured origin or exact quick-URL-file value selected under the recorded originSource; `wrd_pinned_runtime_manifest` is a fresh root-created0600 manifest under the exact schema above, and `wrd_pinned_runtime_manifest_sha256` pins its bytes; `wrd_new_output_dir` is a fresh private path. Root verifies actual deployed source/assets and current log identity before creating that per-run manifest. The runner never derives revision claims from .env. They are operational values verified by root, not unresolved design decisions. Subsequent commands change only scenario to within-grace, after-grace, continuity and allocate a new output directory. No recursive retries or parallel sessions.
- [ ] Route-free baseline300 must pass with full cleanup before within-grace. Within-grace uses native-direct original close and no routes; after-grace includes its own routed300-second baseline and uses only12 s own-page future-attempt blocking. Each recovery must show requested server-observed class, unchanged admission owner, stable complete Host observation and complete reset/media gates. After-grace PASS is explicitly functional recovery under playwright-routed stimulus; nativeAfterGraceQualification stays NOT_RUN. Retain induced-close classification, never label prior natural WS1006 reproduced. Human supersession ends testing without reclaim.
- [ ] Fresh continuity10800 starts after all prior browser cleanup and with no fault routing. No concurrent heavy validation. A disconnect is incomplete/failed continuity even if ordinary recovery works; preserve samples and first-close diagnostics. Stop further automatic testing on failure and diagnose evidence.
- [ ] Final execution report distinguishes source tests, root-attested deployed source/assets, route-free baseline, native-direct within-grace recovery, playwright-routed after-grace functional recovery, native-after-grace NOT_RUN, fresh route-free10800 continuity, cleanup APIs versus actual process-exit evidence and businessInput/visibleEffect/physical NOT_RUN. Final local health and Host-online check required; no claim that passive acceptance establishes actual input delay or visible effect.

## Plan self-review

Spec coverage maps real recovery correction prerequisites to the read-only prerequisite gate; server/human/proof requirements to Task1; Viewer races to2; server classification/privacy to3; startup, result separation and cleanup to4; scoped reproducible stimuli to5; authority regression/source gate/docs to6; combined rollout and fresh acceptance to the root-only operational gate. Pinned human owner and pending human intent are distinct tested gates. All newly introduced interfaces are defined above and consumed only by following tasks. No task changes strict proof helper or original supervisor. Root reviews this private plan before copying to repository; no source implementation or live action occurred during drafting.
