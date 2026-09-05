# Terminal Formal Watch Task5 Report

**Date:** 2026-09-05
**Plan:** `docs/superpowers/plans/2026-09-03-terminal-formal-watch-remediation-plan.md`
**Design:** `docs/superpowers/specs/2026-09-03-terminal-formal-watch-remediation-design.md` §§2.5–2.6, §3

## Scope

This report records the final Task 5 documentation and safe quick-tunnel
boundary follow-up. It covers the ordinary-start migration for an already
loaded legacy quick-tunnel LaunchAgent and executable fixture coverage for
diagnostic-only quick-tunnel failure handling. It does not operate a real
LaunchAgent, service, Host, Cloudflare connector, or tunnel.

## Implementation

- `start-safe-wrd.sh` runs a migration before local services. When
  `launchctl print` proves a job is loaded, the migration inspects the
  installed plist and issues only `launchctl disable` and `launchctl bootout`
  when both legacy autostart flags are explicitly true. A current
  `false/false` plist, missing plist, or failed inspection is preserved
  fail-safe. URL files are not read-modified or deleted by this path.
- `launchd/com.webremotedesktop.tunnel.plist` remains non-autoloading. The
  explicit `restart-safe-tunnel.sh` path retains the separate
  `bootstrap`/`enable`/`kickstart` lifecycle and URL rotation behavior.
- `run-safe-quicktunnel.sh` uses shared state/report helpers. Unauthorized,
  unreachable, and connector-exit states report diagnostics and do not kill,
  delete the current URL, or loop into replacement.
- `lib-safe-startup.sh` and `lib-safe-wrd.sh` expose the startup decision and
  diagnostic seams used by production scripts and fixtures; no test-only
  bypass flag changes production control flow.

## TDD and verification evidence

The new fixture suite was run before the implementation and failed because
the migration, startup, and diagnostic helpers were absent. After the minimal
implementation it passed:

```text
Before implementation:
node --test scripts/tunnel-safety-fixture.test.js
→ 1 passed, 4 failed (expected missing production seams)

After implementation:
node --test scripts/tunnel-safety-fixture.test.js
→ 5 passed, 0 failed
```

The focused tunnel/startup regression passed:

```text
node --test scripts/tunnel-safety-fixture.test.js scripts/run-safe-quicktunnel.test.js scripts/start-safe-wrd.test.js scripts/tunnel-launchctl.test.js
→ 27 passed, 0 failed
```

The complete script gate passed:

```text
node --test scripts/*.test.js
→ 104 passed, 0 failed
```

Static syntax and whitespace checks passed:

```text
bash -n scripts/run-safe-quicktunnel.sh scripts/start-safe-wrd.sh \
  scripts/restart-safe-tunnel.sh scripts/lib-safe-wrd.sh \
  scripts/lib-safe-startup.sh scripts/lib-tunnel-launchctl.sh
git diff --check
→ exit 0; no whitespace output
```

The round2 fixtures execute the production shell scripts as subprocesses with
fake PATH commands, temporary plist/PID/URL state, and shell marker hooks.
They do not execute the shell scripts against real processes or invoke any
real launchctl/service/tunnel operation.

## Round2 executable-boundary evidence

```text
node --test scripts/tunnel-safety-fixture.test.js
→ 5 passed, 0 failed

node --test scripts/tunnel-safety-fixture.test.js scripts/run-safe-quicktunnel.test.js \
  scripts/start-safe-wrd.test.js scripts/tunnel-launchctl.test.js
→ 27 passed, 0 failed

node --test scripts/*.test.js
→ 104 passed, 0 failed
```

The subprocess fixture records that a loaded current `false/false` plist is
left alone, a loaded legacy `true/true` plist receives only `print/disable/
bootout`, and a failed `plutil` inspection receives only `print`. It executes
the run-safe script against fake Unauthorized, unreachable, and connector-exit
connectors and asserts no `kill`, URL-file deletion, or replacement spawn;
the explicit restart script separately records its authorized launchctl
bootstrap/enable/kickstart lifecycle.

## Acceptance boundary

- **PASS:** positively identified loaded legacy auto job is disabled and
  booted out without
  `bootstrap`, `kickstart`, `remove`, URL deletion, or replacement.
- **PASS:** loaded current `false/false` and unknown/failed-inspection jobs are
  left untouched.
- **PASS:** explicit tunnel restart remains available only through its
  separate lifecycle helper.
- **PASS:** Unauthorized, unreachable, and connector-exit observations are
  diagnostic-only and preserve the current URL file.
- **NOT RUN:** real macOS LaunchAgent state, public quick-tunnel reachability,
  fixed-domain browser acceptance, physical devices, and long-duration
  service/tunnel endurance.

No runtime or public-path conclusion is inferred from these fixture tests.
