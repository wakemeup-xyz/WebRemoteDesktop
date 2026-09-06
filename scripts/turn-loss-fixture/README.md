# Isolated TURN loss fixture

This fixture injects two and only two finite UDP loss patterns into an
experiment-only TURN relay leg: `every_100th_for_30s` (30 seconds) and
`all_for_200ms` (200 milliseconds).  It is never a production-network tool.

Before use, the T4 driver must create a unique UUID `runId`, a realm beginning
`turn-loss-lab-`, and a strict manifest with the selected UDP leg.  It then
runs `python3 controller.py prepare --manifest INPUT --runtime runtime`.  This
is the only supported way to derive the Compose project name, one-time TURN
username/password, control token, credentials file, and generated Compose
override.  The manifest also binds both TURN and controller images to
`repo@sha256:...` identities.  A default port, inferred UDP pair, tag, local
build, or user-supplied Compose environment variable is invalid.  `prepare`
first requires Docker's sealed digest resolution and an isolated inspection of
the controller image for `/fixture/controller.py` and `iptables`; an unavailable
daemon is `BLOCKED` and produces no runnable fixture.

Use the generated override with the generated project name.  Compose assigns
manifest-derived loopback host ports for TURN and the controller's loopback-only
TCP endpoint.  The driver verifies the running Compose mappings and derived
network name with `verify_started_fixture()` before connecting.  The TURN relay
range `51000-51009` is mapped only to loopback
and coturn advertises that isolated address, so the experiment endpoints can
reach the selected relay leg without any public listener.  The selected leg
must have exactly one endpoint in that range.  The TURN service has no added
capabilities.  The `loss-controller` and
independent `loss-watchdog` sidecars alone receive `NET_ADMIN`, inside TURN's
non-host network namespace; no service has host networking or a host PID
namespace.  The entrypoint loads the generated temporary credentials into
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
available, pull the manifest's exact images and archive `docker image inspect`'s
`RepoDigests` alongside the manifest.  A tag or local build is not an
image-digest record.

The T4 driver connects to the generated loopback control endpoint with the
generated control token, opens a session/generation, and confirms the exact
manifest selector with a real, nonzero dry-run packet count.  That baseline is
bound to the control session, generation, selector, and monotonic time; it is
consumed by one `apply_loss(run_id, pattern, duration_ms)` call.  The controller
refuses production realms, host interfaces, mismatched run IDs/selectors,
control ports, stale/zero baselines, extra patterns, and durations over 35
seconds.  It persists a deadline state before declaring the rule active.  If
that persistence fails it rolls the installed rule back.  If deletion fails it
keeps the rule handle in `cleanupPending` state for retry.

The independent watchdog reads the shared state at startup and continually
removes expired or `cleanupPending` rules, so controller process loss cannot
leave an accepted rule indefinitely.  It reports `IDLE`, `ARMED`, `CLEARED`, or
`CLEANUP_PENDING`; the fixture is unhealthy unless the expected deadline state
is present.  The final evidence verifier records monotonic start/end, actual
drop count from the exact iptables rule counter and strict ordered RTP sequence
gaps from a receiver-owned evidence file.  The control connection cannot submit
drop counts or sequences.  Zero observed effect cannot pass.  Credentials,
TURN environment, and manifest are written with mode `0600`.

Do not treat an HTTP throttle, sender-side hook, or offline packet simulation as
this fixture.  T4/T5 still need to execute the two injections with a ten-second
healthy interval and independently prove the two-second recovery, IDR/new-frame
link, no PeerConnection rebuild, and stable resolution.  Until that run exists,
the T6 runtime and recovery gates remain `NOT_RUN`.
