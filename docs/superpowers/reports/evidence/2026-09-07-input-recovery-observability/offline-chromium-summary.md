# Offline Chromium evidence summary

Date: 2026-09-08
Scope: `offline-synthetic` only; local source fixture, no credentials, no origin, no service.

Command:

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
