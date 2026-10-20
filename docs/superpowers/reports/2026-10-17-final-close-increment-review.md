# Final close-metadata incremental review

## Findings

No actionable P0/P1/P2/P3 findings identified in 2a55ac5..0f29c45. Correctness, security/privacy, architecture boundaries and active documentation consistency pass this incremental review. This verdict approves the diagnostic-tool/docs increment for controlled synchronization; it is not a live-acceptance verdict.

## Reviewed scope and evidence

Read the committed four-script diff, surrounding observer/validator and supervisor integration, binding owned-turn-long spec/plan and amended observer contract, task review, new diagnosis entry, deployment/acceptance headers and signal/media/recovery/boundary reports. Runtime product code is unchanged in this range; afd598a runtime review/deployment is supplied prior evidence, not reverified here. The task review records Node22/22 and Python42/42 PASS; no specific new test concern justified rerunning those tests.

- Security/privacy: ec projection has exact transport-close/description gates, catches unreadable metadata, copies only validated integer code1000..4999 and boolean wasClean. It does not enumerate/retain context, native reason, URL, error text or packet content. Python accepts exactly the two nested keys and rejects boolean/float codes. Missing metadata remains absent.
- Compatibility: new schema1 reader accepts historical ec without ws. Old strict readers reject new ws records; this is explicitly documented, so the helper/sampler must be delivered as a pair. This is not bidirectional compatibility.
- Budgets/identity: event192B, ring128, delta16/4096B and final32768B remain enforced. New metadata is bounded primitives. Registration, old-object c=false semantics, cursor/order, first terminal preservation and cause=unknown are unchanged. Late ec cannot rewrite earlier sd/mc. New test coverage includes getter failure, invalid values, bridge validation and flood budgets.
- Architecture: this is a narrow acceptance-observer extension, without a second product transport implementation or new attribution engine. Admission, fresh-zeroViewer, one-use proof, first-failure termination, media settings and thresholds are untouched. No production deployment/restart is required to load an injected acceptance sampler.
- Documentation: active plan/spec explain the exception to the old no-helper-change rule and old-reader limitation; current entry and execution/acceptance headers preserve failed outcomes and distinguish deployment, synthetic tests and runtime qualification. Historical review snapshots remain explicitly baseline-specific. No material false PASS claim found.

## Rollout integration prerequisite (pending, not a defect)

Read-only hash check confirms supervisor currently pins exactly the old helper/sampler in the primary checkout, with BASE pointing there. execute rejects mismatches before creating an output directory or worker. Source synchronization and explicit paired pin refresh are still pending as declared by the controller. Before future use, synchronize both reviewed scripts, set both exact pins and run the supervisor fakefixture verification. Do not weaken the equality check or rewrite prior run hashes/artifacts.

Reviewed new hashes:
- passive_session_soak.py: f84777d8de0bda53f5a46400c2cd91d5d91f4d84ca364567d1cf58f11467c418
- passive_session_sampler.js: d3a426786a7d31feeace6d395662ea850aa4678361f635c16d65900162a42f5d

## Acceptance gaps that remain open

Directly read original a/b summary.json and supervisor.json. A is INCOMPLETE,256.071958s,256samples,max8116.308ms and sampleTriggered=true; B is INCOMPLETE,131.952546s,132samples,max783.3ms and sampleTriggered=false. Both request10800s and explicitly do not establish complete process-tree exit. These match the active reports; no short-window concatenation or supervisor wall-time promotion was found.

Three-hour continuity, ordinary-user automatic recovery with restored actual input, native/visible-effect timing, runtime profile/FPS transition qualification, usable Host stall stack and WebSocket initiator attribution remain unestablished. Existing reports correctly separate ACK/post-apply frames from real visible effects and do not assign Cloudflare responsibility from transport-close. New ws metadata has only synthetic evidence so far; code1006/wasClean cannot establish the closer. Waiting for the already-requested human test does not authorize another concurrent Viewer.

## Final verdict and limits

PASS for the reviewed increment, with the declared source/pin/docs synchronization still to be completed by the controller. Overall stability and real-input acceptance remain INCOMPLETE/NOT RUN. No network/browser/native input/services/build/install/sample actions, no source/index writes, and no subagents used. Only this requested private0600 review artifact was written. Review anchor is handed off here for controller persistence in the repository, because this review explicitly forbids repository writes: reviewed up to 0f29c45 on 2026-10-17 Asia/Shanghai.
