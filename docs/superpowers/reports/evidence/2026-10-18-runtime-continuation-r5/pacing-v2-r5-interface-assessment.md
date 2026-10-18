# Pacing v2 ↔ exact R5 static interface assessment

**Compatibility findings: none. Verdict: statically compatible for the documented interface binding.** This closes the pending static method/path/schema assessment against the exact final R5 package. It is not whole-driver execution evidence, runtime proof, deployment approval or root execution approval.

## Exact binding and integrity

- Pacing v2: `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-capture-pacing-private-v2-fgbxntxg`; verified manifest SHA-256 `fd58e215e2218e2b33a04932c14ed16f36001e191882280040431766a86283a1`, all16 manifested payloads matching.
- R5: `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-frontend-move-context-operations-private-r5-wive_sjb`; verified manifest SHA-256 `3983cba582cb5d972149739621cc5cd13f2b6f3f458713d2db4e8e181b73ab7f`, all45 manifested payloads matching.
- R5 independent review matches SHA-256 `96264a6cd0d0af58fed7d4fb7b1fe8f134caddc756f5574f72af921e79c520ba`; actual R5 EXECUTION-REVIEW.json names that review and manifest with the required `frontend-move-context-operations-r5` scope.
- Root checker result matches SHA-256 `5267d5384f73aa078278e7f2cf9e3f66a5fe55873f8f282bc9aa8169cac88793`. Its retained execution record says exit0, no timeout,5.690913898s, passed-offline-only,4 methods,2 accepted,10 rejected and1262 rows, Viewer source `c802a68362459b46b84593c7e8921575e0783394`, build `bb581651b422e400`, Host/Signal `dfb15434e79da90b803b763c533836e16c080c71`, tools `59bca14209eed299b0e94da58decb8b85e5ce70c`. These are existing root evidence, not checks rerun by this assessment.

## Import closure

Pacing `run-experiment.py:31`–`:38` resolves the selected operations directory, hashes its manifest and payloads, imports continuation_common, verifies that module's parent path and package_guard result, and loads ordinary-continuation-supervisor under a distinct non-main module name.

The actual R5 definition import closure is:

- continuation_common → deployment → bindings → core; deployment also imports asset_template → core.
- ordinary-continuation-supervisor → continuation_common, process_observation_diagnostics, validation_stages, qualification_evidence → operational_common → core.

All local modules in that closure are manifested. Static AST inspection found definitions, imports and constant setup; no operational main runs on those imports. core initializes path constants and an environment copy for its existing command wrapper; this is not an environment dump or a runtime probe. The ordinary supervisor's main is guarded by `__name__ == '__main__'`. Process/native/browser/network activity stays behind invoked runtime methods. No such imports were executed during this assessment.

The later dynamically loaded dependencies are also compatible: core.load_owned hashes the immutable SUP before compile/exec under a non-main module name; qualification_evidence.load_passive_validators hashes the pure passive helper before definition loading. Pacing's own runner import resolves the existing primary `scripts/ordinary_session_recovery.py`, which imports the unchanged pure passive helper. The current primary and pinned source checkout bytes for runner/helper/sampler match each other; their digests are recorded below. Future admission must still pass R5's actual source/assets/runtime guards at execution time.

## Actual calls versus R5 contracts

| Pacing v2 call or consumed value | Actual R5 definition/contract | Assessment |
| --- | --- | --- |
| load_ops → common.package_guard() | bindings.py:60–65 checks exact R5 review scope/manifest/payloads and returns the manifest SHA string | Compatible; uppercase `manifestSHA256` in the pacing decision is its own schema, while package_guard internally uses R5's `packageManifestSha256` receipt field |
| c.attempt_context(bargs), with attempt_dir/attempt_sha256 | continuation_common.py:92–109 returns `(path,m,ref,a,manifest)`; :106 mutates args.runtime_manifest, runtime_manifest_sha256, sequence, reference and attempt | Compatible with `(bf,bm,reference,bpins,bmanifest)` and later bargs.runtime_manifest_sha256 use |
| Baseline result and started marker reads | ordinary supervisor :53 writes qualification-started.json with direct child outputDirectory; :122 writes qualification-result.json with classification/scenario/durationSeconds/attemptSHA256/sampleTriggered/completedRows/qualification/owned/sampleOwned/currentReadiness | Compatible with pacing :99–105 and :110. Fresh R5 baseline success remains required; none is assumed here |
| c.check_runtime_binding(manifest,bm,reference,pins,admission=True), later without admission | continuation_common.py:76–87 accepts these arguments and the exact native manifest keys; checks nonce/scenario/mode, time/expiry and420-second admission budget, product/component/build/origin/log bindings | Compatible. Pacing adds `_sha` only after admission and supplies raw re-read manifest at final revalidation, so exact-key validation is preserved |
| c.source_assets_guard(reference) | continuation_common.py:44–45 derives the reviewed applied deployment and validates rendered assets against reference['assets'] | Compatible, including reference['_deployment'] populated by ready_context |
| c.health(), then c.health(require_idle=False) | core.py:147–157 returns healthy/hostOnline/viewerCount/relayViewerCount/observedAtEpoch; default requires idle, false permits bounded final occupancy | Compatible. Nonzero final occupancy does not grant another admission |
| c.load_owned(), c.SUP_SHA, c.PRESERVED | Exported through core→bindings→deployment→continuation_common; core.py:166–170 loads the exact SUP; constants at :11/:13 have the expected shapes | Compatible with Registry, SampleObservation, sample_limits and exact preserved PID/birth checks |
| c.validate_owned_coverage(worker_owned,sample_owned) | bindings.py:43–44 accepts variadic Registry result dicts, requires recorded identities exited and no unexpected coverage | Compatible; empty/uncertain registration and failures remain independently vetoed by pacing's worker status/error logic |
| c.validate_no_signals(worker_owned,sample_owned) | bindings.py:46–47 rejects any recorded signal | Compatible and conservative: an intervention cannot become a successful diagnostic collection |
| driver.Rows(folder/'session/samples.jsonl') and .read/.offset/.pending/.path | ordinary supervisor :20–35 exposes all consumed members, bounded newline-only rows, plain0600 file, identity/truncation/size fences | Compatible with pacing row draining/freshness/final coverage checks |
| driver.ObservationGate('baseline',build,pure), gate.observe(row), gate.pure | qualification_evidence.py:77–122 exposes these members; observe returns the same validated row at :121 and retains invalid observations as failure | Compatible, including pacing's `row is freshrows[-1]` identity check and original strict ordinary row validation before trigger logic |
| driver.load_passive_validators() | qualification_evidence.py:21–28 returns actual helper definitions after exact helper SHA check | Compatible with sample/gate/lifecycle validation and completed_result |
| driver.completed_result(prior_output,'baseline',bmanifest,prior_gate,pure), later folder/new manifest | ordinary supervisor :37–41 reads `out/session/summary.json` and `out/session/lifecycle.json`, validates terminal evidence, returns the same five-key qualification digest/scope object saved by R5 | Compatible with both actual baseline output child and separate diagnostic folder layout; pacing sets manifest['_sha'] for terminal_valid's projection check |
| runner._gates(sample,'relay') | unchanged producer _gates(sample,mode,*,recovery=False) returns a boolean based on strict input and passive continuity gates | Compatible with Trigger's exact-True check; baseline CLI and300-second scenario remain unchanged |

