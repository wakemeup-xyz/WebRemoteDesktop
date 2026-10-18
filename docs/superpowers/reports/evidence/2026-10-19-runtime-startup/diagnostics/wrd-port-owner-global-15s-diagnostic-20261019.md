# One independently authorized15s global lsof diagnostic — 2026-10-19

The exact original global listener query completed successfully in **0.287494 seconds**, exit0, with PID-only output `[33747]`. It did not need the additional timeout allowance in this sample. At this later instant, system load1 had already fallen to**9.190918** from the earlier measurement window's roughly233–237, so this does **not** establish high-load completion time or a need to extend the production five-second gate.

## Scope, bounds and every result

- New explicit budget: exactly1 standalone diagnostic call, independently authorized after the original3×5s plus scoped comparison budget was exhausted. It does not erase or retry those samples under their original budget. Remaining new budget0; no automatic retry or further timeout increase.
- Original global argv unchanged: `['/usr/sbin/lsof', '-nP', '-t', '-iTCP:8080', '-sTCP:LISTEN']`. No PID filter or other lsof option was added.
- Requested monotonic deadline15 seconds, stdout cap32KiB, stderr retained only as byte count plus SHA256 of at most4096-byte prefix. Raw stderr and non-PID stdout were not persisted. Process creation, OS scheduling and child cleanup may add wall-clock overhead; this limit is not a universal hard completion guarantee.
- UTC window: `2026-10-18T17:51:28.282850+00:00`–`2026-10-18T17:51:28.570290+00:00`. Asia/Shanghai: 2026-10-19 01:51:28.
- Elapsed0.287494s; exit0; timeout=false; captureCap=false; stdout6 bytes; one PID `[33747]`; zero non-PID lines; stderr0 bytes. Empty stderr-prefix SHA256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. No parse/completion issues.
- The only process that could have been killed/reaped on timeout or capture cap was the lsof child created by this Popen. No timeout/cap cleanup signal was required; no other process was signaled or discovered.
- `os.getloadavg()` before and after: `[9.19091796875, 53.8486328125, 76.6572265625]`,12 logical CPUs. These load averages are not CPU percentages.

## Interpretation and fence boundary

This produced a complete global listener PID set for this observation, `[33747]`, matching the parent's known Signal PID33747. It is the same unscoped lsof selection as the existing gate, rather than the earlier PID-scoped comparison or the netstat PCB table. It does not refresh PID birth, same-repository Signal/Host candidate uniqueness, health, preserved-process state, source/context hashes, or any other existing preflight condition. The complete original service gate was **NOT RUN**, and this standalone result was not inserted into it.

The earlier three requested five-second observations remain right-censored timeouts with their original durations and zero outputs. This one later query completed within the original five-second threshold after load receded. It therefore cannot show whether giving the earlier high-load calls15 seconds would have helped, nor prove that load alone caused their delays. There is no p95, stable performance distribution, high-load deadline assurance, or diagnosis of a particular blocking syscall from these data.

Keep the current five-second fail-closed gate unchanged. A fresh gate attempt, if the root's approved frozen context permits it, belongs to the root's own operation and must independently satisfy all current checks; this subtask has no remaining query budget. Any future administrative15-second probe design still requires separate evidence and independent review. This report establishes neither a need for that change nor permission to change deployment/input/startup/native-worker budgets. Netstat remains diagnostic and does not replace FD-owner proof.

## Preserved evidence and artifacts

All earlier5s/scoped lsof artifacts and the netstat runtime-schema artifacts were only read for hashes, not rewritten. Their sizes and SHA256 values are recorded in `/tmp/wrd-port-owner-global-15s-diagnostic-20261019.json`. The previously confirmed failure digest remains `25619b4f8486d3b1b8c624b35645a8dadc0b1855dbe703c2e6c787c3b4e10856`; the root has confirmed that the original brief's digest mismatch was a SHA/text-boundary ambiguity, not file drift, as recorded in the separate netstat note.

This Markdown and sibling JSON are private mode0600. No service, Host, tunnel, watcher, browser, native input, build, Registry, source, index or Git operation was performed. The lsof invocation only observed local process/kernel file-descriptor state and made no network connection.
