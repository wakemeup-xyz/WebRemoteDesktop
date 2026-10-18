# R2 focused revision review

Private architecture documents only. R0 and R1 remain unchanged. No product/index/tracked writes, product imports, tests, browser, HTTP/network, services, tunnel or native operations were performed. Read-only source and installed Playwright file inspection confirms the review premises; root's reported formal entry availability is supplied context, not a new network observation by this drafter.

## Independent R1 findings addressed

| Finding | R2 resolution | Planned behavioral verification |
|---|---|---|
| P2 routed wrapper misidentified as native | Split within-grace native-direct fresh route-free page from after-grace playwright-routed signaling. Capture original constructor/close before app only for direct case; no constructor replacement/private _ws access. Explicit immutable instrumentation and qualificationEvidenceScope everywhere required. | Pure fake wrapper that passes global instanceof cannot produce native claim; no routes in baseline/continuity/within; routed after baseline and recovery retain narrower label; close exactly once. |
| P2 Host replacement lacks producer | Fixed local127.0.0.1:8080/api/status private Host-ID equality before Start/fault, every one-second tick and final export; existing role=host disconnect log becomes sticky alarm. Missing/change/gap -> no PASS. | Host replacement during after-grace with unchanged admission/build and final valid lease/media must remain INCOMPLETE; same final ID plus disconnect alarm also cannot pass. |
| P3 Task6 integration write lacks owned path | Moved guard-owned actual handler within/after-grace addition into Task1, which owns viewer-admission.integration.test.js. Task6 only runs/reviews that source regression and writes its already-owned review/docs. | Ownership checklist: Task1 owns test write; Task6 finding returns to root/owning implementer, no out-of-scope product/test write. |

## Root rulings incorporated

- Supported Playwright routing is retained with honest evidence limits. After-grace PASS means real ordinary server/application functional recovery under routed stimulus; no naturalWS1006, uninstrumented WebSocket performance or native after-grace claim. `nativeAfterGraceQualification` remains NOT_RUN. Baseline300 and fresh10800 use no routes.
- Host status is local, not a per-tick public Cloudflare fetch. One bounded asyncio TCP request,750ms total including close/cancellation;8192-byte headers/16384-byte body; no thread, queue, proxy, redirect or arbitrary URL. Injected status_reader keeps tests pure. Status and existing page sample are concurrently owned under the unchanged2-second sample bound; final export retains1-second cap. Gaps/incomplete teardown stay explicit.
- Formal and quick origin sources are separate and pinned in the manifest. Quick URL only comes from the existing quick URL file, with no regeneration. Formal origin uses preserved reviewed configuration, prior user authorization and fresh root verification; the supplied authorized origin is https://link.stockhub.wiki. Absent quick file does not block that path. No fake URL-file writes or tunnel changes.
- Root verifies the selected public origin maps to the same local Signal8080/Host before creating the per-run deployment attestation. Runtime code/source claims remain root-attested; browser build is separately sampled against the pinned build.

## Consistency checks

Spec and plan use the same instrumentation enum none/native-direct/playwright-routed and scenario-to-scope mapping. ordinaryRecovery and sample wrappers include qualificationEvidenceScope; summary additionally includes nativeAfterGraceQualification and bounded hostObservation. Fixed selected-event enum adds only host-disconnected; fixed reasons add Host observation unavailable/gap/disconnect. Raw Host IDs remain private equality inputs; only salted hashes persist. Human owner/intent priority, guarded nonmutation, proof nonresumability, ACK/lease/media/input gates and all production deadlines are unchanged.

No new server endpoint or general diagnostic framework is proposed. The only previously planned new server event remains grace-expired; Host continuity reuses the existing status endpoint and disconnect event. Path ownership stays serial under mandatory SDD. Pure source tests and actual runtime results remain unexecuted in drafting.

## Artifact SHA256

- R1 `2026-10-18-guarded-ordinary-recovery-design.md`: `7a12f3ecccca0c688d581d0a8420341a0c4d697ebb38f2afd1b58cb530566f5c`
- R2 `2026-10-18-guarded-ordinary-recovery-design.md`: `09e7fb03127b2a6e3c6397738582ce11abb046e81fe09f6fff4df4ae1c1ab833`
- R1 `2026-10-18-guarded-ordinary-recovery-plan.md`: `ef1dc47b527c3aed162aab4327e4d2b1ef9e403142837700c3360261cb5569d8`
- R2 `2026-10-18-guarded-ordinary-recovery-plan.md`: `5d79d7e5a51f348b5af8d00c3a28049f8ea494039a5d0382b96c1cbf628a8c0a`
- `R1-to-R2.diff`: `8415f4048dd662913b6881adf08eeedad27d010cc140c707b3bca04785b57bbb`
