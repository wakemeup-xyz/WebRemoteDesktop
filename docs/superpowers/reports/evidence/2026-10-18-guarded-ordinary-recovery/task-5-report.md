# Task 5 implementation report

Status: DONE. Base reviewed commit: `55e006d`. Source/index ownership is explicitly returned to root with this report and the short handback. No commit, staging or index mutation was performed. Root owns independent review, the versioned contract clarification, staging/commit, deployment and every live qualification gate.

## Changed paths and ownership

- New `scripts/ordinary_recovery_fault.py`: 269 lines, one page-local intentional fault adapter.
- New `scripts/test_ordinary_recovery_fault.py`: 513 lines, 25 pure tests including actual init-closure evaluation in bounded Node VM children.
- `scripts/ordinary_session_recovery.py`: +14/-4. Only the fixed adapter-failure projection, late/final fault veto and failed-fault PASS schema check; the existing startup, sampling, classification and cleanup loop remain intact. Its existing scope labels/emission were already correct and are tested rather than rewritten.
- This private report and named private test logs in the existing task directory are the only other writes.

The four pre-existing dirty documents, node_modules, strict helper, passive sampler, original SUP, production methods and all other source/test paths were not edited. The final scoped `git diff --check` exited 0 without output; `git diff --cached --name-only` was empty. No subagents, live browser, optional runtime API probe, network/API/status/process inspection, Host/native/proof/service/tunnel operation, npm/build/install or broader test command ran. Only the explicitly authorized bounded test Node children and the existing runner suite's owned pure CLI test children were created.

## Context and explicit root rulings

Read the Task 5 brief first, then integration context, exact Task 3 shared contracts, global constraints, complete design section “Browser-local fault adapter and scope of evidence”, Task 4 report and the superpowers 6.3.0 implementer-prompt contract. Read the complete prepared static installed API evidence at `/tmp/wrd-playwright-fault-adapter-api-evidence-20261018.md`.

Root explicitly authorized bounded direct Node VM children for testing the actual init closure (not a fake Python reimplementation). Each subprocess is owned by `subprocess.run`, has a 5-second timeout and must return successfully; VM script execution also has a 500ms per-evaluation limit. Missing Node, timeout and nonzero exit fail the test, never skip it. The tested VM exposes only fake browser/application globals and the standard URL parser, with no real WebSocket, fetch, process, filesystem or network APIs. The test host uses Node's VM and stdin/stdout to provide those contexts. No shell or grandchildren are used.

Root also approved one narrow interface clarification: read-only `failure_reason`, initially `none`, then sticky `fault-attempt-cap` or `fault-handler-failed`. The exact persisted seven-field snapshot is unchanged. The runner validates the finite property before surfacing it, defaults an absent property on existing Task 4 fakes to `fault-handler-failed`, rejects malformed values with `schema-rejected`, and checks both ordinary ticks and the late final snapshot. This is directly owned adapter evidence, not inference of a server rebind cause. Root will update the versioned contract after handback.

## Implementation

### Immutable scenarios and capability boundary

`BrowserLocalFault(*, scenario)` is synchronous. It accepts only within-grace and after-grace, fixes read-only scenario/instrumentation/blockSeconds, and performs only the scenario-specific local public API import and callable capability checks. Within-grace requires Page.add_init_script/evaluate and does not depend on routing availability. After-grace additionally requires Page.route/route_web_socket/unroute and WebSocketRoute.connect_to_server/close. Missing module/capability raises fixed `fault-capability-unavailable` before browser creation. A full runner test verifies capability-unavailable yields NOT_RUN and never constructs the browser manager. Baseline/continuity never import or construct this adapter.

Install must match the constructor scenario and can bind only once to its owned page and validated origin. Invalid origins install nothing and return only a fixed reason, including non-string/bool, credentials, paths, query, fragment, invalid ports, whitespace and backslashes. Trigger rejects a different page and any second attempt without invoking the page again. Snapshot returns an independent copy with exactly the existing keys, fixed instrumentation and 0/12 blockSeconds; it carries no URL, identity, exception or auth content.

