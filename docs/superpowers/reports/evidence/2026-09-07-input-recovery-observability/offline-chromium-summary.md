# Offline Chromium evidence summary

Date: 2026-09-08
Scope: `offline-synthetic` only; local source fixture, no credentials, no origin, no service.

Historical Task 4 delivery command (`2ddbc15`):

```bash
python3 scripts/mobile_input_interaction_acceptance.py --browser chromium \
  --out /tmp/task4-final.json
```

Independent JSON validation of that single run:

```text
scope=offline-synthetic browser=chromium scenarios=20
network.requests=0 network.sensitivePayloads=0
all_status_pass=True all_checks_true=True
exit=0
```

The run used actual Playwright locators/DOM events and checked actual offline wire side effects. The network route is deny-by-default and aborts every attempted request. `sensitivePayloads` is only a bounded URL/body marker count; it is not a general secret detector. Artifact privacy is established separately by the allowlisted scenario-summary test and its sensitive-field canaries.

Required exact outcomes included in the run:

- physical timeout: 2 accepted writes, 2 ACK timeouts, 1 incident;
- touch timeout: 2 accepted writes, 2 ACK timeouts, 1 incident;
- IME timeout: 1 accepted write, 1 ACK timeout, 1 incident;
- long-press deferred: 1 send, 1 timeout, 1 incident, 0 accepted ACKs;
- drag-start deferred: 1 send, 1 timeout, 1 incident, 0 accepted ACKs;
- 17-step delete drain: 17 sends, first 16 synchronous ACKs, 1 final timeout, 1 incident;
- each delayed send has a safe originating event identity;
- mouse-up, physical key-up and touch-up release-only loss: 2 sends, 1 down ACK, 1 release timeout, 1 incident each.

This summary intentionally omits raw input IDs, text, key/code, payload, coordinates, URL, credentials and browser console bundles. See the durable [Task 4 acceptance report](../../2026-09-07-input-recovery-observability-acceptance.md).

## Final primary verification and remaining FAIL

On implementation `cc9ef32915c2988215cf655f68efdcca329d1bf1` (reviewed delivery
`2b49d5918063ead78f0a52cc6941df0a09448de4` changes only docs), the primary ran:

```text
node --test scripts/mobile-input-interaction-acceptance.test.js
4 tests / 4 pass / 0 fail / 0 cancelled / 0 skipped
duration_ms=93357.448399 exit=0
22 scenarios, all PASS, checks nonempty and all true, network 0
```

The additional durable scenarios retain 5/5 accepted browser→Signal sends and
18/18 events during recovery waiting/gate blocked, and prove exact draft content
equality after reset and canceled 16-batch drain with no replay.

This green suite does **not** cover the final R4 residual:
[reproduce-modal-composition.py](reproduce-modal-composition.py) drives actual
modal DOM compositionend and reports one send, one timeout, zero incidents and
missing originating eventId; exit 1. The independent reviewer confirmed the
same defect with actual modules. Final acceptance remains **FAIL / R4 P2 open**,
not merge-ready. No physical/system IME/Quartz/live/public evidence is claimed.
