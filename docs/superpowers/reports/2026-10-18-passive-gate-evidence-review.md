# Passive gate evidence preflight and review record

2026-10-18. Independent read-only source preflight completed before implementation. Evidence-tool-only scope approved with explicit uncertainty and existing runtime preserved.

Confirmed: failure cleanup overwrites startupSummary. Current gate projection retains only inputAllowed, while lease1 proves a grant arrived but not full gate readiness. Source+timing support8s sticky UI failure as a candidate, not a measured blocker. Later protocol-too-old occurs while Host is null/offline and does not establish protocol regression. Longest11.766s stall coincides with slow Host capture/output/encoder/loop; native sample did not cover it and stale resources cannot establish memory-pressure causality.

Preflight corrections bound the design: timer handle presence cannot prove pending/fired; page-lifetime first startup marks are not attempt scoped; full effective gate differs from getDesktopInputGateSnapshot; capture Input/socket ownership and recheck after getters; immutable timed startup/failure and required-startup capture behavior retained; console is an exact positive page-level fact only. Existing DC watchdog cancels on open, so a future slow-negotiation policy also needs a finite paint phase.

Root chose exact console observation instead of method wrappers/product logging for less runtime interference, accepting weaker clock/attempt attribution. Root chose evidence first instead of changing timeout or broadly reviving disconnected. These decisions and their costs are retained in the design. Task/final review and guarded sync/run pending.