### Native-direct and routed triggers

The init closure runs before application scripts. It captures the original global WebSocket constructor and original prototype.close reference without replacing either. Native-direct requires both references still identical, membership against that captured constructor, the exact current `WebRTC.socket.io.engine.transport.ws`, websocket transport, OPEN state, exact owned origin/socket.io path/EIO4/known bounded query, current ordinary owner/auth/socket/Host and full read-only input readiness gates. Getter reconciliation may not change the client/socket/engine/transport/ws identity. It calls the captured original close on that exact object once with code 1000 and `wrd-local-recovery-check`, ignoring an overridden instance.close. No HTTP or WS route registration occurs on this path. No product disconnect/connect, manager/engine close/open, acquisition or recovery method is invoked.

The routed trigger requires the same current owner/auth/path/gates and exact engine object, plus membership in the current public WebSocket wrapper. That membership only rejects an arbitrary lookalike; it is expressly not native provenance. It calls the current object's public close once and stays labeled `playwright-routed`. A fake wrapper that passes global instanceof but is not native remains routed and its synthetic clean-close metadata is not promoted to native evidence. A plain lookalike with an arbitrary close function is rejected before invoking that function.

### Supported routing, block and ownership

After-grace installs page-local HTTP and WS matchers before navigation. Matchers require exact owned origin/port/path, EIO=4, the correct polling/websocket transport, no duplicate/unknown parameters, <=5 query fields and bounded standard sid/t/b64 values; other traffic forwards unchanged. The existing owned browser context already blocks service workers. The independently owned fixed local status reader is untouched, and a route test explicitly confirms /api/status does not match or count as blocked traffic.

Open WS routing calls synchronous public `connect_to_server()` without awaiting it and never installs on_message or on_close hooks. The 12-second Python-monotonic block is armed once immediately before the current wrapper trigger. Future matching polling aborts; future matching WS routes await public close without any upstream connect. At the exact deadline, future requests forward normally; retries never extend it. No request is held asleep. The 33rd combined attempted block records sticky `fault-attempt-cap`, leaves projected counts at 32 and clears the block; the run cannot qualify. Handler failure/cancellation also clears the block and retains failure through cleanup.

Public async route operations are owned tasks with 200ms work + 50ms cancellation settlement. Timed-out/noncooperative operations remain tracked and cannot be hidden as completed cleanup. Their eventual exceptions are consumed without persisting backend text. Disarm clears the block before its first await, removes only the exact saved HTTP matcher/handler, retires the closure, waits owned handler/operation settlement with a bounded 200ms + 50ms cancellation allowance, and fails if settlement is incomplete. WS registration remains forwarding until owned context teardown. No native-global restoration, private WS unroute or upstream access is claimed. The runner's existing outer 1-second export / 8-second total cleanup deadlines remain unchanged.

### Evidence and late-failure integration

Existing `qualificationEvidenceScope` emission stays fixed from preflight in summary, ordinaryRecovery and every wrapper row: native-passive-continuity for both no-fault scenarios, ordinary-functional-native-direct-close for within-grace, ordinary-functional-playwright-routed-stimulus for after-grace. Both reducer PASS cases and the actual full fake after-grace run are tested. Scope promotion, instrumentation mismatch and nativeAfterGraceQualification promotion are schema-rejected. Every summary keeps nativeAfterGraceQualification NOT_RUN.

The runner now allowlists directly owned adapter failure reasons at tick and final teardown. A failed snapshot cannot validate as recovery PASS. Actual full fake runs verify success control, failure during a normal tick, failure during disarm, failure only after browser.close, and preservation of an earlier human-priority failure. These exercise the original real run/reducer with every baseline tick, actual fake Start/request/response and normal cleanup; no reducer PASS, prequalified model, shortened duration or recovery authority is injected. A virtual scheduling clock advances time while local fake samples, Host status and bounded file-backed server events remain observed through the existing code. These are pure tests, not a live PASS claim.

## Installed API facts and evidence limits

