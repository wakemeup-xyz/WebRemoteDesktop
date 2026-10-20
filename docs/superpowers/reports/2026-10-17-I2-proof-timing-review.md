# I2 proof 时序独立审查

提交 `0a89ebe`，25 Python + 10 Node 测试通过；独立 spec/quality PASS。仅验收工具调整，不宣称前次启动失败由 proof 过期引起。

### Spec Compliance

- ✅ Spec compliant. UI login now precedes authenticated core readiness, the single proof callback and the single real Start click (`scripts/passive_session_soak.py:113`, `:188`, `:202`, `:400`). The callback uses the current browser Auth token/generation, reads fresh zero-Viewer/online-Host status, issues one proof and preserves existing proof storage (`scripts/passive_session_soak.py:35`).
- ✅ Shared request/body deadline is at most eight seconds and bounded by the remaining Start deadline; streamed response bodies are capped at 16 KiB. Auth continuity is checked after fetch and each body await (`scripts/passive_session_soak.py:35`, `:119`, `:150`).
- ✅ Post-proof freshness, auth/storage guard, marks and button checks fail closed before Start; callback/click have no retry path (`scripts/passive_session_soak.py:188`, `:191`, `:202`). No ordinary-ticket issuance, consumed-proof clearing, product-handler replacement or connection creation was introduced.
- ✅ Startup evidence projects only bounded phase enums, booleans and safe generation values; cause remains unknown. Guard and media-wait failures receive distinct fixed categories (`scripts/passive_session_soak.py:94`, `:125`, `:422`, `:436`). Strict sampling/continuity logic is unchanged, and startup evidence is captured before the soak clock starts (`scripts/passive_session_soak.py:412`).
- ⚠️ Production startup success and three-hour continuity are outside this diff's evidence. No production/browser/network/native/service/build actions were run; the previous zero-sample failure cause remains unknown.

### Strengths

- The implementation removes the separate password API login and keeps credentials in the real UI login path (`scripts/passive_session_soak.py:113`, `:400`).
- Tests execute the actual browser callback in an isolated VM and cover zero-Viewer/Host guards, auth changes across awaits, shared deadline, body cap, proof refusal, privacy projection and actual product enums (`scripts/test_passive_session_soak.py:353`, `:363`, `:396`, `:412`). Async helper tests cover login/proof/click order, post-proof state changes, failure summaries, zero-sample incompleteness and browser cleanup (`scripts/test_passive_session_soak.py:266`, `:287`, `:423`).

### Issues

#### Critical (Must Fix)

- None found.

#### Important (Should Fix)

- None found.

#### Minor (Nice to Have)

- None found.

### Assessment

**Task quality:** Approved.

**Reasoning:** The change satisfies the requested proof timing and bounded startup evidence contract within the two owned helper/test files. Guards preserve one-shot admission and strict soak outcomes without attributing an unobserved production failure.

**Review checks:** Read the brief, implementer report and packaged diff; the initial combined output truncated the implementation hunk, which was recovered from the package. No test suite rerun or Git operation was performed. Concrete integration risk checked: current Auth generation/verification and proof storage must match the unchanged product consumers; inspected `web-client/js/auth.js:15`, `:28`, `:36` and `web-client/js/webrtc.js:2582`, `:2592`, `:2648`. Concrete projection risk checked: actual phase fields/enums must survive the allowlist; inspected `web-client/js/webrtc.js:396`, `:467`, `:1724` and `web-client/js/media-activity-runtime.js:24`. Concrete UI/bootstrap risk checked: the real submit button and pre-Start boot must support the new order; inspected `web-client/index.html:20` and `web-client/js/webrtc.js:6737`, `:6751`. These focused checks found compatible unchanged contracts.
