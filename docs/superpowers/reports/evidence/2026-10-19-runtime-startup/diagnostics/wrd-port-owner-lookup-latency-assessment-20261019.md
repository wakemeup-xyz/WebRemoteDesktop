# Bounded port-owner lookup latency assessment — 2026-10-19

The original TCP8080 global listener query timed out in all three permitted attempts. The single PID-scoped comparison completed in 3.244640 seconds and returned PID33747. This establishes repeatable failure of the current five-second observation budget during this window; it does not identify the blocking mechanism or prove global exclusive ownership.

## Scope, budgets, and time window

- Primary repository: `/Users/macstudio1/AI/Claude/WebRemoteDesktop`. Read-only diagnosis; only this Markdown and its sibling JSON were written, both mode0600.
- Original argv, unchanged: `['/usr/sbin/lsof', '-nP', '-t', '-iTCP:8080', '-sTCP:LISTEN']`.
- Hard call budget: at most3 original queries plus at most1 scoped comparison; each uses `subprocess.run(..., timeout=5)` with a newly created child. Actual counts: 3 original + 1 scoped. Remaining lsof budget: zero. No retries or additional lsof invocations were made.
- Scoped comparison only appends `['-a', '-p33747']`; it is a diagnostic comparison and was not substituted into any ownership gate.
- Nominal aggregate child wait allowance: 20 seconds. The script also refused to start another query after30 seconds. Process creation, OS scheduling, and timeout kill/reap can add overhead; this is not a guaranteed wall-clock completion deadline. The completed measurement loop took 18.340080 seconds.
- Query window UTC: `2026-10-18T17:41:11.228032+00:00` to `2026-10-18T17:41:29.568556+00:00`. Asia/Shanghai: 2026-10-19 01:41:11–01:41:29.
- Supplemental scalar/health window UTC: `2026-10-18T17:42:09.232215+00:00` to `2026-10-18T17:42:09.449889+00:00`. These later facts do not retrospectively prove health at the prior root preflight failure instant.
- JSON cap64KiB; only PID-valued stdout is retained (max128 PID values per invocation). For each stderr, only byte count and SHA256 of its first4096 bytes are retained. No stderr body, command lines of observed processes, environment, credentials, viewer input, or URL content was retained.

## Every query result

| Attempt | Kind | Elapsed seconds | Exit code | Timeout | PID-only stdout | Stderr bytes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | original | 5.048003 | null (TimeoutExpired) | true | (empty) | 0 |
| 2 | original | 5.012638 | null (TimeoutExpired) | true | (empty) | 0 |
| 3 | original | 5.014267 | null (TimeoutExpired) | true | (empty) | 0 |
| 4 | scoped_comparative | 3.244640 | 0 | false | 33747 | 0 |

For timeout records the exit code is `null`: `subprocess.run` rethrows `TimeoutExpired` after killing/reaping its own child and does not expose a CompletedProcess return code. Only those newly created lsof children could be signaled by its built-in timeout cleanup; no service PID was signaled. Elapsed values include cleanup and are not lsof completion times. All three original observations are right-censored beyond the five-second requested timeout.

All four stderr prefixes were empty and have SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. The PID stdout for the scoped query was6 bytes (`33747` plus newline). There were no non-PID stdout lines.

## Local facts and gate semantics

During the query loop, observed load1 was approximately233–237 on12 logical CPUs; supplemental load1 was237.284180. These are system run-queue/load observations, not CPU utilization measurements. The parent supplied an earlier load near67; this new window differs substantially and cannot be used as a same-state controlled experiment.

The subsequent local probes disabled proxies, used at most2 seconds per route and a4096-byte response cap, and retained only allowlisted fields:

- `/health`: HTTP200, `status=ok`, 0.078843 seconds.
- `/api/status`: HTTP200, `hostOnline=true`, `viewerCount=0`, `relayViewerCount=0`, 0.004053 seconds.

Known PID scalar reads showed the original identities still running: Signal33747 birth1792336141.182036, Host36877 birth1792322600.528357, tunnel84671 birth1792151067.803588, watcher897 birth1790840870.948583. Only birth, status, and RSS scalars were read; no process command line or environment was queried.

The actual private `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-viewer-tools-successor-r3-_77m0ogi/core.py` implements `command()` with `subprocess.run(..., env=ENV, stdout=PIPE, stderr=PIPE, timeout=timeout)` at line74, and its `service_set()` calls the unchanged original lsof argv with5 seconds at line143, then requires the returned PID set to equal the observed Signal PID. The service-set check also validates known PID identity and rejects ambiguous same-repository Signal/Host candidates. This diagnosis did not invoke that entire function, import or execute the private helper, read its Registry, or modify its gates. Its ENV copies the parent environment and adds Git/Python-control flags; exact inherited environment parity with the root execution was not asserted or recorded.

