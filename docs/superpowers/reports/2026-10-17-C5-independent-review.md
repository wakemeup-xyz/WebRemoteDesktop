# C5 独立复审归档

最新结论：`8e375fa` 的 R1 复审 PASS；初轮 P2 已修复。下文按原样保存初审与复审，不把源码通过等同于公网运行验收通过。

# C5 independent scoped review

Reviewed frozen range: `7a69cad..cd64e54` (16 paths). Verdict: **REQUEST CHANGES — one P2**. No production, service, browser, native-input, source, or Git mutation was performed. This file is the review artifact; root owns versioned rollup and anchor.

## Findings

### P2 — Reclaim after a superseded cold Start never installs the completed bootstrap

**Location:** `web-client/js/webrtc.js:2495`, interacting with `reclaimDesktopSessionOnce` at lines 6576–6597.

**Trigger:** A page's first Start opens signaling while its bootstrap is pending. Another explicit Viewer supersedes it (or admission rejects it), setting `_superseded`. The valid bootstrap then resolves. The new early return exits before `init` / `applyBootstrapSnapshot`, and also leaves `_deferPeerUntilConfig` true. The user next clicks the displayed “在此页重新连接” button.

**Consequence:** Reclaim obtains a fresh ticket and creates a new socket, but calls `createPeerConnection` without loading/applying the skipped bootstrap. On relay, `hasTurnConfigured()` remains false even though the completed bootstrap contains working TURN configuration; the real PC creation method exits through `relay-unavailable-no-turn`. The intended manual recovery can displace the current Viewer yet fail to produce media itself. Automatic reconnect cannot supply the missing bootstrap.

**Independent evidence:** A focused offline VM probe reused the existing `loadWebRTC` fixture without registering/running its tests. It exercised actual `startViewer`, socket listeners, supersede cleanup, `reclaimDesktopSession`, `buildPeerConfig`/`hasTurnConfigured`, and `createPeerConnection`; only platform IO/DOM/config responses were fake. Sequence: delay controller.load → accept initial welcome → trigger viewer-superseded → resolve bootstrap with `turnConfigured: true` and a TURN server → await Start → await reclaim. Result: before reclaim `superseded=true`, `turnConfigured=false`; after reclaim `superseded=false`, two sockets constructed, `turnConfigured=false`, `pcCreated=false`. No network, browser, or real RTC was used. The supplied C5 Viewer helper replaces `createPeerConnection` with an empty function and therefore misses this boundary.

The exact probe is saved beside this report as `task-C5-reclaim-counterexample.cjs`. From the worktree root: `node .superpowers/sdd/2026-10-17-reliability-latency-remediation-plan/task-C5-reclaim-counterexample.cjs`. It was executed once as an equivalent inline script against cd64e54; saving the script did not rerun it. Its assertions intentionally describe the observed defect, so it is a reproducer rather than a passing regression test for the eventual fix.

**Actionable fix:** Ensure manual reclaim obtains/applies the current valid bootstrap before starting a peer, including when its initial Start was superseded/rejected before configuration finished; release the obsolete deferred-config state. Preserve the existing rule that a superseded asynchronous Start must not resume media or overwrite a newer operation. Cover reclaim both after and before the original bootstrap response, with real configuration/PC eligibility checks and a configured relay fixture. Do not fix this by allowing an old Start continuation to regain authority.

## Other scoped conclusions

- Admission ownership is centralized in one runtime shared by the authenticated HTTP endpoint and Socket.IO. The pinned owner and issuance high-water survive ticket TTL and socket/grace cleanup. Capacity rejects rather than evicting live deduplication evidence. Subject/session binding, consumed-ticket retry, issuance ordering, unknown-generation rejection, and same-session new-generation fencing are coherent.
- Rejected ordinary connections return before map, lease, Host producer/reset, and proof-epoch changes. The original grace-inside and grace-expired counterexamples are covered by real-handler tests that assert the active B map/lease/Host event stream remains unchanged. Current-owner recovery still uses existing Host ACK/rebind and reset/regrant barriers.
- Proof remains one-use, realm/epoch-bound and zero-Viewer. Successful proof admission invalidates ordinary history; old automatic recovery cannot evict it, while a fresh explicit user Start can. Proof-bearing Start/reclaim (including malformed retained markers) does not obtain an ordinary takeover ticket. The strict proof-only runtime denies ordinary ticket issuance.
- Documented legacy compatibility is conservative and implemented: one pristine first admission, identity-matched current legacy recovery, no stale fallback after explicit/proof admission, and unknown resume after process restart requires a manual action.
- Client ticket issuance is limited to Start/reclaim, authenticated and bounded; welcome replaces socket auth with resume identity, and automatic refresh/recovery does not mint another ticket. Rejection uses the terminal superseded state and preserves drafts. The outstanding finding is configuration lifecycle integration on that new rejection/supersede path.
- Active addendum, plan, appended requirements, and task report describe the implemented API, state bounds, proof behavior, legacy compatibility and restart limitations. No additional documentation or architecture blocker was found.

## Validation and limits

Inspected source and tests in the exact frozen diff plus directly affected callers. Implementer-supplied 473/473 results were reviewed, not rerun. Independent `git diff --check 7a69cad..cd64e54` passed. Only the new focused offline counterexample above was executed. This review does not establish deployment, public media continuity, real input/visible effect, or long-session acceptance.


# C5 R1 independent scoped re-review

Frozen range: `18b5c88..8e375fa` (three paths). Scope: the original C5 P2 cold-bootstrap/reclaim finding and regressions introduced by its fix. Root documentation preparation at `18b5c88` and unrelated branch changes were excluded.

**Findings: none. Original P2: ADDRESSED. Scoped verdict: PASS.**

The superseded/admission-rejected Start now retains valid bootstrap configuration after checking both authentication and the current pending request identity. Configuration retention does not initialize a peer or restore the old attempt. Its matching finalizer clears the pending/deferred-config markers even when the old Start exits. Consequently, reclaim after bootstrap completion has the TURN configuration needed by the real relay PC creation path.

Reclaim before completion waits for that same validated configuration promise while the old Start remains superseded. It requests its new explicit ticket and creates its socket/peer only afterward. The old Start continuation therefore cannot initialize media for the reclaim operation. Authentication is checked during response validation and again in the Start continuation; stale authentication rejects pending reclaim rather than issuing a ticket. Cleanup is guarded by pending-promise identity, so an obsolete configuration request cannot clear a newer request's pending state.

Reviewed the six added real-PC lifecycle cases: both rejection events followed by post-bootstrap reclaim; pre-bootstrap reclaim with current/stale authentication; stale-auth configuration rejection; and authentication change between configuration validation and the Start continuation. Assertions inspect actual `createPeerConnection` output, configured TURN, relay policy, deferred/pending state, socket/ticket counts, and the single reclaim media attempt. The platform RTC constructor/DataChannel are fake; the production configuration and lifecycle methods are retained, closing the initial test gap.

Architecture and documentation: the repair adds one bounded pending configuration promise to the existing Start/reclaim owner rather than another admission controller. Server admission, proof, legacy and Host authority contracts are unchanged. The versioned C5 report records the original RED, R1 behavior, exact targeted command/results, and remaining runtime limits. No scoped architecture or documentation issue remains.

Validation: implementer-supplied 259/259 targeted tests were inspected and not rerun. Independent `git diff --check 18b5c88..8e375fa` passed. No new counterexample was needed; no source/Git/root-document mutation, browser, service, production, real RTC, or native input action was performed. Only this review artifact was written. PASS clears the identified source-review blocker; deployment and real media continuity acceptance remain separate root-owned steps.
