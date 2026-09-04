# Task 5 report — documentation sync and acceptance record

## Status

DONE_WITH_NOT_RUN

自动化验收已完成；真实设备、物理 Quartz 和公网/tunnel 验收按要求保持 **NOT RUN**。

## Changed documentation

- Updated the six active designs named by remediation spec §2.9. Their status now reflects implemented or partial scope, with physical/public boundaries explicit.
- Updated `docs/需求文档/WebRemoteDesktop-需求文档.md` §5 so `https://link.stockhub.wiki` is the formal entry and `/tmp/wrd-safe-current-url.txt` is diagnostic-only.
- Updated `README.md` and `docs/runbook-safe-startup.md` with the relay paint/SPS SLA: ≤2s chase is allowed, UI stall begins at ≥2s, the failure line begins at ≥3s, and Host SPS refresh retains the healthy-sample gate plus 12s cooldown.
- Updated the current remediation plan checkboxes for Tasks 1–5 and scope checks; physical/public acceptance remains an unchecked `NOT RUN` item.
- Added the detailed acceptance record at `docs/superpowers/reports/2026-09-03-remote-desktop-control-continuity-acceptance.md`.

## Verification

- `node --test web-client/js/*.test.js web-client/css/*.test.js`: **572 passed, 0 failed**.
- Prescribed `cd signal-server && npm test`: blocked before tests by missing isolated-worktree `esbuild`; no dependency installation was performed.
- Complete Signal suite using the existing dependency tree and serialized Node test startup: **323 passed, 0 failed**.
- `cd python-host && PYTHONPATH=. python3 -m pytest -q`: **212 passed, 0 failed**, one existing `mss.mss` deprecation warning.
- `git diff --check` and staged-scope checks are required before commit.

## Acceptance boundary

The automation matrix covers all 15 control-continuity regressions. Real Android/iOS/iPad browser behavior, narrow-screen physical geometry, macOS Quartz/IME/long-press behavior, formal public URL health, and tunnel media behavior remain **NOT RUN**. No tunnel or service action was taken.

## Commit

`docs: sync control-continuity status and record acceptance`
