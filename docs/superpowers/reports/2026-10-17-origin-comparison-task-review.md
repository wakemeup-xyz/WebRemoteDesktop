# Task 4 independent spec, quality and integration review

2026-10-17. Verdict: PASS for private preparation and fake-only validation. No P0, P1, P2 or P3 implementation findings. Live origin comparison NOT RUN; Task 2 formal three-hour qualification remains OPEN. Human testing pending is the current no-Viewer constraint; existing maintenance authorization is not revoked or subject to another generic permission request.

## Evidence and scope

Read task-4-brief.md, task-4-report.md, the owned-turn spec including Task 4, and /tmp/wrd-origin-comparison-design-review.md. Reviewed complete supervisor and tests and verified task4-review.diff exactly equals independently reconstructed diffs against the private before copies. Only the two-origin dictionary, first execute guard, preflight/final originClass and CLI choices changed in supervisor; three test methods were added. No helper/sampler or admission/worker lifecycle changes.

Spec PASS: exactly formal https://link.stockhub.wiki and loopback http://127.0.0.1:8080 accepted, no URL normalization or alias expansion. Non-string rejection short-circuits dictionary membership, including unhashable list/dict. Guard precedes duration/hash/Host/output/Popen. CLI defaults remain formal, relay and 300; direct worker argv uses original approved origin and literal relay. Both private JSON records use fixed classification and do not serialize origin or arguments wholesale.

Quality PASS: reran 19 selected unittest methods with Python 3.11 -B, 0.171 seconds, OK. Excluded exactly test_harmless_owned_child, test_cli_rejects_missing_pid_and_arbitrary_duration and test_help_has_no_writes. No actual worker/sample child, network, browser, service, native input or dependency installation was invoked. Synthetic execute tests mock process creation/identity; fixtures were under the private root and cleaned. Regression coverage includes 2 origins x 2 durations, wrong paired hash before Host/mkdir/Popen, invalid-origin early rejection, CLI choices/default, unchanged thresholds, single sample latch, stale Host, deadline during worker cleanup, byte limits, reused PID avoidance and original helper artifacts. The RED history was reviewed as implementer evidence; this reviewer independently reran GREEN only.

Integration PASS: private BASE points to the primary checkout. Actual helper/sampler bytes in BOTH primary and review worktree match the preserved paired pins. Helper accepts both passed origins, preserves normal UI login and fresh one-shot proof path, classifies their hostnames consistently, and retains relay argument/continuity semantics. Pin guard remains fail-closed. Worker proof/session artifacts remain solely helper-owned; final cleanup remains based on owned identities, with no perfect-tree-exit claim. Existing sample thresholds (>2000 for 300; >=5000 for 10800), 10-second external sample budget, 8MiB cap, 128 identity cap and duration+300 deadline remain unchanged.

Private root mode verified 0700; supervisor, tests, both before copies and review diff verified 0600. This review file is also 0600. No source/index writes performed.

## SHA256

- supervisor.py: 2bfc3e7c5cffa72ad3fda45ae78c91bb4c83cb9684d05356acffeaab84b39f7a
- test_supervisor.py: 43d9ba3a3f1fb5ddbe7dea7f565d6cc5619ccb9a0e744413e3103a353c33c494
- supervisor before: 76106a958fde1fe80650524ca43952a12bc7c7ce36ee348f30ebebce95e0e884
- tests before: d81a89cee89c744e62c8f0ae9d6cd2ef375d7ee5f0d0d81a0cc36973c3eb3e8b
- task4-review.diff: 59f7929e5af15f6858c1443fc05ed723f0d2c7ed68df93f9eab1f7e2b4ae79d5
- helper (both checkouts): f84777d8de0bda53f5a46400c2cd91d5d91f4d84ca364567d1cf58f11467c418
- sampler (both checkouts): d3a426786a7d31feeace6d395662ea850aa4678361f635c16d65900162a42f5d

## Limits and operational wording

Input originClass is not independent actual-route evidence. Fresh zero-Viewer proof, observed build/protocol/media-category comparability, no replay/reconnect and original helper results remain required. A 300-second result is diagnostic only; even loopback 10800 PASS cannot satisfy formal qualification. Existing sample intervention remains possible and must be disclosed. This preparation review does not establish live transport behavior, deployment or three-hour acceptance.

The implementation report phrase “future explicit authorization” should be read in current task context: maintenance authorization already exists; the unresolved operational gate is the pending human-testing/no-Viewer constraint and fresh zero-Viewer checks. No repeated maintenance-permission question is recommended by this review.
