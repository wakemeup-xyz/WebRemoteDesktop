# Passive control-gate evidence design

2026-10-18. This increment repairs evidence tools only. Product/runtime baseline f4202b7, Viewer build07ad960b331ccc4b, Signal42509 and Host89291 remain running. The failed formal run sampled133 rows with inputAllowed=false, maxgap11766.232ms, then Host ping timeout and lease invalidation. The Viewer socket remained connected before cleanup. Exact log/time boundaries are in the signaling timeout review and sanitized evidence summary.

The confirmed tool defect is cleanup overwriting startupSummary. A source/timing-supported candidate is an8s first-frame deadline making disconnected sticky while the same media attempt later paints; it is not yet a captured gate blocker. Do not change production timers or policy based on the retained boolean.

## Decisions and costs

1. Preserve startup and post-failure evidence separately, with clock domains explicit. Retain legacy startupSummary fields for compatibility; additive capture metadata costs bounded summary bytes.
2. Add a fixed gate projection to existing rows, not a second polling loop. Cost: extra bounded JSON bytes; no raw user input or state dumps. Null/unknown remains missing evidence.
3. Observe only the existing exact console timeout transition. Cost: positive page-level evidence only; no attempt identity and absence proves nothing. No product method wrappers, new product logging, timers, marks or rebuild.
4. Defer product deadline/recovery changes until capture distinguishes UI inactivity from reset/recovery factors. Existing8s feedback and fail-closed policy remain. Future phase supervision requires a separate reviewed finite paint budget; the DC watchdog ends on open and cannot bound no-frame waiting alone.

## Scope and authority

User implementation/maintenance authorization persists. Controller manages source sync and guarded probes; worker/reviewers perform offline tools only. Preserve current source/index dirt and all primary HEAD/index state. No tunnel/watcher mutation, no Host/Signal restart for this increment, no native business input, no settings/quality/network/lease/admission/reset changes. One source/index writer, actual scoped independent task and final reviews required before sync.

## Exact minimal evidence contract

### Timed immutable snapshots

Keep `startupSummary` at its original meaning and location: assign it once only after a successful required startup capture. Never overwrite it during cleanup. Preserve direct fields such as `startupSummary.uiPhase` for existing readers. Add only validated fixed timing/gate fields, or a sibling timing envelope if required for compatibility.

Use a separate `failureSnapshot`, assigned once from the first available post-failure capture before browser close. If startup was never reached, leave `startupSummary=null`; do not relabel a failure snapshot as startup. If a failing row already has a valid gate projection, retain that immutable projection and its browser time separately from the later capture. Do not claim a cleanup query occurred at failure detection.

For each snapshot retain: fixed capture stage (`startup-baseline` or `post-failure-preclose`), browser `performance.now()` from the same synchronous projection, Python monotonic request-start and completion times, fixed capture status (`ok`, `not-reached`, `unavailable`, `timeout`, `schema-rejected`, `cancelled`, `error`), and the projected state. Use existing Python `failureDetectedMs` separately. All times are nonnegative finite bounded values or null; never subtract browser and Python clock values. No new wall-clock value is needed. Null/unknown denotes missing evidence. An export/capture error cannot overwrite the original failure or turn a run into PASS. Preserve the current required-startup-summary failure behavior.

### Per-row gate projection

Add one exact-key `inputGate` object. Budget it to at most 4096 bytes, within the unchanged 32768-byte row and 64 MiB run caps. Prefer no new event stream: existing ~1-second rows give bounded baseline/change/failure observations. Existing top-level `inputAllowed` remains compatible and comes from the same single effective-gate read as the new `allowed`; do not change continuity pass criteria.

Every boolean below is boolean or null (null when owner/API is missing or projection fails). Every state has an explicit `unknown` fallback. The object has:

