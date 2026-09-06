# Task 2 report: bounded preset matrix

## Scope and boundaries

Implemented the data-only `ultrafast` control and sole `superfast` candidate,
five independently gated ScenarioRuns per resolution, actual codec-creation
record validation, and `--matrix relay-preset-refinement`. Production policy
selection, Viewer payloads, environment parsing, services, and tunnels were
not changed. Runtime gates remain `NOT RUN`.

## TDD evidence

- **RED:** `python3 -m unittest -q scripts/test_turn_encoder_experiments.py`
  failed because `scripts/turn_encoder_experiments.py` did not exist
  (`FileNotFoundError`).
- **GREEN:** `python3 -m unittest -q scripts/test_turn_encoder_experiments.py
  scripts/test_eval_turn_encoder_quality.py` passed: 17 tests. The contract
  rejects preset/options drift, incomplete scenarios or frames, NaN, wrong
  IDRs, safety-net drift, and codec reopen; it permits a complete control that
  has a quality failure to remain comparable.
- Final syntax and whitespace checks also passed:
  `python3 -m py_compile scripts/turn_encoder_experiments.py
  scripts/eval-turn-encoder-quality.py
  docs/superpowers/reports/evidence/2026-09-05-turn-quality/encoder_probe.py`
  and `git diff --check`.

## Offline execution

Maintenance was proven immediately before execution with
`/api/status`: `viewerCount=0`, `relayViewerCount=0`, empty `viewers`, and
`viewerEpoch=41`. No service was restarted or stopped.

The one bounded run was:

```bash
nice -n 15 /Users/macstudio1/.homebrew/opt/python@3.11/libexec/bin/python3 \
  scripts/eval-turn-encoder-quality.py --matrix relay-preset-refinement \
  --output /tmp/wrd-next-preset.json
```

It completed in about 21 minutes 38 seconds and was archived as
`docs/superpowers/reports/evidence/2026-09-06-turn-next/relay-preset-refinement.json`
(SHA-256 `91713be6ee85ccf8ec5522441153e88119fdffad57033e5970627e304a1c05b4`).
The evidence contains its execution-time source digests and input digest
`a83d190307d46b7c6482044561449c01d95825196ee2af84d4a74590f30e4434`.

The result was `no-offline-winner`; runtime gates are all `NOT RUN`. The fresh
control was structurally rejected because the first implementation incorrectly
required an `initial` IDR at the start of the continuation-only
`post-scroll-static` phase. Its actual frames had only the required requested
IDRs at 305 and 500. The validator was corrected and covered by the final
green tests, but this changes a source file covered by the run digest; the
archived run must not be reused as evidence for the corrected code. Per the
one-run bound, no automatic rerun was performed and the candidate was not
measured.

## Concerns

- The corrected matrix has code/test evidence only. A new user-authorized
  maintenance-window run is required for a candidate result.
- This task intentionally does not establish any TURN, Viewer, input, loss,
  or production readiness result.