Local man page `/usr/share/man/man8/lsof.8` confirms: `-n` disables network-number to host-name conversion (line1247), `-P` disables port-number to service-name conversion (line1357), `-t` produces PID-only output and implies warning suppression `-w` (line1654), `-a` ANDs all selection criteria (lines171–186), and `-p` selects only the stated process set (line1339). Thus the scoped query only proves that PID33747 has a matching listener at its observation; it cannot exclude another process listening on TCP8080. Empty stderr also does not rule out suppressed warnings. The manual describes potential kernel stat/readlink/lstat blocks (line3378 onward); no evidence here identifies such a block in this run. No name-resolution diagnosis follows from these measurements, because hostname/port-name conversion was already disabled.

## Causal limits and minimal next step

The reproduced timeout is in read-only port observation before any build/Node startup. The new evidence supports a repeatable five-second preflight-budget failure under high system load while the existing local service remained healthy in later probes. It does not prove that load alone caused the delay, that scoped PID filtering alone caused the speed difference, that lsof was blocked in any particular syscall, or that port ownership was globally exclusive. One scoped sample and three timeout samples do not support a p95, a stable latency distribution, or a long-session availability claim.

Preserve the existing fail-closed global ownership fence and stop here: this diagnosis has exhausted its lsof budget. A minimal subsequent operation, if separately authorized by the root's fresh context, is one finite attempt of the exact unchanged gate after system load recedes. Do not increase the timeout, loop indefinitely, run a build, or replace the global gate with the scoped result based on this report.

If repeated exact global observation remains impractical, a future fence design could evaluate a bounded kernel listener snapshot plus complete PID ownership mapping for every IPv4/IPv6 TCP8080 listener, retaining known PID birth and same-repository uniqueness checks, treating visibility gaps as failure, and running at the same temporal fence. That is an unimplemented design candidate requiring an explicit proof of parity and offline tests; no equally strong replacement is established by this diagnosis. PID-only health, bind failure, or scoped lsof alone cannot establish the current global exclusive-owner assertion.

## Provenance and exclusions

- Prior root failure file: `/private/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-guarded-recovery-root-private-20261018-_43p8cug/STARTUP-JOIN-R3-READONLY-PREFLIGHT-FAILURE.json`. Computed SHA256 `25619b4f8486d3b1b8c624b35645a8dadc0b1855dbe703c2e6c787c3b4e10856`. Expected digest received from parent: `19b4f8486d3b1b8c624b35645a8dadc0b1855dbe703c2e6c787c3b4e10856`. Match: `false`. The file body was not printed or copied into this report.
- Actual private core SHA256: `66431f4b76ebf7820307a11279e52572c1a1feceba33b6d78d5a580557388742`.
- Local lsof man-page SHA256: `b3e81bbde414e488160ead258804afbb09438c49b3aaba2e59f185314cc8ac1e`.
- Detailed bounded results: `/tmp/wrd-port-owner-lookup-latency-assessment-20261019.json`.
- No service lifecycle command, Host/tunnel/watcher signal, external network request, URL read/write, native/browser operation, build, Registry operation, source/index edit, or Git mutation was performed. The only requests were the two fixed loopback health routes above.

## Additional native TCP table candidate assessment

The local `/usr/share/man/man1/netstat.1` was read in full. It documents `-a` as including all socket states/listening server sockets, `-n` as numerical addresses, `-p` as protocol selection and `-v` only as increasing verbosity. Its OUTPUT section documents local/foreign address, queues, protocol and state; it contains no PID/epid column or owner-semantics description. The parent's additional authorization was conditional on local man indicating PID columns, so actual `/usr/sbin/netstat -anv -p tcp` calls remain0/1 pending clarification. No runtime header or table completeness has been observed: status `UNKNOWN`.

A proposed strict parser must reject timeout, nonzero exit, output cap/truncation, warnings, missing/duplicated/shifted schema fields, unknown protocol families, malformed TCP rows, unparseable local endpoints, ambiguous port/state, absent or nonpositive owners, and observation gaps. It must inspect every row before discarding nonmatching rows in memory; it may persist only header/schema and exact local-port8080 LISTEN PID/address-family summaries, never IPs or other connection rows. Multiple distinct owners fail; no listener fails. Missing/malformed/visibility or completeness uncertainty remains `UNKNOWN`, never partial `PASS`. A singleton PID must additionally match the known Signal PID and birth snapshot, and existing repository-uniqueness checks remain required.

Even a complete runtime TCP PCB table with PID/epid columns does not by itself establish equivalence to global lsof file-descriptor ownership. The local manual does not establish whether those fields enumerate every process holding an inherited/shared listening socket or provide a single recorded/effective owner. Full IPv4/IPv6 visibility, complete ownership semantics, snapshot freshness and birth matching need separate proof. This is a diagnostic/design assessment only; no fence was replaced or implemented.