| Field | Allowed value / source |
|---|---|
| `status` | `observed`, `unavailable`, `scope-changed` |
| `allowed` | actual effective-gate allowed boolean |
| `blockedReasons` | unique fixed enums below, at most 32 entries; unrecognized input becomes one `unknown` enum, never copied |
| `inputActive`, `hasInputLease`, `viewportSupported` | Input's current active/lease/viewport predicates |
| `uiPhase` | `idle`, `signaling`, `media-pending`, `connected`, `media-stalled`, `disconnected`, `unknown` |
| `hasPaintedFrame`, `currentAttemptReady`, `hasActiveControl`, `socketConnected`, `manualDisconnect`, `superseded` | corresponding current predicates; compare attempt identity only in browser memory |
| `desiredMediaState` | `active`, `suspended`, `unknown` |
| `mediaRuntimePhase` | `active`, `suspending`, `suspended`, `resuming`, `unknown` |
| `keyboardControllerState` | `INACTIVE`, `READY`, `BLOCKED`, `RESET_REQUIRED`, `unknown` |
| `keyboardTransportState` | `ready`, `blocked`, `reacquire-required`, `revoked`, `unknown` |
| `surfaceState` | `settled`, `pending`, `uncertain`, `unknown` |
| `mouseResetPending` | pending reset boolean only |
| `desktopWriteRecoveryState` | `none`, `reacquire-required`, `reconciled`, `unknown` |
| `draftComposing`, `draftPending`, `draftUncertain` | three booleans only; never text or draft length |
| `recoveryState` | `idle`, `waiting`, `recovered`, `failed`, `unknown` |
| `firstFrameTimerHandlePresent` | true if a non-null own handle is present, false only for explicit null, null for absent/inaccessible field |

If minimizing duplicated row bytes, the already validated top-level socket/media fields may be referenced by schema instead of copied, but the snapshot must remain internally consistent. Optional relay factors are not necessary to discriminate this non-tunnel candidate; if included, only `relayScopeCurrent`, `relayFrameLoaded`, `relayFrameStale` booleans are permitted, using comparisons in memory. No scope IDs, timestamped raw relay frame object or arbitrary snapshot is permitted.

The exact gate reason allowlist is: `no-active-control`, `inactive`, `viewport-unsupported`, `manual-disconnect`, `media-not-ready-for-attempt`, `media-gate`, `runtime-phase:active`, `runtime-phase:suspending`, `runtime-phase:suspended`, `runtime-phase:resuming`, `runtime-phase:unknown`, `media-state:active`, `media-state:suspended`, `media-state:unknown`, `keyboard-transport-blocked`, `keyboard-transport-reacquire-required`, `keyboard-transport-revoked`, `keyboard-reset-pending`, `keyboard-blocked`, `surface-pending`, `surface-uncertain`, `mouse-reset-pending`, `desktop-write-reacquire-required`, `draft-composing`, `draft-pending`, `draft-uncertain`, `recovery-waiting`, `recovery-failed`, `unknown`. These are a closed projection of `input.js:1984–2019`, not all general diagnostic/recovery reason strings.

Capture the gate synchronously after the existing stats await and only when the captured owner/scope still matches. Extend the owner check to the captured Input and socket reference for the new evidence, since the existing transport check does not include them. If any owner/scope differs, expose `status=scope-changed`, nullable factors and an empty reason list; never project new-owner state under the old sample scope. Capture projected state after all getters and recheck scope once more, because existing keyboard snapshot getters can reconcile/expire a barrier (`keyboard-transport.js:97–101`, `remote-keyboard-controller.js:39–55`). Do not invoke recovery, reset, focus or setters. Reuse a single effective gate read; do not persist `getDiagnosticState()` or its nested arbitrary dictionaries.

`firstFrameTimerHandlePresent` deliberately does not say pending/fired. The field is initially absent; timer callback early returns need not clear it (`webrtc.js:2425–2430`). A handle alone cannot establish the deadline or its firing.

### Existing startup marks only

Project an exact fixed map with keys `start-click`, `bootstrap-start`, `bootstrap-ready`, `bootstrap-degraded`, `signal-connected`, `first-frame`, `active`. Each value is the first original finite nonnegative bounded `atMs`, or null. At most seven values; discard mark details, all unknown names, resource records, URLs and build objects. Retain optional fixed availability status. Read only `StartupTelemetry.snapshot()`; do not call mark/import/recordResources.

