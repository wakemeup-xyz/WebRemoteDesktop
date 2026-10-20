# Narrow F1 revision review

Date: 2026-10-19. **Verdict: Approved. F1 addressed.** No new Important/Critical finding in the supplied fix diff.

Reviewed package: `.superpowers/sdd/2026-10-19-after-grace-peer-ownership-plan/review-6f9d830..b9d2aaf.diff`, supplied BASE `6f9d830a96149d0ff01153fedf2c311c4d9a8696` → HEAD `b9d2aaf0dd1c96fe41468ec4434d99b774f6e946`. Scope was the original Important finding and newly changed examples only; unchanged design was not reopened. Commit identities are those supplied in the immutable review package, not independently revalidated through Git.

## F1 resolution

The revised spec and Task 1 Step 2 now require the actual MediaActivity controller/runtime in the same VM, explicitly initialize them and assert their existence. Permissive runtime/gate substitutions are prohibited. The helper's real manual-pause transition establishes a positive-generation request; this avoids accidentally claiming recovery ACK coverage from the legitimate generation-zero initial active path.

The request helper selects the actual emitted current-attempt/current-generation request; `ackMedia` routes simulated Host output through real `handleMediaActivityAck`. The main test requires resuming/closed gates before ACK and after ACK alone, then actual current rVFC before active/open media gates. Added matrix entries cover frame-before-ACK using the existing early-frame replay semantics and rejection of old attempt/generation proof. Real Input reset acknowledgements remain an independently asserted prerequisite, with final effective Input gate asserted rather than inferred from media state.

This closes the original absent-runtime/default-allow loophole without broadening product scope or relaxing a gate.

## Targeted API compatibility check

Read only the changed examples and directly relevant source:

- `media-activity-controller.js` exports onto `window` when present, accepts `manual-pause`, and increments generation on true/false changes; the new VM alias and positive-generation setup match it.
- `media-activity-runtime.js` exports onto `globalThis`; `beginDesired` requires a positive generation, resume ACK remains resuming until a rendered frame, and snapshots include the exact `lastAck` fields asserted by the plan.
- `webrtc.js` real apply/replay methods establish the request and resume baseline, while the previously reviewed real ACK/frame path supports early-frame replay. The new plan correctly avoids requiring a second frame after ACK when the saved early frame belongs to the current baseline.
- The existing `initial visible attempt binds active media without requiring a resume request` test confirms the loading pattern and legitimate generation-zero distinction used in the revision.

No new example/API mismatch requiring a plan change was found. The documented pending-startup variant must continue to withhold its initial paint as already specified; the completed fixture's default paint is not evidence for that separate case.

## Gate boundary

Approval clears this design/plan F1 gate only. Actual platform fake completeness, expected baseline RED, GREEN, all callback/ACK-order cases and final candidate review remain to be demonstrated during implementation. No tests, services, network, browser/native or process operations were performed, and source/index/HEAD were not changed. Only this report was written. Deployment, fresh ordinary qualification, visible/native/physical effects and continuity remain outside this review and unmeasured.
