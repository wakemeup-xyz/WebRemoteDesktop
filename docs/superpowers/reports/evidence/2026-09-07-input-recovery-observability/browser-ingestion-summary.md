# Browser-to-Signal ingestion evidence summary

Date: 2026-09-08
Scope: `offline-synthetic`; actual offline Viewer producer plus actual Signal diagnostic ingestion function, persistence disabled. This is not a live Socket/public-origin or DataChannel delivery proof.

Durable command (implementation commit `cc9ef32915c2988215cf655f68efdcca329d1bf1`):

```bash
python3 scripts/mobile_input_interaction_acceptance.py --browser chromium \
  --out /tmp/wrd-input-final-fix-cli-v2.json
```

Observed safe result:

```json
{"scope":"offline-synthetic","scenario":"browser-signal-ingestion","status":"PASS","producerAcceptedSends":5,"ingestedAcceptedSends":5,"producerTraceEvents":18,"ingestedTraceEvents":18,"recoveryWaiting":true,"effectiveGateBlocked":true,"persistenceEnabled":false,"network":{"requests":0,"sensitivePayloads":0}}
```

Exit: `0`.

The durable scenario creates the real offline DOM click → blur/focus input trace, then feeds the resulting safe payload to `ingestDiagnosticPayload`. It compares the producer and receiver accepted-send correlation and safe gate/recovery/surface state; optional hash/reason fields may be omitted or `null`, both meaning unavailable rather than a fabricated success. Raw IDs, payloads, text, coordinates and credentials are intentionally not recorded here. The earlier `root-browser-ingestion-probe.py` remains only a historical ignored scratch seed and is not required for reproduction. DataChannel input bypasses Signal, so absence of a Signal input-relay record cannot by itself establish a DataChannel loss.