The supplied static local installation evidence records **Python distribution 1.59.0** and **bundled playwright-core driver package.json 1.59.1**; they are not claimed uniformly 1.59.0. The source confirms route_web_socket installs a replacement global wrapper, can synthesize public clean close metadata and changes forwarding/timing. Public connect_to_server is synchronous fire-and-schedule rather than a handshake ACK. An unconnected route handler's normal return may ensure-open a mock, so blocked future WS routes explicitly close and never connect upstream. HTTP unroute/unroute_all do not remove WS registration or restore the native constructor. API completion is not peer receipt, upstream-close proof or process exit.

No `_ws`, private upstream, private binding, CDP, message inspection/rewrite or alternate browser transport was introduced. Native direct code-1000 close and routed close are intentional stimuli and neither reproduces natural1006. API source metadata and fake tests do not establish an actually installed browser or live close/recovery. Live baseline300 / within / after / fresh10800 qualification, production loading and real application/media behavior remain NOT_RUN and root-owned.

## TDD and actual commands

All Python execution below used `/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11`. Final invocations explicitly pinned `WRD_TEST_NODE=/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node`. The full final Python test command is exactly:

```text
WRD_TEST_NODE=/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node /Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest scripts.test_ordinary_recovery_fault scripts.test_ordinary_session_recovery
```

Each adapter suite invokes the owned Node command `[supplied-node-path, '-e', VM_HARNESS]` twice, with a JSON stdin payload containing the actual adapter init script. The final two children evaluate 20 native-direct and 7 routed contexts (27 total); no test subprocess or VM context accesses a real browser, API, network or native input.

1. **Initial RED before adapter implementation:** `python3.11 -m unittest scripts.test_ordinary_recovery_fault`; log `task-5-red.log`. 19 tests / 0.088s / exit 1 / 23 errors. Eighteen errors were expected missing adapter ModuleNotFoundError. Five were scope-test fixture TypeErrors from omitting the existing required cleanup_complete keyword; those fixtures were corrected, and those five are not represented as source defects.
2. Initial implementation GREEN: same adapter-only command; log `task-5-first-green.log`. 19 tests / 0.420s / exit 0. Output was not pristine: patching the shared time module initially distorted asyncio debug timing. Tests were corrected to replace only the adapter's time binding with a small fake object; production event-loop clocks are never patched. Later logs are clean.
3. **Integration RED before runner integration:** `python3.11 -m unittest scripts.test_ordinary_recovery_fault.FailureIntegrationTests`; log `task-5-red-integration.log`. 2 tests / 5.930s / exit 1 / 3 failures + 3 errors. Missing allowlisted helper produced errors. Tick/disarm failure was incorrectly generic; failure only after browser close actually returned exit0/PASS. Success control and earlier-failure case were not the failing subtests.
4. Integration GREEN after the minimal runner fix: pinned Node + adapter-only command; log `task-5-green-integration.log`. 21 tests / 6.137s / exit 0 / OK, pristine.
5. **Self-review origin RED:** `python3.11 -m unittest scripts.test_ordinary_recovery_fault.RouteTests.test_invalid_origin_is_fixed_and_installs_nothing`; log `task-5-red-origin.log`. 1 test / 0.010s / exit 1 / 1 bool-origin subtest error. Exposed AttributeError from URL parsing before type validation; fixed by validating the bounded origin type first.
6. Self-review GREEN with added trigger cancellation and noncooperative close settlement: pinned Node + adapter-only command; log `task-5-selfreview-green.log`. 24 tests / 6.649s / exit 0 / OK, pristine. The noncooperative fake is released and reaped in finally; no test task remains.
7. First combined scoped suite: full command above; log `task-5-final-tests.log`. 103 tests / 18.932s / exit 0 / OK, pristine.
8. Combined suite after adding the explicit capability-before-browser integration test: same full command; log `task-5-final-after-gate-tests.log`. 104 tests / 19.555s / exit 0 / OK, pristine.
9. **Self-review routed-object RED:** pinned Node + `python3.11 -m unittest scripts.test_ordinary_recovery_fault.InitClosureTests.test_routed_wrapper_passes_global_instanceof_but_never_claims_native`; log `task-5-red-routed-object.log`. 1 test / 0.106s / exit 1 / 1 failing lookalike-object subtest. The arbitrary object's close was invoked once. Added the public wrapper instanceof target check while retaining the explicitly routed label; this check makes no native claim.
10. **Final actual-source GREEN after all source/test edits:** full command above; log `task-5-final-after-selfreview.log`. **104 tests / 20.207s / exit 0 / OK. Output pristine; no warnings.** Twenty-five adapter/integration tests and 79 existing runner tests passed. Exactly two Node VM children ran in this final command, 27 fake contexts. No source or test edits followed this run.
11. Final `git diff --check -- scripts/ordinary_recovery_fault.py scripts/test_ordinary_recovery_fault.py scripts/ordinary_session_recovery.py`: exit 0, no output. Final `git diff --cached --name-only`: empty.

