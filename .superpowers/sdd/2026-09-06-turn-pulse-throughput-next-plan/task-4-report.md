# Task 4 report: isolated legacy lab boundary

## Scope

Implemented the policy-selection seam and a child-scoped, loopback-only lab
Signal controller. `PRODUCTION_RELAY_POLICY_VERSION` remains unchanged and the
ordinary Host still invokes the production environment parser, which rejects
v2. The current T2 sidecar reports `NO_QUALIFIED_CANDIDATE`, so candidate mode
rejects before a Signal or Host child can start.

## TDD evidence

- **RED:** the new `scripts/test_turn_lab.py` and
  `scripts/turn-lab-signal.test.js` initially failed module collection because
  the lab modules did not exist.
- **GREEN:** focused Python coverage checks VerifiedLabContext admission,
  immutable experiment resolver selection across publish/refresh/rebuild,
  candidate manifest/hash rejection, production proof/epoch monitoring,
  child cleanup, and pre-import `SERVER_URL` injection. Signal checks cover
  random loopback port/auth/runtime and rejected production/non-loopback
  origins.

## Runtime evidence

One disposable lab Signal-only self-check started on a random loopback port
(`http://127.0.0.1:63859` in that run), returned `running` with a lab realm,
then exited with its temporary directory empty. A second authenticated lab
Signal probe logged a random loopback origin and received HTTP 200 from private
Viewer login followed by HTTP 201 from that lab's proof-admission endpoint.
No production process, port 8080, Viewer, tunnel, credential file, firewall,
or runtime configuration was changed.

The requested legacy Host/Viewer evidence remains `NOT_RUN`: this task did not
have a dedicated captured desktop, a verified zero-human-Viewer production
proof, or an isolated real Viewer/Host fixture. Consequently single-Viewer,
relay, pause/resume, profile-switch, and the T3 60-second coverage versus
observer-overhead comparison were not attempted. Candidate runtime is
`NOT_RUN` by the T2 `NO_QUALIFIED_CANDIDATE` gate.

## Verification

```
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m pytest -q scripts/test_turn_lab.py python-host/test_h264_encoder_policy.py
node --test scripts/turn-lab-signal.test.js signal-server/test/config.test.js signal-server/test/diagnostic.test.js
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m pytest -q python-host/test_media_profile.py python-host/test_stall_decoder_refresh.py python-host/test_latency_timing.py python-host/test_h264_idr.py
node --test signal-server/websocket/runtime-context.test.js signal-server/websocket/signaling.test.js
```

All listed commands passed in this worktree; `test_latency_timing.py` retained
its pre-existing MSS deprecation warning.

## Independent review remediation

The first independent review found that the initial draft could inherit Host
credentials, bypass the LabHost entrypoint, forge proof state, and orphan a
child overlay. Those findings were fixed before the final verification: the
Signal child returns only per-run lab credentials through its private pipe;
the Host environment is scrubbed and launched as a new process group through
`turn_lab_host.py`; lab proof token/realm/epoch are Signal-issued and matched;
production monitoring uses status-only reads after one admission; and group
teardown is bounded. Candidate admission now unconditionally rejects because
the required full T2 recomputation is absent and T2 records no qualified
candidate.

## Fix round 1

The review of commit `8c785ef` found that the public driver still accepted
forged production proof callables and plain lab-context JSON. The operational
path now accepts only `ProductionAdmissionClient` pinned to
`http://127.0.0.1:8080`; it obtains one production admission and monitors only
status thereafter. Production proof construction is sealed. Lab Signal issues
a one-time context credential bound to run/origin/realm/epoch/policy; the Host
consumes it before creating `LabWebRemoteHost`. URL parsing now rejects paths,
userinfo, query/fragment, non-loopback addresses, and ports 8080/5173. Signal
and Host children use scrubbed environments, bounded startup and process-group
cleanup. No real production admission or lab Host/Viewer run was performed.

## Fix round 2

The public `LabRun` constructor now accepts only a Viewer token and always
builds its final `ProductionAdmissionClient` for exact canonical
`http://127.0.0.1:8080`. There are no public Signal, proof, context, or child
command injection arguments. Direct `ProductionProof` construction and client
subclassing fail; tests use a module-private test-support factory with a real
random-port loopback HTTP fixture.

Lab context issue has an exact field allowlist and verifies that its proof
token remains an unconsumed Signal admission for the exact lab realm/epoch.
The Host receives no context-issue secret. It validates raw context shape,
atomically consumes the high-entropy credential over loopback, and compares
every binding field including proof token before constructing its sealed
context. Replay, swapped token/realm/epoch, wrong mode/policy, and unknown
fields fail closed. Python and Node require the same canonical bare loopback
URL form.

After a successful start, an internal watchdog polls only `status()` and
automatically removes all child process groups and runtime files on a human
Viewer, epoch change, status failure, or child exit. Startup identity reading
uses bounded nonblocking bytes, so partial no-newline output fails by the
ten-second deadline; parent log descriptors close during teardown.

Verification for this round:

```
/Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 -m pytest -q scripts/test_turn_lab.py python-host/test_h264_encoder_policy.py
node --test scripts/turn-lab-signal.test.js signal-server/websocket/runtime-context.test.js signal-server/websocket/signaling.test.js
git diff --check
```

Final rerun after Host raw-binding adversarial coverage: Python `34 passed`;
Node `82 passed`; `git diff --check` passed.
Tests used only ephemeral loopback Signal and proof fixtures. No production
admission was attempted. Real Host/Viewer single-viewer, relay, pause/resume,
profile-switch, T3 60-second coverage and observation-overhead comparison
remain `NOT_RUN`; they need a dedicated desktop/Viewer fixture and are
forbidden against the current production Viewer. Candidate remains `NOT_RUN`
and fail-closed because T2 has `NO_QUALIFIED_CANDIDATE`.

Additional broad regression: `cd signal-server && npm test` completed with
`339 passed, 1 failed`. The same failure reproduces in
`node --test test/terminal-auth.test.js`: existing
`/api/auth/login/admin emits audit events for success and rejection outcomes`
gets HTTP 500 because `signAccessToken` sees no JWT secret. It is outside the
lab paths changed here; the focused Signal/context/runtime/signaling suites
above passed. This remains a truthful `BLOCKED` broad-suite item rather than a
claim that the full suite is green.