## Row, terminal and pin compatibility

R5 row_valid requires the exact ordinary schema fields consumed by Trigger: scenario/phase/elapsedSeconds, identity.sessionHash/socketHash/admissionHash and sample fields including transport, callbacks, size, inputAllowed, scopeStable, PC/attempt/generation/lease. Transport enum/path/codec constraints are checked before Trigger accesses them. Baseline phase order is startup→baseline→terminal, compatible with the trigger's allowed phases. ObservationGate returns the original row rather than a copy. Its strict duration/identity/event/Host checks remain unmodified.

completed_result delegates to terminal_valid, whose manifest projection requires `_sha`, nonce, origin evidence, product source commits and Viewer build. Pacing supplies these for old and new manifests at its actual call sites. Terminal summary/lifecycle paths, baseline no-fault contract, NOT_RUN business/native/visible/physical scope and returned qualification digest map all match R5. No path adapter or schema relaxation is needed.

The root mixed checker runs the pinned producer and byte-identical qualification consumer from its immutable R6 reference; I independently compared R5/R6 qualification_evidence.py bytes and found them identical (SHA `ea398d2260c405a6115808c3c5f3f975974974e62bc6cb88be61c414e0c941b4`). The actual producer/helper/sampler bytes in primary equal the held source checkout, with SHA values:

- ordinary_session_recovery.py: `dc4f678d70a11009a16062d48b597294e0360a280165a893da59b9c185322fb4`
- passive_session_soak.py: `b0a15095651c9147eb451b27eb815ec4ea4cc984f2d293d3617c4cee89a15426`
- passive_session_sampler.js: `f862b739cbe7eb543ccab304203c71c62a43014530fa2da9a7655cba293665d3`
- Immutable SUP: `d03cc2025f41d26c0079d3f820fdb2cd5479ae14448fb1c6f91c4589d6bd5c7b`, matching both packages.

These comparisons support the interface/producer-consumer identity binding. They do not prove pacing's whole-driver orchestration or native IO works.

## Remaining evidence and execution conditions

**Whole pacing-driver fake integration: NOT_RUN.** Its full main/import/admission/baseline replay/worker/sample/finalization orchestration has not been executed together by this assessment or established by the23 pure tests. **Native IO: NOT_RUN**, including actual PID-file/log descriptor race paths, psutil ownership observation, actual sample launch/attach/resource limits/cleanup and real browser/health/service integration. This report intentionally did not execute entry imports, tests, probes or any of those operations.

The actual future pacing decision must select this exact R5 directory/manifest and use canonical private paths required by pacing.read/ref, with current-owner0600 reference files. Pacing's own execution-review receipt is a separate diagnostic scope and schema; the R5 receipt cannot substitute for it. Source/component/build/deployment/origin/log identities must come from actual successful R5 deployment/readiness and fresh completed uninstrumented baseline. Root must still enforce fresh new-template build equality to the retained checker build result, actual asset approval and other R5 gates. No deployed state or valid baseline is inferred from frozen files or checker PASS.

No code or package change is required by this static compatibility assessment. This report neither authorizes sampling nor promotes diagnostic time into qualification. Prior v2 findings closure remains unchanged; native capture TID is unknown, GIL/kernel attribution is unestablished, and native/business/visible/physical evidence remains NOT_RUN. Core source/deployment decisions are unaffected.

Only this report was written. All evidence was obtained by read-only text/hash/AST inspection; no operational entrypoint imports, test reruns, builds, process/status/health/network/browser/native/service operations, package/source changes or subagents were used.
