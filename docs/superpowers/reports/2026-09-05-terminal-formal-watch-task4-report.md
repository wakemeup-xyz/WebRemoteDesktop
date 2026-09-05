# Terminal Formal Watch Task4 Report

**Date:** 2026-09-05
**Plan:** `docs/superpowers/plans/2026-09-03-terminal-formal-watch-remediation-plan.md`
**Design:** `docs/superpowers/specs/2026-09-03-terminal-formal-watch-remediation-design.md` §2.4

## Scope

This task is limited to `scripts/watch-fixed-domain.sh`,
`scripts/lib-fixed-domain.sh`, `scripts/restart-fixed-domain-tunnel.sh`, and
their focused Node test files. Formal watch remains named-tunnel-only. No
trycloudflare, signal-server, Host, or real formal tunnel operation was
started, stopped, restarted, or rebuilt.

## Findings and fixes

- The original `mkdir(lock)` publication exposed an empty directory before
  owner metadata. A concurrent watcher could reclaim that directory and then
  have its PID metadata overwritten by the first watcher.
- Lock publication now marks initialization, refuses to reclaim missing or
  incomplete owner metadata, records PID plus `ps` start time and command
  signature, and removes only metadata belonging to the current owner.
- Reclaim is conservative: only a proven-dead PID is reclaimable; a live PID,
  identity mismatch, PID reuse, or incomplete inspection is preserved.
- Token-authenticated `cloudflared` processes are identified without printing
  argv. Managed credentials restart and the watch restart branch both refuse
  when a token connector exists.
- `ps` inspection failure is fail-closed: managed restart refuses with a
  non-secret diagnostic and the watcher records a skip without submitting a
  connector.

## TDD evidence

### Red

Before the hardening changes, the new tests failed for the expected missing
behaviors:

```text
node --test --test-name-pattern='empty lock|records process|closed inspection' scripts/watch-fixed-domain.test.js
→ empty lock was reclaimed; identity metadata was empty; ps failure continued restart
```

### Green

Focused lock/token tests:

```text
node --test scripts/watch-fixed-domain.test.js scripts/restart-fixed-domain-tunnel.test.js
→ 18 pass / 0 fail
```

Full script regression suite:

```text
node --test scripts/*.test.js
→ 96 pass / 0 fail
```

Additional static checks:

```text
bash -n scripts/watch-fixed-domain.sh scripts/lib-fixed-domain.sh scripts/restart-fixed-domain-tunnel.sh
git diff --check
→ pass
```

## Acceptance boundary

The automated evidence covers stale/dead PID reclaim, empty initialization
race protection, live foreign/PID-reuse preservation, SIGTERM cleanup, owner
metadata changes, token detection, watcher skip behavior, and `ps` failure
fail-closed behavior. Physical device, public tunnel, and live formal watcher
acceptance remain **NOT RUN** by design.

**Planned commit message:** `fix(tunnel): recover stale watch lock and refuse token connectors`
