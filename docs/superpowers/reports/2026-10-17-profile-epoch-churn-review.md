# Profile epoch churn independent offline review

Scope: read-only source inspection in reliability-latency checkout HEAD e996467. Relevant four files have no diff from runtime source e279060. No Host construction, MSS, native input, network, browser, install, build, services or tracked writes. One Python AST extraction/pure resolver synthetic check; no timing qualification claimed.

## Findings

1. Confirmed unnecessary image epoch invalidation (host.py:1983–2029). apply_media_profile always calls set_max_resolution and set_target_fps. Both increment _target_generation and release pending frame reservations even if unchanged. This is NOT _capture_generation (which remains unchanged). Same-size bitrate-only or logical-profile-only changes therefore invalidate the cached ndarray; same-size FPS change does too. recv:1610–1660 selects cache only with matching target generation and discards in-flight worker output on generation mismatch, recursively requesting another frame. These are image-size validity rules being coupled to non-image changes.

2. Confirmed codec-policy churn opportunity (h264_encoder_policy.py:204–214). Exact peak 720p 20 FPS resolves to h264_videotoolbox fixed 3.2 Mbps; 15 FPS resolves to existing relay-on-demand-v1/libx264 (1.8 Mbps with the tested request), then 20 FPS resolves back. This is intentional fail-closed peak qualification, not a resolver bug. Cached Viewer stats→observe→applyMediaProfile can exercise it because QualityLock retains resolution but permits FPS/rate changes above floors. Host profile admission checks lease/identity/sequence; it does not apply M5 qualification to this legacy entry point.

3. Conditional extra reopen amplification: after epoch invalidation, no screenshot+no valid fallback creates blank at maximum rectangle, e.g.1280×720; actual 16:10 screenshot scales to1152×720. Encoder _encode_frame:724–738 unconditionally drops codec when frame dimensions differ. Thus a blank and following real capture can cause two dimension transitions despite unchanged requested resolution. Source establishes possibility, not that this occurred in the longrun. No synthetic encoder or native codec run was performed.

## Minimal synthetic results

Extracted only ScreenCaptureTrack setters/apply/release helper via ast, instantiated synthetic class with lock and monitor fields, no native constructor. Starting target epoch9, capture epoch4, max1280×720, target20: apply FPS20→15→20 yielded target epoch deltas2,2,2; sizeChanged=false throughout; capture epoch remained4. Original cached epoch9 becomes invalid immediately. Pure resolver for identical relay1280×720 intent at20/15/20 FPS yielded peak/VT/3200000, on-demand/libx264/1800000, peak/VT/3200000. These checks confirm state behavior only; no actual stall duration or hardware behavior established.

## Contract interpretation

QualityLock spec docs/superpowers/specs/2026-08-02-quality-lock-low-latency-design.md §1/§3 explicitly permits quality-floor-preserving bitrate/FPS microadjustments while locking resolution. Therefore15 FPS is not automatically a QualityLock violation. It also explicitly requires same-size hot updates rather than incidental reopen.

M5 docs/superpowers/specs/2026-10-17-media-latency-design.md §7 line163 says qualification applies only to proposed NEW automatic adaptive selection. Existing startup/fallback/user choices remain prior paths. New adapter disabled without local qualification is consistent with M5. Legacy adaptive entry surviving outside that new adapter is a coverage/compatibility gap; do not claim its existence directly violates M5 or that M5 already authorizes removing old rate adaptation. Any guard on it is a narrow reviewed extension of admission policy.

## Smallest review-ready repair

A. Mechanical correctness repair, independently useful: normalize/cap requested dimensions first and atomically compare/update target dimensions under _target_lock. Advance image-validity epoch and release frame reservations only for an effective dimension change. Update FPS/pacing without changing image-validity epoch or discarding valid pixels; identical FPS is no-op. If pacing changes truly need their own epoch, separate pacing from image validity rather than invalidating both. Preserve suspension/shutdown _capture_generation guards. apply_media_profile returns effective capped sizeChanged. Preserve strict no-op encoder fingerprint behavior. Do not change peak qualification, bitrate floors, selected resolution or codec tuples.

B. To stop legacy codec oscillation, explicitly review a narrow Host admission extension: automatic quality feedback may keep current applied policy when the requested FPS/rate would change effective codec/fingerprint without local qualification; connection/path sync, explicit user resolution/FPS, and unavailable-hardware fallback retain existing authorized paths. Use a trusted/validated origin contract; freeform Viewer reason alone is not authoritative. Current wire lacks an explicit reliable user-intent discriminator, so do not ship a casual reason allowlist. Prefer routing adaptive changes through a shared internal admission/coordinator, preserving current until qualified. Viewer suppression can reduce traffic but Host must cover cached Viewers. This is an additional policy change, not necessary for A and not already proven by tests.

Do NOT fix by allowing15/12 FPS peak, raising thresholds, forcing20 FPS for all requests, reducing resolution, lowering quality floors, or asserting unmeasured native policy superiority.

Required offline regression cases: same-size bitrate/logical-only/identical updates retain epoch and cache; FPS-only change retains valid in-flight image and input correlation; real effective size change increments epoch once and drops old-size result; cap-equivalent requests are no-op; suspend/shutdown still reject old work; empty capture after rate-only change reuses prior real-sized cache; qualified codec policies retain exact tuple restriction. For B, test old Viewer identity/sequence replay and explicit user paths separately; unknown/unqualified automatic origin preserves all current intent/capture/policy/generation.

## Causality and remaining evidence

Parent reports first gap6.733s preceded first adaptive profile change. That ordering excludes profile churn as trigger of that first gap. Churn can amplify later recovery/cadence failures and resource pressure; it does not explain later Host heartbeat death by itself. Actual first-stall root cause, codec-open counts, CPU/loop obstruction and heartbeat failure remain unproven in this audit. Native/longrun/visible-effect acceptance: NOT RUN. A is safe to implement/review independently; B requires the stated origin/behavior contract decision before implementation.
