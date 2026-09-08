# CPU telemetry cadence scope

The peak encoder matrix records CPU only for this project as occupancy telemetry.
Late sampler ticks and irregular one-Hz preflight intervals are retained as
`telemetryQuality: DEGRADED`, including their raw timestamps, but do not alter
the raw direct encoder/packetizer P95 or quality gates.

Viewer activity, sampler health failures, monotonic regressions, unavailable
boundary samples, missing coverage, and an unresponsive sampler remain
fail-closed. Each preflight still requires 30 successful samples and a healthy
sampler; its 60-second scheduling cap prevents dispatch delay from invalidating
otherwise independent frame measurements while still failing a non-responsive
sampler.

This rule applies only to newly generated evidence. Older artifacts retain the
rule that produced them and are not requalified.
