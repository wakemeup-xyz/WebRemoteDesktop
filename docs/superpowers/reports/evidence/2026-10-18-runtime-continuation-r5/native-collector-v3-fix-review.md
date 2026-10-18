# Native latency collector v3 — scoped second fix review

**Approved for the reviewed draft/offline wiring scope. No remaining finding in this fix delta.** This is not source implementation approval, test evidence, operational authorization or native acceptance.

## Disposition

**V2 fix-induced P2, trace-action dependency: ADDRESSED.** V3 design lines 61–66 and 87–92 make `captureControlledTransportSnapshot()` a no-argument, read-only snapshot of the two fixed current send candidates, reliable ACK source, socket object/ID and PC. The existing LatencyMonitor slot selects the applicable candidate from its immutable reserved type/action only after that metadata matches a genuine accepted-send observation. ACK ID/wire type, scope/lease, actual transport and saved/current source fences remain required. Trace action hints, `_unorderedTraceSends`, `peekInputAckMetadata`, hint availability and Date.now no longer select or qualify controlled evidence. Existing trace calls retain their original independent purpose.

The design and plan agree on the new no-argument signature. Task 1's live-snapshot fixture, Task 2's hook/fixture calls, adapter reads and final-read source selection use the same candidate model. Unused branches may change without invalidating the active branch; the reliable ACK source remains separately checked for moves. This removes the trace dependency without introducing another getter, callback, transport policy or authority path.

Plan Task 2 Step 4a explicitly covers trace available/unavailable × wall-clock shift -60000/0/+60000 through actual accepted move and ACK methods, retaining original Performance timestamps. It preserves real trace recording/pruning and ACK validators, supplies only the trace capability/fake platform, and requires wrong-source, unknown-ID and suppressed-move negative cases under those variants. These are planned checks, not executed results.

The original three P2 items remain **ADDRESSED**, as established by the v2 scoped review: current-source fencing at final read, explicit original clocks in fixed step/artifact schemas, and bounded independent M2 completion with callable finalization. Their unrelated contracts were not reopened for a comprehensive new review. No new signature, source-selection, privacy or authority breakage was found in this v2→v3 delta.

## Identity and limits

Read the v2→v3 design/plan diffs and the changed v3 references/fixtures. Independently computed SHA-256 values match the supplied identities:

- `/tmp/wrd-native-latency-collector-design-draft-v3-20261018.md`: `19fd4ed9c9981caf7fc72c94c9714e090fec52d40d9373a8bfde1056fda41e84`.
- `/tmp/wrd-native-latency-collector-plan-draft-v3-20261018.md`: `64b5318b573c2618a2efdaeaee34bb8bf77dfe76c2a2d6b5a6467e72be414e20`.

Only this requested review file was written; prior drafts/reviews and repository source were untouched. No implementation, tests, project imports, builds, Git/source/runtime/process/health/network/browser/service/native operations were performed. No subagents were used. Parent reports current source `3662573` held for unrelated runner review; this scoped review neither inspected nor qualifies that work. Draft source/deployment wording remains historical provenance to reconcile before a versioned handoff.

An independently isolated Mac/macOS guest remains unresolved. All native/proof/lease/reset/rebind/media guards and ordinary-run NOT_RUN boundaries remain. The current six measurement values remain null/NOT_RUN. Approval of these draft contracts supplies no numerical runtime evidence or native/visible/physical/long-session acceptance, and grants no implementation or live-test start by itself.
