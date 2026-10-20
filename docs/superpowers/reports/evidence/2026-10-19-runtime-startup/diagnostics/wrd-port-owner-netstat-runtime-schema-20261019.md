# One bounded native TCP runtime-schema probe — 2026-10-19

The single authorized `/usr/sbin/netstat -anv -p tcp` probe completed in **0.061269 seconds**, exit0, and produced a complete captured table with runtime `pid` and `epid` columns. The exact local-port8080 LISTEN summary contained PID33747 on tcp4, with epid0. This is `SCHEMA_OBSERVED_ONLY`; equivalence to the existing global lsof file-descriptor-owner fence remains **UNKNOWN**. No gate changed.

## Finite scope and evidence

- Exactly1 actual invocation, argv unchanged: `['/usr/sbin/netstat', '-anv', '-p', 'tcp']`. Authorized maximum1; remaining budget0. No lsof invocation occurred in this follow-up.
- Requested monotonic deadline5 seconds, combined stdout/stderr capture cap2MiB. EOF was reached for both pipes, exit0, no timeout/cap/exception. Captured stdout47567 bytes and stderr0 bytes. Only the newly created Popen child could have been killed on timeout/cap; no timeout signal was needed. Process creation or OS scheduling can add overhead beyond a requested deadline, so this is not a general hard wall-clock guarantee.
- UTC window: `2026-10-18T17:48:53.050003+00:00`–`2026-10-18T17:48:53.111149+00:00`. Asia/Shanghai: 2026-10-19 01:48:53.
- Runtime headers only:

```text
Active Internet connections (including servers)
Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)      rhiwat  shiwat    pid   epid state  options           gencnt    flags   flags1 usscnt rtncnt fltrs
```

Multiword Local Address and Foreign Address headers were normalized before checking the exact18-field schema; every captured nonheader row had the recognized TCP family, matching field count, and a parseable local endpoint. No parsing issues were found. No IPs or unrelated connection rows were persisted; the raw table existed only in bounded process memory and was discarded after extracting this summary.

| Local port | Address family | pid | epid |
| --- | --- | --- | --- |
| 8080 | tcp4 | 33747 | 0 |

The target PID set was `[33747]`; there was no target-summary truncation. The earlier known Signal snapshot was PID33747/birth1792336141.182036, read at UTC17:42:09. This probe did not refresh birth and does not claim that a seven-minute-old snapshot proves identity at the new temporal fence. A real gate still needs fresh PID birth matching and its existing same-repository uniqueness checks.

## What this establishes and what is still unknown

Unlike the generic local man entry, the actual installed binary exposes pid/epid columns. One global native TCP table observation was fast in this later window; that does not establish a stable latency distribution or a controlled speed comparison with the earlier three lsof timeouts. The parent-provided 01:43 system resource snapshot reported823 processes/89 runnable and about11.17GiB swap used of12.288GiB. That snapshot was not independently reread here, differs from the probe time, and does not establish a sole cause or ownership of resource pressure.

The table has one pid and one epid scalar per socket row. The local man page does not define those owner semantics. The two explicitly authorized SDK headers were present under `/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/`: `sys/socketvar.h` exposes `so_pgid` at lines124/147, while `netinet/in_pcb.h` has a NAT `nat_owner` field at line141; neither header establishes the runtime pid/epid mapping or proves that every process holding an inherited/shared listening FD is enumerated. The corresponding Xcode-app SDK paths were absent. No full-machine search or external source lookup was performed.

Therefore a singleton PCB pid set is not established as equivalent to global lsof FD ownership. Complete IPv4/IPv6 visibility, visibility across owners, PID/epid meaning, inherited/shared descriptors, socket and process generation races, and PID birth still need proof. A full table and a matching PID do not close those semantic gaps. The actual output is useful diagnostic evidence; it is not a replacement exclusive-owner PASS.

## Proposed strict replacement parser contract, unimplemented

1. Require successful bounded completion, EOF on both pipes, an exact supported header, no warnings, no cap/truncation, and valid structure for every TCP row. Unknown fields, malformed/shifted rows, or unparseable local endpoints mean `UNKNOWN`; never silently skip a row that could conceal another8080 listener.
2. Establish complete IPv4/IPv6 scope and PID/epid ownership semantics separately. Unsupported visibility or unproved owner completeness means `UNKNOWN`.
3. Match exact local port8080 and LISTEN state; retain only numeric positive PID/owner and address family. Missing/wildcard/nonpositive/ambiguous owners mean `UNKNOWN`; no listener or multiple distinct owners fails closed.
4. Only after ownership parity is proved may a singleton match be combined with fresh known Signal PID/birth, existing repository candidate uniqueness, and the same temporal fence. A health response, scoped PID query, or bind failure alone is insufficient.
5. Persist bounded header/schema and8080 LISTEN PID/address-family summaries only. This report contains no implementation or gate approval.

## Digest clarification and artifact provenance

Root explicitly confirmed the prior failure SHA256 as `25619b4f8486d3b1b8c624b35645a8dadc0b1855dbe703c2e6c787c3b4e10856`. A fresh local hash matched. The earlier brief concatenated the word SHA with a digest beginning256, which caused the received text boundary to be parsed incorrectly. This was a messaging ambiguity, **not file drift**. The original report/JSON, including their raw received metadata, were preserved and not rewritten. Their current hashes and the exact SDK header hashes are recorded in the sibling JSON.

New detailed bounded record: `/tmp/wrd-port-owner-netstat-runtime-schema-20261019.json`. Both new artifacts are private mode0600. No service, Host, tunnel, watcher, browser, native input, build, Registry, source/index, or Git mutation was performed; this command only read the local kernel TCP table and made no network connection.
