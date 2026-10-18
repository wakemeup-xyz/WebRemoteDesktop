# Task 2 fixture integration correction

Status: DONE. Base: `ec163c262d4651d4a440886a943f2a562a6f38bf`.

Read the exact one-file correction brief, binding global constraints and Task 6 findings. Original Task 2 brief/contract was already read during implementation. Root explicitly handed over sole source ownership for `web-client/js/webrtc.test.js` only.

Diagnosis: Task 6's retained actual combined run (`task-6-node.log`) had 608 tests, 584 pass, 24 fail, exit 1, duration 31193.301565 ms. The existing `loadWebRTC` fixture evaluates the real full product but omitted the standard browser `URLSearchParams` global. The real parser consequently rejected before fetch/socket. These are genuine fixture RED results; no product defect or product RED is claimed. That original log was not modified.

Correction: supply the actual Node standard `URLSearchParams` to the browser VM context. Existing `Object.assign(context, overrides)` still permits explicit overrides. The real parser/admission flow and every assertion remain intact. No selector defaults, fake parser, fake admission decision, relaxed assertion or product change was introduced.

Exact one-file diff:

```diff
@@ -116,6 +116,7 @@ function loadWebRTC(overrides = {}) {
     // Explicit offline configuration response; never use a real network fetch.
     fetch: async (url) => ({ ok: true, status: 200, json: async () => url.endsWith('/api/auth/viewer-admission') ? { admission: { ticket: 'fixture-ticket' } } : {} }),
     AbortController,
+    URLSearchParams,
     setTimeout: trackTimeout,
     clearTimeout: clearTrackedTimeout,
     setInterval: trackInterval,
```

Only scoped full-suite command, run once after that edit from `/Users/macstudio1/.codex/worktrees/reliability-latency/WebRemoteDesktop`:

```
/Users/macstudio1/AI/trae/node-v24.15.0-darwin-x64/bin/node --test web-client/js/webrtc.test.js > .superpowers/sdd/2026-10-18-guarded-ordinary-recovery-plan/task-2-fixture-fix-node.log 2>&1
```

Exit 0. Complete output is retained in `task-2-fixture-fix-node.log` beside this report. Final output:

```
ℹ tests 307
ℹ suites 0
ℹ pass 307
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 29775.633427
```

Pristine assessment: all 307 assertions pass, zero failure/cancellation/skip/todo. The suite retains its ordinary product diagnostic logging. A bounded scan of this complete test log found no `not ok`, failure marker, `Warning:`, `Unhandled`, `uncaught`, `ERR_ASSERTION` or `ReferenceError`. The scan's exit 1 means no matches, not test failure. `git diff --check -- web-client/js/webrtc.test.js` exited 0 with no output.

Self-review: the one-line VM-global addition is sufficient and remains inside sole ownership. No other source files, dirty documents, primary/W2, tunnel/watch state, index or commits were touched. Private outputs are only this report and its scoped test log. No combined 608-test rerun, browser/network/API/build/service/process inspection/npm or subagent activity occurred. No runtime/deployment availability claim is made. No implementation concerns identified.

Source/index ownership is explicitly returned to root for the requested independent scoped review and subsequent staging/commit.
