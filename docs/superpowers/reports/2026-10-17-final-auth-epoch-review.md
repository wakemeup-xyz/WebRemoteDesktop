# Final incremental auth/image-epoch review

Verdict: PASS for runtime correctness/security/architecture and scoped private sampler increment. One P3 documentation reconciliation item remains for the planned final documentation update; no P0–P2 findings.

## P3 — Retire the launch-time “current result unknown” statement

`docs/superpowers/reports/2026-10-17-live-acceptance.md`, final paragraph under “DC准入部署与三小时TURN验收启动”, still says “当前没有最终时长/连续性结论”. The same document now correctly leads with the completed 256.072-second INCOMPLETE result. Label the paragraph as launch-time history or append the final failure outcome/link there so the active report does not retain conflicting present-tense conclusions. This is documentation-only and does not invalidate the runtime fixes.

## Reviewed scope

Committed range `0ffb941..36cf393`, concentrating on runtime commits `e996467` and `83c513e`, their regression tests, associated viewer-auth-blocking/capture-image-epoch specs and plans, active acceptance/execution reports, failure-analysis and task-review evidence. Existing code was read only where needed to establish interfaces. Private `/tmp/wrd-owned-turn-probe-private/supervisor.py` independently hashed to `d99fb2896cbf627902b3792ee18ee79a219a549840c541a2d4871ef71ff82f24`; sampled its observation, bounded drain, trigger, ownership, and cleanup integration against the sample-observation spec and implementation/review records.

## Correctness and security

Auth removes request-time bcrypt work for an already plaintext configured shared secret and reuses fixed-length SHA-256 digest/timingSafeEqual comparison. Valid configuration must be a nonempty string; absent/invalid configuration fails closed. Both route aliases retain one shared 20-request/15-minute limiter, existing missing-input 400/wrong-input 401 behavior, truthy String conversion, JWT role/subject/lifetime, and config loading. Full UTF-8 input including suffixes beyond 72 bytes is intentional; no trimming/normalization or secret logging was introduced. Admin/Host interfaces are unchanged. Tests cover these boundaries and prohibit bcrypt computation.

Capture now invalidates image state only when normalized effective target dimensions change; a real resize advances once and releases prior reservations once. FPS changes retain interval updates without invalidating pixel data. Caller behavior receives effective sizeChanged; policy admission and encoder policy are unchanged. recv still compares image and capture epochs after awaiting its worker; stop/suspension/resume fences remain. Cache output retains its original capture identity, is not fresh, and does not create a new M2 reservation. Genuine fresh work across FPS changes remains valid. A pacing change can take effect on the next pacing interval, consistent with the existing asynchronous pacing architecture. Synthetic regressions cover cache, in-flight FPS/resize, caps, release counts and blank prevention.

Private observation separates timeout detection, first observed exit and finalization, preserving timeout outcome. It polls/deadline-checks before bounded nonblocking drainage, caps per-call reads at 64 KiB and retained private prefix at 16 KiB, and retains 10-second budget/8 MiB report limit/one trigger/target identity and registered-child cleanup. It does not automatically claim valid stack content from file existence. No new production signal or retry path was found.

## Architecture and evidence limits

Changes fit the existing auth helper and image-generation ownership boundaries without duplicate caches, workers or configuration truth. FPS/bitrate policy remains independent of pixel validity. The private sampler stays outside production helpers.

The failed long run remains failed: 256 seconds, maximum gap about 8.116 seconds, Host heartbeat/lease loss. First stall preceded adaptive profile changes. Neither fix establishes an OS-pressure root-cause fix, three-hour stability, ordinary-user reconnect acceptance, or native input-to-visible latency. Production Host stacks remain unknown. The separately reported 3.622-second owned-child sample proves only that specific harmless target capability, not production Host behavior or future pressure resilience.

No tests were rerun in this final static review. Parent-reported independent 25 auth and 105 Python test passes (three constructor cases excluded), and private 19 implementation/16 pure review passes are supporting evidence, not newly reproduced or additive unique counts. Existing native/long-run acceptance omissions remain explicit. No services, network, browser, native APIs, broad tests, installs, builds, source/index changes or Cloudflare operations were performed. Four watcher files were outside scope and untouched. Runtime deployment has not been inferred from source review; root must separately document exact loaded candidate and acceptance.

This report is private mode 0600; no repository review anchor was written under the explicit review-only/source-index constraints.

## Focused documentation re-review — P3 CLOSED

Read the amended live-acceptance.md paragraph at line 184 in the candidate worktree. It explicitly labels the paragraph as the 14:49 launch-time record and now states the final 256.072-second INCOMPLETE outcome, maximum 8116.308 ms gap, Host heartbeat timeout, zero-byte sample, and links the failure-window analysis. The conflicting present-tense unknown-result statement is removed. P3 is CLOSED; overall scoped review PASS with no outstanding findings. This follow-up only read the requested paragraph and appended this private report; no tests or runtime actions, and no expanded review scope. Earlier coverage/acceptance limitations still apply.
