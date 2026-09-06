# Isolated TURN loss fixture

This fixture injects two and only two finite UDP loss patterns into an
experiment-only TURN relay leg: `every_100th_for_30s` (30 seconds) and
`all_for_200ms` (200 milliseconds).  It is never a production-network tool.

Before use, the T4 driver must create a unique UUID `runId`, a realm beginning
`turn-loss-lab-`, a random loopback `TURN_LISTEN_PORT`, temporary TURN
credentials under `runtime/credentials/`, and a strict `runtime/manifest.json`.
The manifest records the selected UDP leg only after the relay has been
established; it contains the namespace, isolated `eth0`, exact source and
destination addresses/ports, loopback control endpoint, credential reference,
and SHA-256 version digest.  A default port or an inferred UDP pair is invalid.

`compose.yaml` has a private Docker network.  The TURN service has no added
capabilities.  Only the `loss-controller` sidecar has `NET_ADMIN`, and it
shares TURN's non-host network namespace so its OUTPUT rule can see the relay
leg.  It has neither host networking nor a host PID namespace.  The relay range
is fixed to UDP `51000-51009`; the listener is loopback-mapped from a unique
host port.  Neither compose nor this controller starts, stops, or changes any
production service or tunnel.

The driver must first run `DockerRuntimeProbe.status()`.  A missing or
unreachable daemon is `BLOCKED` and all real injection/recovery evidence stays
`NOT_RUN`; the Python tests do not substitute a network run.  Once a daemon is
available, pull/build the exact images and archive `docker image inspect`'s
`RepoDigests` alongside the manifest.  A tag alone is not an image-digest
record.

After the relay is selected, call `confirm_selected_leg()` with the exact
manifest selector and a real, nonzero dry-run packet count.  Then call
`apply_loss(run_id, pattern, duration_ms)`.  The controller refuses production
realms, host interfaces, mismatched run IDs/selectors, control ports, zero
baselines, extra patterns, and durations over 35 seconds.  It saves monotonic
start/end timestamps, actual drop counts, and receiver RTP sequence gaps.
`clear_loss()` is called by the independent timeout watchdog, a context
manager's `finally`, and control-connection closure.

Do not treat an HTTP throttle, sender-side hook, or offline packet simulation as
this fixture.  T4/T5 still need to execute the two injections with a ten-second
healthy interval and independently prove the two-second recovery, IDR/new-frame
link, no PeerConnection rebuild, and stable resolution.  Until that run exists,
the T6 runtime and recovery gates remain `NOT_RUN`.
