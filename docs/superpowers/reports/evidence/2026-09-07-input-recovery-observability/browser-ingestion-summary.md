# Browser-to-Signal ingestion evidence summary

Date: 2026-09-08
Scope: `offline-synthetic`; actual offline Viewer producer plus actual Signal diagnostic ingestion function, persistence disabled. This is not a live Socket/public-origin or DataChannel delivery proof.

Command:

```bash
python3 .superpowers/sdd/2026-09-07-input-recovery-observability-plan/root-browser-ingestion-probe.py
```

Observed safe result:

```json
{"scope":"offline-synthetic","accepted":true,"matchedSends":5,"recoveryState":"waiting","finalGateAllowed":false,"traceEvents":18,"persistenceEnabled":false}
```

Exit: `0`.

The probe creates the real offline DOM click → blur/focus input trace, then feeds the resulting safe payload to `ingestDiagnosticPayload`. Optional hash/reason fields may be omitted or `null`; both mean unavailable and are not treated as a fabricated success. Raw IDs, payloads, text, coordinates and credentials are intentionally not recorded here. DataChannel input bypasses Signal, so absence of a Signal input-relay record cannot by itself establish a DataChannel loss.
