# Task 1 implementation report

Status: implementation complete; offline checks passed; independent review and actual diagnostic are NOT RUN by this implementer.

Read binding spec, plan Global Constraints, task brief, unchanged production helper and prior private design review. Followed the binding spec's no-proxy/no-CDP design. No repository source/index/commit, service, network, browser, dependency-install or subagent actions performed. Only private supervisor/tests and this requested report were written.

## Private artifacts and hashes

- `/tmp/wrd-owned-turn-probe-private` is 0700. Both scripts are 0600.
- `supervisor.py` SHA256 `651bfabe6f4dc1d314a526a54cc99af7af837b6b5d6a91bd0e060f915c4f4c7e`
- `test_supervisor.py` SHA256 `2fb04e704d627629c11359f2ee019db102b4c3faf8994ae40c5f081352fa7a93`
- Fixed production helper SHA256 `2dfc5ee1e669c7f60662eb4b8cd17c1596bc146d3641845cfb12fd55d98592ed`.
- Fixed production sampler SHA256 `b47bfa435806b1c30a15e6d743f594f70ba17a4b73cbe10e6230ab36e9d53594`.

Both production hashes are checked before creating a run. CLI accepts only Host 87412, 300 seconds, formal origin and relay mode; `--help` performs no writes. Output must be a new immediate child of the private directory. The unchanged helper is directly launched with an argv list, production `.env` path and a `session/` output directory. Passwords never enter argv. Worker stdout/stderr go to DEVNULL to avoid unbounded or unsanitized output. The original summary/lifecycle/samples remain helper-owned; sidecars neither edit nor reinterpret them.

Worker is directly created by the supervisor and its PID/create_time is recorded immediately after Popen returns; scheduling may let the worker begin before the first observation. Each 250ms scan verifies direct owned parent identity and child-parent edges; registry capacity is 128 identities. Signals are per matching PID/create_time via psutil methods, descendants first; no process-group/name cleanup. The worker wall-clock cap is 600 seconds, followed by the separately bounded 1s observation, 3s TERM and 2s KILL cleanup windows. Finalization records worker return code and supervisor intervention separately. This means the complete supervisor invocation may exceed 600 seconds by cleanup/final-writing overhead; 600 seconds is the worker observation cap.

Preflight records helper/sampler hashes, Host birth and both existing Host PID-file values, log inode/device/offset. Fixed Host identity and both PID files are revalidated before the one-shot sample. First complete row with finite non-null frameAgeMs >2000 latches before validation or launch. The sample child uses its own registry, 10s external cap, RLIMIT_FSIZE=8MiB and no core dumps. The sample deadline is checked during browser cleanup as well. Compact progress is emitted at 30s intervals. Exception persistence uses exception class names only.

## Offline verification

Initial regression run failed as expected because supervisor.py did not exist. Final command:

`PYTHONDONTWRITEBYTECODE=1 python3 /tmp/wrd-owned-turn-probe-private/test_supervisor.py`

Result: **10 tests passed**, final run 0.922s. Coverage includes unknown ancestry, changed parent identity during registration, reused PID excluded from TERM/KILL, descendant registration, capacity bound, complete-lines-only reading, one-shot trigger and changed/unreadable Host refusal, cleanup after failure/deadline, fake execute-level natural worker failure versus wall-clock expiry, byte-preserved original helper artifact, harmless directly owned sleeping Python child cleanup, and side-effect-free help. Test fixtures were private and removed. No real browser/Host sample was launched. During development one execute-level test needed its fake psutil constructor completed; the final test exercises the intended fake adapter throughout.

## Self-review and limitations

- Already-recorded identities exiting is explicitly separate from complete tree exit; complete tree exit remains false/unproven. Polling can miss a fast orphan and permissions/identity changes can prevent ownership proof. No broad fallback cleanup is authorized.
- macOS has no pidfd-style atomic identity-bound signal here. Revalidation and psutil checks reduce, but cannot eliminate, the check-to-signal race.
- Registry observation and sample enforcement depend on OS scheduling and bounded ordinary filesystem/process operations. Deadlines are not real-time guarantees; polling/scheduling adds latency. A supervisor crash/SIGKILL cannot execute finally.
- Live `/usr/bin/sample`, RLIMIT_FSIZE behavior on that binary, raw stack content, Playwright lifecycle behavior, production PID-file contents and real Host birth remain NOT RUN. External independent review must assess these before the actual run.
- Trigger watches helper sampling rows only, so startup/media-start stalls are not covered. Sidecar records row elapsed time and trigger wall time but cannot prove optical onset or exact stack/stall overlap. No extra page evaluations are injected.
- Raw sample remains private and may contain paths/metadata. A real run remains perturbed diagnostic evidence, never performance or long-session qualification.
- No new tests mock manager lifecycle branches because the unmodified helper is launched directly; current tests cover the supervisor contract. They do not establish a full browser process-tree proof.
