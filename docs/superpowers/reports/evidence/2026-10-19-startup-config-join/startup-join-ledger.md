# SDD ledger — plan: docs/superpowers/plans/2026-10-19-startup-config-grant-ordering-plan.md

Spec: docs/superpowers/specs/2026-10-19-startup-config-grant-ordering-design.md
Task1 BASE=9deab6e; sourceholda68released before any operations, old tool draft unsealed/unexecuted retained.

| Task/pair | Produced vs consumed | Preflight result |
| --- | --- | --- |
| Task1 self | config/grant join in existing WebRTC; actual-method regression/realInput gate | Consistent. Configured PC may exist before grant as today, but no peer beforeconfig/no offer before current eligiblegrant. |
| Task1 source/tests | shared reconcile + media guards consumed by both real callback orders | Consistent. Named test-helper pseudocode is local fixture only; it must not replace production bodies or force product readiness. |
| Task1 Input boundary | existing setControlLease false recovery must remain before offer when init resumes earlygrant | Loadbearing: hasActiveControl alone insufficient. Worker must inspect actual Input APIs and test true/false paths, report its minimal choice. |

Ruling: source/local ordering P2 takes priority over long-run acceptance on known defective startup; maintain livec802service while fixing, no currentR5causal/permanentstall assertion. Existing implementation authorization covers bounded codefix without anotherquestion. Cost ifwrong: delayed fresh tests and future Signal-only rebuild/reload, currentservicespreserved.

Task1: complete (commits9deab6e..fefc555, taskreviewclean; SpecApproved/QualityApproved /tmp/wrd-startup-config-grant-task-review-20261019.md). No parked/deferred implementationfindings. RED1/2 actualbehavior; focused7PASS; affected561PASS39.337s afternecessaryfakeInputfixturecorrection. Wholeincrementfinalreviewpending, no runtimequalification.
