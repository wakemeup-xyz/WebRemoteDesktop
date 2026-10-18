# Source implementation and review evidence

The product increment is BASE4d591bb → c239482, with design/plan d3bdf81 and three serial Host tasks. No source promotion, Host reload or new runtime qualification has occurred at this record. All three task gates are Approved; final whole-increment review is pending.

- Task1 original Important finding: new observer CPU was charged to native-grab non-CPU time. Original worker fixed it in d3eaa28; scoped R1 Approved. The 7ms observer + 10ms native fake produces 10ms wall / 10ms CPU / 0ms non-CPU, with7ms postGrab. [Original task review](task-1-review.md), [scoped R1](task-1-r1-review.md).
- Task2 exact-once existing-worker resource closure and late-pixel guard: independent Astra review Approved, no findings. [Review](task-2-review.md).
- Task3 invocation-specific old-object terminal and original authority/error/cancellation ordering: independent Astra review Approved, no findings. [Review](task-3-review.md).
- [Fixed test provenance](source-tests.json): latest six affected pure suites103 tests/30.241s/exit0/OK. Earlier67/84 overlap and are not added. Actual behavioral REDs and corrected command/CWD setup mistakes are distinguished in the execution report/private full implementer reports.

Canonical task package hashes: Task1 original62117bytes SHA072bbac502d7682445a45358b92b13e1b6f2ac1551e4bd671687e251666cdc79; R1fix10830bytes SHA3d033752f5115b9d29eebea1c2ca064dae9ff2398a9e53cf630d826f865d5b68; Task2 61060bytes SHAb1ad655ab1fc3c27ca99837a7c374cb0fd6b802659c4295d7fd8f2ab037f4fd2; Task3 46665bytes SHA61effd64a5ad890885c45e1d4b4d88d200088abea56dfc1aea21163b392ed5bb.

Private Host-only operational preparation R1 is independently Approved for its two originalP1 fixes: preserve actual filesystem modes separately from Git execution bits and include all890 deployed BASE regular files (261notinprimaryindex;629indexedregular retained). Guarded per-file atomic exact copy, one-use safe-helper Host-only reload and strict ownership uncertainty classification are reviewed; no operation was executed. Package SHA256SUMS.json SHAa2f3aa5c5aa544cfd0af9ef6f7b7d3a8b7af523463cbe8bd64d9039e07971f82; original R0 remains unchanged. Operational static approval is distinct from source/runtime approval and full process-tree termination stays unknown.

Implementation uses existing thread/executor/authority/deadlines/pacing and fixed bounded scalar observations. No quality/FPS/codec/network tuning, native acceptance, sender release, executor termination or permanent native-block recovery claim is made. Dedicated native-input/visible/physical qualification and ordinary-user recovery remain unqualified. Root continues fresh exact-source/runtime measurements after final source review; no user testing prompt is pending.
