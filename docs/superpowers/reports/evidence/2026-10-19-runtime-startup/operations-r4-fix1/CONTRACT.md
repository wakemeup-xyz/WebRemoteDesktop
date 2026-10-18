# Root-owned input contracts

This describes future records; none is manufactured by preparation. Every `{path,sha256}` reference is an absolute bounded path plus actual SHA256. Operational JSON files must be regular0600 with the expected owner and no symlink ancestor. Root must preserve all prior one-use records. Exact keys are enforced where noted below.

## Execution approval

Root creates `EXECUTION-REVIEW.json` in this package only after independent review of its sealed manifest. Exact keys: `schemaVersion:1`, `scope:"viewer-tools-successor-r1"`, `packageManifestSha256` (actual SHA256SUMS.json digest), `independentReview:{path,sha256}`. The manifest covers every preparation payload except itself and future root execution review/operational artifacts. Package guard requires all listed bytes unchanged. This approval never authorizes tunnel or Host restart.

## Final binding

`FINAL-BINDING.json` is prepared metadata, not execution evidence. Exact keys: schemaVersion1, sourceTIP41c7b09 full40, viewerSourceTIPfefc555 full40, toolTIP2822441 full40, sourceReview{path,sha256} for root fix3. Final source gate requires held sourceHEAD, exact c802→final full-index canonical patch and ordered57 paths, four promotion paths and53 notPromoted docs, all old/new component bytes/modes and review refs. Source receipt status must equal APPROVED_SOURCE_ONLY; draft/earlier receipts do not qualify. Real filesystem preimages stay0600.

## Deployment decision

Exact keys: `schemaVersion`, `kind`, `deploymentId`, `packageManifestSHA256`, `sourceReviewSHA256`, `failedHistory`, `windowLowerMs`, `windowUpperMs`, `operation`.

Values: schemaVersion1; kind `root-new-frontend-deployment`; operation `source-copy-and-restart-signal-only`; fresh32lowerhex deploymentId; actual package/source receipt digests; all3 failures in historical order. Window clocks are integer epoch milliseconds, nonnegative, upper>lower, width≤600000; freeze requires lower≥current epoch. No automatic regeneration if a window or one-use operation is consumed.

Freeze outputs frozen.json/hash plus exact four candidate blobs, full Viewer+five builder input closure, old14 dist, code hash closure and knownmap prehash. It preserves every file, including documents outside copyPaths, through the1016 expected map.

## Asset review

Exact keys: `schemaVersion:1`, `frozenSHA256`, `templateRelativePath`, `templateSHA256`, `buildResultSHA256`, `independentReview:{path,sha256}`. templateRelativePath is the actual one-level two-time-template-* output directory. The source copy and reload require a successful actual two-endpoint build with acceptable lifecycle/no signals; actual dist is matched to template, permitting only bounded current builtAt fields. Template output graph supplies the new count and buildId.

## Known-attempt quiescence

Root uses prepare-deployment-quiescence.py separately for apply and reload after prior preparation. The exact receipt includes schemaVersion1, kind `root-three-failure-quiescence`, packageManifestSHA256, frozenSHA256, sourceTIP, deploymentId, phase, applySHA256 (null for apply; actual hash for reload), failedHistory, knownIdentities, observation, scope `task-known-recorded-identities-only`, fullProcessTreeExit `unknown`.

The list must be exactly the21 distinct PID/birth identities from all3 closed failed attempts. Gone, zombie or nonmatching birth are quiescent; alive matching, unknown, missing identity, unclosed historical record or reversed clock refuses. Receipt clocks must be within60s at each publication/reload check. The same known list is reobserved directly before each file replace and Signal helper invocation; no unrelated PID discovery/signals are added. No receipt or a stale receipt stops action; there is no retry or fresh automatic receipt.

## Actual mixed offline integration

Run the prepared checker only after its independent review. Root must run it after private asset review and before source apply. It consumes final source checkout, exact FINAL-BINDING SHA and actual template buildId; it has no dependency on runtime readiness. Its output is not live acceptance.

Root receipt exact keys: `schemaVersion:1`, `kind:"root-mixed-native-pure-integration"`, `sourceTIP`=final41 full40, `toolTIP`=282 full40, `viewerBuildId`=actual reviewed template buildId, `componentPins`={signal:dfb,host:dfb,viewer:fefc,tools:282 full40}, `checker:{path,sha256}`, `independentReview:{path,sha256}`, `result:{path,sha256}`, `actualExitCode:0`, `classification:"passed-offline-only"`.