## Self-review and handback

Reviewed constructor/import timing, scenario binding, exact-target and reference checks, same-turn getter races, fixed status/privacy surfaces, endpoint/query predicates, 12-second deadline boundary, combined cap, route callback API semantics, cancellation/noncooperation, sticky failure, exact HTTP unroute identity, unsupported WS restoration assumptions, scenario scopes, late postclose veto and first-failure preservation. The additional REDs above produced concrete fixes before the final full scoped run.

No known unresolved Task 5 correctness concern remains. There is no claim of live qualification or native after-grace coverage. Independent review of the fault capability/evidence scope/cleanup, root's versioned failure_reason contract note and root's eventual commit remain required later steps. All owned source paths and index are now handed back; this worker will make no further edits without a new explicit assignment.

# Fix round 1 — Important P2 contract precedence, base 73d77d9

Status: DONE. Read the refreshed Task 5 brief and complete task-5-review.md before editing. Root's committed ruling distinguishes the main default-manager runtime dependency from the adapter/scenario-specific public capability. The existing source already implements that distinction: a missing default-manager async_playwright import yields runtime-dependency-unavailable before adapter construction; an injected manager skips that main-manager import but still requires the adapter's relevant public APIs. No import reordering or runner/adapter edit was made.

Only `scripts/test_ordinary_recovery_fault.py` changed (+34 lines), plus this requested private report appendix and the named private log. Added one pure test with valid hash-pinned within-grace and after-grace manifests and explicit manager_factory=None. It denies every Playwright import, observes the single attempted playwright.async_api import, and asserts exit1, manifest validation completed, recovery NOT_RUN, the exact preflight runtime-dependency-unavailable reason and no fault capability check/trigger. Browser start, admission observer construction, status read and adapter loading are all individually asserted never called. The private ImportError canary cannot appear in the persisted summary. The existing injected-manager missing-route_web_socket test remains unchanged and still proves fault-capability-unavailable before browser construction.

This is regression coverage for the clarified contract, with an expected initial GREEN; no manufactured RED was attempted. Actual focused command:

```text
/Users/macstudio1/.homebrew/opt/python@3.11/bin/python3.11 -m unittest scripts.test_ordinary_recovery_fault.FailureIntegrationTests.test_default_manager_missing_playwright_is_runtime_dependency_before_adapter scripts.test_ordinary_recovery_fault.FailureIntegrationTests.test_capability_unavailable_is_not_run_before_browser_factory
```

Log: `.superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-5-r1-focused.log`.

Actual output:

```text
..
----------------------------------------------------------------------
Ran 2 tests in 0.045s

OK
```

Both tests passed on the first run, covering two default-manager recovery scenarios and the existing injected-manager capability case; output pristine. The unchanged full 104-test suite and Node VM tests were not rerun, as root directed. No optional Playwright import succeeded, and no browser, status/network/API, native/service/tunnel, process inspection, build/npm/install, subagent, commit, staging or index mutation occurred. Final scoped git diff --check exited0 without output and git diff --cached --name-only was empty. Self-review confirms only the requested test coverage was added and all main-runtime/adapter behavior remains unchanged. Source/index ownership is explicitly handed back to root; no further edits without reassignment.
