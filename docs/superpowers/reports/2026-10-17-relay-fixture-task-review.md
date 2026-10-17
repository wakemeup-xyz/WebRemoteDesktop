# Independent relay fixture review

Verdict: **APPROVED**. No actionable spec-compliance or quality findings.

Reviewed commit `cae6650c73433a7bc68e2f4885bf81f4f4f2357e` against `509220db01c04cccbe9696322a3dc8639672d08d`.

## Spec compliance

- The commit changes only `web-client/js/input-signaling-continuity.test.js`; the actual Git changed-file list matches the supplied diff. No production edits, threshold changes, or weakened validation were found.
- The relay-only helper supplies schema version 1 and exactly the five required scope fields. It calls actual `handleMediaActivityAck` and `handleRelayFrame`; the non-relay helper is unchanged.
- Retained-load coverage first authenticates each origin and captures an installed production image callback. It replaces the attempt, then replaces producer/media identity, invokes the retained callbacks, and preserves the negative resuming/null rendered-frame assertions. The current replacement becomes active only after its qualified onload.
- Refresh begins with authenticated scope and actual image onload, exercises the real refresh and explicit media-control replay, and derives the replacement media generation from the emitted request. It rejects the previous ACK/frame, rejects a current frame before authentication, and checks both ACK alone and image arrival alone remain resuming before current onload activates it.
- Neither selected scenario uses ordinary start. Accordingly, no synthetic pending-start correlation is needed or introduced. Neither repaired scenario injects generic `noteMediaRenderedFrame` proof.
- Existing negative identity and freshness assertions outside these blocks remain intact; the removed generic old-ACK check is replaced by explicit old-origin ACK/frame rejection at the refresh boundary.

## Quality and evidence

Read the task brief first, implementation report, supplied review diff, linked M6 addendum, prior clock review/classification, relay fixture setup, and relevant production ACK/scope/frame/onload handlers. The test flow matches the current strict relay admission and image proof contract. The dummy base64 data is intentionally used with the existing VM image double; this establishes handler behavior, not browser decoding or optical presentation.

The implementation report records RED at the two documented stale fixture boundaries, targeted GREEN 2/2, full continuity GREEN 33/33, and adjacent GREEN 156/156. These results are attributed to the implementer; no redundant suite rerun was warranted by a concrete uncertainty in this review. No runtime, browser, network, service, native-input, index, commit, or subagent operation was performed. This review only writes this ignored review report.

Offline approval does not establish deployment or real-session acceptance.
