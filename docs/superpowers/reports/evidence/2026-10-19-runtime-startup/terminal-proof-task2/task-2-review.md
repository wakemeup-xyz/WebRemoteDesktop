**Spec compliance: ❌ Issues found. Task quality: Needs fixes.**

Reviewed BASE `8c0e0e6331647b779323e04fec6f5943102a9906` → HEAD `0589da2042e8f3f273b2274639219612ec8a9cca`, limited to the two new files in the supplied review package. The full diff was reviewed in sequential sections; no changed source file was separately reread. No Critical findings.

### Strengths

- `scripts/guarded_terminal_scan_continuation.py:137`: the loader verifies the original manifest before executing definitions, derives its package import closure, uses separate private module graphs, rejects cached package-name pollution, and preserves the fixed R4 root and original gate references. The corresponding negative and identity tests are at `scripts/test_guarded_terminal_scan_continuation.py:201` and `:213`.
- `scripts/guarded_terminal_scan_continuation.py:221`: history validation keeps all four failed lineages and the failed reload/readiness relationship, derives the 34 identities with provenance, and reads complete historical IDs rather than prefixes. The first historical variant is handled without inventing absent attempt/sequence IDs (`scripts/test_guarded_terminal_scan_continuation.py:234`).
- `scripts/guarded_terminal_scan_continuation.py:494`: the main code object is preserved and only the three authorized globals change. Original source validation runs before startup/final wrapper checks; final does not replay startup TTL. The sample uses the actual original variadic coverage validator. Identity, expiry, marker, and late-final tests are at `scripts/test_guarded_terminal_scan_continuation.py:452`, `:468`, and `:522`.
- `scripts/guarded_terminal_scan_continuation.py:572`: check-only avoids main and operational outputs, invokes the original current/source gates, and ends with fresh admission. Normal results preserve raw legacy coverage and separately bind proof/assessment. Tests explicitly distinguish fake external legacy boundaries from actual new validators (`scripts/test_guarded_terminal_scan_continuation.py:307`, `:416`).

### Important findings

1. **[P2] The second birth read is cached, so it does not establish the required stable identity.** `scripts/guarded_terminal_scan_continuation.py:699–704` resolves one `psutil.Process` and calls that object's `create_time()` both before and after `status()`. The installed implementation caches creation time: `/Users/macstudio1/Library/Python/3.11/lib/python/site-packages/psutil/__init__.py:775–785` documents and implements returning `_create_time` after the first read. Thus the observation can report equal birth/birthAgain even if the PID changes during status observation. `_check_observation` at `scripts/guarded_terminal_scan_continuation.py:331` accepts that purported stability. The production-adapter test at `scripts/test_guarded_terminal_scan_continuation.py:606` covers only the absent branch and cannot detect this. Use a fresh public Process handle for the second birth observation of the same PID, rejecting disappearance/error/change; do not bypass psutil through private `_proc`. Add a cache-faithful present-identity race test and stable-present success tests. The design's resolve-count wording must be updated consistently before adopting the additional handle.

   **Focused reproduction:** actual `ProductionIO.observe_known` and `_check_observation`, with fake psutil/services/clocks only, accepted `stable-nonmatching`; the backend was read once at birth 20, changed to birth 30 during status, and the recorded birthAgain remained cached 20. Output: `accepted=True, actualBackendBirthReads=[20.0], observedBirth=20.0, observedBirthAgain=20.0, backendBirthAfterStatus=30.0`. No real PID was inspected.

   **Named dependency blocker, not a separate broad Task 1 review:** root requested checking the same concrete risk in `scripts/terminal_scan_proof.py:335–340`. Its present after-observation also resolves once and calls the same object's cached `create_time()` twice. Task 2 cannot establish its integrated proof contract until that producer is corrected and its affected tests reviewed. This finding does not reclassify any historical failure or assert that a stable different birth means the old identity is alive; it identifies an unperformed required identity-stability observation.

2. **[P2] Predecessor admission does not bind the authorized scenario to the result being accepted.** `scripts/guarded_terminal_scan_continuation.py:443–456` compares result/attempt/started IDs, then compares root decision fields to the prior attempt, but never compares the prior attempt/decision scenario to `previous['scenario']` or `SCENARIOS[index]`. The legacy result is checked against the expected scenario separately. Consequently these two internally consistent pairs can disagree, allowing the next scenario despite an outer predecessor whose root decision authorized a different scenario. Require the expected scenario across prior outer attempt, root decision, outer result, and legacy result. Also complete the closely related predecessor record schema checks here: `prior_attempt` has exact keys but its kind/version are not checked, and `started` at line 445 has neither exact keys nor kind/version validation. Add negative cases with correctly recomputed fixture hashes, so rejection cannot be attributed merely to SHA drift.

   **Focused reproduction:** one fake baseline executed the actual immutable main and actual new producer/consumer. In memory only, its outer attempt and root decision were changed to `scenario=continuity`, and outer hashes/admission decision references were consistently resealed while the outer and legacy result scenarios remained baseline. The actual next within-grace entry with `check_only=True` returned `read-only-integration-passed`. Output: `previousResultScenario=baseline, previousDecisionScenario=continuity, workerLaunches=1, fixtureOnly=True`; the one launch was the fake baseline ledger entry, with no second launch or real worker.

### Named external checks and verification limits

