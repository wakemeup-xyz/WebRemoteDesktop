# Isolated TURN loss fixture

This fixture injects two and only two finite UDP loss patterns into an
experiment-only TURN relay leg: `every_100th_for_30s` (30 seconds) and
`all_for_200ms` (200 milliseconds).  It is never a production-network tool.

Before use, the T4 driver must create a unique UUID `runId`, a realm beginning
`turn-loss-lab-`, and a strict manifest with the selected UDP leg.  It then
runs `python3 controller.py prepare --manifest INPUT --runtime runtime`.  This
is the only supported way to derive the Compose project name, one-time TURN
username/password, control token, credentials file, and generated Compose
override. The manifest binds TURN to a remote `repo@sha256:...` identity and
the controller to a locally-built OCI image ID `sha256:...`.
`build-controller --base-image REF` resolves REF to a base RepoDigest, builds
the repository Dockerfile without a runtime tag, and records the returned image
ID plus base, Dockerfile, and controller source hashes as labels. `prepare`
verifies those labels, the exact local image ID, and `docker run --network none`
availability of the controller, gateway, and TURN wire parser; an unavailable daemon
is `BLOCKED` and produces no runnable fixture.

Use the generated override with the generated project name.  Compose assigns
manifest-derived loopback host ports for TURN and the controller's loopback-only
TCP endpoint.  The driver verifies the running Compose mappings and derived
network name with `verify_started_fixture()` before connecting.  The TURN relay
range `51000-51009` is mapped only to loopback and coturn advertises that
isolated address, so experiment endpoints can reach the selected relay leg
without any public listener. The selected leg must have exactly one endpoint
in that range. The project has a dedicated bridge network (not Docker
`internal`, because Docker Desktop suppresses required loopback mappings); no
service uses host networking or host PID. The TURN service receives only
`NET_BIND_SERVICE`. The controller, gateway, and independent watchdog all
drop every Linux capability; the gateway owns the in-path header ledger.
The control server binds the fixture namespace so Docker can forward it, while
Compose publishes it only as `127.0.0.1`; every request still needs its
generated control token. The entrypoint loads the generated temporary credentials into
coturn with `--lt-cred-mech --user`.  Neither Compose nor this controller
starts, stops, or changes any production service or tunnel.

The driver starts only the generated pair, for example:
`docker compose --project-name turn-loss-<run-id-prefix> -f compose.yaml -f runtime/compose.generated.yaml up -d`.
It invokes `verify_started_fixture()` to check both loopback mappings and the
network, then authenticates every JSON-lines control
request with `controlToken` from the temporary credentials file.  The control
service clears an active rule when its TCP connection closes; the watchdog is
the separate deadline owner.

The driver must first run `DockerRuntimeProbe.status()`.  A missing or
unreachable daemon is `BLOCKED` and all real injection/recovery evidence stays
`NOT_RUN`; the Python tests do not substitute a network run.  Once a daemon is
available, pull the manifest TURN RepoDigest and archive its `docker image
inspect` evidence. Build the controller only through `build-controller`; archive
its local OCI image ID and provenance labels from `image-evidence.json`. A
mutable tag is never a Compose runtime value.

The T4 driver connects to the generated loopback control endpoint with the
generated control token, opens a session/generation, and requests a baseline.
The controller persists a short-lived probe transaction and the gateway counts
only the authority-sealed ChannelData target before and after the probe. Only a
positive gateway counter delta grants a baseline; the control
caller cannot submit packet counts, selectors, or observation times. That
baseline is bound to the control session, generation, selector, and monotonic
time; it is consumed by one `apply_loss(run_id, pattern, duration_ms)` call. The controller
refuses production realms, host interfaces, mismatched run IDs/selectors,
control ports, stale/zero baselines, extra patterns, and durations over 35
seconds.  It persists a deadline state before declaring the rule active.  If
that persistence fails it rolls the installed rule back.  If deletion fails it
keeps the rule handle in `cleanupPending` state for retry.

The independent watchdog reads the shared state at startup and continually
clears expired or `cleanupPending` gateway intents, so controller process loss
cannot leave an accepted fault indefinitely. The controller holds the state
store's cross-process lock across persisted probe/install intent and terminal
state. A watchdog therefore cannot clear intent in the middle of a transaction.
It reports `IDLE`, `ARMED`, `CLEARED`, or
`CLEANUP_PENDING`; the fixture is unhealthy unless the expected deadline state
is present. The gateway signs its unique media binding and every event ledger with an
in-process Ed25519 key. The host verifies the public material, instance digest,
run, realm, binding digest, counters, and signature before it persists the
selected binding or accepts final media evidence. The host cannot submit media
observations or ledger rows. T3/T5 HMAC sealing remains in the host Lab process
and may use its own short mode-0600 Unix socket, but that socket is never
mounted into or contacted by Compose. The gateway receipt binds run/realm,
instance, event handle, receiver-directed RTP before/during/after sequences,
drop and send-failure counters. The host T3/T5 authority separately verifies
the 60-second T3 artifact and five-way T5 transcript, then binds PLI/FIR ->
IDR -> new paint recovery within two seconds without a PC rebuild or resolution
change. The control connection cannot submit drop counts, packet rows, or
sequences. Zero observed effect cannot pass.
Credentials,
TURN environment, and manifest are written with mode `0600`.

Do not treat an HTTP throttle, sender-side hook, or offline packet simulation as
this fixture.  T4/T5 still need to execute the two injections with a ten-second
healthy interval and independently prove the two-second recovery, IDR/new-frame
link, no PeerConnection rebuild, and stable resolution.  Until that run exists,
the T6 runtime and recovery gates remain `NOT_RUN`.
