# Independent R4→R5 checker-fix review

**Approved — reported finding addressed; no new actionable findings.** The capture namespace correction resolves the concrete AttributeError reproduced against R4. This is approval of the exact R5 delta for a fresh root-owned offline run, not a claim that the whole corrected checker or runtime qualification has passed.

Package: `/var/folders/xm/pfsckdms3fl0y_5q05v2rvf80000gn/T/wrd-frontend-move-context-operations-private-r5-wive_sjb`.

Reviewed manifest SHA256: `3983cba582cb5d972149739621cc5cd13f2b6f3f458713d2db4e8e181b73ab7f` (45 manifested files).

Reviewed checker SHA256: `5d04326be8f94a38f20944a98041a4d743c86af3363a39c44ab7ec58f2e0b5f6`.

## Fix assessment

At mixed-native-integration.py:100–116, capture now receives runtime_args for the fixture scenario, paths, config, manifest digest and actual producer argument. The expected build at :116 still reads args.viewer_build_id, which now correctly resolves to main's validated CLI namespace. No local assignment shadows that outer binding. This preserves the actual runtime namespace passed to the producer while checking the same externally selected source/build identity used by mixed_manifest, mixed_sample and final output.

The unchanged checker still routes actual fixture methods through the actual pinned producer and unchanged qualification consumer. Its per-method expected acceptance, actual exit agreement, canary exclusions and final two-accepted/ten-rejected counters remain. The unchanged integration consumer requires exact four-method/two-accept/ten-reject/1262-row output, current checker SHA, F2/build/component pins and successful root-attested exit. No failing branch was skipped and no assertion was replaced with a fixture property.

The added test_mixed_capture_namespace.py compiles the actual capture AST inside a real enclosing make_capture(args). The runtime namespace intentionally lacks viewer_build_id. The positive case checks producer object/injection identity, correct build reaching the fake consumer and expected count changes; the negative case checks that a wrong manifest build raises before consumer creation or counter updates. These are appropriately scoped namespace regressions. Their fake rows/producer/consumer do not establish whole-checker acceptance.

I inspected the retained actual RED log (two AttributeErrors at original capture:116,0.027s) and GREEN log (two PASS,0.021s), independently matching SHA256 `a0c587b3340c69fca874ec7377f58bd375a5979f1140095a778a22508196575c` and `a019f597cf7ae5c28f2542a89fa56d0e8a5f56d08109743a8d69b37ce287d9da`. I did not rerun them. The previous R4 static review, including my review, missed this functional harness bug. Its earlier pure binding tests were never evidence that the whole checker passed. R5's report records that limitation accurately.

## Independent static closure checks

I independently verified all45 R5 manifested files and all41 sealed R4 payloads against their original manifests. R5 is0700 and its owner-owned regular files are0600; its directory contains exactly the manifest plus its45 payloads, with no execution receipt or deployment artifacts. I reconstructed the complete payload delta independently and matched R4-to-R5.diff exactly, SHA256 `6bdaa26e6556ef718f13b6c61db1cc5797614e3ad47095ae9643048fc04e18ca`. The preparation handoff matches `3f5d6a660f3191633074e9266cd1d826c3062c62e5a1a2f4076af2783d950257`.

Only two existing code files changed: bindings.py changes the single execution scope string to frontend-move-context-operations-r5; mixed-native-integration.py changes capture's parameter/runtime-local references. The complete checker AST matches R4 after normalizing only runtime_args identifiers/argument back to args. The only added code is the extracted-capture regression. All other existing Python/JavaScript bytes, including source bindings, freeze/build/deployment/readiness/sequence consumers, quiescence, Registry, sampler and qualification logic, match R4. Every R5 Python file parses without importing it.

F2 source HEAD remains `c802a68362459b46b84593c7e8921575e0783394`. The source receipt is byte-identical to R4 and retains SHA256 `1a3531258a8232f0425497d66dc557d2f1e228b6e16a310f281ba6b66a86a7a1`. The previously reviewed source32/apply30/post1016, historical archive17, seven reviews and backend/tool/module pins remain unchanged; I did not duplicate their full prior review or test runs.

I rehashed the retained actual R4 execution record, failure output, line-only trace, original package review and actual asset review against R5 provenance. R4's exit1/no-timeout/1.712945627s/52-byte failure remains failed-or-indeterminate. The line trace only localizes main:144; the separate extracted-function RED demonstrates the underlying shadowing defect. The diagnostic assessment hash also matches its recorded `5d54a9760cb2e2e2da4a341c411c77cb8f2b57b48fdc3214f32ed72c545cb7c0`.

The preserved R4 frozen.json, build-result.json and template.json match their independently approved hashes `ca362b229d9dce405c324ee97a67339825f0badc0282dc644798558d2ce3703a`, `61a04517ef1207757406c8beb01e5c1124001baefaafc21bb4525fed812df724` and `fd786846f4438d8ac64c529596394d6340444b0d0859cdd9d017515812481bc3`. That template records buildId bb581651b422e400. The actual R4 asset review matches SHA256 `4475c189144c558c2907f161ebf873256788e74a06f2413f870228699138e3e8`. No apply-started/result exists in that R4 frozen deployment. I did not rebuild or repeat full asset inspection.

## Root execution order and limits

The corrected checker remains suitable for root-owned fake-only execution using python3 -B from the pinned source checkout with a finite external deadline. Its audit/import exclusions, fake manager/status/clocks, forbidden real status reader, empty password environment and fixture config protections are unchanged. It is not a general sandbox and still needs the outer deadline. This report supplies static suitability, not an execution result.

Root may first run this new R5 checker against same-source actual approved R4 buildId bb581651b422e400, then freeze a fresh R5 deployment and perform both actual private builds. The changed contract expressly requires actual new-template build equality with that fresh result and independent actual R5 artifact approval before copy/reload. This order is compatible with the unchanged offline receipt schema: its binding is exact checker/source/build, without a deployment timestamp-order field. It never treats R4's failed checker as a successful result.

Fresh R5 package scope and the complete codeHashes closure prevent old R4 frozen/template records from substituting: deployment.py:36 requires the entire current executable hash map, :53 requires template equality to that map, and :57 binds the fresh frozen hash/source/window. The new regression file is included automatically in that closure. Fresh window/build gates and actual startup output equality remain. Root must enforce the stated pre-copy equality check and obtain the actual new asset review; no expired R4 window extension or old asset approval is granted here.

All later exact14-known-birth quiescence, source30 apply, Signal-only reload, same Host36877/birth1792322600.528357, tunnel/watch preservation, readiness, new sequence and individual scenario gates remain unchanged. Root remains sole operator under existing human authorization; no repeated approval is requested. Whole R5 checker success, new asset approval, publication/reload and runtime qualification are still unperformed gates at this review. Missing native/business/visible/physical evidence remains NOT_RUN/null.

Only this report was written. No tests, operational imports, builds, process/status/health/network/browser/native/service actions, package/source edits or subagents were used. Review evidence came from read-only file/hash/AST inspection and a read-only source HEAD lookup. Historical failures, old frozen records and the expired window were retained unchanged.