- **Original gate/main contract risk:** read only the pinned R4 `continuation_common.py:94–124` and `ordinary-continuation-supervisor.py:58–142` to confirm source return/argument behavior, original current-gate calls, startup marker ordering, and final validation order. These checks support the three-hook integration; no gate was executed against the live environment.
- **Dynamic dependency-loader risk:** read original `core.py:212–217`, `qualification_evidence.py:21–28`, and import statements of the pinned supervisor/passive source. They execute definitions under non-main module names and retain their original source checks; no source copy or shared module patch was introduced by this diff.
- **Sample delegation risk:** read original `bindings.py:54–56`; `validate_owned_coverage(*evidence)` is a pure loop, so passing the actual sample alone preserves its original check. No fabricated clean worker is necessary.
- **Listener/service boundary risk:** read original `core.py:172–203`; `service_set` retains the global lsof command with timeout 5, and health enforces integer viewer/relay counts and strict idle. No service/process/network command was executed.
- **psutil caching evidence:** source file SHA256 `d138a5786b163b56ba86ea0b2d5589dfca37e1bcdf8de1057fe1e933d6ab808a`, path and lines given in finding 1. Package origin lookup and file hashing were read-only; the focused reproduction used a fake module.
- The implementer reports a clean 38-test GREEN in 15.900 seconds. That suite was not rerun. Only the two named focused fake-only probes above were run because their concrete doubts were not answered by the reported tests.
- ⚠️ **Full actual legacy success chain remains NOT_CLOSED.** After both findings and the Task 1 dependency are fixed and reviewed, root still needs the planned real read-only `--check-only` against immutable inputs and actual FS/metadata/Git/process/HTTP gates. This review supplies no live-check, runtime, deployment, or qualification PASS. Actual qualification remains NOT_RUN; pacing remains NOT_ELIGIBLE.

### Assessment

**Task quality: Needs fixes.** The scoped integration and explicit fixture boundaries are sound in structure, but cached identity reads and incomplete predecessor authorization binding violate required admission/proof contracts. No separate Minor findings are deferred. This review wrote only this report; it did not run Git, services, browser, Host, sample, network, or live-process operations.

### Exact focused probe commands

Both commands ran in `/Users/macstudio1/.codex/worktrees/terminal-scan-exit/WebRemoteDesktop`; neither invoked the unittest suite or wrote fixture records to disk.

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=scripts python3 -B - <<'PY'
import sys, types
from unittest.mock import patch
import guarded_terminal_scan_continuation as r5
reads=[]
class CachedProcess:
    def __init__(self, pid):
        self.pid=pid
        self.backend_birth=20.0
        self.cached_birth=None
    def create_time(self):
        if self.cached_birth is None:
            reads.append(self.backend_birth)
            self.cached_birth=self.backend_birth
        return self.cached_birth
    def status(self):
        self.backend_birth=30.0
        return 'sleeping'
class Missing(Exception): pass
known=[{'pid':123,'birth':10.0,'parent':None,'firstObservedEpoch':1.0,'lastObservedEpoch':2.0,'sources':[]}]
services={'fixture':True}
legacy=types.SimpleNamespace(service_set=lambda:services, health=lambda **kw:{'viewerCount':0,'relayViewerCount':0})
with patch.dict(sys.modules, {'psutil':types.SimpleNamespace(Process=CachedProcess,NoSuchProcess=Missing)}):
    observation=r5.ProductionIO().observe_known(known,services,legacy,lambda:100.0,lambda:100.0)
r5._check_observation(observation,known,services,observation['started'],lambda:100.0,lambda:100.0)
print({'accepted':True,'actualBackendBirthReads':reads,'observedBirth':observation['identities'][0]['birth'],'observedBirthAgain':observation['identities'][0]['birthAgain'],'backendBirthAfterStatus':30.0})
PY
```

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=scripts python3 -B - <<'PY'
from copy import deepcopy
from pathlib import Path
import guarded_terminal_scan_continuation as r5
from test_guarded_terminal_scan_continuation import R5Case, actual_main_fixture, advance_case
c=R5Case()
result=c.run(loaded=actual_main_fixture(c))
assert result['classification']=='observed-qualification-completed'
folder=c.path.parent
prior=r5.loads(c.io.files[str(c.path)][0])
decision=r5.loads(c.io.read_record(prior['rootDecision']))
decision['scenario']='continuity'
new_decision=c.io.put(prior['rootDecision']['path'],decision)
prior['scenario']='continuity'; prior['rootDecision']=new_decision
new_attempt=c.io.put(c.path,prior)
started=r5.loads(c.io.files[str(folder/'r5-started.json')][0])
started['attemptSHA256']=new_attempt['sha256']; started['rootDecision']=new_decision
started['admission']['decisionSHA256']=new_decision['sha256']
new_started=c.io.put(folder/'r5-started.json',started)
result['attemptSHA256']=new_attempt['sha256']; result['startedSHA256']=new_started['sha256']
result['rootDecision']=new_decision; result['startupAdmission']['decisionSHA256']=new_decision['sha256']
c.io.put(folder/'r5-result.json',result)
n=advance_case(c,'within-grace')
checked=n.run(check_only=True)
print({'nextCheck':checked['classification'],'previousResultScenario':result['scenario'],'previousDecisionScenario':decision['scenario'],'workerLaunches':len(c.io.popen_calls),'fixtureOnly':True})
PY
```