These are page-lifetime first-by-name marks, not attempt-scoped history (`startup-telemetry.js:56–81`). `first-frame` and `active` are produced together by media readiness, independently of effective input (`webrtc.js:1186–1192`); never claim the active mark proves the Input gate. Start-click-to-first-frame is an observable page timing, not the exact init-to-deadline interval. The normal fresh one-Start guard helps interpretation but does not create absent attempt timestamps.

### Preferred positive timeout fact: narrowly filtered console tap

Install `page.on('console', handler)` before ordinary Start. Accept only console type `log` and one fully anchored, length-bounded line matching exactly:

`[PAINT-GATE] uiPhase=disconnected reason=first-frame-timeout painted=true`

or the identical line ending `painted=false`. The filter may use a fixed regex for that single boolean; do not accept arbitrary phases/reasons, substring matches, suffixes, line breaks or broad console output. Drop raw text immediately after filtering; do not inspect/persist arguments, locations, stack traces or DOM. A parser error only downgrades fixed observer coverage; it cannot fail product callbacks or control flow.

Persist only a fixed event class `first-frame-timeout-transition`, `painted` boolean, Python receipt-monotonic timestamp, accepted-count capped at 64, and immutable first accepted event. Retain coverage: attachment status, whether installed before Start, attach/detach Python monotonic timestamps, fixed error/cap flag. Store at most the first event plus bounded counters, not a growing array. Detach only this owned handler in normal/failed/cancelled cleanup before close, without removing other listeners or changing current deadlines. Continue using existing cleanup budgets and preliminary evidence writes.

This is a **positive page-scope transition fact**. Receipt time is not browser event time. It does not contain attempt identity; do not claim same-attempt causality without separate evidence. Absence never proves no timeout: logging occurs only on an actual phase change, delivery may be missing, or the page may already be disconnected. A matching positive event before baseline plus baseline inactive/disconnected/painted/current-ready factors substantially improves evidence, while later Host ping timeout remains a separate failure. This minimal approach avoids product wrappers and a production rebuild.

A method wrapper is deferred. If future evidence requires exact call time and current-attempt attribution, any wrapper must forward receiver, arguments, return value and thrown object unchanged, catch only observation failures, restore only when still owner, and explicitly fence replacements/retirement. None of that is needed in the preferred increment.

## Required compatibility and privacy checks for the worker

1. Valid observed baseline followed by changed failure state preserves startup bytes and startup timing exactly; failure snapshot is separate and later. Failure before startup leaves startup null. Capture timeout/error/cancellation preserves original failure and cleanup ordering.
2. Gate fixtures individually exercise every reason and enum, unknown canaries, missing APIs, true/false/null, all states and reason count/byte bounds. UI disconnected + painted/current-ready/ACTIVE socket must be observable as `inactive`; do not synthesize allowed from factor conjunction. Reuse actual allowed result.
3. PC, client, socket, Input, build, attempt, generation and lease changes across stats await produce no mixed-scope new evidence. Existing concurrent hung getStats still starts at most one stats query. Stop remains idempotent and cancels only owned observers.
4. Known mark times remain original; unknown names/details/resources canaries never cross the boundary. Missing marks are null. First-frame/active marks do not change control verdicts.
5. Console observer accepts exactly both allowed lines once installed before Start; rejects substrings, altered enums, HTML, secret suffixes, multiline input, non-log types and overlong text. It records receipt time only, caps count, preserves first event, reports missing/failed/capped coverage, survives callback exceptions, and removes only itself through every cleanup path.
6. Python revalidates exact keys, enums, scalar types, finite/nonnegative times, list limits and byte limits before every persistence path, including preliminary/fallback artifacts. Additive fields do not alter old `inputAllowed`, proof guard, exactly-one-Start, reconnect/continuity verdict, row budget, permissions, original failure or diagnostic attribution. Legacy rows/summaries remain readable with new fields absent/unknown.
7. Existing meaningful suites to extend/run during implementation: `scripts/passive-session-sampler.test.js`, `scripts/test_passive_session_soak.py`; no product behavior test should be rewritten in this tool-only increment. Existing startup-summary error tests and strict preclose-before-close tests must continue to pass. This preflight did not execute them.