The actual result JSON must equal the checker's emitted object: result `pure-native-startup-integration-only`, methods4, accepted2, rejected10, rows1262, sourceTIP, viewerBuildId and those componentPins. No synthetic successful result is accepted. The immutable R6 consumer manifest remains4b0ea13281c859ef38ac6ddb62a3bf3f642b3fba14abc61ef6993c0fda0d30b8. A checker failure stops root before applying source; the code later enforces successful evidence at sequence admission.

## New sequence decision

Exact keys: schemaVersion1, kind `root-new-frontend-context-sequence`, sequenceId, packageManifestSHA256, sourceTIP, toolTIP, deployment, readinessSHA256, offlineIntegrationEvidence, failedHistory, automaticLaunch=false.

`deployment` exact keys are `frozen_dir`, `frozen_sha256`, `asset_review`, `asset_review_sha256` and refer to this new successful deployment. offlineIntegrationEvidence is the actual receipt reference above. Readiness must trace successful or narrowly eligible reconciled reload evidence, exact new assets and new Signal/same Host. Old second/third sequence identities are rejected; no old failed sequence advances. The former R6 attempt has separate frozen/run identity, preserved in historical refs.

## Each scenario decision

Exact keys: schemaVersion1, kind `root-one-scenario-attempt`, sequenceId, attemptId, runNonce, scenario, mode, origin, productTIP, toolTIP, priorFailureSHA256, failedHistory, sourceTIP, previousResult.

All identifiers are distinct fresh32lowerhex; old known nonces and second/third sequence/attempt IDs are rejected. Mode `relay`; origin formal `https://link.stockhub.wiki`. priorFailureSHA256 is third5ef3358..., failedHistory includes all3. First baseline previousResult=null; each later case references the actual successful immediately preceding scenario result in this same sequence. Budgets are300/390/390/10800 seconds. A scenario reservation is consumed before runtime preparation; its failure does not clear that reservation. Runtime-manifest schema remains producer-compatible with separate backend/source tree, Viewerfefc/build and final tool source file pins.

No automatic launch, next attempt, owner clearing, reclaim, proof/ticket operation or retry is included. Each real scenario requires fresh strict idle/human-priority preflight even if the prior final occupancy was idle. Ordinary terminal integrity may observe normal post-close occupancy without claiming it belongs to the worker or draining it.

## R3 builder endpoint diagnostic evidence

Each endpoint child result must now include processDiagnostics (exact schema2 diagnostic-only roleworker snapshot) and diagnosticsErrorClass=null. Snapshot fields are schemaVersion/scope/role/events/dropped/failed/expectedStateExitCounts/gaps/gapsDropped/overflow/limits. failed=false, all overflow flags=false, dropped/gapsDropped=0; limits events32/gaps32/contextDepth8/counter2147483647. Lists, counters, enums, nullable identity fields, finite clocks, event ordering, direct scan association and serialized≤32768bytes are validated. Supported events alone do not override unchanged Registry decisions; original coverage/signals/full-tree constraints are still mandatory. Old endpoint records without diagnostics are not valid new R3 build evidence. No actual diagnostic snapshot is pre-created by preparation.


## R4 immutable object read optimization
Only full40 revision/path/tree-OID-bound successful Git blob bytes may be cached in-process; no live state/HEAD/tree/receipt/source/dist/service/ownership cache. Strict batch frame/SHA1/EOF/exit and bounded atomic publication; no error fallback. Cache1024 entries/128MiB, blob32MiB, Git30s unchanged, PIPE acceptance bound not hard OS capture limit. Existing60s quiescence,5s global lsof,all21 identities and600s window retain every original check. Fresh R4 manifest/context/review required; old R3C records never replay.

R4-fix1: only the immutable reader uses git --no-replace-objects for BOTH ls-tree and cat-file --batch; other commands/ENV unchanged. Full40/raw path/OID plus verified blob SHA1 defines cache identity. Existing canonical/content/tree pins continue independently and reject disagreement; this local tightening does not promise equivalence for all replace-ref cases. Initial sealed R4 is preserved unapproved/unexecuted.
